<?php
namespace App\Core;

class Response {
    public static function json($data, int $status = 200): void {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    public static function ok($data = []): void {
        self::json(['code' => 200, 'message' => 'success', 'data' => $data], 200);
    }

    public static function error(string $message, int $status = 400, $data = null): void {
        self::json(['code' => $status, 'message' => $message, 'data' => $data], $status);
    }

    public static function notFound(string $message = 'Not Found'): void {
        self::error($message, 404);
    }

    public static function serverError(string $message = 'Internal Server Error'): void {
        self::error($message, 500);
    }
}
