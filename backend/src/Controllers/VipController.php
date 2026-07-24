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
            'data' => Database::fetchAll('SELECT * FROM anprc_vip_plates ORDER BY id DESC'),
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
        // Scopes: channel_nos = ['RJ001','RJ002'] creates one row per lane;
        // empty/absent = one row with channel_no NULL (applies to ALL lanes).
        $scopes = [];
        if (!empty($body['channel_nos']) && is_array($body['channel_nos'])) {
            foreach ($body['channel_nos'] as $c) {
                $c = trim((string)$c);
                if ($c !== '' && !in_array($c, $scopes, true)) $scopes[] = $c;
            }
        }
        if (!$scopes) $scopes = [null];

        $created = [];
        $skipped = [];
        foreach ($scopes as $scope) {
            $existing = Database::fetchOne(
                "SELECT id FROM anprc_vip_plates
                 WHERE license_plate = ? AND COALESCE(channel_no, '*') = COALESCE(?, '*')",
                [$plate, $scope]
            );
            if ($existing) { $skipped[] = $scope ?? '*'; continue; }
            $id = Database::insert('anprc_vip_plates', [
                'license_plate' => $plate,
                'description' => $body['description'] ?? null,
                'enabled' => isset($body['enabled']) ? (int)(bool)$body['enabled'] : 1,
                'channel_no' => $scope,
                // NULL/'' = permanent
                'expires_at' => !empty($body['expires_at']) ? $body['expires_at'] : null,
            ]);
            $created[] = Database::fetchOne('SELECT * FROM anprc_vip_plates WHERE id = ?', [$id]);
        }
        if (!$created) {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'vip.create',
                'request_payload' => $body, 'status' => 'failed',
                'error_message' => "VIP plate '$plate' already exists in the selected scope(s)",
            ]);
            Response::error("VIP plate '$plate' already exists in the selected scope(s)", 409);
            return null;
        }
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'vip.create',
            'request_payload' => $body,
            'response_payload' => ['created' => $created, 'skipped_scopes' => $skipped],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'created', 'data' => [
            'created' => $created, 'skipped_scopes' => $skipped,
        ]];
    }

    public function update(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $row = Database::fetchOne('SELECT * FROM anprc_vip_plates WHERE id = ?', [$id]);
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
        if (array_key_exists('expires_at', $body))  $upd['expires_at'] = !empty($body['expires_at']) ? $body['expires_at'] : null;
        if ($upd) Database::update('anprc_vip_plates', $upd, 'id = :id', ['id' => $id]);
        $fresh = Database::fetchOne('SELECT * FROM anprc_vip_plates WHERE id = ?', [$id]);
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
        $existing = Database::fetchOne('SELECT license_plate FROM anprc_vip_plates WHERE id = ?', [$id]);
        Database::query('DELETE FROM anprc_vip_plates WHERE id = ?', [$id]);
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
