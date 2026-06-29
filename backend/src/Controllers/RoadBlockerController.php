<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Services\MqttOutbound;
use App\Services\InspectionService;

/**
 * Manual road-blocker control panel API. Drives the CORX CX-5104E-L relay via
 * MQTT (MqttOutbound::blockerRelay enqueues a pulse; the Python worker publishes
 * it to the relay's subscribe topic). Open = blocker DOWN (clears lane),
 * Close = UP (blocks lane), Stop = halt. Config lives in anprc_settings.
 */
class RoadBlockerController {
    public function open(Request $r): array  { return $this->act('open', $r); }
    public function close(Request $r): array { return $this->act('close', $r); }
    public function stop(Request $r): array  { return $this->act('stop', $r); }

    private function act(string $action, Request $r): array {
        $res = MqttOutbound::blockerRelay($action);
        InspectionService::logOperation([
            'action'           => "blocker_{$action}_manual",
            'request_payload'  => ['topic' => $res['topic'] ?? null, 'body' => $res['body'] ?? null],
            'response_payload' => ['queued' => $res['queued'] ?? null],
            'status'           => $res['ok'] ? 'success' : 'failed',
            'error_message'    => $res['ok'] ? null : ($res['error'] ?? 'enqueue_failed'),
        ]);
        if (!$res['ok']) {
            return ['code' => 400, 'message' => $res['error'] ?? 'failed', 'data' => null];
        }
        return ['code' => 200, 'message' => 'queued', 'data' => [
            'action' => $action,
            'queued' => $res['queued'],
            'topic'  => $res['topic'],
            'body'   => $res['body'],
        ]];
    }

    public function status(Request $r): array {
        $get = static function (string $key, string $default): string {
            $row = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = ?", [$key]);
            return (string)($row['value'] ?? $default);
        };
        $on = static fn(string $v) => in_array($v, ['1', 'true', 'True'], true);

        $last = Database::fetchOne(
            "SELECT action, status, created_at FROM anprc_operation_log
             WHERE action IN ('open_blocker','blocker_close','blocker_open_manual','blocker_close_manual','blocker_stop_manual')
             ORDER BY id DESC LIMIT 1"
        );

        return ['code' => 200, 'message' => 'success', 'data' => [
            'enabled'   => $on($get('blocker_relay_enabled', '1')),
            'auto_open' => $on($get('blocker_auto_open_enabled', '0')),
            'topic'     => $get('blocker_relay_topic', 'testsubscribe'),
            'value'     => (int)$get('blocker_relay_value', '210001'),
            'res'       => $get('blocker_relay_res', '123'),
            'channels'  => [
                'open'  => $get('blocker_relay_open_ch', 'A01'),
                'close' => $get('blocker_relay_close_ch', 'A02'),
                'stop'  => $get('blocker_relay_stop_ch', 'A03'),
            ],
            'last_action' => $last ?: null,
        ]];
    }

    /**
     * Toggle whether the inspection flow auto-opens the blocker. OFF by default —
     * collision risk (no vehicle sensor). Body: { enabled: bool }.
     */
    public function setAutoOpen(Request $r): array {
        $enabled = (bool)($r->json()['enabled'] ?? false);
        Database::query(
            "INSERT INTO anprc_settings (key_name, value) VALUES ('blocker_auto_open_enabled', :v)
             ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value",
            ['v' => $enabled ? '1' : '0']
        );
        InspectionService::logOperation([
            'action'          => 'blocker_auto_open_toggle',
            'request_payload' => ['enabled' => $enabled],
            'status'          => 'success',
        ]);
        return ['code' => 200, 'message' => 'updated', 'data' => ['auto_open' => $enabled]];
    }
}
