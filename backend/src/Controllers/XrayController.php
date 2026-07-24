<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\ImageStorage;
use App\Services\InspectionService;
use App\Services\XrayService;

/**
 * X-ray scan review — lists inbound scans (stored by InboundController::xray)
 * and lets an operator pass/deny one, which sends the vendor receipt
 * (POST /x-ray/{channelNo}) that opens or keeps closed the exit barrier.
 */
class XrayController {

    // GET /api/xray?status=&license_plate=&limit=&offset=
    public function index(Request $req): array {
        $limit  = max(1, min(200, (int)$req->input('limit', 50)));
        $offset = max(0, (int)$req->input('offset', 0));
        $status = $req->input('status');
        $plate  = $req->input('license_plate');

        $where = []; $params = [];
        if ($status) { $where[] = 'review_status = :st'; $params['st'] = $status; }
        if ($plate)  { $where[] = 'vehicle_number ILIKE :p'; $params['p'] = "%$plate%"; }
        $w = $where ? (' WHERE ' . implode(' AND ', $where)) : '';

        $rows = Database::fetchAll(
            "SELECT * FROM anprc_inspection_xray$w ORDER BY id DESC LIMIT $limit OFFSET $offset", $params
        );
        foreach ($rows as &$r) $this->decorate($r);
        unset($r);

        $total = (int)(Database::fetchOne(
            "SELECT COUNT(*)::int AS c FROM anprc_inspection_xray$w", $params
        )['c'] ?? 0);
        $pending = (int)(Database::fetchOne(
            "SELECT COUNT(*)::int AS c FROM anprc_inspection_xray WHERE review_status = 'pending'"
        )['c'] ?? 0);

        return ['code' => 200, 'message' => 'success',
                'data' => ['items' => $rows, 'total' => $total, 'pending' => $pending]];
    }

    // POST /api/xray/{id}/review  body: {result: bool, note?: string}
    // Operator verdict → sends the vendor receipt. Only a pending scan can be
    // reviewed; re-sending after a failed receipt goes through /resend.
    public function review(Request $req): ?array {
        $id = (int)$req->param('id');
        $row = Database::fetchOne('SELECT * FROM anprc_inspection_xray WHERE id = ?', [$id]);
        if (!$row) { Response::error('X-ray record not found', 404); return null; }
        if ($row['review_status'] !== 'pending') {
            Response::error('Already reviewed: ' . $row['review_status'], 409); return null;
        }

        $result = (bool)$req->input('result', false);
        $note = trim((string)$req->input('note', ''));
        $actor = AuthController::usernameFromRequest($req);

        Database::update('anprc_inspection_xray', [
            'review_status' => $result ? 'passed' : 'denied',
            'reviewed_by'   => $actor,
            'reviewed_at'   => date('Y-m-d H:i:s'),
            'review_note'   => $note !== '' ? mb_substr($note, 0, 500) : null,
        ], 'id = :id', ['id' => $id]);

        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => XrayService::config()['channel_no'],
            'inspection_id' => $row['inspection_id'],
            'action' => $result ? 'xray_review_pass' : 'xray_review_deny',
            'request_payload' => ['xray_id' => $id, 'note' => $note],
            'response_payload' => null,
            'status' => 'success',
        ]);

        XrayService::sendReceipt($row, $result, $note !== '' ? $note : ($result ? 'Manual review passed' : 'Manual review denied'), $actor);

        $fresh = Database::fetchOne('SELECT * FROM anprc_inspection_xray WHERE id = ?', [$id]);
        $this->decorate($fresh);
        return ['code' => 200, 'message' => 'success', 'data' => $fresh];
    }

    // POST /api/xray/room-come/{channelNo}  body: {licensePlateNo}
    // The x-ray room's own ANPR recognized a plate → open the room's ENTRY
    // gate. Any car may come (voluntarily or routed); the room's EXIT gate is
    // vendor-driven by the receipt, not by us. Called by the worker.
    public function roomCome(Request $req): ?array {
        $channelNo = $req->param('channelNo');
        $plate = trim((string)$req->input('licensePlateNo', ''));
        $ch = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
        if (!$ch || $ch['kind'] !== 'xray') { Response::error("Not an x-ray channel: $channelNo", 404); return null; }
        if (!$ch['enabled']) { Response::error("Channel disabled: $channelNo", 400); return null; }
        if (empty($ch['anpr_device_sn'])) { Response::error("Channel $channelNo has no ANPR device SN", 400); return null; }

        $get = static function (string $key, string $default): string {
            $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
            return $row['value'] ?? $default;
        };
        $queueId = \App\Services\MqttOutbound::gateOpen(
            $ch['anpr_device_sn'],
            (int)$get('entry_gate_io', '0'),
            (int)$get('entry_gate_value', '2'),
            (int)$get('entry_gate_pulse_ms', '1000')
        );

        InspectionService::logOperation([
            'channel_no' => $channelNo,
            'action' => 'xray_room_come',
            'request_payload' => ['licensePlateNo' => $plate, 'cameraSn' => $ch['anpr_device_sn'], 'queueId' => $queueId],
            'response_payload' => null,
            'status' => 'success',
        ]);
        InspectionService::pushEvent('xray-room-come', [
            'channelNo' => $channelNo,
            'licensePlate' => $plate,
        ]);
        return ['code' => 200, 'message' => 'x-ray room gate open queued',
                'data' => ['queueId' => $queueId, 'licensePlate' => $plate]];
    }

    // POST /api/xray/{id}/resend — retry the receipt with the recorded verdict.
    public function resend(Request $req): ?array {
        $id = (int)$req->param('id');
        $row = Database::fetchOne('SELECT * FROM anprc_inspection_xray WHERE id = ?', [$id]);
        if (!$row) { Response::error('X-ray record not found', 404); return null; }
        if ($row['receipt_result'] === null) {
            Response::error('No verdict recorded yet — review the scan first', 400); return null;
        }
        $actor = AuthController::usernameFromRequest($req);
        XrayService::sendReceipt($row, (int)$row['receipt_result'] === 1,
            (string)($row['review_note'] ?? ''), $actor);

        $fresh = Database::fetchOne('SELECT * FROM anprc_inspection_xray WHERE id = ?', [$id]);
        $this->decorate($fresh);
        return ['code' => 200, 'message' => 'success', 'data' => $fresh];
    }

    private function decorate(array &$r): void {
        $r['scanned_image_url'] = ImageStorage::publicUrl($r['scanned_image_path']);
        $r['plate_image_url'] = ImageStorage::publicUrl($r['plate_image_path']);
        if ($r['alarm_info'] !== null && is_string($r['alarm_info'])) {
            $r['alarm_info'] = json_decode($r['alarm_info'], true);
        }
    }
}
