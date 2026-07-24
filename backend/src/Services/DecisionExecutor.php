<?php
namespace App\Services;

use App\Core\Database;
use App\Core\Logger;

/**
 * Executes the verdict produced by DecisionEngine:
 *   pass / vip_pass → open road blocker + whitelist exit camera
 *   fail / suspect  → route to X-RAY: the vehicle is NOT turned back (reversing
 *                     against the queue behind it causes gridlock) — the blocker
 *                     opens like a pass and the vehicle proceeds to the x-ray
 *                     for secondary inspection (videotron will show GO TO X-RAY)
 *   then in all cases → auto-call S300 /leave to reset the channel
 */
class DecisionExecutor {

    /**
     * Apply a verdict to an inspection. Idempotent — running twice has no extra effect.
     *
     * @param array $inspection  Row from inspections (must be re-fetched in caller after update)
     * @param array $verdict     ['decision' => 'pass|suspect|fail|vip_pass', 'reason' => string]
     * @param array $channel     Row from channels (used for rb_* config)
     */
    public static function apply(array $inspection, array $verdict, array $channel): void {
        if ($inspection['decision'] !== 'pending') {
            // Already decided previously, don't re-execute side effects
            return;
        }

        $decision = $verdict['decision'];
        $reason = $verdict['reason'];

        Database::update('anprc_inspections', [
            'decision' => $decision,
            'decision_reason' => $reason,
            'decision_at' => gmdate('Y-m-d H:i:s'),
        ], 'id = :id', ['id' => $inspection['id']]);

        InspectionService::pushEvent('decision', [
            'inspectionId' => $inspection['id'],
            'channelNo' => $inspection['channel_no'],
            'licensePlate' => $inspection['license_plate'],
            'decision' => $decision,
            'reason' => $reason,
        ]);

        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'auto_decision',
            'request_payload' => ['decision' => $decision, 'reason' => $reason],
            'response_payload' => null,
            'status' => 'success',
        ]);

        // NON-blocker side effects run at the verdict. The ROAD BLOCKER is NOT
        // lowered here — the real S300 keeps pushing face images + the recorded
        // video for ~90s after the UVIS verdict, and the user wants the barrier
        // to open only after the inspection has its pictures/videos and the
        // device has reset. So we DEFER the blocker-open + completion (see below).
        if (in_array($decision, ['pass', 'vip_pass'], true)) {
            self::whitelistOnExitCamera($inspection, $channel);
            // Lane security mode: red routes EVERY vehicle to the x-ray, orange
            // routes a random security_random_pct % of clean ones. (Not-clean
            // vehicles route via the fail/suspect branch regardless of mode.)
            $secRoute = ($decision === 'pass') ? self::securityRoute($channel) : null;
            if ($secRoute !== null) {
                self::routeToXray($inspection, $channel, $decision, $secRoute);
            }
        } else if (in_array($decision, ['fail', 'suspect'], true)) {
            // FAIL/SUSPECT are NOT turned back (queue gridlock) — routed forward
            // to the X-RAY. Records the routing + whitelists the exit; blocker is
            // deferred like a pass.
            self::whitelistOnExitCamera($inspection, $channel);
            self::routeToXray($inspection, $channel, $decision, 'inspection');
        }

        // S300 lifecycle close (VIP never started the S300, so it's excluded).
        // CRITICAL: do NOT /leave at the verdict — the UVIS verdict lands ~15s
        // into the scan, and a /leave then makes the vendor send vehicle-out,
        // which ABORTS the S300 mid-inspection (device drops back to ready). So
        // we only SCHEDULE: after blocker_open_delay_s (default 60s) the cron
        // sweep sends /leave (device finishes + emits recorded video) THEN opens
        // the blocker + completes. That gives the S300 its full scan time.
        if ($decision !== 'vip_pass') {
            $delay = self::deferDelaySeconds($channel);
            Database::query(
                "UPDATE anprc_inspections SET blocker_open_due_at = ? WHERE id = ?",
                [gmdate('Y-m-d H:i:s', time() + max(0, $delay)), $inspection['id']]
            );
            InspectionService::logOperation([
                'channel_no' => $inspection['channel_no'],
                'inspection_id' => $inspection['id'],
                'action' => 'blocker_open_scheduled',
                'request_payload' => ['delay_s' => $delay, 'mode' => $channel['s300_inspection_mode'] ?? 'full'],
                'status' => 'success',
            ]);
        }
    }

    /**
     * Seconds to wait after the UVIS verdict before the deferred /leave + blocker,
     * per the lane's S300 inspection mode (s300_inspection_mode):
     *   none / skip → 0  (fire on the next cron tick; skip still /leaves)
     *   timed       → s300_timed_seconds (fixed countdown from the verdict)
     *   full        → blocker_open_delay_s (fallback; face images pull/reset it)
     */
    private static function deferDelaySeconds(array $channel): int {
        $mode = (string)($channel['s300_inspection_mode'] ?? 'full');
        switch ($mode) {
            case 'none':
            case 'skip':
                return 0;
            case 'timed':
                return max(0, (int)($channel['s300_timed_seconds'] ?? 15));
            default: // full
                return (int)(Database::fetchOne(
                    "SELECT value FROM anprc_settings WHERE key_name = 'blocker_open_delay_s'"
                )['value'] ?? 40);
        }
    }

    /**
     * Cron-driven: the deferred close is now due (blocker_open_delay_s after the
     * verdict). By now the S300 has had its full scan time, so:
     *   1) auto-/leave — resets the device AND triggers the recorded-video push
     *      (vendor vehicleLeave → forwardVideoRecord). Sent LATE on purpose so it
     *      doesn't abort the scan.
     *   2) open the road blocker (per-lane behaviour + auto-open).
     *   3) complete the inspection.
     * Called from CronController::tick and the manual Leave button (immediate).
     */
    public static function fireDeferredBlocker(array $inspection, array $channel, bool $sendLeave = true): void {
        if ($sendLeave && ($inspection['decision'] ?? '') !== 'vip_pass' && self::autoLeaveEnabled()) {
            self::autoLeave($inspection, $channel);
        }
        self::openBlocker($inspection, $channel, (string)($inspection['decision'] ?? 'pass'));
        Database::update('anprc_inspections', [
            'state' => 'completed',
            'reset_completed_at' => gmdate('Y-m-d H:i:s'),
            'blocker_open_due_at' => null,
        ], 'id = :id', ['id' => $inspection['id']]);
    }

    /** Whether the flow issues an S300 /leave (at the deferred blocker time). */
    public static function autoLeaveEnabled(): bool {
        $row = Database::fetchOne("SELECT value FROM anprc_settings WHERE key_name = 's300_auto_leave_enabled'");
        return in_array((string)($row['value'] ?? '0'), ['1', 'true', 'True'], true);
    }

    /**
     * Deferred-close PHASE 1 (cron): the scan is done, so /leave the S300 —
     * resets the device + triggers the recorded video. The blocker is NOT opened
     * yet; the caller reschedules it blocker_reset_interval_s later so the device
     * has time to reset itself first. leave_called_at is stamped either way so a
     * failed /leave doesn't loop this phase forever.
     */
    public static function deferredLeave(array $inspection, array $channel): void {
        if (self::autoLeaveEnabled() && ($inspection['decision'] ?? '') !== 'vip_pass') {
            self::autoLeave($inspection, $channel);
        }
        Database::query(
            "UPDATE anprc_inspections SET leave_called_at = COALESCE(leave_called_at, ?) WHERE id = ?",
            [gmdate('Y-m-d H:i:s'), $inspection['id']]
        );
    }

    /**
     * FAIL / SUSPECT → forward to X-RAY (never turn the vehicle back).
     * Opens the road blocker exactly like a pass so the vehicle can proceed,
     * and records the routing. The visit stays ACTIVE — the vehicle does enter
     * the premises (via the x-ray), it is not denied.
     *
     * Videotron (future integration — client not built yet): when the videotron
     * push is wired up, this is the point where it must display the
     * `videotron_xray_text` setting (default "GO TO X-RAY") for the driver.
     * The exit camera IS whitelisted (user decision 2026-07-04, "for now"): the
     * vehicle is inside either way and must be able to leave. When the x-ray
     * outcome flow is defined, exit authorisation may move there instead.
     */
    /**
     * Lane security mode → forced x-ray routing for CLEAN vehicles.
     *   red    → every vehicle ('security_red')
     *   orange → security_random_pct % at random ('security_random')
     *   green  → none (inspection result decides, i.e. only fail/suspect)
     */
    private static function securityRoute(array $channel): ?string {
        switch ((string)($channel['security_mode'] ?? 'green')) {
            case 'red':
                return 'security_red';
            case 'orange':
                $pct = max(0, min(100, (int)($channel['security_random_pct'] ?? 20)));
                return mt_rand(0, 99) < $pct ? 'security_random' : null;
            default:
                return null;
        }
    }

    /**
     * Record + announce that a vehicle must go to the X-RAY. $route says why:
     * inspection | security_red | security_random | manual | blacklist.
     * Public: also called by the manual route endpoint and the blacklist entry
     * flow. Does NOT whitelist the exit camera — callers own that.
     */
    public static function routeToXray(array $inspection, array $channel, string $decision, string $route, ?string $actor = null): void {
        Database::update('anprc_inspections', ['xray_route' => $route],
            'id = :id', ['id' => $inspection['id']]);

        $text = (string)(Database::fetchOne(
            "SELECT value FROM anprc_settings WHERE key_name = 'videotron_xray_text'"
        )['value'] ?? 'GO TO X-RAY');

        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'route_to_xray',
            'request_payload' => ['decision' => $decision, 'route' => $route, 'videotron_text' => $text],
            'status' => 'success',
        ]);
        InspectionService::pushEvent('route-to-xray', [
            'inspectionId' => $inspection['id'],
            'channelNo' => $inspection['channel_no'],
            'licensePlate' => $inspection['license_plate'],
            'decision' => $decision,
            'route' => $route,
            'videotronText' => $text,
        ]);
    }

    /**
     * Resolve a SUSPECT inspection that was held for manual review.
     *   approve → treat like a pass (open road blocker + whitelist exit camera)
     *   reject  → treat like a fail (back-up audio prompt + deny the visit)
     * Either way the channel is then released via /leave so the S300 can reset.
     *
     * Records the decider in the inspection's review_* columns AND in the
     * operation log (actor_username), so the audit trail shows who approved /
     * rejected. Idempotent: returns false if the inspection isn't awaiting review.
     *
     * @param array  $inspection  Row from inspections
     * @param array  $channel     Row from channels
     * @param bool   $approved    true = approve (let in), false = reject (turn back)
     * @param string $actor       username of the approver / rejecter
     * @param ?string $note       optional free-text note recorded in the log
     */
    public static function resolveReview(array $inspection, array $channel, bool $approved, string $actor, ?string $note = null): bool {
        if ($inspection['decision'] !== 'suspect' || ($inspection['review_status'] ?? null) !== 'pending') {
            return false; // not awaiting review — guard against double-resolve
        }

        $status = $approved ? 'approved' : 'rejected';
        Database::update('anprc_inspections', [
            'review_status' => $status,
            'reviewed_by' => $actor,
            'reviewed_at' => gmdate('Y-m-d H:i:s'),
        ], 'id = :id', ['id' => $inspection['id']]);

        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => $approved ? 'review_approve' : 'review_reject',
            'request_payload' => ['note' => $note, 'reason' => $inspection['decision_reason'] ?? null],
            'status' => 'success',
        ]);

        InspectionService::pushEvent('review-resolved', [
            'inspectionId' => $inspection['id'],
            'channelNo' => $inspection['channel_no'],
            'licensePlate' => $inspection['license_plate'],
            'reviewStatus' => $status,
            'reviewedBy' => $actor,
        ]);

        if ($approved) {
            self::whitelistOnExitCamera($inspection, $channel);
        } else {
            self::sendBackUpAudio($inspection, $channel);
            self::markVisitDenied($inspection, $inspection['decision_reason'] ?? 'Rejected on manual review');
        }

        // Same close as apply(): DEFER the /leave + blocker + completion (the
        // cron sweep sends /leave late so it doesn't abort the scan). Honours the
        // lane's S300 inspection mode for the delay.
        $delay = self::deferDelaySeconds($channel);
        Database::query(
            "UPDATE anprc_inspections SET blocker_open_due_at = ? WHERE id = ?",
            [gmdate('Y-m-d H:i:s', time() + max(0, $delay)), $inspection['id']]
        );
        return true;
    }

    private static function whitelistOnExitCamera(array $inspection, array $channel): void {
        // Lanes are not paired — the vehicle may leave through ANY exit, so the
        // plate is whitelisted on every enabled exit camera.
        $exits = VisitService::findAllExits();
        if (!$exits) {
            InspectionService::logOperation([
                'channel_no' => $inspection['channel_no'],
                'inspection_id' => $inspection['id'],
                'action' => 'whitelist_skipped',
                'request_payload' => ['reason' => 'no enabled exit channel with anpr_device_sn'],
                'status' => 'failed',
                'error_message' => 'configure at least one exit channel with an ANPR SN',
            ]);
            return;
        }
        $queued = [];
        foreach ($exits as $exit) {
            $queueId = MqttOutbound::whitelistAdd(
                $exit['anpr_device_sn'],
                $inspection['license_plate'],
                "auto entry pass inspection #{$inspection['id']}"
            );
            $queued[] = ['exitCameraSn' => $exit['anpr_device_sn'], 'queueId' => $queueId];
        }
        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'whitelist_enqueue_add',
            'request_payload' => [
                'plate' => $inspection['license_plate'],
                'exits' => $queued,
            ],
            'status' => 'success',
        ]);
    }

    private static function markVisitDenied(array $inspection, string $reason): void {
        $visit = Database::fetchOne(
            'SELECT * FROM anprc_visits WHERE entry_inspection_id = ? LIMIT 1',
            [$inspection['id']]
        );
        if ($visit && $visit['status'] === 'active') {
            VisitService::markEntryDenied((int)$visit['id'], $reason);
        }
    }

    /**
     * Open the ENTRY ANPR camera's OWN barrier gate by pulsing a GPIO output
     * relay (gpio_out, protocol §7.2). This is the PRE-INSPECTION gate: it is
     * called from /come (on plate recognition) so the vehicle can drive into
     * the inspection area — UVIS / S300 / road blocker all come afterwards.
     * Off by default; enable + tune via settings:
     *   entry_gate_open      '1' to enable (default '0')
     *   entry_gate_io        output index 0-3 (default '0')
     *   entry_gate_value     0=OFF 1=ON 2=Pulse (default '2')
     *   entry_gate_pulse_ms  pulse duration ms (default '1000')
     */
    public static function openEntryGate(array $inspection, array $channel): void {
        $cfg = self::entryGateConfig();
        if (!$cfg['enabled']) return;

        $sn = $channel['anpr_device_sn'] ?? null;
        if (!$sn) {
            InspectionService::logOperation([
                'channel_no' => $inspection['channel_no'],
                'inspection_id' => $inspection['id'],
                'action' => 'open_entry_gate_skipped',
                'request_payload' => ['reason' => 'channel has no anpr_device_sn'],
                'status' => 'failed',
                'error_message' => 'set anpr_device_sn on the entry channel',
            ]);
            return;
        }

        $queueId = MqttOutbound::gateOpen($sn, $cfg['io'], $cfg['value'], $cfg['delay_ms']);
        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'open_entry_gate',
            'request_payload' => [
                'cameraSn' => $sn, 'io' => $cfg['io'],
                'value' => $cfg['value'], 'delay' => $cfg['delay_ms'], 'queueId' => $queueId,
            ],
            'status' => 'success',
        ]);

        // Vendor parity: on gate-open, also switch the lane signal light green
        // (serial_data SET_RELAY_STATUS). Tunable via settings:
        //   entry_green_light_enabled '1' to send (default '1')
        //   entry_green_light_ch      relay channel (default '1')
        //   entry_green_light_sec     on-time seconds (default '10')
        if ($cfg['green_enabled']) {
            $gqId = MqttOutbound::greenLight($sn, $cfg['green_ch'], $cfg['green_sec']);
            InspectionService::logOperation([
                'channel_no' => $inspection['channel_no'],
                'inspection_id' => $inspection['id'],
                'action' => 'entry_green_light',
                'request_payload' => [
                    'cameraSn' => $sn, 'ch' => $cfg['green_ch'],
                    'sec' => $cfg['green_sec'], 'queueId' => $gqId,
                ],
                'status' => 'success',
            ]);
        }
    }

    /**
     * Replicate the vendor CP's on-recognition feedback: greet the driver by
     * voice and show the plate on the camera's LED display. Sent as MQTT
     * `serial_data` frames to the ANPR camera's KF control card (see
     * KfControlCard), alongside the entry-gate pulse. Independent of the gate
     * enable flag so the camera still greets even when the gate is left closed.
     * Tunable via settings:
     *   entry_voice_enabled  '1' to play voice    (default '1')
     *   entry_voice_text     spoken text          (default 'Welcome')
     *   entry_led_enabled    '1' to show LED text (default '1')
     *   entry_led_text       LED text; '' = show the plate number; otherwise a
     *                        literal that may contain a {plate} placeholder (default '')
     */
    public static function announceRecognition(array $channel, string $plate, ?int $inspectionId, string $channelNo): void {
        $sn = $channel['anpr_device_sn'] ?? null;
        if (!$sn) return;

        $get = static function (string $key, string $default): string {
            $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
            return $row['value'] ?? $default;
        };
        $on = static fn(string $v) => in_array($v, ['1', 'true', 'True'], true);

        if ($on($get('entry_voice_enabled', '1'))) {
            $text = $get('entry_voice_text', 'Welcome');
            $queueId = MqttOutbound::playVoice($sn, $text);
            InspectionService::logOperation([
                'channel_no' => $channelNo, 'inspection_id' => $inspectionId,
                'action' => 'entry_voice',
                'request_payload' => ['cameraSn' => $sn, 'text' => $text, 'queueId' => $queueId],
                'status' => 'success',
            ]);
        }

        if ($on($get('entry_led_enabled', '1'))) {
            $tpl = $get('entry_led_text', '');
            $text = $tpl === '' ? $plate : str_replace('{plate}', $plate, $tpl);
            $queueId = MqttOutbound::ledText($sn, $text);
            InspectionService::logOperation([
                'channel_no' => $channelNo, 'inspection_id' => $inspectionId,
                'action' => 'entry_led',
                'request_payload' => ['cameraSn' => $sn, 'text' => $text, 'queueId' => $queueId],
                'status' => 'success',
            ]);
        }
    }

    /**
     * Alert on a BLACKLISTED plate at the ANPR stage: speak the routing prompt +
     * show it on the camera LED (control card), like announceRecognition.
     * Since the blacklist→x-ray flow the vehicle is let through — the voice
     * directs it to the x-ray instead of denying entry.
     * Settings: blacklist_voice_enabled/text, blacklist_led_enabled/text.
     */
    public static function announceBlacklist(array $channel, string $plate, string $channelNo): void {
        $sn = $channel['anpr_device_sn'] ?? null;
        if (!$sn) return;

        $get = static function (string $key, string $default): string {
            $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
            return $row['value'] ?? $default;
        };
        $on = static fn(string $v) => in_array($v, ['1', 'true', 'True'], true);

        if ($on($get('blacklist_voice_enabled', '1'))) {
            $text = $get('blacklist_voice_text', 'Blacklisted Vehicle. Go To X-RAY');
            $queueId = MqttOutbound::playVoice($sn, $text);
            InspectionService::logOperation([
                'channel_no' => $channelNo,
                'action' => 'blacklist_voice',
                'request_payload' => ['cameraSn' => $sn, 'text' => $text, 'queueId' => $queueId],
                'status' => 'success',
            ]);
        }

        if ($on($get('blacklist_led_enabled', '1'))) {
            $tpl = $get('blacklist_led_text', 'BLACKLIST');
            $text = str_replace('{plate}', $plate, $tpl);
            $queueId = MqttOutbound::ledText($sn, $text);
            InspectionService::logOperation([
                'channel_no' => $channelNo,
                'action' => 'blacklist_led',
                'request_payload' => ['cameraSn' => $sn, 'text' => $text, 'queueId' => $queueId],
                'status' => 'success',
            ]);
        }
    }

    /**
     * Alert on a WHITELIST-ONLY lane denial (plate not on the lane's whitelist).
     * Reuses the blacklist voice/LED enabled switches; only the texts differ
     * (settings whitelist_deny_voice_text / whitelist_deny_led_text).
     */
    public static function announceWhitelistDenied(array $channel, string $plate, string $channelNo): void {
        $sn = $channel['anpr_device_sn'] ?? null;
        if (!$sn) return;

        $get = static function (string $key, string $default): string {
            $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
            return $row['value'] ?? $default;
        };
        $on = static fn(string $v) => in_array($v, ['1', 'true', 'True'], true);

        if ($on($get('blacklist_voice_enabled', '1'))) {
            $text = str_replace('{plate}', $plate,
                $get('whitelist_deny_voice_text', 'Unregistered Vehicle. Go To X-RAY'));
            $queueId = MqttOutbound::playVoice($sn, $text);
            InspectionService::logOperation([
                'channel_no' => $channelNo,
                'action' => 'whitelist_deny_voice',
                'request_payload' => ['cameraSn' => $sn, 'text' => $text, 'queueId' => $queueId],
                'status' => 'success',
            ]);
        }

        if ($on($get('blacklist_led_enabled', '1'))) {
            $text = str_replace('{plate}', $plate, $get('whitelist_deny_led_text', 'NOT REGISTERED'));
            $queueId = MqttOutbound::ledText($sn, $text);
            InspectionService::logOperation([
                'channel_no' => $channelNo,
                'action' => 'whitelist_deny_led',
                'request_payload' => ['cameraSn' => $sn, 'text' => $text, 'queueId' => $queueId],
                'status' => 'success',
            ]);
        }
    }

    private static function entryGateConfig(): array {
        $get = function (string $key, string $default): string {
            $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
            return $row['value'] ?? $default;
        };
        $on = static fn(string $v) => in_array($v, ['1', 'true', 'True'], true);
        return [
            'enabled'       => $on($get('entry_gate_open', '0')),
            'io'            => (int)$get('entry_gate_io', '0'),
            'value'         => (int)$get('entry_gate_value', '2'),
            'delay_ms'      => (int)$get('entry_gate_pulse_ms', '1000'),
            'green_enabled' => $on($get('entry_green_light_enabled', '1')),
            'green_ch'      => (int)$get('entry_green_light_ch', '1'),
            'green_sec'     => (int)$get('entry_green_light_sec', '10'),
        ];
    }

    /**
     * VIP bypass entry point: the come() VIP fast-path skips apply(), so it calls
     * this to lower the blocker like any pass. Same gating applies (per-lane
     * auto-open) — a no-op on manual (auto-open off) lanes.
     */
    public static function openBlockerOnVipBypass(array $inspection, array $channel): void {
        self::openBlocker($inspection, $channel, 'vip_pass');
    }

    /**
     * Lower (OPEN) the road blocker so a cleared vehicle can pass. Driven via the
     * CORX CX-5104E-L relay over MQTT (MqttOutbound::blockerRelay enqueues a pulse;
     * the worker publishes it). We deliberately only OPEN here — raising/closing is
     * left to the hardware controller / manual control (crush-hazard if raised on a
     * blind timer while a vehicle is still passing). See [[road-blocker-corx-relay]].
     */
    private static function openBlocker(array $inspection, array $channel, string $decision): void {
        // Whether the FLOW lowers the blocker on a pass is governed by ONE switch:
        // per-lane `blocker_auto_open` (auto-open toggle on the Road Blocker page),
        // with the global `blocker_auto_open_enabled` as the no-channel fallback.
        //   OFF (default) → the flow never touches the blocker; operate it manually
        //                   from the Road Blocker page. Safe default: the blocker
        //                   has no vehicle-present sensor, so auto-lowering on the
        //                   verdict alone is a collision risk. See [[road-blocker-corx-relay]].
        //   ON            → lower it here on pass (deferred close). The lane then
        //                   stays busy until the barrier is raised again (Raise
        //                   button / sensor advances blocker_cycle to idle).
        // (The lane must also have a relay — per-lane blocker_relay_enabled, or the
        // global relay fallback; blockerRelay() reports it if not.)
        if (!InspectionService::autoOpenEnabled($inspection['channel_no'])) {
            Logger::info("[Decision] inspection #{$inspection['id']} {$decision}: auto blocker-open disabled for this lane (manual only)");
            return;
        }

        // Drive this lane's own relay (per-channel config, falling back to global).
        $result = MqttOutbound::blockerRelay('open', $inspection['channel_no']);

        if (!$result['ok']) {
            Logger::warn("[Decision] inspection #{$inspection['id']} {$decision}: blocker open skipped — {$result['error']}");
            InspectionService::logOperation([
                'channel_no' => $inspection['channel_no'],
                'inspection_id' => $inspection['id'],
                'action' => 'open_blocker_skipped',
                'request_payload' => ['reason' => $result['error']],
                'status' => 'failed',
                'error_message' => $result['error'],
            ]);
            return;
        }

        // Enter the blocker cycle: the lane stays busy (auto-open mode) until the
        // vehicle passes and the barrier is raised again. Advanced by the sensor.
        Database::update('anprc_channels',
            ['blocker_cycle' => 'lowered'], 'channel_no = :c', ['c' => $inspection['channel_no']]);

        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'open_blocker',
            'request_payload' => ['topic' => $result['topic'], 'body' => $result['body'], 'queue_id' => $result['queued']],
            'response_payload' => ['queued' => $result['queued']],
            'status' => 'success',
            'error_message' => null,
        ]);

        Database::update('anprc_inspections', [
            'blocker_opened' => 1,
            'blocker_opened_at' => gmdate('Y-m-d H:i:s'),
        ], 'id = :id', ['id' => $inspection['id']]);
        InspectionService::pushEvent('blocker-opened', [
            'inspectionId' => $inspection['id'],
            'channelNo' => $inspection['channel_no'],
            'licensePlate' => $inspection['license_plate'],
            'decision' => $decision,
        ]);
    }

    private static function sendBackUpAudio(array $inspection, array $channel): void {
        $audioIndex = (int)($channel['failure_audio_index'] ?? 7);
        $s300 = new S300Client($channel['s300_base_url']);

        // WAV file URL the device downloads for the prompt — configurable in Settings.
        $audioUrl = (string)(Database::fetchOne(
            "SELECT value FROM anprc_settings WHERE key_name = 's300_audio_failure_url'"
        )['value'] ?? '');

        $payload = [
            'cmdNo' => 335,
            'data' => [[
                'index' => $audioIndex,
                'language' => 3, // English
                'url' => $audioUrl,
                'desc' => 'Auto: back-up prompt on FAIL',
            ]],
        ];
        // Vendor server takes the channel in the path (protocol doc omits it).
        $result = $s300->post(
            '/api/v1/device-s300/audio-prompt/' . rawurlencode($channel['channel_no']),
            $payload
        );

        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'send_backup_audio',
            'request_payload' => $payload,
            'response_payload' => is_array($result['body']) ? $result['body'] : ['raw' => $result['body']],
            'status' => $result['ok'] ? 'success' : 'failed',
            'error_message' => $result['error'],
        ]);

        InspectionService::pushEvent('failure-audio-sent', [
            'inspectionId' => $inspection['id'],
            'channelNo' => $inspection['channel_no'],
            'licensePlate' => $inspection['license_plate'],
            'audioIndex' => $audioIndex,
        ]);
    }

    /** Re-attempt the /leave for a decided inspection whose first autoLeave failed
     *  (e.g. S300 unreachable at decision time). Used by the cron self-heal sweep. */
    public static function retryAutoLeave(array $inspection, array $channel): bool {
        return self::autoLeave($inspection, $channel);
    }

    private static function autoLeave(array $inspection, array $channel): bool {
        // Per-lane behaviour: no UVIS/S300 on this lane — there is no device to
        // reset, so complete the inspection directly instead of calling /leave.
        if ((int)($channel['behavior_uvis_s300'] ?? 1) === 0) {
            Database::update('anprc_inspections', [
                'state' => 'completed',
                'reset_completed_at' => gmdate('Y-m-d H:i:s'),
            ], 'id = :id', ['id' => $inspection['id']]);
            return true;
        }

        $s300 = new S300Client($channel['s300_base_url']);
        // Vendor server takes POST here (protocol doc says GET).
        $result = $s300->post('/api/v1/channel-s300/leave/' . rawurlencode($channel['channel_no']));

        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'auto_leave',
            'request_payload' => null,
            'response_payload' => is_array($result['body']) ? $result['body'] : ['raw' => $result['body']],
            'status' => $result['ok'] ? 'success' : 'failed',
            'error_message' => $result['error'],
        ]);

        if ($result['ok']) {
            Database::update('anprc_inspections', [
                'auto_leave_called' => 1,
                'leave_called_at' => gmdate('Y-m-d H:i:s'),
            ], 'id = :id', ['id' => $inspection['id']]);
            // Only flip state if not already further along
            Database::query(
                "UPDATE anprc_inspections SET state = 'resetting'
                 WHERE id = ? AND state IN ('pending','started','inspecting')",
                [$inspection['id']]
            );
        }
        return (bool)$result['ok'];
    }
}
