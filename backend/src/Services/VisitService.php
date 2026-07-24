<?php
namespace App\Services;

use App\Core\Database;

class VisitService {
    /** All enabled exit channels that have an ANPR camera. Entry/exit lanes are
     *  NOT paired: a vehicle may enter from any lane and exit from any lane, so
     *  whitelist add/remove fans out to every exit camera. */
    public static function findAllExits(): array {
        return Database::fetchAll(
            "SELECT * FROM anprc_channels
             WHERE kind = 'exit' AND enabled = 1
               AND anpr_device_sn IS NOT NULL AND anpr_device_sn <> ''
             ORDER BY channel_no"
        );
    }

    /** Find the active (entered, not exited) visit for this plate, if any. */
    public static function findActiveVisit(string $licensePlate): ?array {
        return Database::fetchOne(
            "SELECT * FROM anprc_visits
             WHERE license_plate = ? AND status = 'active'
             ORDER BY id DESC LIMIT 1",
            [$licensePlate]
        );
    }

    /**
     * Record an entry. If the plate is ALREADY inside (active visit) — x-ray
     * loop re-entry, a missed exit, or a duplicate recognition — the existing
     * record is REUSED and refreshed instead of stacking a second "inside" row,
     * so a plate never shows as inside twice. Re-entry itself is never blocked.
     */
    public static function createEntry(string $licensePlate, string $entryChannelNo, ?int $inspectionId): int {
        $existing = self::findActiveVisit($licensePlate);
        if ($existing) {
            Database::update('anprc_visits', [
                'entry_channel_no' => $entryChannelNo,
                'entry_inspection_id' => $inspectionId ?? $existing['entry_inspection_id'],
                'entry_at' => gmdate('Y-m-d H:i:s'),
                'notes' => trim(sprintf(
                    'Re-entry while active (previous entry %s via %s)',
                    $existing['entry_at'] ?? '?', $existing['entry_channel_no'] ?? '?'
                )),
            ], 'id = :id', ['id' => $existing['id']]);
            return (int)$existing['id'];
        }
        return Database::insert('anprc_visits', [
            'license_plate' => $licensePlate,
            'entry_channel_no' => $entryChannelNo,
            'entry_inspection_id' => $inspectionId,
            'entry_at' => gmdate('Y-m-d H:i:s'),
            'status' => 'active',
        ]);
    }

    public static function closeVisit(int $visitId, string $exitChannelNo): void {
        Database::update('anprc_visits', [
            'status' => 'completed',
            'exit_channel_no' => $exitChannelNo,
            'exit_at' => gmdate('Y-m-d H:i:s'),
        ], 'id = :id', ['id' => $visitId]);
    }

    public static function logOrphanExit(string $licensePlate, string $exitChannelNo): int {
        return Database::insert('anprc_visits', [
            'license_plate' => $licensePlate,
            'exit_channel_no' => $exitChannelNo,
            'exit_at' => gmdate('Y-m-d H:i:s'),
            'status' => 'orphan_exit',
            'notes' => 'Exit plate detected without an active entry record',
            // Not an automatic pass: the CP pops a confirmation and an operator
            // must allow (opens the exit barrier) or deny.
            'orphan_review' => 'pending',
        ]);
    }

    /** Record a straight entry denial (e.g. blacklist) — no inspection is created,
     *  so this inserts the denied_entry visit directly for Visits/Reports. */
    public static function logDeniedEntry(string $licensePlate, string $entryChannelNo, string $reason): int {
        return Database::insert('anprc_visits', [
            'license_plate' => $licensePlate,
            'entry_channel_no' => $entryChannelNo,
            'entry_at' => gmdate('Y-m-d H:i:s'),
            'status' => 'denied_entry',
            'notes' => $reason,
        ]);
    }

    public static function markEntryDenied(int $visitId, string $reason): void {
        Database::update('anprc_visits', [
            'status' => 'denied_entry',
            'notes' => $reason,
        ], 'id = :id', ['id' => $visitId]);
    }
}
