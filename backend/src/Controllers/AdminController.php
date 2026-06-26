<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Services\InspectionService;

/**
 * AdminController — maintenance / testing utilities.
 *
 * resetData() wipes all transactional + MQTT log data so a test run can start
 * from a clean slate. Configuration is preserved (channels, vip_plates,
 * settings, users, audio_prompts).
 *
 * SAFETY: this is destructive. It is only permitted when the backend is in
 * debug mode OR auth.dev_bypass is enabled — i.e. never on a hardened
 * production deploy. Remove the route once testing is finished.
 */
class AdminController {

    /** Transactional / report tables that get wiped. Order is irrelevant — CASCADE handles refs. */
    private const RESET_TABLES = [
        'anprc_mqtt_inbound_log',
        'anprc_mqtt_outbound_queue',
        'anprc_inbound_events_raw',
        'anprc_inspection_uvis_coords',
        'anprc_inspection_uvis',
        'anprc_inspection_video_streams',
        'anprc_inspection_face_images',
        'anprc_inspection_status_logs',
        'anprc_inspections',
        'anprc_visits',
        'anprc_vehicles',
        'anprc_operation_log',
    ];

    public function resetData(Request $req) {
        $cfg = $GLOBALS['APP_CONFIG'];
        $allowed = !empty($cfg['app']['debug'])
            || !empty($cfg['auth']['dev_bypass'])
            || getenv('AUTH_DEV_BYPASS') === '1';
        if (!$allowed) {
            return ['code' => 403, 'message' => 'Data reset is disabled (production mode)', 'data' => null];
        }

        $actor = AuthController::usernameFromRequest($req);

        // Count rows before wiping, for the audit trail + response summary.
        $counts = [];
        foreach (self::RESET_TABLES as $tbl) {
            $row = Database::fetchOne("SELECT COUNT(*) AS c FROM \"$tbl\"");
            $counts[$tbl] = (int) ($row['c'] ?? 0);
        }

        // Single TRUNCATE resets every sequence (IDs restart at 1) atomically.
        $list = implode(', ', array_map(fn($t) => "\"$t\"", self::RESET_TABLES));
        Database::query("TRUNCATE TABLE $list RESTART IDENTITY CASCADE");

        // Log the reset itself — first row in the freshly-cleared operation_log.
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'admin.reset_data',
            'request_payload' => ['cleared' => $counts],
            'status' => 'success',
        ]);

        return [
            'code' => 200,
            'message' => 'Data cleared',
            'data' => [
                'cleared' => $counts,
                'total' => array_sum($counts),
                'preserved' => ['anprc_channels', 'anprc_vip_plates', 'anprc_settings', 'anprc_users', 'anprc_audio_prompts'],
            ],
        ];
    }
}
