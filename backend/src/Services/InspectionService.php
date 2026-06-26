<?php
namespace App\Services;

use App\Core\Database;

class InspectionService {
    public static function findChannel(string $channelNo): ?array {
        return Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
    }

    public static function getOrCreateActiveInspection(string $channelNo, string $licensePlate): array {
        $existing = Database::fetchOne(
            "SELECT * FROM anprc_inspections
             WHERE channel_no = ? AND state IN ('pending','started','inspecting','resetting')
             ORDER BY id DESC LIMIT 1",
            [$channelNo]
        );
        if ($existing) return $existing;

        $vehicle = Database::fetchOne(
            'SELECT * FROM anprc_vehicles WHERE license_plate = ? ORDER BY id DESC LIMIT 1',
            [$licensePlate]
        );

        $id = Database::insert('anprc_inspections', [
            'channel_no' => $channelNo,
            'vehicle_id' => $vehicle['id'] ?? null,
            'license_plate' => $licensePlate,
            'state' => 'pending',
        ]);
        return Database::fetchOne('SELECT * FROM anprc_inspections WHERE id = ?', [$id]);
    }

    public static function findActiveInspection(string $channelNo): ?array {
        return Database::fetchOne(
            "SELECT * FROM anprc_inspections
             WHERE channel_no = ? AND state IN ('pending','started','inspecting','resetting')
             ORDER BY id DESC LIMIT 1",
            [$channelNo]
        );
    }

    public static function isVip(string $licensePlate): bool {
        $row = Database::fetchOne(
            'SELECT id FROM anprc_vip_plates WHERE license_plate = ? AND enabled = 1 LIMIT 1',
            [trim($licensePlate)]
        );
        return $row !== null;
    }

    public static function isBlacklisted(string $licensePlate): bool {
        $row = Database::fetchOne(
            'SELECT id FROM anprc_blacklist_plates WHERE license_plate = ? AND enabled = 1 LIMIT 1',
            [trim($licensePlate)]
        );
        return $row !== null;
    }

    /**
     * Returns busy status for a channel.
     *   busy=true means a previous vehicle is still being processed; new /come MUST be rejected.
     *   busy=false means channel is free (operatingState 0 / Ready, or no active inspection).
     */
    public static function getChannelStatus(string $channelNo): array {
        $active = self::findActiveInspection($channelNo);
        if (!$active) {
            return ['busy' => false, 'reason' => 'no_active_inspection', 'active' => null];
        }
        $op = $active['current_operating_state'];
        // operatingState 0 = Ready -> not busy
        if ($op === null || (int)$op === 0) {
            return ['busy' => false, 'reason' => 'ready', 'active' => $active];
        }
        return [
            'busy' => true,
            'reason' => 'in_progress',
            'operating_state' => (int)$op,
            'active' => $active,
        ];
    }

    public static function mapOperatingStateToInspectionState(int $opState): string {
        switch ($opState) {
            case 0: return 'started';
            case 1: return 'inspecting';
            case 2: return 'resetting';
            case 3: return 'completed';
            case 4: return 'emergency_stop';
            case 5: return 'failed';
            case 6: return 'started';
            default: return 'pending';
        }
    }

    public static function logOperation(array $log): int {
        return Database::insert('anprc_operation_log', [
            'actor_username' => $log['actor_username'] ?? null,
            'channel_no' => $log['channel_no'] ?? null,
            'inspection_id' => $log['inspection_id'] ?? null,
            'action' => $log['action'],
            'request_payload' => isset($log['request_payload']) ? json_encode($log['request_payload']) : null,
            'response_payload' => isset($log['response_payload']) ? json_encode($log['response_payload']) : null,
            'status' => $log['status'],
            'error_message' => $log['error_message'] ?? null,
        ]);
    }

    public static function pushEvent(string $type, array $payload): void {
        $cfg = $GLOBALS['APP_CONFIG']['logs']['path'];
        if (!is_dir($cfg)) @mkdir($cfg, 0777, true);
        $line = json_encode([
            'ts' => microtime(true),
            'type' => $type,
            'payload' => $payload,
        ]) . "\n";
        @file_put_contents($cfg . '/events.stream', $line, FILE_APPEND);
    }
}
