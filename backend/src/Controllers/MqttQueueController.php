<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;

class MqttQueueController {
    /**
     * GET /api/mqtt-queue/pending?limit=20
     * Returns pending outbound MQTT commands for the worker to publish.
     * The worker is expected to call /sent or /failed after publishing.
     */
    public function pending(Request $req) {
        $limit = max(1, min(100, (int)$req->input('limit', 20)));
        $rows = Database::fetchAll(
            "SELECT id, device_sn, command_name, payload, attempts, created_at
             FROM anprc_mqtt_outbound_queue
             WHERE status = 'pending'
             ORDER BY id ASC LIMIT $limit"
        );
        foreach ($rows as &$r) {
            $r['payload'] = json_decode($r['payload'], true);
        }
        return ['code' => 200, 'message' => 'success', 'data' => $rows];
    }

    /**
     * POST /api/mqtt-queue/{id}/sent — worker reports successful publish
     */
    public function sent(Request $req) {
        $id = (int)$req->param('id');
        Database::update('anprc_mqtt_outbound_queue', [
            'status' => 'sent',
            'sent_at' => gmdate('Y-m-d H:i:s'),
            'attempts' => (int)Database::fetchOne('SELECT attempts FROM anprc_mqtt_outbound_queue WHERE id = ?', [$id])['attempts'] + 1,
        ], 'id = :id', ['id' => $id]);
        return ['code' => 200, 'message' => 'ok', 'data' => null];
    }

    /**
     * POST /api/mqtt-queue/{id}/failed — worker reports publish failure
     * Body: { error: "...", giveUp: bool }
     */
    public function failed(Request $req) {
        $id = (int)$req->param('id');
        $body = $req->json();
        $row = Database::fetchOne('SELECT * FROM anprc_mqtt_outbound_queue WHERE id = ?', [$id]);
        if (!$row) { Response::notFound(); return null; }
        $attempts = (int)$row['attempts'] + 1;
        $giveUp = !empty($body['giveUp']) || $attempts >= 5;
        Database::update('anprc_mqtt_outbound_queue', [
            'status' => $giveUp ? 'failed' : 'pending',
            'attempts' => $attempts,
            'last_error' => substr((string)($body['error'] ?? 'unknown'), 0, 500),
        ], 'id = :id', ['id' => $id]);
        return ['code' => 200, 'message' => 'ok', 'data' => ['attempts' => $attempts, 'giveUp' => $giveUp]];
    }
}
