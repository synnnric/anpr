<?php
namespace App\Services;

use App\Core\Database;
use App\Core\Logger;

/**
 * Executes the verdict produced by DecisionEngine:
 *   pass / suspect / vip_pass → open road blocker
 *   fail                      → push back-up audio prompt
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

        Database::update('inspections', [
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

        // Branch on decision
        if (in_array($decision, ['pass', 'suspect', 'vip_pass'], true)) {
            self::openBlocker($inspection, $channel, $decision);
            self::whitelistOnExitCamera($inspection, $channel);
        } else if ($decision === 'fail') {
            self::sendBackUpAudio($inspection, $channel);
            self::markVisitDenied($inspection, $reason);
        }

        // Auto-/leave so S300 can reset (except for VIP which never started)
        if ($decision !== 'vip_pass') {
            self::autoLeave($inspection, $channel);
        }
    }

    private static function whitelistOnExitCamera(array $inspection, array $channel): void {
        $exit = VisitService::findPairedExit($channel);
        if (!$exit || empty($exit['anpr_device_sn'])) {
            InspectionService::logOperation([
                'channel_no' => $inspection['channel_no'],
                'inspection_id' => $inspection['id'],
                'action' => 'whitelist_skipped',
                'request_payload' => ['reason' => 'no paired exit channel with anpr_device_sn'],
                'status' => 'failed',
                'error_message' => 'configure a paired exit channel on this entry channel',
            ]);
            return;
        }
        $queueId = MqttOutbound::whitelistAdd(
            $exit['anpr_device_sn'],
            $inspection['license_plate'],
            "auto entry pass inspection #{$inspection['id']}"
        );
        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'whitelist_enqueue_add',
            'request_payload' => [
                'exitCameraSn' => $exit['anpr_device_sn'],
                'plate' => $inspection['license_plate'],
                'queueId' => $queueId,
            ],
            'status' => 'success',
        ]);
    }

    private static function markVisitDenied(array $inspection, string $reason): void {
        $visit = Database::fetchOne(
            'SELECT * FROM visits WHERE entry_inspection_id = ? LIMIT 1',
            [$inspection['id']]
        );
        if ($visit && $visit['status'] === 'active') {
            VisitService::markEntryDenied((int)$visit['id'], $reason);
        }
    }

    private static function openBlocker(array $inspection, array $channel, string $decision): void {
        if (empty($channel['rb_ip']) || empty($channel['rb_device_no']) || empty($channel['rb_board_id'])) {
            Logger::warn("[Decision] inspection #{$inspection['id']} {$decision} but channel {$channel['channel_no']} has no road blocker configured");
            InspectionService::logOperation([
                'channel_no' => $inspection['channel_no'],
                'inspection_id' => $inspection['id'],
                'action' => 'open_blocker_skipped',
                'request_payload' => ['reason' => 'road blocker not configured'],
                'status' => 'failed',
                'error_message' => 'rb_ip/rb_device_no/rb_board_id not set on channel',
            ]);
            return;
        }

        $client = new RoadBlockerClient($channel['rb_ip'], (int)$channel['rb_port']);
        $result = $client->openColumn(
            $channel['rb_device_no'],
            $channel['rb_board_id'],
            (int)$channel['rb_column_num']
        );

        InspectionService::logOperation([
            'channel_no' => $inspection['channel_no'],
            'inspection_id' => $inspection['id'],
            'action' => 'open_blocker',
            'request_payload' => [
                'deviceNo' => $channel['rb_device_no'],
                'boardId' => $channel['rb_board_id'],
                'columnNum' => (int)$channel['rb_column_num'],
                'action' => 'down',
            ],
            'response_payload' => is_array($result['body']) ? $result['body'] : ['raw' => $result['body']],
            'status' => $result['ok'] ? 'success' : 'failed',
            'error_message' => $result['error'],
        ]);

        if ($result['ok']) {
            Database::update('inspections', [
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
    }

    private static function sendBackUpAudio(array $inspection, array $channel): void {
        $audioIndex = (int)($channel['failure_audio_index'] ?? 7);
        $s300 = new S300Client($channel['s300_base_url']);

        $payload = [
            'cmdNo' => 335,
            'data' => [[
                'index' => $audioIndex,
                'language' => 3, // English
                'url' => '',
                'desc' => 'Auto: back-up prompt on FAIL',
            ]],
        ];
        $result = $s300->post('/api/v1/device-s300/audio-prompt', $payload);

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

    private static function autoLeave(array $inspection, array $channel): void {
        $s300 = new S300Client($channel['s300_base_url']);
        $result = $s300->get('/api/v1/channel-s300/leave/' . rawurlencode($channel['channel_no']));

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
            Database::update('inspections', [
                'auto_leave_called' => 1,
                'leave_called_at' => gmdate('Y-m-d H:i:s'),
            ], 'id = :id', ['id' => $inspection['id']]);
            // Only flip state if not already further along
            Database::query(
                "UPDATE inspections SET state = 'resetting'
                 WHERE id = ? AND state IN ('pending','started','inspecting')",
                [$inspection['id']]
            );
        }
    }
}
