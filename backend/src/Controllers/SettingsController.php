<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;

class SettingsController {
    public function index(Request $req) {
        $rows = Database::fetchAll('SELECT * FROM settings');
        $map = [];
        foreach ($rows as $r) $map[$r['key_name']] = $r['value'];
        return ['code' => 200, 'message' => 'success', 'data' => $map];
    }

    public function update(Request $req) {
        $body = $req->json();
        foreach ($body as $k => $v) {
            Database::query(
                "INSERT INTO settings (key_name, value) VALUES (:k, :v)
                 ON CONFLICT (key_name) DO UPDATE SET value = EXCLUDED.value",
                ['k' => $k, 'v' => (string)$v]
            );
        }
        return ['code' => 200, 'message' => 'updated', 'data' => null];
    }
}
