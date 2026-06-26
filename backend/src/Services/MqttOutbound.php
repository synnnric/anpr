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
        $frame = KfControlCard::voiceFrame($text);
        return self::enqueue($cameraSn, 'serial_data', KfControlCard::serialDataBody([$frame]));
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
        $frames = [];
        foreach ($lines as $i => $line) {
            $frames[] = KfControlCard::tempTextFrame($line, $i);
        }
        return self::enqueue($cameraSn, 'serial_data', KfControlCard::serialDataBody($frames));
    }

    /**
     * Switch the camera's lane signal light green for `seconds` via MQTT
     * `serial_data` (serial frame CMD 0x0F, SET_RELAY_STATUS). The vendor CP
     * sends this on every gate-open, alongside the gpio_out pulse.
     */
    public static function greenLight(string $cameraSn, int $ch = 1, int $seconds = 10): int {
        $frame = KfControlCard::relayFrame($ch, $seconds);
        return self::enqueue($cameraSn, 'serial_data', KfControlCard::serialDataBody([$frame]));
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
