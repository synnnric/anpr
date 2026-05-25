<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\ImageStorage;

class InspectionController {
    public function index(Request $req) {
        $limit = max(1, min(200, (int)$req->input('limit', 50)));
        $offset = max(0, (int)$req->input('offset', 0));
        $state = $req->input('state');
        $channelNo = $req->input('channelNo');
        $plate = $req->input('plate');

        $where = []; $params = [];
        if ($state)     { $where[] = 'state = :state'; $params['state'] = $state; }
        if ($channelNo) { $where[] = 'channel_no = :ch'; $params['ch'] = $channelNo; }
        if ($plate)     { $where[] = 'license_plate ILIKE :pl'; $params['pl'] = "%$plate%"; }

        $sql = 'SELECT * FROM inspections';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;

        $rows = Database::fetchAll($sql, $params);
        $total = Database::fetchOne(
            'SELECT COUNT(*) as c FROM inspections' . ($where ? ' WHERE ' . implode(' AND ', $where) : ''),
            $params
        )['c'] ?? 0;

        return ['code' => 200, 'message' => 'success', 'data' => ['items' => $rows, 'total' => (int)$total]];
    }

    public function show(Request $req) {
        $id = (int)$req->param('id');
        $row = Database::fetchOne('SELECT * FROM inspections WHERE id = ?', [$id]);
        if (!$row) { Response::notFound('Inspection not found'); return null; }

        $row['status_logs'] = Database::fetchAll(
            'SELECT id, operating_state, cmd_no, received_at FROM inspection_status_logs WHERE inspection_id = ? ORDER BY id ASC',
            [$id]
        );
        $row['face_images'] = Database::fetchAll(
            'SELECT id, image_url, received_at FROM inspection_face_images WHERE inspection_id = ? ORDER BY id ASC',
            [$id]
        );
        $row['video_streams'] = Database::fetchAll(
            'SELECT id, camera_code, stream_url, received_at FROM inspection_video_streams WHERE inspection_id = ? ORDER BY id ASC',
            [$id]
        );

        $uvis = Database::fetchAll(
            'SELECT * FROM inspection_uvis WHERE inspection_id = ? ORDER BY id ASC',
            [$id]
        );
        foreach ($uvis as &$u) {
            $u['image_url'] = ImageStorage::publicUrl($u['image_path']);
            $u['coords'] = Database::fetchAll(
                'SELECT confidence, x1, y1, x2, y2 FROM inspection_uvis_coords WHERE uvis_id = ?',
                [$u['id']]
            );
        }
        unset($u);
        $row['uvis'] = $uvis;

        $ops = Database::fetchAll(
            'SELECT id, action, status, error_message, request_payload, response_payload, created_at
             FROM operation_log WHERE inspection_id = ? ORDER BY id ASC',
            [$id]
        );
        foreach ($ops as &$o) {
            $o['request_payload'] = $o['request_payload'] ? json_decode($o['request_payload'], true) : null;
            $o['response_payload'] = $o['response_payload'] ? json_decode($o['response_payload'], true) : null;
        }
        unset($o);
        $row['operations'] = $ops;

        return ['code' => 200, 'message' => 'success', 'data' => $row];
    }
}
