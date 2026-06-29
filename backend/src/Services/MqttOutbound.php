<?php
namespace App\Services;

use App\Core\Database;

/**
 * Enqueues MQTT commands for the worker to publish.
 * The backend never speaks MQTT directly — it writes to mqtt_outbound_queue
 * and the Python worker drains the queue.
 */
class MqttOutbound {
    public static function enqueue(string $deviceSn, string $commandName, array $payload): int {
        return Database::insert('anprc_mqtt_outbound_queue', [
            'device_sn' => $deviceSn,
            'command_name' => $commandName,
            'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE),
            'status' => 'pending',
        ]);
    }

    /**
     * Drive the CORX CX-5104E-L road-blocker relay. Unlike camera commands (which
     * the worker wraps in the device envelope and publishes to device/{sn}/...
     * topics), the relay expects a RAW JSON body on its own subscribe topic. We
     * enqueue command_name 'corx_relay' with {topic, body}; the worker recognises
     * it and publishes `body` verbatim.
     *
     *   $action: 'open' (DOWN/clear lane) | 'close' (UP/block lane) | 'stop'
     *
     * @return array{ok:bool, queued?:int, topic?:string, body?:array, error?:string}
     */
    public static function blockerRelay(string $action): array {
        $get = static function (string $key, string $default): string {
            $row = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = ?", [$key]);
            return (string)($row['value'] ?? $default);
        };
        $on = static fn(string $v) => in_array($v, ['1', 'true', 'True'], true);

        if (!$on($get('blocker_relay_enabled', '1'))) {
            return ['ok' => false, 'error' => 'blocker relay disabled'];
        }
        $chKey = [
            'open'  => ['blocker_relay_open_ch',  'A01'],
            'close' => ['blocker_relay_close_ch', 'A02'],
            'stop'  => ['blocker_relay_stop_ch',  'A03'],
        ];
        if (!isset($chKey[$action])) {
            return ['ok' => false, 'error' => "unknown blocker action: $action"];
        }
        $topic = $get('blocker_relay_topic', 'testsubscribe');
        $value = (int)$get('blocker_relay_value', '210001');
        $res   = substr($get('blocker_relay_res', '123'), 0, 15);
        $chan  = $get($chKey[$action][0], $chKey[$action][1]);

        $body = [$chan => $value, 'res' => $res];
        $queued = self::enqueueRaw($topic, $body, "blocker_$action");
        return ['ok' => true, 'queued' => $queued, 'topic' => $topic, 'body' => $body];
    }

    /**
     * Enqueue a raw MQTT publish (no camera envelope). command_name 'corx_relay'
     * tells the worker to publish `body` verbatim to `topic`.
     */
    public static function enqueueRaw(string $topic, array $body, string $label): int {
        return Database::insert('anprc_mqtt_outbound_queue', [
            'device_sn'    => 'corx-relay',
            'command_name' => 'corx_relay',
            'payload'      => json_encode(['topic' => $topic, 'body' => $body, 'label' => $label], JSON_UNESCAPED_UNICODE),
            'status'       => 'pending',
        ]);
    }

    /**
     * Resolve the serial-frame encoder for the camera's display+voice control
     * card. The vendor keys this off the per-device display_motherboard_type
     * (1 = 科发/KF, 2 = 方控/FK). Our cameras are FK, so FK is the default;
     * the `control_card_type` setting overrides it for KF hardware.
     *
     * @return class-string
     */
    private static function card(): string {
        $row = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = ?", ['control_card_type']);
        return ((string)($row['value'] ?? '2')) === '1' ? KfControlCard::class : FangkControlCard::class;
    }

    /**
     * Add a plate to a device's local whitelist via MQTT `white_list_operator`.
     * Used to authorise an exit plate after a successful entry.
     */
    public static function whitelistAdd(string $exitCameraSn, string $licensePlate, ?string $context = null): int {
        // Mirror the vendor CP's WhiteSaveHandler exactly: dldb_rec carries ONLY
        // these five fields (operator_type=update_or_add, need_alarm=0 = whitelist).
        // $context is accepted for caller compatibility but intentionally not sent —
        // the vendor omits vehicle_comment / create_time / seg_time on this path.
        $now = date('Y-m-d H:i:s');
        return self::enqueue($exitCameraSn, 'white_list_operator', [
            'operator_type' => 'update_or_add',
            'dldb_rec' => [
                'plate' => $licensePlate,
                'enable' => 1,
                'enable_time' => $now,
                'overdue_time' => date('Y-m-d H:i:s', time() + 86400 * 30),
                'need_alarm' => 0,                       // 0 = whitelist, 1 = blacklist
            ],
        ]);
    }

    /**
     * Remove a plate from a device's whitelist (one-time-pass cleanup after exit).
     */
    public static function whitelistDelete(string $exitCameraSn, string $licensePlate): int {
        return self::enqueue($exitCameraSn, 'white_list_operator', [
            'operator_type' => 'delete',
            'plate' => $licensePlate,
        ]);
    }

    /**
     * Greet a recognized driver by voice on the camera's KF control card, via
     * MQTT `serial_data` (serial frame CMD 0x30). Replicates the vendor CP's
     * on-recognition "Welcome" voiceover.
     */
    public static function playVoice(string $cameraSn, string $text): int {
        $card = self::card();
        $frame = $card::voiceFrame($text);
        return self::enqueue($cameraSn, 'serial_data', $card::serialDataBody([$frame]));
    }

    /**
     * Show text (e.g. the plate number) on the camera's LED display via MQTT
     * `serial_data` (serial frame CMD 0x62). Comma-separated text becomes
     * multiple alternating-colour lines, matching the vendor CP. Returns 0 if
     * there is nothing to show.
     */
    public static function ledText(string $cameraSn, string $text): int {
        $lines = array_values(array_filter(
            array_map('trim', explode(',', $text)),
            static fn($s) => $s !== ''
        ));
        if (!$lines) return 0;
        $card = self::card();
        $frames = [];
        foreach ($lines as $i => $line) {
            $frames[] = $card::tempTextFrame($line, $i);
        }
        return self::enqueue($cameraSn, 'serial_data', $card::serialDataBody($frames));
    }

    /**
     * Switch the camera's lane signal light green for `seconds` via MQTT
     * `serial_data` (serial frame CMD 0x0F, SET_RELAY_STATUS). The vendor CP
     * sends this on every gate-open, alongside the gpio_out pulse.
     */
    public static function greenLight(string $cameraSn, int $ch = 1, int $seconds = 10): int {
        $card = self::card();
        $frame = $card::relayFrame($ch, $seconds);
        return self::enqueue($cameraSn, 'serial_data', $card::serialDataBody([$frame]));
    }

    /**
     * Pulse a camera's GPIO output relay via MQTT `gpio_out` (protocol §7.2) —
     * used to open the camera's own barrier gate.
     *   io    : output index [0,3] (which relay the barrier is wired to)
     *   value : 0=OFF, 1=ON, 2=Pulse (ON then OFF)
     *   delay : pulse duration ms, clamped to [500,5000]
     */
    public static function gateOpen(string $cameraSn, int $io = 0, int $value = 2, int $delayMs = 1000): int {
        return self::enqueue($cameraSn, 'gpio_out', [
            'delay' => max(500, min(5000, $delayMs)),
            'io'    => max(0, min(3, $io)),
            'value' => $value,
        ]);
    }
}
