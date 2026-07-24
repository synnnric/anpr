<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\InspectionService;

/**
 * Master list of site locations/zones (e.g. "Gerbang Pancasila", "Gerbang 46").
 * Feeds the channel form's location dropdown. Channels store the NAME, so the
 * master list is purely a picklist — deleting an entry never breaks channels.
 */
class LocationController {
    public function index(Request $req) {
        return ['code' => 200, 'message' => 'success',
                'data' => Database::fetchAll('SELECT * FROM anprc_locations ORDER BY name ASC')];
    }

    public function create(Request $req) {
        $name = trim((string)$req->input('name', ''));
        $actor = AuthController::usernameFromRequest($req);
        if ($name === '') { Response::error('name required', 400); return null; }
        $exists = Database::fetchOne('SELECT id FROM anprc_locations WHERE LOWER(name) = LOWER(?)', [$name]);
        if ($exists) { Response::error("Location already exists: $name", 409); return null; }
        $id = Database::insert('anprc_locations', ['name' => mb_substr($name, 0, 64)]);
        $row = Database::fetchOne('SELECT * FROM anprc_locations WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor, 'action' => 'location.create',
            'request_payload' => ['name' => $name], 'response_payload' => $row,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'created', 'data' => $row];
    }

    public function destroy(Request $req) {
        $id = (int)$req->param('id');
        $actor = AuthController::usernameFromRequest($req);
        $row = Database::fetchOne('SELECT * FROM anprc_locations WHERE id = ?', [$id]);
        if (!$row) { Response::notFound('Location not found'); return null; }
        // Refuse while channels still point at it — clear those first.
        $used = (int)(Database::fetchOne(
            'SELECT COUNT(*)::int AS c FROM anprc_channels WHERE location = ?', [$row['name']]
        )['c'] ?? 0);
        if ($used > 0) {
            Response::error("Location in use by $used channel(s)", 409);
            return null;
        }
        Database::query('DELETE FROM anprc_locations WHERE id = ?', [$id]);
        InspectionService::logOperation([
            'actor_username' => $actor, 'action' => 'location.delete',
            'request_payload' => ['id' => $id, 'name' => $row['name']],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'deleted', 'data' => null];
    }
}
