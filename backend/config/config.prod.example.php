<?php
// PRODUCTION config template.
// Copy to config.prod.php on the prod server, fill in real values, and set
// APP_ENV=prod (Apache: `SetEnv APP_ENV prod` in the vhost; CLI: `APP_ENV=prod php ...`).
// config.prod.php is gitignored — never commit real secrets.

return [
    'app' => [
        'name' => 'ANPR + S300 Backend',
        'version' => '1.0.0',
        // Keep FALSE in production — debug=true leaks file paths in error responses.
        'debug' => false,
        'timezone' => 'Asia/Jakarta',
        // Lock to the real operator origin(s). Same-origin requests (SPA and
        // backend both behind anprc-sigap.dpr.go.id) send no Origin header,
        // so this only matters for cross-origin access.
        'cors_origins' => ['https://anprc-sigap.dpr.go.id', 'http://anprc-sigap.dpr.go.id', 'http://10.10.33.144'],
    ],
    'database' => [
        // Shared SIGAP PostgreSQL — all ANPR objects are anprc_-prefixed.
        'driver' => 'pgsql',
        'host' => '10.10.33.142',
        'port' => 5432,
        'name' => 'db_sigap',
        'user' => 'sigap',
        'password' => 'CHANGE_ME',
    ],
    'upload' => [
        'base_path' => __DIR__ . '/../uploads',
        'public_url' => '/anpr_backend/uploads',
        'max_size' => 50 * 1024 * 1024,
    ],
    'auth' => [
        // Generate with: php -r "echo bin2hex(random_bytes(32));"
        // Do NOT reuse the dev secret.
        'secret' => 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
        'token_ttl' => 86400 * 7,
        // MUST be false in production — true grants admin to ANY username.
        'dev_bypass' => false,
        // Parent platform DB (SSO lookup, used once dev_bypass is off).
        'parent_db' => [
            'driver' => 'mysql',
            'host'   => '127.0.0.1',
            'port'   => 3306,
            'name'   => 'parent_platform',
            'user'   => 'parent_reader',
            'password' => 'CHANGE_ME',
            'table'      => 'tbl_users',
            'col_id'     => 'id',
            'col_uname'  => 'username',
            'col_display'=> 'full_name',
            'col_role'   => 'role',
            'col_active' => 'is_active',
        ],
    ],
    'logs' => [
        'path' => __DIR__ . '/../logs',
    ],
];
