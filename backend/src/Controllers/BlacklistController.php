<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\InspectionService;

/**
 * CRUD for the ANPR-stage deny list (blacklist_plates). A plate on this list is
 * refused entry at /come — see S300Controller::come.
 */
class BlacklistController {
    public function index(Request $req) {
        return [
            'code' => 200, 'message' => 'success',
            'data' => Database::fetchAll('SELECT * FROM anprc_blacklist_plates ORDER BY id DESC'),
        ];
    }

    public function create(Request $req) {
        $body = $req->json();
        $actor = AuthController::usernameFromRequest($req);
        $plate = trim((string)($body['license_plate'] ?? ''));
        if ($plate === '') {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'blacklist.create',
                'request_payload' => $body, 'status' => 'failed',
                'error_message' => 'license_plate required',
            ]);
            Response::error('license_plate required', 400);
            return null;
        }
        $existing = Database::fetchOne('SELECT id FROM anprc_blacklist_plates WHERE license_plate = ?', [$plate]);
        if ($existing) {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'blacklist.create',
                'request_payload' => $body, 'status' => 'failed',
                'error_message' => "Blacklist plate '$plate' already exists",
            ]);
            Response::error("Blacklist plate '$plate' already exists", 409);
            return null;
        }
        $id = Database::insert('anprc_blacklist_plates', [
            'license_plate' => $plate,
            'description' => $body['description'] ?? null,
            'enabled' => isset($body['enabled']) ? (int)(bool)$body['enabled'] : 1,
        ]);
        $row = Database::fetchOne('SELECT * FROM anprc_blacklist_plates WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'blacklist.create',
            'request_payload' => $body,
            'response_payload' => $row,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'created', 'data' => $row];
    }

    public function update(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $row = Database::fetchOne('SELECT * FROM anprc_blacklist_plates WHERE id = ?', [$id]);
        if (!$row) {
            InspectionService::logOperation([
                'actor_username' => $actor, 'action' => 'blacklist.update',
                'request_payload' => ['id' => $id], 'status' => 'failed',
                'error_message' => "Blacklist plate #$id not found",
            ]);
            Response::notFound('Blacklist plate not found'); return null;
        }
        $body = $req->json();
        $upd = [];
        if (array_key_exists('description', $body)) $upd['description'] = $body['description'];
        if (array_key_exists('enabled', $body))     $upd['enabled'] = (int)(bool)$body['enabled'];
        if ($upd) Database::update('anprc_blacklist_plates', $upd, 'id = :id', ['id' => $id]);
        $fresh = Database::fetchOne('SELECT * FROM anprc_blacklist_plates WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'blacklist.update',
            'request_payload' => ['id' => $id, 'plate' => $row['license_plate'], 'changes' => $upd],
            'response_payload' => $fresh,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'updated', 'data' => $fresh];
    }

    public function destroy(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $existing = Database::fetchOne('SELECT license_plate FROM anprc_blacklist_plates WHERE id = ?', [$id]);
        Database::query('DELETE FROM anprc_blacklist_plates WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'blacklist.delete',
            'request_payload' => ['id' => $id, 'plate' => $existing['license_plate'] ?? null],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'deleted', 'data' => null];
    }

    // GET /api/blacklist/check/{plate}
    public function check(Request $req) {
        $plate = trim((string)$req->param('plate'));
        $isBlacklisted = InspectionService::isBlacklisted($plate);
        return ['code' => 200, 'message' => 'success', 'data' => ['plate' => $plate, 'blacklisted' => $isBlacklisted]];
    }
}
