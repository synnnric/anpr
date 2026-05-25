<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;

class OperationLogController {
    public function index(Request $req) {
        $limit = max(1, min(500, (int)$req->input('limit', 100)));
        $offset = max(0, (int)$req->input('offset', 0));
        $action = $req->input('action');
        $channelNo = $req->input('channelNo');

        $where = []; $params = [];
        if ($action)    { $where[] = 'action = :a'; $params['a'] = $action; }
        if ($channelNo) { $where[] = 'channel_no = :ch'; $params['ch'] = $channelNo; }

        $sql = 'SELECT * FROM operation_log';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = Database::fetchAll($sql, $params);

        // Decode JSON fields for convenience
        foreach ($rows as &$r) {
            $r['request_payload'] = $r['request_payload'] ? json_decode($r['request_payload'], true) : null;
            $r['response_payload'] = $r['response_payload'] ? json_decode($r['response_payload'], true) : null;
        }
        return ['code' => 200, 'message' => 'success', 'data' => $rows];
    }
}
