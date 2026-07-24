<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;

/**
 * API activity log — every inbound HTTP call the S300/vendor makes to our
 * /overseas/s300/* endpoints is recorded in anprc_inbound_events_raw (by
 * InboundController::saveRaw). This exposes it to the CP so device↔platform
 * traffic is visible ("did the call arrive, from where, with what body").
 */
class ApiLogController {
    // GET /api/api-log?limit=100&offset=0&endpoint=uvis
    public function index(Request $req): array {
        $limit = min(500, max(1, (int)$req->input('limit', 100)));
        $offset = max(0, (int)$req->input('offset', 0));
        $endpoint = $req->input('endpoint');

        $where = [];
        $params = [];
        if ($endpoint !== null && $endpoint !== '' && $endpoint !== 'all') {
            $where[] = 'endpoint = ?';
            $params[] = $endpoint;
        }
        $sql = "SELECT id, endpoint, cmd_no, channel_no, source_ip,
                       LEFT(raw_body, 800) AS body_preview, LENGTH(raw_body) AS body_len,
                       received_at
                FROM anprc_inbound_events_raw";
        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;

        $events = Database::fetchAll($sql, $params);
        $totalSql = 'SELECT COUNT(*)::int AS c FROM anprc_inbound_events_raw';
        if ($where) {
            $totalSql .= ' WHERE ' . implode(' AND ', $where);
        }
        $total = (int)(Database::fetchOne($totalSql, $params)['c'] ?? 0);
        $endpoints = array_column(
            Database::fetchAll("SELECT DISTINCT endpoint FROM anprc_inbound_events_raw ORDER BY endpoint"),
            'endpoint'
        );
        return ['code' => 200, 'message' => 'success', 'data' => [
            'events' => $events,
            'endpoints' => $endpoints,
            'total' => $total,
        ]];
    }
}
