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
        return Database::insert('mqtt_outbound_queue', [
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
        // Schema per MQTT protocol §7.8: operator_type=update_or_add, dldb_rec is a
        // single object (not an array), create_time required, need_alarm=0 means whitelist.
        $now = date('Y-m-d H:i:s');
        return self::enqueue($exitCameraSn, 'white_list_operator', [
            'operator_type' => 'update_or_add',
            'dldb_rec' => [
                'plate' => $licensePlate,
                'enable' => 1,
                'create_time' => $now,
                'enable_time' => $now,
                'overdue_time' => date('Y-m-d H:i:s', time() + 86400 * 30),
                'need_alarm' => 0,                       // 0 = whitelist, 1 = blacklist
                'time_seg_enable' => 0,
                'seg_time_start' => '00:00:00',
                'seg_time_end' => '00:00:00',
                'vehicle_comment' => mb_substr((string)($context ?? ''), 0, 16), // ≤16 chars per spec
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
