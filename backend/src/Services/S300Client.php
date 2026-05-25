<?php
namespace App\Services;

class S300Client {
    private string $baseUrl;
    private int $timeout;

    public function __construct(string $baseUrl, int $timeout = 10) {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->timeout = $timeout;
    }

    public function get(string $path): array {
        return $this->request('GET', $path, null);
    }

    public function post(string $path, ?array $body = null): array {
        return $this->request('POST', $path, $body);
    }

    private function request(string $method, string $path, ?array $body): array {
        $url = $this->baseUrl . $path;
        $ch = curl_init($url);
        $headers = ['Content-Type: application/json', 'Accept: application/json'];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
        }

        $startedAt = microtime(true);
        $raw = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        $elapsedMs = (int)((microtime(true) - $startedAt) * 1000);
        curl_close($ch);

        if ($raw === false) {
            return [
                'ok' => false,
                'status' => 0,
                'error' => $err ?: 'curl_exec failed',
                'body' => null,
                'elapsed_ms' => $elapsedMs,
            ];
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
