<?php
namespace App\Services;

use App\Core\Database;

/**
 * Evaluates an inspection and returns a decision verdict.
 *
 * Rules:
 *   VIP plate                          → vip_pass
 *   UVIS imageType=1 (object detected) → suspect
 *   UVIS imageType=0 (clean)           → pass
 *   S300 operatingState=5 (failure)    → fail (equipment_failure)
 *   ANPR is_fake_plate=1               → fail (fake_plate)
 *   UVIS not received within timeout   → fail (uvis_timeout)
 *
 * Returns ['decision' => string, 'reason' => string] or null if undecidable yet.
 */
class DecisionEngine {

    public static function evaluate(array $inspection): ?array {
        if ($inspection['decision'] !== 'pending') {
            return ['decision' => $inspection['decision'], 'reason' => $inspection['decision_reason']];
        }

        if ($inspection['state'] === 'vip_skipped') {
            return ['decision' => 'vip_pass', 'reason' => 'VIP plate on allowlist'];
        }

        // Hard equipment failure?
        $failureLog = Database::fetchOne(
            'SELECT id FROM inspection_status_logs WHERE inspection_id = ? AND operating_state = 5 LIMIT 1',
            [$inspection['id']]
        );
        if ($failureLog) {
            return ['decision' => 'fail', 'reason' => 'S300 equipment failure (operatingState=5)'];
        }

        // Fake plate?
        if ($inspection['vehicle_id']) {
            $v = Database::fetchOne('SELECT is_fake_plate FROM vehicles WHERE id = ?', [$inspection['vehicle_id']]);
            if ($v && (int)$v['is_fake_plate'] === 1) {
                return ['decision' => 'fail', 'reason' => 'Fake plate detected by ANPR'];
            }
        } else {
            $v = Database::fetchOne(
                'SELECT is_fake_plate FROM vehicles WHERE license_plate = ? ORDER BY id DESC LIMIT 1',
                [$inspection['license_plate']]
            );
            if ($v && (int)$v['is_fake_plate'] === 1) {
                return ['decision' => 'fail', 'reason' => 'Fake plate detected by ANPR'];
            }
        }

        // UVIS result available?
        $uvis = Database::fetchOne(
            'SELECT image_type, object_count FROM inspection_uvis WHERE inspection_id = ? ORDER BY id DESC LIMIT 1',
            [$inspection['id']]
        );
        if ($uvis) {
            if ((int)$uvis['image_type'] === 1) {
                return ['decision' => 'suspect', 'reason' => 'Undercarriage foreign object detected (' . (int)$uvis['object_count'] . ')'];
            }
            return ['decision' => 'pass', 'reason' => 'Undercarriage clean'];
        }

        // Timed out? decision_timeout_at is stored UTC; append a UTC marker so
        // strtotime doesn't interpret it as the PHP default (Asia/Jakarta).
        if ($inspection['decision_timeout_at']
            && strtotime($inspection['decision_timeout_at'] . ' UTC') <= time()) {
            return ['decision' => 'fail', 'reason' => 'UVIS scan not received within timeout'];
        }

        return null; // not decidable yet
    }
}
