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
        if ($from)   { $where[] = 'COALESCE(entry_at, exit_at) >= :f'; $params['f'] = $from; }
        if ($to)     { $where[] = 'COALESCE(entry_at, exit_at) <= :t'; $params['t'] = $to; }

        $sql = 'SELECT * FROM visits';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = Database::fetchAll($sql, $params);

        $totalSql = 'SELECT COUNT(*) AS c FROM visits';
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
             FROM visits",
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

            // Remove from exit camera whitelist (one-time pass cleanup)
            $exitChannel = Database::fetchOne('SELECT * FROM channels WHERE channel_no = ?', [$exitCh]);
            if ($exitChannel && !empty($exitChannel['anpr_device_sn'])) {
                MqttOutbound::whitelistDelete($exitChannel['anpr_device_sn'], $plate);
            }

            InspectionService::pushEvent('visit-completed', [
                'visitId' => (int)$visit['id'],
                'licensePlate' => $plate,
                'exitChannelNo' => $exitCh,
            ]);
            return ['code' => 200, 'message' => 'exit recorded', 'data' => ['visitId' => (int)$visit['id'], 'kind' => 'completed']];
        }

        // No active visit → orphan exit
        $orphanId = VisitService::logOrphanExit($plate, $exitCh);
        InspectionService::pushEvent('orphan-exit', [
            'visitId' => $orphanId,
            'licensePlate' => $plate,
            'exitChannelNo' => $exitCh,
        ]);
        return ['code' => 200, 'message' => 'orphan exit logged', 'data' => ['visitId' => $orphanId, 'kind' => 'orphan_exit']];
    }
}
