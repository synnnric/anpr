<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\InspectionService;
use App\Services\MqttOutbound;

/**
 * Manual ANPR camera actions from the CP (ANPR Control page), addressed by
 * CHANNEL — the camera SN comes from the channel config, not the browser.
 * Commands go through the outbound queue → worker, the same proven path the
 * automatic flow uses (voice = serial_data control-card frames; the camera has
 * no working native tts_voice command on real hardware).
 */
class AnprController {
    /** Resolve a channel that has an ANPR camera, or respond 4xx and return null. */
    private static function cameraChannel(string $channelNo): ?array {
        $ch = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
        if (!$ch) { Response::notFound("Channel $channelNo not found"); return null; }
        if (empty($ch['anpr_device_sn'])) {
            Response::error("Channel $channelNo has no ANPR device SN configured", 400);
            return null;
        }
        return $ch;
    }

    // POST /api/anpr/speak  body: {channel_no, text}
    public function speak(Request $req) {
        $body = $req->json();
        $channelNo = trim((string)($body['channel_no'] ?? ''));
        $text = trim((string)($body['text'] ?? ''));
        $actor = AuthController::usernameFromRequest($req);
        if ($channelNo === '' || $text === '') {
            Response::error('channel_no and text required', 400);
            return null;
        }
        $ch = self::cameraChannel($channelNo);
        if (!$ch) return null;

        $queueId = MqttOutbound::playVoice($ch['anpr_device_sn'], $text);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $channelNo,
            'action' => 'anpr_speak',
            'request_payload' => ['cameraSn' => $ch['anpr_device_sn'], 'text' => $text, 'queueId' => $queueId],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'queued', 'data' => [
            'queueId' => $queueId, 'cameraSn' => $ch['anpr_device_sn'],
        ]];
    }

    // POST /api/anpr/gate-open  body: {channel_no}
    // Bare relay pulse only. A manual admit WITH a plate goes through the
    // normal flow instead (the CP calls /api/s300/come/{ch} — same as a
    // camera recognition, so the standard inspection runs).
    public function gateOpen(Request $req) {
        $body = $req->json();
        $channelNo = trim((string)($body['channel_no'] ?? ''));
        $actor = AuthController::usernameFromRequest($req);
        if ($channelNo === '') {
            Response::error('channel_no required', 400);
            return null;
        }
        $ch = self::cameraChannel($channelNo);
        if (!$ch) return null;

        // Same relay pulse the automatic flow uses (settings entry_gate_*).
        $get = static function (string $key, string $default): string {
            $row = Database::fetchOne('SELECT value FROM anprc_settings WHERE key_name = ?', [$key]);
            return $row['value'] ?? $default;
        };
        $io = (int)$get('entry_gate_io', '0');
        $value = (int)$get('entry_gate_value', '2');
        $delay = (int)$get('entry_gate_pulse_ms', '1000');
        $queueId = MqttOutbound::gateOpen($ch['anpr_device_sn'], $io, $value, $delay);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $channelNo,
            'action' => 'anpr_gate_open_manual',
            'request_payload' => ['cameraSn' => $ch['anpr_device_sn'], 'io' => $io, 'value' => $value, 'delay' => $delay, 'queueId' => $queueId],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'queued', 'data' => [
            'queueId' => $queueId, 'cameraSn' => $ch['anpr_device_sn'],
        ]];
    }
}
