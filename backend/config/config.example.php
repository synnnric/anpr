<?php
// Copy this file to config.php and fill in real values for your environment.
// config.php is gitignored.

return [
    'app' => [
        'name' => 'ANPR + S300 Backend',
        'version' => '1.0.0',
        'debug' => true,
        'timezone' => 'Asia/Jakarta',
        'cors_origins' => ['*'],
    ],
    'database' => [
        'driver' => 'pgsql',
        'host' => '127.0.0.1',
        'port' => 5433,
        'name' => 'anpr_s300',
        'user' => 'anpr',
        'password' => 'CHANGE_ME',
    ],
    'upload' => [
        'base_path' => __DIR__ . '/../uploads',
        'public_url' => '/anpr_backend/uploads',
        'max_size' => 50 * 1024 * 1024,
    ],
    'auth' => [
        // HMAC secret used to sign session tokens. Generate with:
        //   php -r "echo bin2hex(random_bytes(32));"
        'secret' => 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
        'token_ttl' => 86400 * 7,
        // When true, /api/auth/sso accepts ANY username and grants admin.
        // Use for local dev only — turn off in production.
        'dev_bypass' => true,
        // Parent platform DB (used by SSO lookup once dev_bypass is off).
        'parent_db' => [
            'driver' => 'mysql',
            'host'   => '127.0.0.1',
            'port'   => 3306,
            'name'   => 'parent_platform',
            'user'   => 'parent_reader',
            'password' => 'CHANGE_ME',
            // SELECT-able shape — adapt to the real schema once known.
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
