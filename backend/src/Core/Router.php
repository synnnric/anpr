<?php
namespace App\Core;

class Router {
    private array $routes = [];

    public function get(string $path, $handler): void    { $this->add('GET', $path, $handler); }
    public function post(string $path, $handler): void   { $this->add('POST', $path, $handler); }
    public function put(string $path, $handler): void    { $this->add('PUT', $path, $handler); }
    public function patch(string $path, $handler): void  { $this->add('PATCH', $path, $handler); }
    public function delete(string $path, $handler): void { $this->add('DELETE', $path, $handler); }

    private function add(string $method, string $path, $handler): void {
        $pattern = preg_replace('#\{([a-zA-Z_][a-zA-Z0-9_]*)\}#', '(?P<$1>[^/]+)', $path);
        $pattern = '#^' . $pattern . '$#';
        $this->routes[] = compact('method', 'pattern', 'handler');
    }

    public function dispatch(Request $req): void {
        // CORS preflight
        if ($req->method === 'OPTIONS') {
            http_response_code(204);
            exit;
        }

        $matchedPath = false;
        foreach ($this->routes as $r) {
            if (!preg_match($r['pattern'], $req->path, $m)) continue;
            $matchedPath = true;
            if ($r['method'] !== $req->method) continue;

            foreach ($m as $k => $v) {
                if (!is_int($k)) $req->params[$k] = $v;
            }
            try {
                $result = call_user_func($r['handler'], $req);
                if ($result !== null) Response::json($result);
            } catch (\Throwable $e) {
                Logger::error('Handler exception: ' . $e->getMessage() . "\n" . $e->getTraceAsString());
                $msg = $GLOBALS['APP_CONFIG']['app']['debug']
                    ? $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine()
                    : 'Internal Server Error';
                Response::serverError($msg);
            }
            return;
        }

        if ($matchedPath) Response::error('Method Not Allowed', 405);
        else Response::notFound("Route not found: {$req->method} {$req->path}");
    }
}
