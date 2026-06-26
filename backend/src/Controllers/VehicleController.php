<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\ImageStorage;

class VehicleController {
    public function index(Request $req) {
        $limit = max(1, min(500, (int)$req->input('limit', 100)));
        $offset = max(0, (int)$req->input('offset', 0));
        $plate = $req->input('plate');
        $where = []; $params = [];
        if ($plate) { $where[] = 'license_plate ILIKE :pl'; $params['pl'] = "%$plate%"; }

        $sql = 'SELECT * FROM anprc_vehicles';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;

        $rows = Database::fetchAll($sql, $params);
        $total = Database::fetchOne(
            'SELECT COUNT(*) as c FROM anprc_vehicles' . ($where ? ' WHERE ' . implode(' AND ', $where) : ''),
            $params
        )['c'] ?? 0;
        return ['code' => 200, 'message' => 'success', 'data' => ['items' => $rows, 'total' => (int)$total]];
    }

    // Called from frontend MQTT context when a plate is recognized
    public function create(Request $req) {
        $body = $req->json();
        if (empty($body['license_plate'])) {
            Response::error('license_plate required', 400);
            return null;
        }
        // ivs_result snapshots arrive as base64; save them to files (like UVIS).
        $fullPath = !empty($body['full_image_b64'])
            ? ImageStorage::saveBase64('vehicles', $body['full_image_b64'])
            : ($body['full_image_path'] ?? null);
        $smallPath = !empty($body['small_image_b64'])
            ? ImageStorage::saveBase64('vehicles', $body['small_image_b64'])
            : ($body['small_image_path'] ?? null);

        $id = Database::insert('anprc_vehicles', [
            'license_plate' => $body['license_plate'],
            'plate_type' => $body['plate_type'] ?? null,
            'plate_color' => $body['plate_color'] ?? null,
            'car_color' => $body['car_color'] ?? null,
            'confidence' => $body['confidence'] ?? null,
            'direction' => $body['direction'] ?? null,
            'trigger_type' => $body['trigger_type'] ?? null,
            'is_fake_plate' => $body['is_fake_plate'] ?? null,
            'anpr_device_sn' => $body['anpr_device_sn'] ?? null,
            'image_path' => $body['image_path'] ?? null,
            'image_fragment_path' => $body['image_fragment_path'] ?? null,
            'full_image_path' => $fullPath,
            'small_image_path' => $smallPath,
            'unique_id' => $body['unique_id'] ?? null,
            'detected_at' => $body['detected_at'] ?? gmdate('Y-m-d H:i:s'),
        ]);
        return ['code' => 200, 'message' => 'created', 'data' => ['id' => $id]];
    }
}
