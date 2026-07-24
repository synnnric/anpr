<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\VisitService;
use App\Services\MqttOutbound;
use App\Services\InspectionService;

class VisitsController {
    public function index(Request $req) {
        $limit = max(1, min(500, (int)$req->input('limit', 100)));
        $offset = max(0, (int)$req->input('offset', 0));
        $status = $req->input('status');
        $plate = $req->input('plate');
        $from = $req->input('from');
        $to = $req->input('to');

        $where = []; $params = [];
        if ($status) { $where[] = 'status = :s'; $params['s'] = $status; }
        if ($plate)  { $where[] = 'license_plate ILIKE :p'; $params['p'] = "%$plate%"; }
        $review = $req->input('orphan_review');
        if ($review) { $where[] = 'orphan_review = :r'; $params['r'] = $review; }
        if ($from)   { $where[] = 'COALESCE(entry_at, exit_at) >= :f'; $params['f'] = $from; }
        if ($to)     { $where[] = 'COALESCE(entry_at, exit_at) <= :t'; $params['t'] = $to; }

        $sql = 'SELECT * FROM anprc_visits';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = Database::fetchAll($sql, $params);

        $totalSql = 'SELECT COUNT(*) AS c FROM anprc_visits';
        if ($where) $totalSql .= ' WHERE ' . implode(' AND ', $where);
        $total = (int)(Database::fetchOne($totalSql, $params)['c'] ?? 0);

        return ['code' => 200, 'message' => 'success', 'data' => ['items' => $rows, 'total' => $total]];
    }

    public function summary(Request $req) {
        $today = date('Y-m-d');
        $row = Database::fetchOne(
            "SELECT
                COUNT(*) FILTER (WHERE status = 'active') AS active,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed_total,
                COUNT(*) FILTER (WHERE status = 'completed' AND DATE(exit_at) = :d1) AS completed_today,
                COUNT(*) FILTER (WHERE DATE(entry_at) = :d2) AS entered_today,
                COUNT(*) FILTER (WHERE status = 'orphan_exit' AND DATE(exit_at) = :d3) AS orphan_exits_today,
                COUNT(*) FILTER (WHERE status = 'denied_entry' AND DATE(entry_at) = :d4) AS denied_entries_today
             FROM anprc_visits",
            ['d1' => $today, 'd2' => $today, 'd3' => $today, 'd4' => $today]
        );
        return ['code' => 200, 'message' => 'success', 'data' => array_map('intval', $row ?: [])];
    }

    /**
     * POST /api/visits/record-exit — called by the worker when an exit plate
     * is detected by the exit ANPR camera.
     * Body: { license_plate, exit_channel_no }
     */
    public function recordExit(Request $req) {
        $body = $req->json();
        $plate = trim((string)($body['license_plate'] ?? ''));
        $exitCh = trim((string)($body['exit_channel_no'] ?? ''));
        if ($plate === '' || $exitCh === '') {
            Response::error('license_plate and exit_channel_no required', 400);
            return null;
        }

        $visit = VisitService::findActiveVisit($plate);
        if ($visit) {
            VisitService::closeVisit((int)$visit['id'], $exitCh);

            // One-time-pass cleanup: the plate was whitelisted on EVERY exit camera
            // (lanes are not paired), so remove it from every exit camera too —
            // not just the one it happened to leave through.
            foreach (VisitService::findAllExits() as $exitChannel) {
                MqttOutbound::whitelistDelete($exitChannel['anpr_device_sn'], $plate);
            }

            InspectionService::pushEvent('visit-completed', [
                'visitId' => (int)$visit['id'],
                'licensePlate' => $plate,
                'exitChannelNo' => $exitCh,
            ]);
            return ['code' => 200, 'message' => 'exit recorded', 'data' => ['visitId' => (int)$visit['id'], 'kind' => 'completed']];
        }

        // No active visit → orphan exit. NOT an automatic pass — the barrier
        // stays shut until an operator confirms via the CP popup.
        $orphanId = VisitService::logOrphanExit($plate, $exitCh);
        InspectionService::pushEvent('orphan-exit', [
            'visitId' => $orphanId,
            'licensePlate' => $plate,
            'exitChannelNo' => $exitCh,
        ]);
        return ['code' => 200, 'message' => 'orphan exit logged', 'data' => ['visitId' => $orphanId, 'kind' => 'orphan_exit']];
    }

    /** GET /api/visits/{id}/orphan-candidates — ACTIVE visits whose plate is
     *  similar to the orphan's exit read (misrecognition pairing, e.g.
     *  B1234AB0 vs B1234ABO). Sorted by edit distance, closest first. */
    public function orphanCandidates(Request $req) {
        $id = (int)$req->param('id');
        $orphan = Database::fetchOne('SELECT * FROM anprc_visits WHERE id = ?', [$id]);
        if (!$orphan) { Response::notFound('Visit not found'); return null; }

        $plate = (string)$orphan['license_plate'];
        $actives = Database::fetchAll(
            "SELECT id, license_plate, entry_channel_no, entry_at
             FROM anprc_visits WHERE status = 'active' ORDER BY id DESC LIMIT 200"
        );
        $out = [];
        foreach ($actives as $a) {
            $out[] = $a + ['distance' => levenshtein(strtoupper($plate), strtoupper($a['license_plate']))];
        }
        usort($out, fn($x, $y) => $x['distance'] <=> $y['distance']);
        return ['code' => 200, 'message' => 'success',
                'data' => array_slice($out, 0, 8)];
    }

    /** POST /api/visits/{id}/orphan-pair  body: {pair_visit_id}
     *  The exit read was a MISRECOGNITION of a vehicle that is inside: close
     *  that vehicle's active visit (normal exit), open the barrier, and drop
     *  the orphan row so in/out/inside totals stay tallied. */
    public function orphanPair(Request $req) {
        $id = (int)$req->param('id');
        $pairId = (int)$req->input('pair_visit_id', 0);
        $actor = AuthController::usernameFromRequest($req);
        if (!$actor) { Response::error('authentication required', 401); return null; }

        $orphan = Database::fetchOne('SELECT * FROM anprc_visits WHERE id = ?', [$id]);
        if (!$orphan) { Response::notFound('Visit not found'); return null; }
        if ($orphan['status'] !== 'orphan_exit' || ($orphan['orphan_review'] ?? null) !== 'pending') {
            Response::error('visit is not awaiting orphan confirmation', 409);
            return null;
        }
        $pair = Database::fetchOne('SELECT * FROM anprc_visits WHERE id = ?', [$pairId]);
        if (!$pair || $pair['status'] !== 'active') {
            Response::error('pair_visit_id must be an ACTIVE visit', 400);
            return null;
        }

        // Open the exit barrier (the misread plate isn't on the camera whitelist).
        $queueId = null;
        $ch = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$orphan['exit_channel_no']]);
        if ($ch && !empty($ch['anpr_device_sn'])) {
            $get = static function (string $key, string $default): string {
                $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
                return $row['value'] ?? $default;
            };
            $queueId = MqttOutbound::gateOpen(
                $ch['anpr_device_sn'],
                (int)$get('entry_gate_io', '0'),
                (int)$get('entry_gate_value', '2'),
                (int)$get('entry_gate_pulse_ms', '1000')
            );
        }

        // Normal exit for the REAL vehicle: close + whitelist cleanup.
        Database::update('anprc_visits', [
            'status' => 'completed',
            'exit_channel_no' => $orphan['exit_channel_no'],
            'exit_at' => gmdate('Y-m-d H:i:s'),
            'notes' => "Exit camera read '{$orphan['license_plate']}' — paired manually by $actor",
        ], 'id = :id', ['id' => $pairId]);
        foreach (VisitService::findAllExits() as $exitChannel) {
            MqttOutbound::whitelistDelete($exitChannel['anpr_device_sn'], $pair['license_plate']);
        }
        // The orphan row was a misread — remove it so totals stay tallied.
        Database::query('DELETE FROM anprc_visits WHERE id = ?', [$id]);

        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $orphan['exit_channel_no'],
            'action' => 'orphan_exit_paired',
            'request_payload' => [
                'orphanVisitId' => $id, 'exitRead' => $orphan['license_plate'],
                'pairedVisitId' => $pairId, 'pairedPlate' => $pair['license_plate'],
                'queueId' => $queueId,
            ],
            'response_payload' => null,
            'status' => 'success',
        ]);
        InspectionService::pushEvent('orphan-review', [
            'visitId' => $id,
            'licensePlate' => $orphan['license_plate'],
            'exitChannelNo' => $orphan['exit_channel_no'],
            'allowed' => true,
            'paired' => true,
            'pairedPlate' => $pair['license_plate'],
            'by' => $actor,
        ]);
        InspectionService::pushEvent('visit-completed', [
            'visitId' => $pairId,
            'licensePlate' => $pair['license_plate'],
            'exitChannelNo' => $orphan['exit_channel_no'],
        ]);

        $fresh = Database::fetchOne('SELECT * FROM anprc_visits WHERE id = ?', [$pairId]);
        return ['code' => 200, 'message' => 'success', 'data' => $fresh];
    }

    /** POST /api/visits/{id}/orphan-allow — operator lets the orphan vehicle
     *  out: opens the exit barrier (camera relay pulse) + records the decision. */
    public function orphanAllow(Request $req) { return $this->resolveOrphan($req, true); }

    /** POST /api/visits/{id}/orphan-deny — barrier stays shut, decision recorded. */
    public function orphanDeny(Request $req) { return $this->resolveOrphan($req, false); }

    private function resolveOrphan(Request $req, bool $allow) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        if (!$actor) { Response::error('authentication required', 401); return null; }

        $visit = Database::fetchOne('SELECT * FROM anprc_visits WHERE id = ?', [$id]);
        if (!$visit) { Response::notFound('Visit not found'); return null; }
        if ($visit['status'] !== 'orphan_exit' || ($visit['orphan_review'] ?? null) !== 'pending') {
            Response::error('visit is not awaiting orphan confirmation', 409);
            return null;
        }

        $queueId = null;
        if ($allow) {
            // Same relay pulse the gate flow uses, fired on the EXIT camera.
            $ch = Database::fetchOne(
                'SELECT * FROM anprc_channels WHERE channel_no = ?', [$visit['exit_channel_no']]
            );
            if ($ch && !empty($ch['anpr_device_sn'])) {
                $get = static function (string $key, string $default): string {
                    $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
                    return $row['value'] ?? $default;
                };
                $queueId = MqttOutbound::gateOpen(
                    $ch['anpr_device_sn'],
                    (int)$get('entry_gate_io', '0'),
                    (int)$get('entry_gate_value', '2'),
                    (int)$get('entry_gate_pulse_ms', '1000')
                );
            }
        }

        Database::update('anprc_visits', [
            'orphan_review' => $allow ? 'allowed' : 'denied',
            'orphan_reviewed_by' => $actor,
            'orphan_reviewed_at' => gmdate('Y-m-d H:i:s'),
        ], 'id = :id', ['id' => $id]);

        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $visit['exit_channel_no'],
            'action' => $allow ? 'orphan_exit_allowed' : 'orphan_exit_denied',
            'request_payload' => ['visitId' => $id, 'licensePlate' => $visit['license_plate'], 'queueId' => $queueId],
            'response_payload' => null,
            'status' => 'success',
        ]);
        InspectionService::pushEvent('orphan-review', [
            'visitId' => $id,
            'licensePlate' => $visit['license_plate'],
            'exitChannelNo' => $visit['exit_channel_no'],
            'allowed' => $allow,
            'by' => $actor,
        ]);

        $fresh = Database::fetchOne('SELECT * FROM anprc_visits WHERE id = ?', [$id]);
        return ['code' => 200, 'message' => 'success', 'data' => $fresh];
    }
}
