<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\InspectionService;

class ChannelController {
    public function index(Request $req) {
        return ['code' => 200, 'message' => 'success', 'data' => Database::fetchAll('SELECT * FROM anprc_channels ORDER BY id ASC')];
    }

    public function show(Request $req) {
        $row = Database::fetchOne('SELECT * FROM anprc_channels WHERE id = ?', [$req->param('id')]);
        if (!$row) { Response::notFound('Channel not found'); return null; }
        return ['code' => 200, 'message' => 'success', 'data' => $row];
    }

    private const RB_FIELDS = ['rb_ip', 'rb_port', 'rb_device_no', 'rb_board_id', 'rb_column_num', 'uvis_timeout_sec', 'failure_audio_index', 'kind', 'paired_channel_id'];

    public function create(Request $req) {
        $body = $req->json();
        $actor = AuthController::usernameFromRequest($req);
        if (empty($body['channel_no']) || empty($body['s300_base_url'])) {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'channel.create',
                'request_payload' => $body, 'status' => 'failed',
                'error_message' => 'channel_no and s300_base_url required',
            ]);
            Response::error('channel_no and s300_base_url required', 400);
            return null;
        }
        $data = [
            'channel_no' => $body['channel_no'],
            'anpr_device_sn' => $body['anpr_device_sn'] ?? null,
            's300_base_url' => rtrim($body['s300_base_url'], '/'),
            'name' => $body['name'] ?? null,
            'enabled' => isset($body['enabled']) ? (int)(bool)$body['enabled'] : 1,
        ];
        foreach (self::RB_FIELDS as $k) {
            if (array_key_exists($k, $body)) $data[$k] = $body[$k];
        }
        $id = Database::insert('anprc_channels', $data);
        $row = Database::fetchOne('SELECT * FROM anprc_channels WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $row['channel_no'] ?? null,
            'action' => 'channel.create',
            'request_payload' => $body,
            'response_payload' => $row,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'created', 'data' => $row];
    }

    public function update(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $existing = Database::fetchOne('SELECT * FROM anprc_channels WHERE id = ?', [$id]);
        if (!$existing) {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'channel.update',
                'request_payload' => ['id' => $id], 'status' => 'failed',
                'error_message' => "Channel #$id not found",
            ]);
            Response::notFound('Channel not found'); return null;
        }
        $body = $req->json();
        $allowed = array_merge(['channel_no', 'anpr_device_sn', 's300_base_url', 'name', 'enabled'], self::RB_FIELDS);
        $update = [];
        foreach ($allowed as $k) {
            if (array_key_exists($k, $body)) {
                $update[$k] = $k === 's300_base_url' ? rtrim((string)$body[$k], '/') : $body[$k];
            }
        }
        if ($update) Database::update('anprc_channels', $update, 'id = :id', ['id' => $id]);
        $row = Database::fetchOne('SELECT * FROM anprc_channels WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $existing['channel_no'] ?? null,
            'action' => 'channel.update',
            'request_payload' => ['id' => $id, 'changes' => $update],
            'response_payload' => $row,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'updated', 'data' => $row];
    }

    public function destroy(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $existing = Database::fetchOne('SELECT channel_no FROM anprc_channels WHERE id = ?', [$id]);
        Database::query('DELETE FROM anprc_channels WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'channel_no' => $existing['channel_no'] ?? null,
            'action' => 'channel.delete',
            'request_payload' => ['id' => $id],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'deleted', 'data' => null];
    }

    public function status(Request $req) {
        $channelNo = $req->param('channelNo');
        $channel = Database::fetchOne('SELECT * FROM anprc_channels WHERE channel_no = ?', [$channelNo]);
        if (!$channel) { Response::notFound('Channel not found'); return null; }
        $st = \App\Services\InspectionService::getChannelStatus($channelNo);
        return ['code' => 200, 'message' => 'success', 'data' => array_merge($st, ['channel' => $channel])];
    }
}
