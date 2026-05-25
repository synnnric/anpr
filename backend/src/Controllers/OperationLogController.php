<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;

class OperationLogController {
    public function index(Request $req) {
        $limit  = max(1, min(500, (int)$req->input('limit', 100)));
        $offset = max(0, (int)$req->input('offset', 0));
        $action = $req->input('action');
        $channelNo = $req->input('channelNo');
        $actor  = $req->input('actor');
        $status = $req->input('status');     // 'success' | 'failed'
        $since  = $req->input('since');      // ISO timestamp lower bound
        $until  = $req->input('until');      // ISO timestamp upper bound
        $q      = $req->input('q');          // free-text on action / actor / channel

        $where = []; $params = [];
        if ($action)    { $where[] = 'action = :action';                 $params['action']    = $action; }
        if ($channelNo) { $where[] = 'channel_no = :channel_no';         $params['channel_no']= $channelNo; }
        if ($actor)     { $where[] = 'actor_username = :actor';          $params['actor']     = $actor; }
        if ($status)    { $where[] = 'status = :status';                 $params['status']    = $status; }
        if ($since)     { $where[] = 'created_at >= :since';             $params['since']     = $since; }
        if ($until)     { $where[] = 'created_at <  :until';             $params['until']     = $until; }
        if ($q) {
            $where[] = '(action ILIKE :q OR actor_username ILIKE :q OR channel_no ILIKE :q)';
            $params['q'] = '%' . $q . '%';
        }

        $whereSql = $where ? (' WHERE ' . implode(' AND ', $where)) : '';

        $totalRow = Database::fetchOne('SELECT COUNT(*) AS c FROM operation_log' . $whereSql, $params);
        $total = (int)($totalRow['c'] ?? 0);

        $sql = 'SELECT * FROM operation_log' . $whereSql
             . ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = Database::fetchAll($sql, $params);

        foreach ($rows as &$r) {
            $r['request_payload']  = $r['request_payload']  ? json_decode($r['request_payload'], true)  : null;
            $r['response_payload'] = $r['response_payload'] ? json_decode($r['response_payload'], true) : null;
        }

        return [
            'code' => 200, 'message' => 'success',
            'data' => ['items' => $rows, 'total' => $total],
        ];
    }

    // GET /api/operation-log/facets — distinct actors + actions for filter dropdowns.
    public function facets(Request $req) {
        $actors = Database::fetchAll(
            "SELECT actor_username, COUNT(*) AS n FROM operation_log
             WHERE actor_username IS NOT NULL
             GROUP BY actor_username ORDER BY n DESC LIMIT 50"
        );
        $actions = Database::fetchAll(
            "SELECT action, COUNT(*) AS n FROM operation_log
             GROUP BY action ORDER BY n DESC LIMIT 100"
        );
        return [
            'code' => 200, 'message' => 'success',
            'data' => [
                'actors' => array_map(fn($r) => ['username' => $r['actor_username'], 'count' => (int)$r['n']], $actors),
                'actions' => array_map(fn($r) => ['action' => $r['action'], 'count' => (int)$r['n']], $actions),
            ],
        ];
    }
}
