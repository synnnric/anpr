<?php
namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\InspectionService;

class AuthController {
    // POST /api/auth/sso  body: { username }
    //
    // Exchanges a parent-platform username (passed via the ?username= query param
    // by the embedding portal) for our session token. The local `users` table is
    // the source of truth for roles and audit attribution — SSO upserts a shadow
    // row so the rest of the codebase (operation_log.actor_username, /me, role gates)
    // works unchanged.
    public function sso(Request $req) {
        $body = $req->json();
        $username = trim((string)($body['username'] ?? ''));
        if ($username === '') {
            Response::error('username is required', 400);
            return null;
        }

        $authCfg = $GLOBALS['APP_CONFIG']['auth'];
        $devBypass = !empty($authCfg['dev_bypass']) || getenv('AUTH_DEV_BYPASS') === '1';

        $role = 'operator';
        $displayName = $username;

        if ($devBypass) {
            $role = 'admin';
            $displayName = 'Dev ' . $username;
        } else {
            // TODO: Look up $username in the parent platform's DB using
            // $authCfg['parent_db']. Skeleton:
            //
            //   $p = $authCfg['parent_db'];
            //   $dsn = "{$p['driver']}:host={$p['host']};port={$p['port']};dbname={$p['name']}";
            //   $pdo = new \PDO($dsn, $p['user'], $p['password'],
            //                   [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            //                    \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
            //   $stmt = $pdo->prepare("SELECT {$p['col_id']} AS id,
            //                                 {$p['col_uname']} AS username,
            //                                 {$p['col_display']} AS display_name,
            //                                 {$p['col_role']} AS role,
            //                                 {$p['col_active']} AS active
            //                          FROM {$p['table']}
            //                          WHERE {$p['col_uname']} = :u LIMIT 1");
            //   $stmt->execute([':u' => $username]);
            //   $row = $stmt->fetch();
            //   if (!$row || (int)$row['active'] !== 1) {
            //       Response::error('User not found or disabled', 401); return null;
            //   }
            //   $role = self::mapRole($row['role']);
            //   $displayName = $row['display_name'] ?: $username;
            Response::error('SSO parent-DB lookup not yet configured', 501);
            return null;
        }

        // Upsert shadow row in local users table so operation_log + /me keep working.
        $existing = Database::fetchOne('SELECT id FROM anprc_users WHERE username = ?', [$username]);
        if ($existing) {
            $userId = (int)$existing['id'];
            Database::update('anprc_users',
                ['display_name' => $displayName, 'role' => $role, 'enabled' => 1],
                'id = :uid', ['uid' => $userId]);
        } else {
            $userId = Database::insert('anprc_users', [
                'username' => $username,
                'display_name' => $displayName,
                'role' => $role,
                'enabled' => 1,
                // SSO users never log in with a password — store an unguessable hash.
                'password_hash' => password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT),
            ]);
        }

        $token = self::issueToken($userId);
        $user = Database::fetchOne(
            'SELECT id, username, display_name, role, enabled, created_at FROM anprc_users WHERE id = ?',
            [$userId]
        );
        InspectionService::logOperation([
            'actor_username' => $username,
            'action' => 'auth.sso_login',
            'request_payload' => ['username' => $username, 'dev_bypass' => $devBypass],
            'response_payload' => ['role' => $role, 'user_id' => $userId],
            'status' => 'success',
        ]);
        return ['code' => 200, 'message' => 'success', 'data' => ['user' => $user, 'token' => $token]];
    }

    public function me(Request $req) {
        $uid = self::userIdFromToken($req->header('authorization'));
        if (!$uid) { Response::error('Unauthenticated', 401); return null; }
        $user = Database::fetchOne('SELECT id, username, display_name, role, enabled, created_at FROM anprc_users WHERE id = ?', [$uid]);
        if (!$user) { Response::error('User not found', 404); return null; }
        return ['code' => 200, 'message' => 'success', 'data' => $user];
    }

    public static function issueToken(int $userId): string {
        $cfg = $GLOBALS['APP_CONFIG']['auth'];
        $payload = ['uid' => $userId, 'exp' => time() + $cfg['token_ttl']];
        $b64 = self::b64url(json_encode($payload));
        $sig = self::b64url(hash_hmac('sha256', $b64, $cfg['secret'], true));
        return $b64 . '.' . $sig;
    }

    // Resolves the bearer-token holder to a username for audit logging.
    // Returns null when the token is missing/invalid or the user vanished.
    public static function usernameFromRequest(Request $req): ?string {
        $uid = self::userIdFromToken($req->header('authorization'));
        if (!$uid) return null;
        $row = Database::fetchOne('SELECT username FROM anprc_users WHERE id = ?', [$uid]);
        return $row['username'] ?? null;
    }

    public static function userIdFromToken(?string $auth): ?int {
        if (!$auth) return null;
        $token = preg_replace('/^Bearer\s+/i', '', $auth);
        if (strpos($token, '.') === false) return null;
        list($b64, $sig) = explode('.', $token, 2);
        $cfg = $GLOBALS['APP_CONFIG']['auth'];
        $expected = self::b64url(hash_hmac('sha256', $b64, $cfg['secret'], true));
        if (!hash_equals($expected, $sig)) return null;
        $payload = json_decode(self::b64urlDecode($b64), true);
        if (!$payload || ($payload['exp'] ?? 0) < time()) return null;
        return (int)($payload['uid'] ?? 0) ?: null;
    }

    private static function b64url(string $s): string {
        return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    }
    private static function b64urlDecode(string $s): string {
        $pad = strlen($s) % 4;
        if ($pad) $s .= str_repeat('=', 4 - $pad);
        return base64_decode(strtr($s, '-_', '+/')) ?: '';
    }
}
