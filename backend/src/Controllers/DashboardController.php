<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Services\RoadBlockerClient;

/**
 * Single-shot snapshot of platform health + per-channel device state for the
 * Dashboard page. Designed to be cheap enough to poll every 5 seconds.
 */
class DashboardController {

    private const STALE_INBOUND_SEC = 30;   // ANPR considered offline if no msg in this window
    private const STALE_TICK_SEC    = 15;   // Worker considered down if no cron tick recently
    private const RB_TIMEOUT_SEC    = 2;    // Per-channel road-blocker probe budget
    private const BROKER_TIMEOUT_S  = 1.5;  // TCP probe budget for Mosquitto
    private const BROKER_HOST       = '127.0.0.1';
    private const BROKER_PORT       = 1883;

    public function index(Request $req) {
        $nowEpoch = time();
        $todayJkt = (new \DateTime('now', new \DateTimeZone('Asia/Jakarta')))->format('Y-m-d');
        // Build UTC bounds for "today in Asia/Jakarta" so SQL on UTC columns lines up.
        $jktStart = new \DateTime($todayJkt . ' 00:00:00', new \DateTimeZone('Asia/Jakarta'));
        $jktEnd   = (clone $jktStart)->modify('+1 day');
        $jktStart->setTimezone(new \DateTimeZone('UTC'));
        $jktEnd->setTimezone(new \DateTimeZone('UTC'));
        $startUtc = $jktStart->format('Y-m-d H:i:s');
        $endUtc   = $jktEnd->format('Y-m-d H:i:s');

        return ['code' => 200, 'message' => 'success', 'data' => [
            'system'          => $this->systemHealth($nowEpoch),
            'channels'        => $this->channels($nowEpoch, $startUtc, $endUtc),
            'today'           => $this->todayStats($startUtc, $endUtc),
            'mqtt_queue'      => $this->mqttQueueHealth(),
            'recent_plates'   => $this->recentPlates(8),
            'recent_decisions'=> $this->recentDecisions(8),
        ]];
    }

    // ------------------------------------------------------------------ system

    private function systemHealth(int $nowEpoch): array {
        // --- DB ---
        $dbStart = microtime(true);
        $dbVer = (Database::fetchOne('SELECT version() AS v')['v'] ?? '');
        $dbLatencyMs = (int)((microtime(true) - $dbStart) * 1000);
        $dbVerShort = preg_match('/PostgreSQL\s+(\d+(\.\d+)?)/', $dbVer, $m) ? $m[1] : '';

        // --- MQTT broker — direct TCP probe ---
        $brokerStart = microtime(true);
        $errno = 0; $errstr = '';
        $sock = @fsockopen(self::BROKER_HOST, self::BROKER_PORT, $errno, $errstr, self::BROKER_TIMEOUT_S);
        $brokerLatencyMs = (int)((microtime(true) - $brokerStart) * 1000);
        $brokerReachable = (bool)$sock;
        if ($sock) fclose($sock);

        // --- Worker — heartbeat written by /api/cron/tick into settings ---
        $hb = Database::fetchOne(
            "SELECT value, updated_at FROM anprc_settings WHERE key_name = 'worker_last_seen_at'"
        );
        $workerLastAt = $hb['value'] ?? null;
        $workerDt = self::parsePgUtc($workerLastAt);
        $workerAge = $workerDt ? max(0, $nowEpoch - $workerDt->getTimestamp()) : null;

        // --- MQTT data flow (separate from "is the broker reachable") ---
        $row = Database::fetchOne("SELECT MAX(received_at) AS last_at FROM anprc_mqtt_inbound_log");
        $lastInboundAt = $row['last_at'] ?? null;
        $inboundDt = self::parsePgUtc($lastInboundAt);
        $lastInboundSec = $inboundDt ? max(0, $nowEpoch - $inboundDt->getTimestamp()) : null;

        return [
            'now_utc'              => gmdate('c'),
            'timezone'             => $GLOBALS['APP_CONFIG']['app']['timezone'] ?? 'Asia/Jakarta',
            'backend_version'      => $GLOBALS['APP_CONFIG']['app']['version'] ?? '?',
            'db_version'           => $dbVerShort,
            'db_latency_ms'        => $dbLatencyMs,
            'last_inbound_at'      => self::jakartaIso($lastInboundAt),
            'last_inbound_age_sec' => $lastInboundSec,
            'broker_reachable'     => $brokerReachable,
            'broker_latency_ms'    => $brokerLatencyMs,
            'broker_error'         => $brokerReachable ? null : ($errstr ?: "errno_{$errno}"),
            'worker_last_seen_at'  => self::jakartaIso($workerLastAt),
            'worker_last_seen_age' => $workerAge,
            'backend_status' => 'ok',
            'db_status'      => 'ok',
            'mqtt_status'    => $brokerReachable ? 'ok' : 'stale',
            'worker_status'  => $workerAge !== null && $workerAge <= self::STALE_TICK_SEC ? 'ok' : 'stale',
        ];
    }

    // ------------------------------------------------------------------ channels

    private function channels(int $nowEpoch, string $startUtc, string $endUtc): array {
        $channels = Database::fetchAll('SELECT * FROM anprc_channels ORDER BY id');
        $out = [];
        foreach ($channels as $c) {
            $row = [
                'channel_no'        => $c['channel_no'],
                'name'              => $c['name'],
                'kind'              => $c['kind'],
                'enabled'           => (int)$c['enabled'] === 1,
                'anpr_device_sn'    => $c['anpr_device_sn'],
                's300_base_url'     => $c['s300_base_url'],
                'rb_ip'             => $c['rb_ip'],
                'rb_port'           => $c['rb_port'] !== null ? (int)$c['rb_port'] : null,
                'rb_device_no'      => $c['rb_device_no'],
                'rb_board_id'       => $c['rb_board_id'],
                'rb_column_num'     => $c['rb_column_num'] !== null ? (int)$c['rb_column_num'] : null,
                'paired_channel_id' => $c['paired_channel_id'] !== null ? (int)$c['paired_channel_id'] : null,
                'uvis_timeout_sec'  => (int)$c['uvis_timeout_sec'],
            ];

            // ANPR liveness — use the device's keep_alive heartbeat ONLY, not any
            // message. A camera with zero vehicle traffic still pings every ~10s;
            // calling it offline because no cars are passing would be wrong.
            // We also report total messages today (any type) for activity feel.
            if ($c['anpr_device_sn']) {
                $hb = Database::fetchOne(
                    "SELECT MAX(received_at) AS last_at
                     FROM anprc_mqtt_inbound_log
                     WHERE device_sn = :sn AND message_name = 'keep_alive'",
                    ['sn' => $c['anpr_device_sn']]
                );
                $totals = Database::fetchOne(
                    "SELECT COUNT(*) FILTER (WHERE received_at >= :s AND received_at < :e)::int AS msgs_today
                     FROM anprc_mqtt_inbound_log WHERE device_sn = :sn",
                    ['sn' => $c['anpr_device_sn'], 's' => $startUtc, 'e' => $endUtc]
                );
                $lastAt = $hb['last_at'] ?? null;
                $ageSec = $lastAt ? max(0, $nowEpoch - strtotime($lastAt . ' UTC')) : null;
                $row['anpr_last_heartbeat_at']  = $lastAt;
                $row['anpr_last_heartbeat_age'] = $ageSec;
                $row['anpr_msgs_today']         = (int)($totals['msgs_today'] ?? 0);
                $row['anpr_status']             = self::healthFromAge($ageSec, self::STALE_INBOUND_SEC);
            } else {
                $row['anpr_status'] = 'unknown';
            }

            // Most recent plate detected by this device today.
            if ($c['anpr_device_sn']) {
                $last = Database::fetchOne(
                    "SELECT license_plate, received_at FROM anprc_mqtt_inbound_log
                     WHERE device_sn = :sn AND license_plate IS NOT NULL
                     ORDER BY id DESC LIMIT 1",
                    ['sn' => $c['anpr_device_sn']]
                );
                $row['last_plate']    = $last['license_plate'] ?? null;
                $row['last_plate_at'] = $last['received_at']   ?? null;
            }

            // Active inspection on this channel (entry only — exit has no inspection).
            if ($c['kind'] === 'entry') {
                $active = Database::fetchOne(
                    "SELECT id, license_plate, state, decision, current_operating_state,
                            come_called_at, decision_at, decision_timeout_at
                     FROM anprc_inspections
                     WHERE channel_no = :ch AND state IN ('pending','started','inspecting','resetting')
                     ORDER BY id DESC LIMIT 1",
                    ['ch' => $c['channel_no']]
                );
                $row['active_inspection'] = $active ?: null;

                // Live TCP probe of S300 — proves the device process is reachable.
                $row['s300'] = $this->probeS300($c['s300_base_url']);

                // Road-blocker live state (timeout-bounded).
                $row['road_blocker'] = $this->probeRoadBlocker($c);
            } else {
                $row['active_inspection'] = null;
                $row['s300']              = null;
                $row['road_blocker']      = null;
            }

            $out[] = $row;
        }
        return $out;
    }

    /**
     * Quick reachability probe for the S300 device. There's no documented
     * "ping" endpoint, so we just open a TCP connection to the host:port
     * extracted from s300_base_url. Any successful connect means the process
     * is up; any failure (refused / timeout / DNS) means it isn't.
     */
    private function probeS300(?string $baseUrl): array {
        if (!$baseUrl) return ['reachable' => false, 'reason' => 'not_configured'];
        $parts = parse_url($baseUrl);
        $host = $parts['host'] ?? null;
        $port = $parts['port'] ?? (($parts['scheme'] ?? '') === 'https' ? 443 : 80);
        if (!$host) return ['reachable' => false, 'reason' => 'invalid_url'];

        $started = microtime(true);
        $errno = 0; $errstr = '';
        $conn = @fsockopen($host, $port, $errno, $errstr, 1.5);
        $elapsedMs = (int)((microtime(true) - $started) * 1000);
        if ($conn) {
            fclose($conn);
            return ['reachable' => true, 'host' => $host, 'port' => (int)$port,
                    'elapsed_ms' => $elapsedMs];
        }
        return ['reachable' => false, 'host' => $host, 'port' => (int)$port,
                'reason' => $errstr ?: "errno_{$errno}",
                'elapsed_ms' => $elapsedMs];
    }

    private function probeRoadBlocker(array $channel): ?array {
        if (!$channel['rb_ip'] || !$channel['rb_port'] || !$channel['rb_device_no']) {
            return ['online' => false, 'reachable' => false, 'reason' => 'not_configured'];
        }
        try {
            $client = new RoadBlockerClient((string)$channel['rb_ip'], (int)$channel['rb_port'], self::RB_TIMEOUT_SEC);
            $res = $client->getStatus($channel['rb_device_no']);
            if (!$res['ok']) {
                return ['online' => false, 'reachable' => false,
                        'reason' => $res['error'] ?? "http_{$res['status']}",
                        'elapsed_ms' => $res['elapsed_ms']];
            }
            $body = $res['body'];
            if (!is_array($body) || ($body['code'] ?? 0) !== 200 || !isset($body['data'])) {
                return ['online' => false, 'reachable' => true,
                        'reason' => $body['msg'] ?? 'unexpected_response',
                        'elapsed_ms' => $res['elapsed_ms']];
            }
            return [
                'online'     => true,
                'reachable'  => true,
                'controller_online' => (bool)($body['data']['controlTheDeviceOnline'] ?? false),
                'columns'    => $body['data']['liftingColumnsStatus'] ?? [],
                'elapsed_ms' => $res['elapsed_ms'],
            ];
        } catch (\Throwable $e) {
            return ['online' => false, 'reachable' => false, 'reason' => $e->getMessage()];
        }
    }

    // ------------------------------------------------------------------ today

    private function todayStats(string $startUtc, string $endUtc): array {
        $params = ['s' => $startUtc, 'e' => $endUtc];
        $visits = Database::fetchOne(
            "SELECT
                COUNT(*) FILTER (WHERE status = 'active')::int                                    AS active_now,
                COUNT(*) FILTER (WHERE entry_at >= :s AND entry_at < :e)::int                     AS entered,
                COUNT(*) FILTER (WHERE status = 'completed' AND exit_at >= :s AND exit_at < :e)::int      AS completed,
                COUNT(*) FILTER (WHERE status = 'orphan_exit' AND exit_at >= :s AND exit_at < :e)::int   AS orphan_exits,
                COUNT(*) FILTER (WHERE status = 'denied_entry' AND updated_at >= :s AND updated_at < :e)::int AS denied_entries
             FROM anprc_visits", $params
        ) ?: [];

        $insp = Database::fetchOne(
            "SELECT
                COUNT(*)::int                                                                AS total,
                COUNT(*) FILTER (WHERE decision = 'pass')::int                               AS pass,
                COUNT(*) FILTER (WHERE decision = 'suspect')::int                            AS suspect,
                COUNT(*) FILTER (WHERE decision = 'fail')::int                               AS fail,
                COUNT(*) FILTER (WHERE decision = 'vip_pass')::int                           AS vip_pass,
                COUNT(*) FILTER (WHERE state IN ('pending','started','inspecting','resetting'))::int AS in_progress
             FROM anprc_inspections WHERE created_at >= :s AND created_at < :e", $params
        ) ?: [];

        $plates = Database::fetchOne(
            "SELECT COUNT(*)::int AS c FROM anprc_mqtt_inbound_log
             WHERE message_name = 'ivs_result'
               AND received_at >= :s AND received_at < :e", $params
        );

        return [
            'plates_detected'   => (int)($plates['c'] ?? 0),
            'inspections'       => array_map('intval', $insp),
            'visits'            => array_map('intval', $visits),
        ];
    }

    // ------------------------------------------------------------------ misc

    private function mqttQueueHealth(): array {
        $row = Database::fetchOne(
            "SELECT
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'sent')::int    AS sent,
                COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
                MAX(CASE WHEN status = 'failed' THEN last_error END) AS last_error
             FROM anprc_mqtt_outbound_queue"
        );
        return [
            'pending'   => (int)($row['pending'] ?? 0),
            'sent'      => (int)($row['sent'] ?? 0),
            'failed'    => (int)($row['failed'] ?? 0),
            'last_error'=> $row['last_error'] ?? null,
        ];
    }

    private function recentPlates(int $n): array {
        return Database::fetchAll(
            "SELECT id, device_sn, license_plate, received_at
             FROM anprc_mqtt_inbound_log
             WHERE license_plate IS NOT NULL
             ORDER BY id DESC LIMIT $n"
        );
    }

    private function recentDecisions(int $n): array {
        return Database::fetchAll(
            "SELECT id, channel_no, license_plate, state, decision, decision_reason,
                    blocker_opened, come_called_at, decision_at
             FROM anprc_inspections
             ORDER BY id DESC LIMIT $n"
        );
    }

    private static function healthFromAge(?int $ageSec, int $stale): string {
        if ($ageSec === null) return 'unknown';
        return $ageSec <= $stale ? 'ok' : 'stale';
    }

    /**
     * Parse a DB timestamp into a UTC-anchored DateTimeImmutable.
     * Naive strings (the Postgres default — stored in UTC) are tagged UTC;
     * offset-aware strings (Z or ±HH:MM, e.g. the worker heartbeat) parse as-is.
     * Returns null on empty/unparseable input.
     */
    private static function parsePgUtc(?string $ts): ?\DateTimeImmutable {
        if (!$ts) return null;
        $ts = trim($ts);
        $hasTz = preg_match('/(Z|[+-]\d{2}:?\d{2})$/', $ts) === 1;
        try {
            return $hasTz
                ? new \DateTimeImmutable($ts)
                : new \DateTimeImmutable($ts, new \DateTimeZone('UTC'));
        } catch (\Exception $e) {
            return null;
        }
    }

    /** Render a DB timestamp as ISO 8601 in GMT+7 (Asia/Jakarta), or null. */
    private static function jakartaIso(?string $ts): ?string {
        $d = self::parsePgUtc($ts);
        return $d ? $d->setTimezone(new \DateTimeZone('Asia/Jakarta'))->format('c') : null;
    }
}
