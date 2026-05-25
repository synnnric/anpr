<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\InspectionService;

class VipController {
    public function index(Request $req) {
        return [
            'code' => 200, 'message' => 'success',
            'data' => Database::fetchAll('SELECT * FROM vip_plates ORDER BY id DESC'),
        ];
    }

    public function create(Request $req) {
        $body = $req->json();
        $actor = AuthController::usernameFromRequest($req);
        $plate = trim((string)($body['license_plate'] ?? ''));
        if ($plate === '') {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'vip.create',
                'request_payload' => $body, 'status' => 'failed',
                'error_message' => 'license_plate required',
            ]);
            Response::error('license_plate required', 400);
            return null;
        }
        $existing = Database::fetchOne('SELECT id FROM vip_plates WHERE license_plate = ?', [$plate]);
        if ($existing) {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'vip.create',
                'request_payload' => $body, 'status' => 'failed',
                'error_message' => "VIP plate '$plate' already exists",
            ]);
            Response::error("VIP plate '$plate' already exists", 409);
            return null;
        }
        $id = Database::insert('vip_plates', [
            'license_plate' => $plate,
            'description' => $body['description'] ?? null,
            'enabled' => isset($body['enabled']) ? (int)(bool)$body['enabled'] : 1,
        ]);
        $row = Database::fetchOne('SELECT * FROM vip_plates WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'vip.create',
            'request_payload' => $body,
            'response_payload' => $row,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'created', 'data' => $row];
    }

    public function update(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $row = Database::fetchOne('SELECT * FROM vip_plates WHERE id = ?', [$id]);
        if (!$row) {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'vip.update',
                'request_payload' => ['id' => $id], 'status' => 'failed',
                'error_message' => "VIP plate #$id not found",
            ]);
            Response::notFound('VIP plate not found'); return null;
        }
        $body = $req->json();
        $upd = [];
        if (array_key_exists('description', $body)) $upd['description'] = $body['description'];
        if (array_key_exists('enabled', $body))     $upd['enabled'] = (int)(bool)$body['enabled'];
        if ($upd) Database::update('vip_plates', $upd, 'id = :id', ['id' => $id]);
        $fresh = Database::fetchOne('SELECT * FROM vip_plates WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'vip.update',
            'request_payload' => ['id' => $id, 'plate' => $row['license_plate'], 'changes' => $upd],
            'response_payload' => $fresh,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'updated', 'data' => $fresh];
    }

    public function destroy(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $existing = Database::fetchOne('SELECT license_plate FROM vip_plates WHERE id = ?', [$id]);
        Database::query('DELETE FROM vip_plates WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'vip.delete',
            'request_payload' => ['id' => $id, 'plate' => $existing['license_plate'] ?? null],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'deleted', 'data' => null];
    }

    // GET /api/vip/check/{plate}
    public function check(Request $req) {
        $plate = trim((string)$req->param('plate'));
        $isVip = \App\Services\InspectionService::isVip($plate);
        return ['code' => 200, 'message' => 'success', 'data' => ['plate' => $plate, 'vip' => $isVip]];
    }
}
