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

        // 1) Force a decision on inspections that have exceeded their UVIS timeout.
        //    'completed'/'resetting' are included: the real S300 can finish its own
        //    cycle (work-status op=3 → state completed) BEFORE the timeout fires,
        //    which used to strand the decision at 'pending' forever — the vehicle
        //    still needs its verdict (route-to-xray) even after the device reset.
        $timedOut = Database::fetchAll(
            "SELECT * FROM anprc_inspections
             WHERE decision = 'pending'
               AND decision_timeout_at IS NOT NULL
               AND decision_timeout_at <= ?
               AND state IN ('pending','started','inspecting','resetting','completed')",
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

        // 1b) Self-heal: an inspection can get stranded in an ACTIVE state when the
        //     decision executed but its auto-/leave failed (S300 unreachable at that
        //     moment). Nothing else retries it, so the lane deadlocks: every new
        //     /come hits the one-active-inspection guard. Retry the /leave here;
        //     if the S300 still can't be reached after 2 minutes, force-release
        //     the lane (the S300 can be reset by hand once it is back).
        //     Suspects are included too: since the route-to-xray flow change they
        //     auto-/leave like every other decision (no manual-review lane hold).
        $leaveRetried = [];
        $stranded = Database::fetchAll(
            "SELECT * FROM anprc_inspections
             WHERE decision IN ('pass','fail','suspect')
               AND state IN ('pending','started','inspecting')
               AND auto_leave_called = 0
               AND blocker_open_due_at IS NULL
               AND decision_at IS NOT NULL
               AND decision_at <= ?",
            [gmdate('Y-m-d H:i:s', time() - 10)]
        );
        foreach ($stranded as $insp) {
            $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$insp['channel_no']]);
            if (!$channel) continue;
            $ok = DecisionExecutor::retryAutoLeave($insp, $channel);
            $forced = false;
            if (!$ok && strtotime($insp['decision_at'] . ' UTC') <= time() - 120) {
                // S300 still unreachable — free the lane so traffic can resume.
                Database::update('anprc_inspections', [
                    'state' => $insp['decision'] === 'fail' ? 'failed' : 'completed',
                ], 'id = :id', ['id' => $insp['id']]);
                \App\Services\InspectionService::logOperation([
                    'channel_no' => $insp['channel_no'],
                    'inspection_id' => $insp['id'],
                    'action' => 'leave_watchdog',
                    'request_payload' => ['decision_at' => $insp['decision_at']],
                    'status' => 'success',
                    'error_message' => 'auto-/leave kept failing for 120s; lane force-released',
                ]);
                $forced = true;
            }
            $leaveRetried[] = [
                'inspectionId' => (int)$insp['id'],
                'plate' => $insp['license_plate'],
                'leaveOk' => $ok,
                'forcedRelease' => $forced,
            ];
        }

        // 1c) Deferred close, in TWO phases keyed off blocker_open_due_at:
        //     Phase 1 (leave not yet sent): the scan is done → /leave the S300
        //       (reset + recorded video), then re-arm the timer for
        //       blocker_reset_interval_s (default 7s) so the device can reset
        //       itself BEFORE the barrier moves.
        //     Phase 2 (leave already sent, interval elapsed): lower the blocker +
        //       complete the inspection.
        //     (VIP opens immediately in come(); UVIS-disabled lanes skip phase 1.)
        $blockerFired = [];
        $leftForReset = [];
        $resetInterval = (int)(Database::fetchOne(
            "SELECT value FROM anprc_settings WHERE key_name = 'blocker_reset_interval_s'"
        )['value'] ?? 7);
        $dueBlocker = Database::fetchAll(
            "SELECT * FROM anprc_inspections
             WHERE blocker_open_due_at IS NOT NULL AND blocker_open_due_at <= ?",
            [$now]
        );
        foreach ($dueBlocker as $insp) {
            $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$insp['channel_no']]);
            if (!$channel) {
                // Channel vanished — clear the schedule so it doesn't loop forever.
                Database::query("UPDATE anprc_inspections SET blocker_open_due_at = NULL WHERE id = ?", [$insp['id']]);
                continue;
            }
            $isVip = ($insp['decision'] ?? '') === 'vip_pass';
            $mode = (string)($channel['s300_inspection_mode'] ?? 'full');

            // Skip S300: the user wants the barrier the moment UVIS lands, so do
            // /leave (device reset) + open blocker + complete in ONE shot — no
            // reset-gap phase. (VIP already opened its own blocker in come().)
            if (!$isVip && $mode === 'skip') {
                DecisionExecutor::fireDeferredBlocker($insp, $channel, true);
                $blockerFired[] = ['inspectionId' => (int)$insp['id'], 'plate' => $insp['license_plate']];
                continue;
            }

            $hasS300 = (int)($channel['behavior_uvis_s300'] ?? 1) === 1;
            $leavePending = empty($insp['leave_called_at'])
                && !$isVip && $hasS300 && DecisionExecutor::autoLeaveEnabled();

            if ($leavePending) {
                // Phase 1: reset the device, then wait the interval before the blocker.
                DecisionExecutor::deferredLeave($insp, $channel);
                Database::query(
                    "UPDATE anprc_inspections SET blocker_open_due_at = ? WHERE id = ?",
                    [gmdate('Y-m-d H:i:s', time() + max(0, $resetInterval)), $insp['id']]
                );
                $leftForReset[] = ['inspectionId' => (int)$insp['id'], 'plate' => $insp['license_plate']];
            } else {
                // Phase 2: /leave already done (or not needed) — open blocker + complete.
                DecisionExecutor::fireDeferredBlocker($insp, $channel, false);
                $blockerFired[] = ['inspectionId' => (int)$insp['id'], 'plate' => $insp['license_plate']];
            }
        }

        // 2) Watchdog: force-complete inspections stuck in 'resetting' for too long
        //    (the S300 may have crashed or the reset-complete callback got lost).
        //    Skip ones still awaiting their deferred blocker-open (1c owns those).
        $stuckResetCutoff = gmdate('Y-m-d H:i:s', time() - 30);
        $stuck = Database::fetchAll(
            "SELECT * FROM anprc_inspections
             WHERE state = 'resetting'
               AND leave_called_at IS NOT NULL
               AND leave_called_at <= ?
               AND reset_completed_at IS NULL
               AND blocker_open_due_at IS NULL",
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
            'leave_retried' => $leaveRetried,
            'left_for_reset' => $leftForReset,
            'blocker_fired' => $blockerFired,
            'forced_complete' => $forcedComplete,
            'blocker_closed' => $blockerClosed,
        ]];
    }
}
