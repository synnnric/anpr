<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;

class MqttLogController {

    /**
     * POST /api/mqtt-log/inbound — worker writes each received MQTT message here.
     * Body: { device_sn, topic, message_name, payload }
     */
    public function ingest(Request $req) {
        $b = $req->json();
        $sn   = trim((string)($b['device_sn'] ?? ''));
        $top  = trim((string)($b['topic'] ?? ''));
        $name = trim((string)($b['message_name'] ?? ''));
        if ($sn === '' || $top === '' || $name === '') {
            Response::error('device_sn, topic, message_name required', 400);
            return null;
        }
        $payload = $b['payload'] ?? null;
        $plate = self::extractPlate($name, $payload);
        Database::query(
            'INSERT INTO anprc_mqtt_inbound_log (device_sn, topic, message_name, license_plate, payload)
             VALUES (?, ?, ?, ?, ?::jsonb)',
            [$sn, substr($top, 0, 255), substr($name, 0, 64),
             $plate !== null ? substr($plate, 0, 32) : null,
             $payload === null ? null : json_encode($payload, JSON_UNESCAPED_UNICODE)]
        );
        return ['code' => 200, 'message' => 'logged', 'data' => null];
    }

    /**
     * Pulls the license plate out of known inbound payload shapes.
     * Returns null when this message_name doesn't carry a plate.
     */
    private static function extractPlate(string $name, $payload): ?string {
        if (!is_array($payload)) return null;
        if ($name === 'ivs_result') {
            $b64 = $payload['payload']['AlarmInfoPlate']['result']['PlateResult']['license'] ?? null;
            if (is_string($b64) && $b64 !== '') {
                $decoded = base64_decode($b64, true);
                if (is_string($decoded) && $decoded !== '') return trim($decoded);
            }
        }
        return null;
    }

    /**
     * GET /api/mqtt-log/devices — per-device summary across inbound + outbound.
     * For each device_sn: inbound_total, outbound_total, last_inbound_at, last_outbound_at,
     * top message_name counts.
     */
    public function devices(Request $req) {
        // Inbound stats per device
        $inboundRows = Database::fetchAll(
            "SELECT device_sn,
                    COUNT(*)::int       AS total,
                    MAX(received_at)    AS last_at
             FROM anprc_mqtt_inbound_log
             GROUP BY device_sn"
        );
        $outboundRows = Database::fetchAll(
            "SELECT device_sn,
                    COUNT(*)::int       AS total,
                    MAX(created_at)     AS last_at,
                    COUNT(*) FILTER (WHERE status='pending')::int AS pending,
                    COUNT(*) FILTER (WHERE status='sent')::int    AS sent,
                    COUNT(*) FILTER (WHERE status='failed')::int  AS failed
             FROM anprc_mqtt_outbound_queue
             GROUP BY device_sn"
        );

        $byDev = [];
        foreach ($inboundRows as $r) {
            $byDev[$r['device_sn']] = [
                'device_sn'        => $r['device_sn'],
                'inbound_total'    => (int)$r['total'],
                'last_inbound_at'  => $r['last_at'],
                'outbound_total'   => 0,
                'last_outbound_at' => null,
                'outbound_pending' => 0,
                'outbound_sent'    => 0,
                'outbound_failed'  => 0,
            ];
        }
        foreach ($outboundRows as $r) {
            $sn = $r['device_sn'];
            if (!isset($byDev[$sn])) {
                $byDev[$sn] = [
                    'device_sn'       => $sn,
                    'inbound_total'   => 0,
                    'last_inbound_at' => null,
                    'outbound_total'  => 0,
                    'last_outbound_at'=> null,
                    'outbound_pending'=> 0,
                    'outbound_sent'   => 0,
                    'outbound_failed' => 0,
                ];
            }
            $byDev[$sn]['outbound_total']   = (int)$r['total'];
            $byDev[$sn]['last_outbound_at'] = $r['last_at'];
            $byDev[$sn]['outbound_pending'] = (int)$r['pending'];
            $byDev[$sn]['outbound_sent']    = (int)$r['sent'];
            $byDev[$sn]['outbound_failed']  = (int)$r['failed'];
        }

        // Attach message_name breakdown (top 6) for each device's inbound traffic
        foreach ($byDev as $sn => &$dev) {
            $breakdown = Database::fetchAll(
                "SELECT message_name, COUNT(*)::int AS c
                 FROM anprc_mqtt_inbound_log
                 WHERE device_sn = ?
                 GROUP BY message_name
                 ORDER BY c DESC LIMIT 6",
                [$sn]
            );
            $dev['inbound_breakdown'] = $breakdown;
        }
        unset($dev);

        // Resolve channel info (name + channel_no) by anpr_device_sn match
        $channelMap = [];
        foreach (Database::fetchAll('SELECT channel_no, name, anpr_device_sn FROM anprc_channels') as $c) {
            if (!empty($c['anpr_device_sn'])) {
                $channelMap[$c['anpr_device_sn']] = $c;
            }
        }
        foreach ($byDev as &$dev) {
            $dev['channel'] = $channelMap[$dev['device_sn']] ?? null;
        }
        unset($dev);

        // Sort: most recent activity first
        $devices = array_values($byDev);
        usort($devices, function($a, $b) {
            $ax = max(strtotime($a['last_inbound_at'] ?? '1970-01-01'),
                      strtotime($a['last_outbound_at'] ?? '1970-01-01'));
            $bx = max(strtotime($b['last_inbound_at'] ?? '1970-01-01'),
                      strtotime($b['last_outbound_at'] ?? '1970-01-01'));
            return $bx <=> $ax;
        });
        return ['code' => 200, 'message' => 'success', 'data' => $devices];
    }

    /**
     * GET /api/mqtt-log/inbound — paginated inbound list.
     * Query: device_sn, message_name, from, to, limit, offset
     */
    public function inbound(Request $req) {
        $limit  = max(1, min(500, (int)$req->input('limit', 100)));
        $offset = max(0, (int)$req->input('offset', 0));
        $sn     = $req->input('device_sn');
        $name   = $req->input('message_name');
        $plate  = $req->input('license_plate');
        $from   = $req->input('from');
        $to     = $req->input('to');

        $where = []; $params = [];
        if ($sn)    { $where[] = 'device_sn = :sn';        $params['sn']  = $sn; }
        if ($name)  { $where[] = 'message_name = :n';      $params['n']   = $name; }
        if ($plate) { $where[] = 'LOWER(license_plate) = LOWER(:p)'; $params['p'] = $plate; }
        if ($from)  { $where[] = 'received_at >= :f';      $params['f']   = $from; }
        if ($to)    { $where[] = 'received_at <= :t';      $params['t']   = $to; }

        $sql = 'SELECT id, device_sn, topic, message_name, license_plate, payload, received_at
                FROM anprc_mqtt_inbound_log';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = Database::fetchAll($sql, $params);
        foreach ($rows as &$r) {
            if ($r['payload'] !== null) {
                $r['payload'] = json_decode($r['payload'], true);
            }
        }

        $totalSql = 'SELECT COUNT(*)::int AS c FROM anprc_mqtt_inbound_log';
        if ($where) $totalSql .= ' WHERE ' . implode(' AND ', $where);
        $total = (int)(Database::fetchOne($totalSql, $params)['c'] ?? 0);

        return ['code' => 200, 'message' => 'success',
                'data' => ['items' => $rows, 'total' => $total]];
    }

    /**
     * GET /api/mqtt-log/outbound — paginated outbound list, filters mirror /inbound.
     * Reads from mqtt_outbound_queue.
     */
    public function outbound(Request $req) {
        $limit  = max(1, min(500, (int)$req->input('limit', 100)));
        $offset = max(0, (int)$req->input('offset', 0));
        $sn     = $req->input('device_sn');
        $name   = $req->input('message_name');
        $status = $req->input('status');
        $plate  = $req->input('license_plate');
        $from   = $req->input('from');
        $to     = $req->input('to');

        $where = []; $params = [];
        if ($sn)     { $where[] = 'device_sn = :sn';      $params['sn']  = $sn; }
        if ($name)   { $where[] = 'command_name = :n';    $params['n']   = $name; }
        if ($status) { $where[] = 'status = :st';         $params['st']  = $status; }
        if ($from)   { $where[] = 'created_at >= :f';     $params['f']   = $from; }
        if ($to)     { $where[] = 'created_at <= :t';     $params['t']   = $to; }
        // Plate lives inside JSONB. Two shapes seen on white_list_operator:
        //   single:  payload->>'plate'
        //   bulk:    payload->'dldb_rec'->[i]->>'plate'
        if ($plate) {
            $where[] = "(
                LOWER(payload->>'plate') = LOWER(:p)
                OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(payload->'dldb_rec') = 'array'
                             THEN payload->'dldb_rec' ELSE '[]'::jsonb END
                    ) AS rec WHERE LOWER(rec->>'plate') = LOWER(:p)
                )
            )";
            $params['p'] = $plate;
        }

        $sql = 'SELECT id, device_sn, command_name AS message_name, payload,
                       status, attempts, last_error, created_at, sent_at
                FROM anprc_mqtt_outbound_queue';
        if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $rows = Database::fetchAll($sql, $params);
        foreach ($rows as &$r) {
            if ($r['payload'] !== null) {
                $r['payload'] = json_decode($r['payload'], true);
            }
        }

        $totalSql = 'SELECT COUNT(*)::int AS c FROM anprc_mqtt_outbound_queue';
        if ($where) $totalSql .= ' WHERE ' . implode(' AND ', $where);
        $total = (int)(Database::fetchOne($totalSql, $params)['c'] ?? 0);

        return ['code' => 200, 'message' => 'success',
                'data' => ['items' => $rows, 'total' => $total]];
    }

    /**
     * GET /api/mqtt-log/message-names — distinct message names ever seen, both directions.
     * Used by the frontend filter dropdown so it stays populated independent of current filter state.
     */
    public function messageNames(Request $req) {
        $inbound  = Database::fetchAll('SELECT DISTINCT message_name AS n FROM anprc_mqtt_inbound_log');
        $outbound = Database::fetchAll('SELECT DISTINCT command_name AS n FROM anprc_mqtt_outbound_queue');
        $set = [];
        foreach ($inbound  as $r) $set[$r['n']] = true;
        foreach ($outbound as $r) $set[$r['n']] = true;
        $names = array_keys($set);
        sort($names);
        return ['code' => 200, 'message' => 'success',
                'data' => ['inbound'  => array_column($inbound, 'n'),
                           'outbound' => array_column($outbound, 'n'),
                           'all'      => $names]];
    }
}
