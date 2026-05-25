<?php
namespace App\Core;

class Request {
    public string $method;
    public string $path;
    public array $query;
    public array $headers;
    private ?array $jsonBody = null;
    private ?string $rawBody = null;
    public array $params = [];

    public function __construct() {
        $this->method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        $path = parse_url($uri, PHP_URL_PATH) ?? '/';
        // Strip the /anpr_backend prefix if present (XAMPP subfolder deployment)
        $path = preg_replace('#^/anpr_backend#', '', $path);
        // Strip /public if present (when accessed via document_root/anpr_backend/public)
        $path = preg_replace('#^/public#', '', $path);
        $this->path = $path === '' ? '/' : $path;
        $this->query = $_GET;
        $this->headers = $this->parseHeaders();
    }

    private function parseHeaders(): array {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (strncmp($k, 'HTTP_', 5) === 0) {
                $name = strtolower(str_replace('_', '-', substr($k, 5)));
                $headers[$name] = $v;
            } elseif (in_array($k, ['CONTENT_TYPE', 'CONTENT_LENGTH'])) {
                $headers[strtolower(str_replace('_', '-', $k))] = $v;
            }
        }
        return $headers;
    }

    public function rawBody(): string {
        if ($this->rawBody === null) {
            $this->rawBody = file_get_contents('php://input') ?: '';
        }
        return $this->rawBody;
    }

    public function json(): array {
        if ($this->jsonBody === null) {
            $body = $this->rawBody();
            if ($body === '') return [];
            $decoded = json_decode($body, true);
            $this->jsonBody = is_array($decoded) ? $decoded : [];
        }
        return $this->jsonBody;
    }

    public function input(string $key, $default = null) {
        $body = $this->json();
        return $body[$key] ?? $this->query[$key] ?? $default;
    }

    public function param(string $key, $default = null) {
        return $this->params[$key] ?? $default;
    }

    public function header(string $name, ?string $default = null): ?string {
        return $this->headers[strtolower($name)] ?? $default;
    }

    public function ip(): string {
        return $_SERVER['HTTP_X_FORWARDED_FOR']
            ?? $_SERVER['REMOTE_ADDR']
            ?? 'unknown';
    }
}
