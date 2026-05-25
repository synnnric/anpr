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
        $now = gmdate('Y-m-d H:i:s');

        // Worker heartbeat — the worker calls /api/cron/tick every 5s, so this
        // setting is the freshest signal we have that the worker is alive.
        Database::query(
            "INSERT INTO settings (key_name, value, updated_at) VALUES ('worker_last_seen_at', :v, NOW())
             ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            ['v' => $now]
        );

        // 1) Force a decision on inspections that have exceeded their UVIS timeout
        $timedOut = Database::fetchAll(
            "SELECT * FROM inspections
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
            $channel = Database::fetchOne('SELECT * FROM channels WHERE channel_no = ?', [$insp['channel_no']]);
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
            "SELECT * FROM inspections
             WHERE state = 'resetting'
               AND leave_called_at IS NOT NULL
               AND leave_called_at <= ?
               AND reset_completed_at IS NULL",
            [$stuckResetCutoff]
        );
        $forcedComplete = [];
        foreach ($stuck as $insp) {
            Database::update('inspections', [
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

        // 3) Auto-raise the road blocker after each successful pass. The blocker
        //    was lowered by DecisionExecutor on PASS/SUSPECT/VIP_PASS so the
        //    vehicle could drive through; once it's had `blocker_auto_close_sec`
        //    to clear the area, raise it again for the next vehicle.
        $closeAfter = (int)(Database::fetchOne(
            "SELECT value FROM settings WHERE key_name = 'blocker_auto_close_sec'"
        )['value'] ?? 8);
        $closeCutoff = gmdate('Y-m-d H:i:s', time() - $closeAfter);
        $toClose = Database::fetchAll(
            "SELECT i.*, c.rb_ip, c.rb_port, c.rb_device_no, c.rb_board_id, c.rb_column_num
             FROM inspections i
             JOIN channels c ON c.channel_no = i.channel_no
             WHERE i.blocker_opened = 1
               AND i.blocker_closed_at IS NULL
               AND i.blocker_opened_at IS NOT NULL
               AND i.blocker_opened_at <= ?
               AND c.rb_ip IS NOT NULL
               AND c.rb_device_no IS NOT NULL",
            [$closeCutoff]
        );
        $blockerClosed = [];
        foreach ($toClose as $insp) {
            $client = new \App\Services\RoadBlockerClient(
                (string)$insp['rb_ip'], (int)$insp['rb_port']
            );
            $res = $client->closeColumn(
                (string)$insp['rb_device_no'],
                (string)$insp['rb_board_id'],
                (int)$insp['rb_column_num']
            );
            Database::update('inspections', [
                'blocker_closed_at' => $now,
            ], 'id = :id', ['id' => $insp['id']]);
            \App\Services\InspectionService::logOperation([
                'channel_no'   => $insp['channel_no'],
                'inspection_id'=> $insp['id'],
                'action'       => 'blocker_close',
                'request_payload'  => ['board' => $insp['rb_board_id'], 'column' => $insp['rb_column_num']],
                'response_payload' => ['ok' => $res['ok'], 'elapsed_ms' => $res['elapsed_ms'] ?? null],
                'status'       => $res['ok'] ? 'success' : 'failed',
                'error_message'=> $res['ok'] ? null : ($res['error'] ?? "http_{$res['status']}"),
            ]);
            $blockerClosed[] = [
                'inspectionId' => (int)$insp['id'],
                'plate'        => $insp['license_plate'],
                'channelNo'    => $insp['channel_no'],
                'ok'           => $res['ok'],
            ];
        }

        return ['code' => 200, 'message' => 'success', 'data' => [
            'now' => $now,
            'resolved' => $resolved,
            'forced_complete' => $forcedComplete,
            'blocker_closed' => $blockerClosed,
        ]];
    }
}
