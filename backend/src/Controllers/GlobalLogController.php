<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;

/**
 * Global-log queue drain API for the worker. The worker GETs pending rows +
 * the target URL, POSTs each payload to the partner receiver (gateCarEntry),
 * then marks each sent/failed. Same pattern as the MQTT outbound queue.
 */
class GlobalLogController {

    // GET /api/global-log/pending?limit=20
    // Returns the target URL + enabled flag + the pending rows to push.
    public function pending(Request $req): array {
        $limit = max(1, min(100, (int)$req->input('limit', 20)));
        $enabled = self::setting('global_log_enabled', '0');
        $url = self::setting('global_log_url', '');
        $rows = [];
        if (in_array($enabled, ['1', 'true', 'True'], true) && $url !== '') {
            $rows = Database::fetchAll(
                "SELECT id, event_id, phase, payload, attempts
                 FROM anprc_global_log_queue
                 WHERE status = 'pending'
                 ORDER BY id ASC LIMIT $limit"
            );
            foreach ($rows as &$r) {
                if (is_string($r['payload'])) $r['payload'] = json_decode($r['payload'], true);
            }
            unset($r);
        }
        return ['code' => 200, 'message' => 'success',
                'data' => ['enabled' => in_array($enabled, ['1','true','True'], true),
                           'url' => $url, 'items' => $rows]];
    }

    // POST /api/global-log/{id}/sent
    public function markSent(Request $req): array {
        $id = (int)$req->param('id');
        Database::update('anprc_global_log_queue',
            ['status' => 'sent', 'sent_at' => gmdate('Y-m-d H:i:s'), 'last_error' => null],
            'id = :id', ['id' => $id]);
        return ['code' => 200, 'message' => 'success', 'data' => null];
    }

    // POST /api/global-log/{id}/failed  body: {error}
    public function markFailed(Request $req): array {
        $id = (int)$req->param('id');
        $err = mb_substr((string)$req->input('error', 'push failed'), 0, 500);
        // Give up after 8 attempts so a permanently-bad row doesn't spin forever.
        Database::query(
            "UPDATE anprc_global_log_queue
             SET attempts = attempts + 1,
                 last_error = ?,
                 status = CASE WHEN attempts + 1 >= 8 THEN 'failed' ELSE 'pending' END
             WHERE id = ?",
            [$err, $id]
        );
        return ['code' => 200, 'message' => 'success', 'data' => null];
    }

    private static function setting(string $key, string $def = ''): string {
        $r = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
        return $r['value'] ?? $def;
    }
}
