<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Services\InspectionService;

class SettingsController {
    public function index(Request $req) {
        $rows = Database::fetchAll('SELECT * FROM anprc_settings');
        $map = [];
        foreach ($rows as $r) $map[$r['key_name']] = $r['value'];
        return ['code' => 200, 'message' => 'success', 'data' => $map];
    }

    public function update(Request $req) {
        $body = $req->json();
        $actor = AuthController::usernameFromRequest($req);
        foreach ($body as $k => $v) {
            Database::query(
                "INSERT INTO anprc_settings (key_name, value) VALUES (:k, :v)
                 ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value",
                ['k' => $k, 'v' => (string)$v]
            );
        }
        InspectionService::logOperation([
            'actor_username' => $actor,
            'action' => 'settings.update',
            'request_payload' => $body,
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'updated', 'data' => null];
    }
}
