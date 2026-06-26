<?php
namespace App\Services;

use App\Core\Database;

class VisitService {
    /** Find a paired exit channel for a given entry channel. */
    public static function findPairedExit(array $entryChannel): ?array {
        if (!empty($entryChannel['paired_channel_id'])) {
            $row = Database::fetchOne('SELECT * FROM anprc_channels WHERE id = ? AND kind = ?',
                [$entryChannel['paired_channel_id'], 'exit']);
            if ($row) return $row;
        }
        // Fallback: any enabled exit channel (good enough for 1-entry-1-exit setups)
        return Database::fetchOne('SELECT * FROM anprc_channels WHERE kind = ? AND enabled = 1 LIMIT 1', ['exit']);
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

    public static function createEntry(string $licensePlate, string $entryChannelNo, ?int $inspectionId): int {
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
        ]);
    }

    public static function markEntryDenied(int $visitId, string $reason): void {
        Database::update('anprc_visits', [
            'status' => 'denied_entry',
            'notes' => $reason,
        ], 'id = :id', ['id' => $visitId]);
    }
}
