<?php
namespace App\Services;

/**
 * HTTP client for Qigong AIoT road blocker REST API.
 * See: ROAD BLOCKER API.pdf
 */
class RoadBlockerClient {
    private string $baseUrl;
    private int $timeout;

    public function __construct(string $ip, int $port, int $timeout = 8) {
        $this->baseUrl = "http://$ip:$port";
        $this->timeout = $timeout;
    }

    /**
     * Lower (open) a specific lifting column on a specific board.
     * action=down means the column descends → vehicle can pass.
     */
    public function openColumn(string $deviceNo, string $boardId, int $columnNum): array {
        return $this->operate([
            'deviceNo' => $deviceNo,
            'ipCode' => [$boardId => $columnNum],
            'operationType' => 'liftingColumn_level',
            'action' => 'down',
            'liftingColumnNum' => $columnNum,
        ]);
    }

    /**
     * Raise (close) a specific lifting column on a specific board.
     */
    public function closeColumn(string $deviceNo, string $boardId, int $columnNum): array {
        return $this->operate([
            'deviceNo' => $deviceNo,
            'ipCode' => [$boardId => $columnNum],
            'operationType' => 'liftingColumn_level',
            'action' => 'up',
            'liftingColumnNum' => $columnNum,
        ]);
    }

    public function getStatus(string $deviceNo): array {
        return $this->request('GET', "/open/getStatus/" . rawurlencode($deviceNo), null);
    }

    private function operate(array $body): array {
        return $this->request('POST', '/open/operation', $body);
    }

    private function request(string $method, string $path, ?array $body): array {
        $url = $this->baseUrl . $path;
        $ch = curl_init($url);
        $headers = ['Accept: application/json'];
        if ($body !== null) $headers[] = 'Content-Type: application/json';

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));

        $startedAt = microtime(true);
        $raw = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        $elapsedMs = (int)((microtime(true) - $startedAt) * 1000);
        curl_close($ch);

        if ($raw === false) {
            return ['ok' => false, 'status' => 0, 'error' => $err ?: 'curl failed', 'body' => null, 'elapsed_ms' => $elapsedMs];
        }
        $decoded = json_decode($raw, true);
        return [
            'ok' => $status >= 200 && $status < 300,
            'status' => $status,
            'error' => $err ?: null,
            'body' => $decoded ?? $raw,
            'elapsed_ms' => $elapsedMs,
        ];
    }
}
