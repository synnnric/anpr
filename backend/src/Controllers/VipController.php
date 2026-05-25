<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;

class VipController {
    public function index(Request $req) {
        return [
            'code' => 200, 'message' => 'success',
            'data' => Database::fetchAll('SELECT * FROM vip_plates ORDER BY id DESC'),
        ];
    }

    public function create(Request $req) {
        $body = $req->json();
        $plate = trim((string)($body['license_plate'] ?? ''));
        if ($plate === '') {
            Response::error('license_plate required', 400);
            return null;
        }
        $existing = Database::fetchOne('SELECT id FROM vip_plates WHERE license_plate = ?', [$plate]);
        if ($existing) {
            Response::error("VIP plate '$plate' already exists", 409);
            return null;
        }
        $id = Database::insert('vip_plates', [
            'license_plate' => $plate,
            'description' => $body['description'] ?? null,
            'enabled' => isset($body['enabled']) ? (int)(bool)$body['enabled'] : 1,
        ]);
        return [
            'code' => 200, 'message' => 'created',
            'data' => Database::fetchOne('SELECT * FROM vip_plates WHERE id = ?', [$id]),
        ];
    }

    public function update(Request $req) {
        $id = (int)$req->param('id');
        $row = Database::fetchOne('SELECT * FROM vip_plates WHERE id = ?', [$id]);
        if (!$row) { Response::notFound('VIP plate not found'); return null; }
        $body = $req->json();
        $upd = [];
        if (array_key_exists('description', $body)) $upd['description'] = $body['description'];
        if (array_key_exists('enabled', $body))     $upd['enabled'] = (int)(bool)$body['enabled'];
        if ($upd) Database::update('vip_plates', $upd, 'id = :id', ['id' => $id]);
        return [
            'code' => 200, 'message' => 'updated',
            'data' => Database::fetchOne('SELECT * FROM vip_plates WHERE id = ?', [$id]),
        ];
    }

    public function destroy(Request $req) {
        $id = (int)$req->param('id');
        Database::query('DELETE FROM vip_plates WHERE id = ?', [$id]);
        return ['code' => 200, 'message' => 'deleted', 'data' => null];
    }

    // GET /api/vip/check/{plate}
    public function check(Request $req) {
        $plate = trim((string)$req->param('plate'));
        $isVip = \App\Services\InspectionService::isVip($plate);
        return ['code' => 200, 'message' => 'success', 'data' => ['plate' => $plate, 'vip' => $isVip]];
    }
}
