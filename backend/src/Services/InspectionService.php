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

    /**
     * Resolve the inspection an inbound ARTIFACT (face image, video, realtime
     * stream) belongs to. The real S300 keeps pushing these for ~90s after the
     * verdict — by then our inspection may already be 'completed', so a plain
     * active-only lookup misses them. Fall back to the most recent inspection on
     * the lane within a grace window so late artifacts still attach.
     */
    public static function findInspectionForArtifact(string $channelNo, int $graceMinutes = 5): ?array {
        $active = self::findActiveInspection($channelNo);
        if ($active) return $active;
        return Database::fetchOne(
            "SELECT * FROM anprc_inspections
             WHERE channel_no = ? AND created_at > NOW() - (? * INTERVAL '1 minute')
             ORDER BY id DESC LIMIT 1",
            [$channelNo, $graceMinutes]
        );
    }

    /** Plate on the VIP list for this lane? A row scoped to a channel (channel_no)
     *  only matches that lane; channel_no NULL applies to every lane. Without a
     *  $channelNo the check is scope-blind (any row matches). */
    public static function isVip(string $licensePlate, ?string $channelNo = null): bool {
        if ($channelNo !== null) {
            $row = Database::fetchOne(
                'SELECT id FROM anprc_vip_plates
                 WHERE license_plate = ? AND enabled = 1
                   AND (expires_at IS NULL OR expires_at > NOW())
                   AND (channel_no IS NULL OR channel_no = ?) LIMIT 1',
                [trim($licensePlate), $channelNo]
            );
        } else {
            $row = Database::fetchOne(
                'SELECT id FROM anprc_vip_plates WHERE license_plate = ? AND enabled = 1
                   AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1',
                [trim($licensePlate)]
            );
        }
        return $row !== null;
    }

    /** Plate blacklisted for this lane? Same scoping rules as isVip(). */
    public static function isBlacklisted(string $licensePlate, ?string $channelNo = null): bool {
        if ($channelNo !== null) {
            $row = Database::fetchOne(
                'SELECT id FROM anprc_blacklist_plates
                 WHERE license_plate = ? AND enabled = 1
                   AND (expires_at IS NULL OR expires_at > NOW())
                   AND (channel_no IS NULL OR channel_no = ?) LIMIT 1',
                [trim($licensePlate), $channelNo]
            );
        } else {
            $row = Database::fetchOne(
                'SELECT id FROM anprc_blacklist_plates WHERE license_plate = ? AND enabled = 1
                   AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1',
                [trim($licensePlate)]
            );
        }
        return $row !== null;
    }

    /**
     * Returns busy status for a channel.
     *   busy=true means a previous vehicle is still being processed; new /come MUST be rejected.
     *   busy=false means channel is free (operatingState 0 / Ready, or no active inspection).
     */
    public static function getChannelStatus(string $channelNo): array {
        $active = self::findActiveInspection($channelNo);
        // Base gate (S300 lifecycle) — identical in both modes: busy while an
        // inspection is running and the device is not back to Ready (op 0).
        $baseBusy = false;
        $reason = 'no_active_inspection';
        $op = null;
        if ($active) {
            $op = $active['current_operating_state'];
            if ($op !== null && (int)$op !== 0) {
                $baseBusy = true;
                $reason = 'in_progress';
            } else {
                $reason = 'ready';
            }
        }
        // Auto-open mode adds a blocker-cycle gate: once the inspection flow lowers
        // the blocker on PASS (cycle 'lowered'), the lane stays busy until the
        // barrier is back up (cycle 'idle') — so the next vehicle is admitted only
        // after lowered -> vehicle passed -> raised. The cycle is advanced by the
        // vehicle sensor (RoadBlockerController::sensor). When auto-open is OFF the
        // lane frees as soon as the inspection passes (cycle is ignored).
        if (!$baseBusy && self::autoOpenEnabled($channelNo)) {
            $ch = Database::fetchOne("SELECT blocker_cycle FROM anprc_channels WHERE channel_no = ?", [$channelNo]);
            $cycle = (string)($ch['blocker_cycle'] ?? 'idle');
            if (in_array($cycle, ['lowered', 'passed'], true)) {
                return ['busy' => true, 'reason' => 'blocker_cycle', 'blocker_cycle' => $cycle, 'active' => $active];
            }
        }
        return [
            'busy' => $baseBusy,
            'reason' => $reason,
            'operating_state' => $op !== null ? (int)$op : null,
            'active' => $active,
        ];
    }

    /**
     * Does the inspection flow auto-open the blocker on PASS for this lane?
     * Per-channel `blocker_auto_open` is the source of truth for a real channel;
     * the global `blocker_auto_open_enabled` setting is the fallback (no channel).
     */
    public static function autoOpenEnabled(?string $channelNo = null): bool {
        if ($channelNo !== null) {
            $ch = Database::fetchOne("SELECT blocker_auto_open FROM anprc_channels WHERE channel_no = ?", [$channelNo]);
            if ($ch) {
                return (int)($ch['blocker_auto_open'] ?? 0) === 1;
            }
        }
        $row = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = 'blocker_auto_open_enabled'");
        return in_array((string)($row['value'] ?? '0'), ['1', 'true', 'True'], true);
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
