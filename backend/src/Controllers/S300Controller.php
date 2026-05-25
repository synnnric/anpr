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
        $channel = Database::fetchOne('SELECT * FROM channels WHERE channel_no = ?', [$channelNo]);
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

    private static function callAndLog(string $action, string $channelNo, callable $call, ?array $reqPayload = null, ?int $inspectionId = null): array {
        $result = $call();
        InspectionService::logOperation([
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

    // POST /api/s300/come/{channelNo}  body: {licensePlateNo, force?: bool}
    public function come(Request $req): void {
        $channelNo = $req->param('channelNo');
        $plate = trim((string)$req->input('licensePlateNo', ''));
        $force = (bool)$req->input('force', false);
        if ($plate === '') {
            Response::error('licensePlateNo required', 400);
            return;
        }

        // === VIP bypass ===
        if (InspectionService::isVip($plate)) {
            $id = Database::insert('inspections', [
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
            $channel = Database::fetchOne('SELECT * FROM channels WHERE channel_no = ?', [$channelNo]);
            if ($channel) {
                $exit = VisitService::findPairedExit($channel);
                if ($exit && !empty($exit['anpr_device_sn'])) {
                    \App\Services\MqttOutbound::whitelistAdd(
                        $exit['anpr_device_sn'], $plate, "VIP entry inspection #$id"
                    );
                }
            }
            InspectionService::logOperation([
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
            'SELECT id FROM vehicles WHERE license_plate = ? ORDER BY id DESC LIMIT 1',
            [$plate]
        );

        $timeoutSec = (int)($channel['uvis_timeout_sec'] ?? 30);
        try {
            $inspectionId = Database::insert('inspections', [
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

        // Open a visit record so we can pair it to the eventual exit
        VisitService::createEntry($plate, $channelNo, $inspectionId);

        $result = self::callAndLog('come', $channelNo, function () use ($client, $channelNo, $plate) {
            return $client->post("/api/v1/channel-s300/come/$channelNo", ['licensePlateNo' => $plate]);
        }, ['licensePlateNo' => $plate], $inspectionId);

        Response::json([
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
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
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('capture', $channelNo, function () use ($client, $channelNo) {
            return $client->get("/api/v1/channel-s300/capture/$channelNo");
        }, null, $inspection['id'] ?? null);

        Response::json([
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // GET /api/s300/leave/{channelNo}
    public function leave(Request $req): void {
        $channelNo = $req->param('channelNo');
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('leave', $channelNo, function () use ($client, $channelNo) {
            return $client->get("/api/v1/channel-s300/leave/$channelNo");
        }, null, $inspection['id'] ?? null);

        if ($inspection && $result['ok']) {
            Database::update('inspections', [
                'leave_called_at' => gmdate('Y-m-d H:i:s'),
                'state' => 'resetting',
            ], 'id = :id', ['id' => $inspection['id']]);
        }

        Response::json([
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/read-work-status/{channelNo}
    public function readWorkStatus(Request $req): void {
        $channelNo = $req->param('channelNo');
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('read_work_status', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/device-s300/read-work-status/$channelNo");
        }, null, $inspection['id'] ?? null);

        Response::json([
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/emergency-stop/{channelNo}
    public function emergencyStop(Request $req): void {
        $channelNo = $req->param('channelNo');
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('emergency_stop', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/device-s300/emergency-stop/$channelNo");
        }, null, $inspection['id'] ?? null);

        if ($inspection && $result['ok']) {
            Database::update('inspections', ['state' => 'emergency_stop'], 'id = :id', ['id' => $inspection['id']]);
        }

        Response::json([
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/manual-reset/{channelNo}
    public function manualReset(Request $req): void {
        $channelNo = $req->param('channelNo');
        [$client] = self::clientForChannel($channelNo);
        $inspection = InspectionService::findActiveInspection($channelNo);

        $result = self::callAndLog('manual_reset', $channelNo, function () use ($client, $channelNo) {
            return $client->post("/api/v1/device-s300/manual-reset/$channelNo");
        }, null, $inspection['id'] ?? null);

        Response::json([
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }

    // POST /api/s300/audio-prompt   body: {channelNo, data:[{index, language, url, desc}]}
    public function audioPrompt(Request $req): void {
        $body = $req->json();
        $channelNo = $body['channelNo'] ?? null;
        $data = $body['data'] ?? [];
        if (!$channelNo || !is_array($data) || empty($data)) {
            Response::error('channelNo and data[] required', 400);
            return;
        }

        [$client] = self::clientForChannel($channelNo);

        $payload = ['cmdNo' => 335, 'data' => $data];
        $result = self::callAndLog('audio_prompt', $channelNo, function () use ($client, $payload) {
            return $client->post('/api/v1/device-s300/audio-prompt', $payload);
        }, $payload);

        if ($result['ok']) {
            foreach ($data as $item) {
                if (!isset($item['index'], $item['language'], $item['url'])) continue;
                Database::query(
                    "INSERT INTO audio_prompts (audio_index, language, url, description)
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
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
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
        if (!$channelNo || !$startTime || !$endTime) {
            Response::error('channelNo, startTime, endTime required', 400);
            return;
        }

        [$client] = self::clientForChannel($channelNo);

        $payload = compact('channelNo', 'startTime', 'endTime');
        $result = self::callAndLog('video_playback', $channelNo, function () use ($client, $payload) {
            return $client->post('/api/v1/device-s300/video-playback', $payload);
        }, $payload);

        Response::json([
            'code' => $result['ok'] ? 200 : ($result['status'] ?: 500),
            'message' => $result['ok'] ? 'success' : ($result['error'] ?? 'failed'),
            'data' => $result['body'],
        ]);
    }
}
