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
    // Global single-lane control (legacy): POST /api/road-blocker/{open,close,stop}
    public function open(Request $r): array  { return $this->act('open', $r); }
    public function close(Request $r): array { return $this->act('close', $r); }
    public function stop(Request $r): array  { return $this->act('stop', $r); }

    // Per-lane control: POST /api/road-blocker/lane/{channelNo}/{action}
    public function laneAction(Request $r): array {
        $action = (string)$r->param('action');
        if (!in_array($action, ['open', 'close', 'stop'], true)) {
            return ['code' => 400, 'message' => "unknown action: $action", 'data' => null];
        }
        return $this->act($action, $r, (string)$r->param('channelNo'));
    }

    // Bulk (all blocker-enabled lanes): POST /api/road-blocker/bulk/{action}
    public function bulk(Request $r): array {
        $action = (string)$r->param('action');
        if (!in_array($action, ['open', 'close', 'stop'], true)) {
            return ['code' => 400, 'message' => "unknown action: $action", 'data' => null];
        }
        $res = MqttOutbound::blockerRelayBulk($action);
        if ($action === 'close' && $res['ok']) {
            foreach ($res['results'] as $laneRes) {
                if (!empty($laneRes['ok'])) {
                    self::completeCycleOnRaise($laneRes['channel_no'] ?? null);
                }
            }
        }
        InspectionService::logOperation([
            'action'           => "blocker_{$action}_bulk",
            'request_payload'  => ['action' => $action],
            'response_payload' => ['sent' => $res['sent'], 'total' => $res['total']],
            'status'           => $res['ok'] ? 'success' : 'failed',
            'error_message'    => $res['ok'] ? null : 'no lane accepted the command',
        ]);
        return [
            'code'    => $res['ok'] ? 200 : 400,
            'message' => $res['ok'] ? "queued {$res['sent']}/{$res['total']} lanes" : 'no lane accepted the command',
            'data'    => $res,
        ];
    }

    /**
     * A successful manual RAISE ('close') also completes the lane's blocker
     * cycle: the operator raising the column IS the "barrier is up" signal
     * while no vehicle sensor is wired, so the auto-open come-gate releases
     * without needing a separate sensor click.
     */
    private static function completeCycleOnRaise(?string $channelNo): void {
        if ($channelNo !== null) {
            Database::query(
                "UPDATE anprc_channels SET blocker_cycle = 'idle'
                 WHERE channel_no = ? AND blocker_cycle IN ('lowered','passed','raised')",
                [$channelNo]
            );
        } else {
            // Global (legacy single-relay) raise: every lane sharing it is now up.
            Database::query(
                "UPDATE anprc_channels SET blocker_cycle = 'idle'
                 WHERE blocker_cycle IN ('lowered','passed','raised')"
            );
        }
    }

    private function act(string $action, Request $r, ?string $channelNo = null): array {
        $res = MqttOutbound::blockerRelay($action, $channelNo);
        if ($action === 'close' && $res['ok']) {
            self::completeCycleOnRaise($channelNo);
        }
        InspectionService::logOperation([
            'channel_no'       => $channelNo,
            'action'           => "blocker_{$action}_manual",
            'request_payload'  => ['channel_no' => $channelNo, 'topic' => $res['topic'] ?? null, 'body' => $res['body'] ?? null],
            'response_payload' => ['queued' => $res['queued'] ?? null],
            'status'           => $res['ok'] ? 'success' : 'failed',
            'error_message'    => $res['ok'] ? null : ($res['error'] ?? 'enqueue_failed'),
        ]);
        if (!$res['ok']) {
            // 409 when the sensor suppressed it (vehicle passing) — a retryable state,
            // distinct from a 400 misconfiguration.
            $code = !empty($res['suppressed']) ? 409 : 400;
            return ['code' => $code, 'message' => $res['error'] ?? 'failed', 'data' => ['suppressed' => $res['suppressed'] ?? false]];
        }
        return ['code' => 200, 'message' => 'queued', 'data' => [
            'action'     => $action,
            'channel_no' => $channelNo,
            'queued'     => $res['queued'],
            'topic'      => $res['topic'],
            'body'       => $res['body'],
        ]];
    }

    /**
     * Future vehicle-sensor hook (scaffold): POST /api/road-blocker/lane/{channelNo}/sensor
     * Body { state: 'passing' | 'clear' | 'raised' }.
     *   passing -> suppress relay commands (vehicle under the blocker)
     *   clear   -> re-enable commands; a 'lowered' cycle advances to 'passed'
     *   raised  -> blocker back up; cycle -> 'idle' (releases the auto-open come-gate)
     */
    public function sensor(Request $r): array {
        $channelNo = (string)$r->param('channelNo');
        $state = (string)($r->json()['state'] ?? '');
        if (!in_array($state, ['passing', 'clear', 'raised'], true)) {
            return ['code' => 400, 'message' => 'state must be one of: passing, clear, raised', 'data' => null];
        }
        $ch = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
        if (!$ch) {
            return ['code' => 404, 'message' => "channel not found: $channelNo", 'data' => null];
        }
        $sensor = (string)($ch['blocker_sensor'] ?? 'clear');
        $cycle  = (string)($ch['blocker_cycle'] ?? 'idle');
        if ($state === 'passing') {
            $sensor = 'passing';
        } elseif ($state === 'clear') {
            $sensor = 'clear';
            if ($cycle === 'lowered') { $cycle = 'passed'; }
        } else { // raised
            $cycle = 'idle';
        }
        Database::update('anprc_channels', ['blocker_sensor' => $sensor, 'blocker_cycle' => $cycle], 'channel_no = :c', ['c' => $channelNo]);
        InspectionService::logOperation([
            'channel_no'       => $channelNo,
            'action'           => 'blocker_sensor',
            'request_payload'  => ['state' => $state],
            'response_payload' => ['sensor' => $sensor, 'cycle' => $cycle],
            'status'           => 'success',
        ]);
        return ['code' => 200, 'message' => 'ok', 'data' => ['channel_no' => $channelNo, 'sensor' => $sensor, 'cycle' => $cycle]];
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
            // Per-lane blockers (multi-lane). Empty => only the global one is used.
            'lanes' => array_map(static function (array $c): array {
                return [
                    'channel_no' => $c['channel_no'],
                    'name'       => $c['name'] ?? null,
                    'enabled'    => (int)($c['blocker_relay_enabled'] ?? 0) === 1,
                    'auto_open'  => (int)($c['blocker_auto_open'] ?? 0) === 1,
                    'topic'      => $c['blocker_relay_topic'] ?? null,
                    'pub_topic'  => $c['blocker_relay_pub_topic'] ?? null,
                    'res'        => $c['blocker_relay_res'] ?? null,
                    'open_ch'    => $c['blocker_relay_open_ch'] ?? null,
                    'close_ch'   => $c['blocker_relay_close_ch'] ?? null,
                    'stop_ch'    => $c['blocker_relay_stop_ch'] ?? null,
                    'sensor'     => $c['blocker_sensor'] ?? 'clear',
                    'cycle'      => $c['blocker_cycle'] ?? 'idle',
                    'position'   => $c['blocker_position'] ?? 'unknown',  // down | up | unknown (ACK-confirmed)
                ];
            }, Database::fetchAll(
                "SELECT * FROM anprc_channels WHERE blocker_relay_enabled = 1 ORDER BY channel_no"
            )),
            'last_action' => $last ?: null,
        ]];
    }

    /**
     * Worker-reported relay heartbeat: the relay published a status on its topic.
     * Stamps blocker_last_seen so the dashboard can show real online/offline.
     * Body { pub_topic, res? }.
     */
    public function heartbeat(Request $r): array {
        $pub = $r->json()['pub_topic'] ?? null;
        if (!$pub) {
            return ['code' => 400, 'message' => 'pub_topic required', 'data' => null];
        }
        // Per-lane blockers keyed by their own publish topic.
        Database::query(
            "UPDATE anprc_channels SET blocker_last_seen = NOW()
             WHERE blocker_relay_enabled = 1 AND blocker_relay_pub_topic = ?", [$pub]
        );
        // Single-lane / global blocker: entry lanes that rely on the global relay
        // (no per-lane config) share the one device on the global publish topic.
        $g = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = 'blocker_relay_pub_topic'");
        $globalPub = (string)($g['value'] ?? 'testpublish');
        if ($pub === $globalPub) {
            Database::query(
                "UPDATE anprc_channels SET blocker_last_seen = NOW()
                 WHERE blocker_relay_enabled = 0 AND kind = 'entry'"
            );
        }
        return ['code' => 200, 'message' => 'ok', 'data' => null];
    }

    /**
     * Worker-reported relay ACK: the device echoed our command on its publish
     * topic (or didn't, within the timeout). Recorded so a dead relay is visible.
     * Body { queue_id, res, ok, latency_ms, expect_ch?, ch_state? }.
     */
    public function ack(Request $r): array {
        $b = $r->json();
        $ok = (bool)($b['ok'] ?? false);
        $res = isset($b['res']) ? (string)$b['res'] : null;
        $expectCh = isset($b['expect_ch']) ? (string)$b['expect_ch'] : null;

        // A confirmed ACK is the position readout: the pulsed channel tells us the
        // direction, and (mid-travel out of scope) the column reaches & holds it.
        // Match the ACK to its lane by the echoed `res`, then compare the pulsed
        // channel to that lane's open_ch (lower→down) / close_ch (raise→up).
        $position = null;
        $lane = null;
        if ($ok && $res !== null && $expectCh !== null) {
            $lane = Database::fetchOne(
                "SELECT * FROM anprc_channels WHERE blocker_relay_enabled = 1 AND blocker_relay_res = ? LIMIT 1",
                [$res]
            );
            $openCh  = $lane['blocker_relay_open_ch']  ?? null;
            $closeCh = $lane['blocker_relay_close_ch'] ?? null;
            if ($lane === null || $openCh === null || $closeCh === null) {
                // Global/legacy relay: fall back to the global channel config.
                $g = static function (string $k, string $d): string {
                    $row = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = ?", [$k]);
                    return (string)($row['value'] ?? $d);
                };
                $openCh  = $openCh  ?? $g('blocker_relay_open_ch', 'A01');
                $closeCh = $closeCh ?? $g('blocker_relay_close_ch', 'A02');
            }
            if ($expectCh === $openCh)  $position = 'down';
            elseif ($expectCh === $closeCh) $position = 'up';

            if ($position !== null) {
                if ($lane) {
                    $fields = ['blocker_position' => $position];
                    // A confirmed RAISE means the barrier is physically up → release
                    // the auto-open come-gate for this lane (same as pressing Raise).
                    if ($position === 'up') { $fields['blocker_cycle'] = 'idle'; }
                    Database::update('anprc_channels', $fields, 'channel_no = :c', ['c' => $lane['channel_no']]);
                } else {
                    // Global relay: every lane on the shared device moved together.
                    if ($position === 'up') {
                        Database::query("UPDATE anprc_channels SET blocker_position = 'up', blocker_cycle = 'idle' WHERE kind = 'entry'");
                    } else {
                        Database::query("UPDATE anprc_channels SET blocker_position = 'down' WHERE kind = 'entry'");
                    }
                }
            }
        }

        InspectionService::logOperation([
            'channel_no'       => $lane['channel_no'] ?? null,
            'action'           => 'blocker_ack',
            'request_payload'  => $b,
            'response_payload' => ['ok' => $ok, 'latency_ms' => $b['latency_ms'] ?? null, 'position' => $position, 'res' => $res],
            'status'           => $ok ? 'success' : 'failed',
            'error_message'    => $ok ? null : 'no device ACK (relay offline?)',
        ]);
        return ['code' => 200, 'message' => 'recorded', 'data' => ['ok' => $ok, 'position' => $position]];
    }

    /**
     * Per-lane auto-open toggle: POST /api/road-blocker/lane/{channelNo}/auto-open
     * Body { enabled: bool }. Independent of the global toggle.
     */
    public function setLaneAutoOpen(Request $r): array {
        $channelNo = (string)$r->param('channelNo');
        $enabled = (bool)($r->json()['enabled'] ?? false);
        $ch = Database::fetchOne('SELECT id FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
        if (!$ch) {
            return ['code' => 404, 'message' => "channel not found: $channelNo", 'data' => null];
        }
        Database::update('anprc_channels', ['blocker_auto_open' => $enabled ? 1 : 0], 'channel_no = :c', ['c' => $channelNo]);
        InspectionService::logOperation([
            'channel_no'      => $channelNo,
            'action'          => 'blocker_auto_open_toggle',
            'request_payload' => ['enabled' => $enabled],
            'status'          => 'success',
        ]);
        return ['code' => 200, 'message' => 'updated', 'data' => ['channel_no' => $channelNo, 'auto_open' => $enabled]];
    }

    /**
     * Toggle whether the inspection flow auto-opens the GLOBAL blocker. OFF by
     * default — collision risk (no vehicle sensor). Body: { enabled: bool }.
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
