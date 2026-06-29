<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Services\DecisionEngine;
use App\Services\DecisionExecutor;

class CronController {
    /**
     * POST /api/cron/tick — sweep for timed-out inspections and force a decision.
     * The frontend AutoTrigger calls this every 5 seconds while open.
     */
    public function tick(Request $req): array {
        $now = gmdate('Y-m-d H:i:s');   // UTC — used for every timeout comparison below

        // Worker heartbeat — the worker calls /api/cron/tick every 5s, so this
        // setting is the freshest signal we have that the worker is alive. Store it
        // as an offset-aware ISO 8601 string in GMT+7 (date_default_timezone is
        // Asia/Jakarta) so anyone reading /api/settings or the dashboard sees an
        // unambiguous local time — unlike the naive-UTC strings the rest of the DB
        // holds. (This value is only ever displayed, never compared in SQL.)
        Database::query(
            "INSERT INTO anprc_settings (key_name, value, updated_at) VALUES ('worker_last_seen_at', :v, NOW())
             ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            ['v' => date('c')]
        );

        // 1) Force a decision on inspections that have exceeded their UVIS timeout
        $timedOut = Database::fetchAll(
            "SELECT * FROM anprc_inspections
             WHERE decision = 'pending'
               AND decision_timeout_at IS NOT NULL
               AND decision_timeout_at <= ?
               AND state IN ('pending','started','inspecting')",
            [$now]
        );

        $resolved = [];
        foreach ($timedOut as $insp) {
            $verdict = DecisionEngine::evaluate($insp);
            if (!$verdict) continue;
            $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$insp['channel_no']]);
            if (!$channel) continue;
            DecisionExecutor::apply($insp, $verdict, $channel);
            $resolved[] = [
                'inspectionId' => (int)$insp['id'],
                'plate' => $insp['license_plate'],
                'decision' => $verdict['decision'],
                'reason' => $verdict['reason'],
            ];
        }

        // 2) Watchdog: force-complete inspections stuck in 'resetting' for too long
        //    (the S300 may have crashed or the reset-complete callback got lost).
        $stuckResetCutoff = gmdate('Y-m-d H:i:s', time() - 30);
        $stuck = Database::fetchAll(
            "SELECT * FROM anprc_inspections
             WHERE state = 'resetting'
               AND leave_called_at IS NOT NULL
               AND leave_called_at <= ?
               AND reset_completed_at IS NULL",
            [$stuckResetCutoff]
        );
        $forcedComplete = [];
        foreach ($stuck as $insp) {
            Database::update('anprc_inspections', [
                'state' => 'completed',
                'reset_completed_at' => $now,
            ], 'id = :id', ['id' => $insp['id']]);
            \App\Services\InspectionService::logOperation([
                'channel_no' => $insp['channel_no'],
                'inspection_id' => $insp['id'],
                'action' => 'reset_watchdog',
                'request_payload' => ['leave_at' => $insp['leave_called_at']],
                'response_payload' => ['forced_complete_at' => $now],
                'status' => 'success',
                'error_message' => 'reset-complete callback not received within 30s; channel released',
            ]);
            \App\Services\InspectionService::pushEvent('reset-watchdog', [
                'inspectionId' => (int)$insp['id'],
                'channelNo' => $insp['channel_no'],
                'licensePlate' => $insp['license_plate'],
            ]);
            $forcedComplete[] = [
                'inspectionId' => (int)$insp['id'],
                'plate' => $insp['license_plate'],
            ];
        }

        // 3) Road-blocker CLOSE (raise) is owned by the HARDWARE controller —
        //    the backend must not command it.
        //
        //    SAFETY: the blocker is a lifting column (rising bollard). Raising it
        //    on a blind software timer can drive the column up into a vehicle
        //    that is still passing — a crush hazard. The controller is the only
        //    component with the loop detector / safety interlock, so it alone
        //    decides when it is safe to raise. The road-blocker REST API exposes
        //    no vehicle-present signal and no auto-close toggle (see ROAD BLOCKER
        //    API.pdf) — that logic is configured at the controller/485 layer.
        //
        //    OPENING still comes from the backend (DecisionExecutor) because only
        //    the platform knows the inspection verdict (PASS/VIP/etc.). But the
        //    backend never sends the raise.
        //
        //    Escape hatch: set blocker_close_mode = 'backend_timer' to restore the
        //    old software-timed raise — ONLY for controllers that have no hardware
        //    self-close/loop detector, and only if you accept the crush risk.
        $blockerClosed = [];
        $closeMode = (string)(Database::fetchOne(
            "SELECT value FROM anprc_settings WHERE key_name = 'blocker_close_mode'"
        )['value'] ?? 'hardware');

        if ($closeMode === 'backend_timer') {
            $closeAfter = (int)(Database::fetchOne(
                "SELECT value FROM anprc_settings WHERE key_name = 'blocker_auto_close_sec'"
            )['value'] ?? 8);
            $closeCutoff = gmdate('Y-m-d H:i:s', time() - $closeAfter);
            $toClose = Database::fetchAll(
                "SELECT i.* FROM anprc_inspections i
                 WHERE i.blocker_opened = 1
                   AND i.blocker_closed_at IS NULL
                   AND i.blocker_opened_at IS NOT NULL
                   AND i.blocker_opened_at <= ?",
                [$closeCutoff]
            );
            // The CORX relay is a single shared device — close (raise) it ONCE if
            // any inspection is due, then mark them all closed.
            if ($toClose) {
                $res = \App\Services\MqttOutbound::blockerRelay('close');
                foreach ($toClose as $insp) {
                    Database::update('anprc_inspections', [
                        'blocker_closed_at' => $now,
                    ], 'id = :id', ['id' => $insp['id']]);
                    \App\Services\InspectionService::logOperation([
                        'channel_no'   => $insp['channel_no'],
                        'inspection_id'=> $insp['id'],
                        'action'       => 'blocker_close',
                        'request_payload'  => ['mode' => 'backend_timer', 'topic' => $res['topic'] ?? null, 'body' => $res['body'] ?? null],
                        'response_payload' => ['queued' => $res['queued'] ?? null],
                        'status'       => $res['ok'] ? 'success' : 'failed',
                        'error_message'=> $res['ok'] ? null : ($res['error'] ?? 'enqueue_failed'),
                    ]);
                    $blockerClosed[] = [
                        'inspectionId' => (int)$insp['id'],
                        'plate'        => $insp['license_plate'],
                        'channelNo'    => $insp['channel_no'],
                        'ok'           => (bool)$res['ok'],
                        'by'           => 'backend_timer',
                    ];
                }
            }
        }
        // else 'hardware' (default): the backend issues no close command; the
        // controller raises the column itself when its loop detector says it is
        // safe. blocker_closed_at is left for the controller's reality, not ours.

        return ['code' => 200, 'message' => 'success', 'data' => [
            'now' => $now,
            'resolved' => $resolved,
            'forced_complete' => $forcedComplete,
            'blocker_closed' => $blockerClosed,
        ]];
    }
}
