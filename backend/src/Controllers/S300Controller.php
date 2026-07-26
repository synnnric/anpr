<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\S300Client;
use App\Services\InspectionService;
use App\Services\VisitService;

class S300Controller {

    private static function clientForChannel(string $channelNo): array {
        $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
        if (!$channel) {
            Response::error("Channel not found: $channelNo", 404);
            exit;
        }
        if (!$channel['enabled']) {
            Response::error("Channel disabled: $channelNo", 400);
            exit;
        }
        return [new S300Client($channel['s300_base_url']), $channel];
    }

    private static function callAndLog(string $action, string $channelNo, callable $call, ?array $reqPayload = null, ?int $inspectionId = null, ?string $actor = null): array {
        $result = $call();
        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $channelNo,
            'inspection_id' => $inspectionId,
            'action' => $action,
            'request_payload' => $reqPayload,
            'response_payload' => is_array($result['body']) ? $result['body'] : ['raw' => $result['body']],
            'status' => $result['ok'] ? 'success' : 'failed',
            'error_message' => $result['error'],
        ]);
        return $result;
    }

    // Vendor reports failures as HTTP 200 + success:false, so on a failed call
    // the upstream status can still be 2xx — map that to 502, not "200 ok".
    private static function errCode(array $result): int {
        return $result['status'] >= 300 ? $result['status'] : 502;
    }

    // POST /api/s300/come/{channelNo}  body: {licensePlateNo, force?: bool}
    public function come(Request $req): void {
        $channelNo = $req->param('channelNo');
        $plate = trim((string)$req->input('licensePlateNo', ''));
        $force = (bool)$req->input('force', false);
        $actor = AuthController::usernameFromRequest($req);
        if ($plate === '') {
            Response::error('licensePlateNo required', 400);
            return;
        }

        // Lane row up-front: the list checks below are per-lane (scoped plates +
        // behaviour switches deciding which lists this lane enforces at all).
        $laneCfg = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
        $enforceBlacklist = (int)($laneCfg['behavior_blacklist'] ?? 1) === 1;
        $enforceVip       = (int)($laneCfg['behavior_vip'] ?? 1) === 1;

        // === X-ray clearance re-entry (the x-ray loop) === a plate whose scan
        // PASSED within xray_clearance_window_s enters WITHOUT inspection.
        // Checked FIRST — before blacklist and security modes — otherwise a
        // blacklisted / red-lane car returning from the x-ray room would be
        // routed there again forever.
        $winRow = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = 'xray_clearance_window_s'");
        $clearWin = max(60, (int)($winRow['value'] ?? 3600));
        // Includes DENIED scans (user decision 2026-07-21): a denied vehicle only
        // moves with operator involvement, so if it re-appears at an entry lane
        // it is admitted without inspection too — but FLAGGED in the records.
        $clearance = Database::fetchOne(
            "SELECT * FROM anprc_inspection_xray
             WHERE vehicle_number = ? AND review_status IN ('auto','passed','denied')
               AND received_at >= NOW() - make_interval(secs => ?)
             ORDER BY id DESC LIMIT 1", [$plate, $clearWin]
        );
        if ($clearance) {
            $flagged = $clearance['review_status'] === 'denied';
            $id = Database::insert('anprc_inspections', [
                'channel_no' => $channelNo,
                'license_plate' => $plate,
                'state' => 'completed',
                'decision' => 'pass',
                'decision_reason' => $flagged
                    ? "FLAGGED: x-ray DENIED (scan #{$clearance['id']}) — operator-handled, admitted without inspection"
                    : "X-ray cleared (scan #{$clearance['id']}) — inspection skipped",
                'decision_at' => gmdate('Y-m-d H:i:s'),
                'come_called_at' => gmdate('Y-m-d H:i:s'),
                'reset_completed_at' => gmdate('Y-m-d H:i:s'),
            ]);
            // createEntry reuses the active visit when there is one (loop road
            // is inside the premises); a voluntary x-ray-first arrival gets a
            // fresh visit.
            VisitService::createEntry($plate, $channelNo, $id);
            if ($laneCfg) {
                foreach (VisitService::findAllExits() as $exit) {
                    \App\Services\MqttOutbound::whitelistAdd(
                        $exit['anpr_device_sn'], $plate, "X-ray cleared entry #$id"
                    );
                }
                \App\Services\DecisionExecutor::openEntryGate(
                    ['id' => $id, 'channel_no' => $channelNo], $laneCfg
                );
                \App\Services\DecisionExecutor::announceRecognition($laneCfg, $plate, $id, $channelNo);
                \App\Services\DecisionExecutor::openBlockerOnVipBypass(
                    ['id' => $id, 'channel_no' => $channelNo, 'license_plate' => $plate], $laneCfg
                );
            }
            InspectionService::logOperation([
                'actor_username' => $actor,
                'channel_no' => $channelNo,
                'inspection_id' => $id,
                'action' => $flagged ? 'come_xray_flagged' : 'come_xray_cleared',
                'request_payload' => ['licensePlateNo' => $plate, 'xrayId' => (int)$clearance['id'], 'window_s' => $clearWin],
                'response_payload' => ['xrayCleared' => !$flagged, 'flagged' => $flagged],
                'status' => 'success',
            ]);
            InspectionService::pushEvent($flagged ? 'xray-flagged' : 'xray-cleared', [
                'channelNo' => $channelNo,
                'inspectionId' => $id,
                'licensePlate' => $plate,
                'xrayId' => (int)$clearance['id'],
            ]);
            \App\Services\GlobalLog::enqueueEntry($id);
            Response::json([
                'code' => 200,
                'message' => $flagged
                    ? 'x-ray was DENIED: admitted without inspection, FLAGGED'
                    : 'x-ray cleared: entry without inspection',
                'data' => [
                    'inspectionId' => $id,
                    'xrayCleared' => !$flagged,
                    'flagged' => $flagged,
                    'licensePlate' => $plate,
                ],
            ]);
            return;
        }

        // === Blacklist → straight to X-RAY (takes precedence over VIP) ===
        // Flow change (user, 2026-07-18): a blacklisted plate is NOT denied.
        // It skips the S300 inspection entirely (auto-pass with a "Blacklisted
        // vehicle" note), the ANPR gate opens so the vehicle proceeds, and it
        // is routed straight to the X-RAY for secondary screening.
        // Per-lane: only when this lane enforces the blacklist (behavior_blacklist),
        // and only plates scoped to this lane (or to all lanes) match.
        if ($enforceBlacklist && InspectionService::isBlacklisted($plate, $channelNo)) {
            $id = Database::insert('anprc_inspections', [
                'channel_no' => $channelNo,
                'license_plate' => $plate,
                'state' => 'completed',
                'decision' => 'pass',
                'decision_reason' => 'Blacklisted vehicle — inspection skipped, routed to X-Ray',
                'decision_at' => gmdate('Y-m-d H:i:s'),
                'come_called_at' => gmdate('Y-m-d H:i:s'),
                'reset_completed_at' => gmdate('Y-m-d H:i:s'),
            ]);
            VisitService::createEntry($plate, $channelNo, $id);
            if ($laneCfg) {
                // Whitelist every exit camera — the vehicle is inside and must
                // be able to leave (exit opens after the x-ray receipt anyway).
                foreach (VisitService::findAllExits() as $exit) {
                    \App\Services\MqttOutbound::whitelistAdd(
                        $exit['anpr_device_sn'], $plate, "Blacklist x-ray entry #$id"
                    );
                }
                // Open the ANPR barrier + speak the routing prompt
                // ("Blacklisted Vehicle. Go To X-RAY") + LED.
                \App\Services\DecisionExecutor::openEntryGate(
                    ['id' => $id, 'channel_no' => $channelNo], $laneCfg
                );
                \App\Services\DecisionExecutor::announceBlacklist($laneCfg, $plate, $channelNo);
                \App\Services\DecisionExecutor::openBlockerOnVipBypass(
                    ['id' => $id, 'channel_no' => $channelNo, 'license_plate' => $plate], $laneCfg
                );
                \App\Services\DecisionExecutor::routeToXray(
                    ['id' => $id, 'channel_no' => $channelNo, 'license_plate' => $plate],
                    $laneCfg, 'pass', 'blacklist', $actor
                );
            }
            InspectionService::logOperation([
                'actor_username' => $actor,
                'channel_no' => $channelNo,
                'inspection_id' => $id,
                'action' => 'come_blacklist_xray',
                'request_payload' => ['licensePlateNo' => $plate],
                'response_payload' => ['blacklisted' => true, 'routedToXray' => true],
                'status' => 'success',
            ]);
            InspectionService::pushEvent('blacklist-xray', [
                'channelNo' => $channelNo,
                'inspectionId' => $id,
                'licensePlate' => $plate,
            ]);
            \App\Services\GlobalLog::enqueueEntry($id);
            Response::json([
                'code' => 200,
                'message' => 'blacklisted: inspection skipped, routed to x-ray',
                'data' => [
                    'inspectionId' => $id,
                    'blacklisted' => true,
                    'routedToXray' => true,
                    'licensePlate' => $plate,
                ],
            ]);
            return;
        }

        // === Whitelist-only lane === a lane with behavior_whitelist_only=1 admits
        // whitelisted plates normally; anything else is NOT denied (user flow
        // 2026-07-20) — it enters like the blacklist path: no S300 inspection,
        // the gate opens, and it is routed straight to the X-RAY.
        // Checked AFTER blacklist (blacklist always wins) and BEFORE the VIP bypass.
        if ((int)($laneCfg['behavior_whitelist_only'] ?? 0) === 1
            && !InspectionService::isVip($plate, $channelNo)) {
            $id = Database::insert('anprc_inspections', [
                'channel_no' => $channelNo,
                'license_plate' => $plate,
                'state' => 'completed',
                'decision' => 'pass',
                'decision_reason' => 'Not whitelisted — inspection skipped, routed to X-Ray',
                'decision_at' => gmdate('Y-m-d H:i:s'),
                'come_called_at' => gmdate('Y-m-d H:i:s'),
                'reset_completed_at' => gmdate('Y-m-d H:i:s'),
            ]);
            VisitService::createEntry($plate, $channelNo, $id);
            if ($laneCfg) {
                foreach (VisitService::findAllExits() as $exit) {
                    \App\Services\MqttOutbound::whitelistAdd(
                        $exit['anpr_device_sn'], $plate, "Whitelist-only x-ray entry #$id"
                    );
                }
                \App\Services\DecisionExecutor::openEntryGate(
                    ['id' => $id, 'channel_no' => $channelNo], $laneCfg
                );
                \App\Services\DecisionExecutor::announceWhitelistDenied($laneCfg, $plate, $channelNo);
                \App\Services\DecisionExecutor::openBlockerOnVipBypass(
                    ['id' => $id, 'channel_no' => $channelNo, 'license_plate' => $plate], $laneCfg
                );
                \App\Services\DecisionExecutor::routeToXray(
                    ['id' => $id, 'channel_no' => $channelNo, 'license_plate' => $plate],
                    $laneCfg, 'pass', 'whitelist_only', $actor
                );
            }
            InspectionService::logOperation([
                'actor_username' => $actor,
                'channel_no' => $channelNo,
                'inspection_id' => $id,
                'action' => 'come_whitelist_xray',
                'request_payload' => ['licensePlateNo' => $plate],
                'response_payload' => ['whitelistOnly' => true, 'routedToXray' => true],
                'status' => 'success',
            ]);
            InspectionService::pushEvent('whitelist-xray', [
                'channelNo' => $channelNo,
                'inspectionId' => $id,
                'licensePlate' => $plate,
            ]);
            \App\Services\GlobalLog::enqueueEntry($id);
            Response::json([
                'code' => 200,
                'message' => 'not whitelisted: inspection skipped, routed to x-ray',
                'data' => [
                    'inspectionId' => $id,
                    'whitelistOnly' => true,
                    'routedToXray' => true,
                    'licensePlate' => $plate,
                ],
            ]);
            return;
        }

        // === VIP bypass === (per-lane: behavior_vip + lane-scoped plates)
        if ($enforceVip && InspectionService::isVip($plate, $channelNo)) {
            $id = Database::insert('anprc_inspections', [
                'channel_no' => $channelNo,
                'license_plate' => $plate,
                'state' => 'vip_skipped',
                'decision' => 'vip_pass',
                'decision_reason' => 'VIP plate on allowlist',
                'decision_at' => gmdate('Y-m-d H:i:s'),
                'come_called_at' => gmdate('Y-m-d H:i:s'),
                'reset_completed_at' => gmdate('Y-m-d H:i:s'),
            ]);
            // Create the visit record + enqueue whitelist for exit camera
            VisitService::createEntry($plate, $channelNo, $id);
            $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
            if ($channel) {
                // Not paired: whitelist the VIP on every enabled exit camera.
                foreach (VisitService::findAllExits() as $exit) {
                    \App\Services\MqttOutbound::whitelistAdd(
                        $exit['anpr_device_sn'], $plate, "VIP entry inspection #$id"
                    );
                }
                // Pre-inspection ANPR gate: open on recognition so the VIP can drive in.
                \App\Services\DecisionExecutor::openEntryGate(
                    ['id' => $id, 'channel_no' => $channelNo], $channel
                );
                // Greet by voice + show plate on the camera LED, like the vendor CP.
                \App\Services\DecisionExecutor::announceRecognition($channel, $plate, $id, $channelNo);
                // Auto-open lane: lower the road blocker too — a VIP skips the
                // inspection, so nothing else in the flow would lower it.
                \App\Services\DecisionExecutor::openBlockerOnVipBypass(
                    ['id' => $id, 'channel_no' => $channelNo, 'license_plate' => $plate], $channel
                );
            }
            InspectionService::logOperation([
                'actor_username' => $actor,
                'channel_no' => $channelNo,
                'inspection_id' => $id,
                'action' => 'come_vip_bypass',
                'request_payload' => ['licensePlateNo' => $plate],
                'response_payload' => ['vip' => true],
                'status' => 'success',
            ]);
            InspectionService::pushEvent('vip-bypass', [
                'channelNo' => $channelNo,
                'inspectionId' => $id,
                'licensePlate' => $plate,
            ]);
            \App\Services\GlobalLog::enqueueEntry($id);
            Response::json([
                'code' => 200,
                'message' => 'vip bypass',
                'data' => [
                    'inspectionId' => $id,
                    'vip' => true,
                    'licensePlate' => $plate,
                ],
            ]);
            return;
        }

        // === Channel busy guard ===
        $status = InspectionService::getChannelStatus($channelNo);
        if ($status['busy'] && !$force) {
            $active = $status['active'];
            Response::json([
                'code' => 409,
                'message' => 'channel busy: previous vehicle still being processed',
                'data' => [
                    'busy' => true,
                    'operating_state' => $status['operating_state'] ?? null,
                    'activePlate' => $active['license_plate'] ?? null,
                    'activeInspectionId' => $active['id'] ?? null,
                    'activeState' => $active['state'] ?? null,
                ],
            ], 409);
            return;
        }

        [$client, $channel] = self::clientForChannel($channelNo);

        // Look up the most recent ANPR detection to capture vehicle_id for fake-plate check
        $vehicle = Database::fetchOne(
            'SELECT id FROM anprc_vehicles WHERE license_plate = ? ORDER BY id DESC LIMIT 1',
            [$plate]
        );

        $timeoutSec = (int)($channel['uvis_timeout_sec'] ?? 30);
        try {
            $inspectionId = Database::insert('anprc_inspections', [
                'channel_no' => $channelNo,
                'vehicle_id' => $vehicle['id'] ?? null,
                'license_plate' => $plate,
                'state' => 'started',
                'come_called_at' => gmdate('Y-m-d H:i:s'),
                'decision_timeout_at' => gmdate('Y-m-d H:i:s', time() + $timeoutSec),
            ]);
        } catch (\PDOException $e) {
            // Partial unique index uq_one_active_inspection_per_channel rejects
            // a second active inspection on the same channel. This races with
            // the busy guard above: both succeed when two /come arrive at the
            // same millisecond. Convert the violation into a clean 409.
            if (($e->errorInfo[0] ?? '') === '23505') {
                $active = InspectionService::findActiveInspection($channelNo);
                Response::json([
                    'code' => 409,
                    'message' => 'channel busy: another /come committed first',
                    'data' => [
                        'busy' => true,
                        'activePlate' => $active['license_plate'] ?? null,
                        'activeInspectionId' => $active['id'] ?? null,
                        'activeState' => $active['state'] ?? null,
                    ],
                ], 409);
                return;
            }
            throw $e;
        }

        // Pre-inspection ANPR gate: open the camera's own barrier immediately on
        // recognition so the vehicle can proceed into the inspection area. The
        // UVIS scan, S300 and road blocker all happen afterwards. (ANPR has no
        // behaviour switch by design — recognition + barrier IS the entry lane.)
        \App\Services\DecisionExecutor::openEntryGate(
            ['id' => $inspectionId, 'channel_no' => $channelNo], $channel
        );
        // Greet by voice + show plate on the camera LED, like the vendor CP.
        \App\Services\DecisionExecutor::announceRecognition($channel, $plate, $inspectionId, $channelNo);

        // Open a visit record so we can pair it to the eventual exit
        VisitService::createEntry($plate, $channelNo, $inspectionId);

        // Per-lane behaviour: behavior_uvis_s300=0 means this lane has no UVIS/S300
        // cycle — the inspection PASSES immediately with an explanatory note, and
        // the rest of the flow (road blocker, exit whitelist) runs as on a normal
        // pass. No S300 HTTP call is made.
        if ((int)($channel['behavior_uvis_s300'] ?? 1) === 0) {
            $fresh = Database::fetchOne('SELECT * FROM anprc_inspections WHERE id = ?', [$inspectionId]);
            \App\Services\DecisionExecutor::apply(
                $fresh, ['decision' => 'pass', 'reason' => 'UVIS+S300 disabled'], $channel
            );
            InspectionService::logOperation([
                'actor_username' => $actor,
                'channel_no' => $channelNo,
                'inspection_id' => $inspectionId,
                'action' => 'come_uvis_s300_bypassed',
                'request_payload' => ['licensePlateNo' => $plate],
                'response_payload' => ['auto_pass' => true],
                'status' => 'success',
            ]);
            Response::json([
                'code' => 200,
                'message' => 'uvis+s300 disabled for this lane — inspection auto-passed',
                'data' => [
                    'inspectionId' => $inspectionId,
                    'bypassed' => 'uvis_s300',
                    'licensePlate' => $plate,
                ],
            ]);
            return;
        }

        $result = self::callAndLog('come', $channelNo, function () use ($client, $channelNo, $plate) {
            return $client->post("/api/v1/channel-s300/come/$channelNo", ['licensePlateNo' => $plate]);
        }, ['licensePlateNo' => $plate], $inspectionId, $actor);

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'S300 call failed'),
            'data' => [
                'inspectionId' => $inspectionId,
                's300Response' => $result['body'],
                'elapsedMs' => $result['elapsed_ms'],
            ],
        ]);
    }

    // GET /api/s300/capture/{channelNo}
    public function capture(Request $req): void {
        $channelNo = $req->param('channelNo');
        $actor = AuthController::usernameFromRequest($req);
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        // Vendor server exposes POST /recapture (protocol doc says GET /capture).
        $result = self::callAndLog('capture', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/channel-s300/recapture/$channelNo");
        }, null, $inspection['id'] ?? null, $actor);

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // GET /api/s300/leave/{channelNo}
    public function leave(Request $req): void {
        $channelNo = $req->param('channelNo');
        $actor = AuthController::usernameFromRequest($req);
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        // Vendor server takes POST here (protocol doc says GET).
        $result = self::callAndLog('leave', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/channel-s300/leave/$channelNo");
        }, null, $inspection['id'] ?? null, $actor);

        if ($result['ok']) {
            // Manual override matches the AUTO flow's tail: the /leave above is
            // "phase 1"; now mark it sent and re-arm the blocker for the SAME
            // reset gap (blocker_reset_interval_s, default 7s) so the S300 resets
            // and the recorded video lands before the barrier moves — the cron
            // phase-2 sweep then opens the blocker + completes. We just skip the
            // 60s-from-verdict / face-image wait, which is the point of the button.
            $target = $inspection ?: Database::fetchOne(
                "SELECT * FROM anprc_inspections
                 WHERE channel_no = ? AND blocker_open_due_at IS NOT NULL
                 ORDER BY id DESC LIMIT 1",
                [$channelNo]
            );
            if ($target) {
                $interval = (int)(Database::fetchOne(
                    "SELECT value FROM anprc_settings WHERE key_name = 'blocker_reset_interval_s'"
                )['value'] ?? 7);
                Database::update('anprc_inspections', [
                    'leave_called_at'     => gmdate('Y-m-d H:i:s'),
                    'auto_leave_called'   => 1,
                    'state'               => 'resetting',
                    'blocker_open_due_at' => gmdate('Y-m-d H:i:s', time() + max(0, $interval)),
                ], 'id = :id', ['id' => $target['id']]);
            }
        }

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/read-work-status/{channelNo}
    public function readWorkStatus(Request $req): void {
        $channelNo = $req->param('channelNo');
        $actor = AuthController::usernameFromRequest($req);
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('read_work_status', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/device-s300/read-work-status/$channelNo");
        }, null, $inspection['id'] ?? null, $actor);

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/emergency-stop/{channelNo}
    public function emergencyStop(Request $req): void {
        $channelNo = $req->param('channelNo');
        $actor = AuthController::usernameFromRequest($req);
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('emergency_stop', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/device-s300/emergency-stop/$channelNo");
        }, null, $inspection['id'] ?? null, $actor);

        if ($inspection && $result['ok']) {
            Database::update('anprc_inspections', ['state' => 'emergency_stop'], 'id = :id', ['id' => $inspection['id']]);
        }

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/manual-reset/{channelNo}
    public function manualReset(Request $req): void {
        $channelNo = $req->param('channelNo');
        $actor = AuthController::usernameFromRequest($req);
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('manual_reset', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/device-s300/manual-reset/$channelNo");
        }, null, $inspection['id'] ?? null, $actor);

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/audio-prompt   body: {channelNo, data:[{index, language, url, desc}]}
    public function audioPrompt(Request $req): void {
        $body = $req->json();
        $channelNo = $body['channelNo'] ?? null;
        $data = $body['data'] ?? [];
        $actor = AuthController::usernameFromRequest($req);
        if (!$channelNo || !is_array($data) || empty($data)) {
            Response::error('channelNo and data[] required', 400);
            return;
        }

        [$client] = self::clientForChannel($channelNo);

        $payload = ['cmdNo' => 335, 'data' => $data];
        // Vendor server takes the channel in the path (protocol doc omits it).
        $result = self::callAndLog('audio_prompt', $channelNo, function () use ($client, $channelNo, $payload) {
            return $client->post('/api/v1/device-s300/audio-prompt/' . rawurlencode($channelNo), $payload);
        }, $payload, null, $actor);

        if ($result['ok']) {
            foreach ($data as $item) {
                if (!isset($item['index'], $item['language'], $item['url'])) continue;
                Database::query(
                    "INSERT INTO anprc_audio_prompts (audio_index, language, url, description)
                     VALUES (:idx, :lang, :url, :desc)
                     ON CONFLICT (audio_index, language)
                     DO UPDATE SET url = EXCLUDED.url, description = EXCLUDED.description",
                    [
                        'idx' => $item['index'],
                        'lang' => $item['language'],
                        'url' => $item['url'],
                        'desc' => $item['desc'] ?? null,
                    ]
                );
            }
        }

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/video-playback   body: {channelNo, startTime, endTime}
    public function videoPlayback(Request $req): void {
        $body = $req->json();
        $channelNo = $body['channelNo'] ?? null;
        $startTime = $body['startTime'] ?? null;
        $endTime = $body['endTime'] ?? null;
        $actor = AuthController::usernameFromRequest($req);
        if (!$channelNo || !$startTime || !$endTime) {
            Response::error('channelNo, startTime, endTime required', 400);
            return;
        }

        [$client] = self::clientForChannel($channelNo);

        $payload = compact('channelNo', 'startTime', 'endTime');
        $result = self::callAndLog('video_playback', $channelNo, function () use ($client, $payload) {
            return $client->post('/api/v1/device-s300/video-playback', $payload);
        }, $payload, null, $actor);

        Response::json([
            'code' => $result['ok'] ? 200 : self::errCode($result),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }
}
