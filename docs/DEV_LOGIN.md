# Development Login Guide

The platform is designed to be **embedded inside a parent portal**. In production
the parent platform passes a username via the `?username=<value>` query parameter
and the backend looks that user up in the parent platform's database.

For **local development** — before the parent platform is available — the backend
has a "dev bypass" mode that accepts any username and grants admin role. This
document explains how to use it, how to disable it, and how to switch back to
production SSO.

---

## 1. The auth flow at a glance

```
┌────────────────┐   ?username=alice    ┌────────────────────┐
│ Parent portal  │ ───────────────────► │  Frontend (Vite)   │
│  (production)  │                      │  http://…:5173     │
└────────────────┘                      └─────────┬──────────┘
                                                  │ POST /api/auth/sso
                                                  │  { username: "alice" }
                                                  ▼
                                        ┌─────────────────────┐
                                        │   PHP backend       │
                                        │   /api/auth/sso     │
                                        ├─────────────────────┤
                                        │ if dev_bypass:      │
                                        │   role = admin      │
                                        │ else:               │
                                        │   look up in parent │
                                        │   platform's DB     │
                                        ├─────────────────────┤
                                        │ upsert local users  │
                                        │ row (shadow record) │
                                        │ → issue HMAC token  │
                                        └─────────────────────┘
                                                  │
                                                  │ { user, token }
                                                  ▼
                                          frontend stores token in
                                          localStorage, strips
                                          ?username= from URL, then
                                          loads the dashboard.
```

The token is reused for every subsequent API call (`Authorization: Bearer …`).
Refreshing the tab keeps you logged in until the token expires (default 7 days).

---

## 2. Enable dev bypass

Open `backend/config/config.php` (gitignored — your local copy only) and set:

```php
'auth' => [
    'secret'    => '<long random string>',
    'token_ttl' => 86400 * 7,
    'dev_bypass' => true,           // ← THIS LINE
    'parent_db'  => [ /* … */ ],
],
```

Alternatively, set an environment variable for the Apache process:

```bash
# Linux / macOS
export AUTH_DEV_BYPASS=1
sudo systemctl restart apache2

# Windows (PowerShell, persistent)
[Environment]::SetEnvironmentVariable('AUTH_DEV_BYPASS', '1', 'User')
# then restart the XAMPP Apache module
```

Either flag is sufficient; the config value wins if both are set.

> The example file `backend/config/config.example.php` already ships with
> `dev_bypass => true` so a fresh `cp config.example.php config.php` works
> out of the box for development.

---

## 3. Log in locally

With the frontend running (`cd frontend && npm run dev`) and Apache serving the
backend at `http://127.0.0.1/anpr_backend`, open:

```
http://localhost:5173/?username=admin
```

You should see:

1. URL becomes `http://localhost:5173/` (param is stripped after token issue)
2. Dashboard loads with the "admin" badge in the top-right StatusBar
3. Refreshing the page keeps you logged in (token persists in `localStorage`)

Any username works in dev — try `?username=alice` or `?username=operator` to
exercise different shadow-user records. Each unique username creates a row in
the local `users` table.

### Smoke-test with curl

```bash
# 1. Mint a token
curl -sX POST http://127.0.0.1/anpr_backend/api/auth/sso \
     -H "Content-Type: application/json" \
     -d '{"username":"admin"}'
# → {"code":200,"data":{"user":{…},"token":"abcd.xyz"}}

# 2. Verify the token works
curl -s http://127.0.0.1/anpr_backend/api/auth/me \
     -H "Authorization: Bearer abcd.xyz"
# → {"code":200,"data":{"id":1,"username":"admin","role":"admin",…}}
```

If step 1 returns `501 SSO parent-DB lookup not yet configured`, `dev_bypass`
is **off**. Re-check `config.php`.

---

## 4. Sign out / switch user

The StatusBar profile menu has **Sign out**. It clears the token from
`localStorage` and lands you on the SSO blocked-access screen.

To switch user, sign out then visit the URL again with a different
`?username=…` parameter.

---

## 5. Disable dev bypass for production

When the parent platform's DB is reachable from production:

1. Edit `config.php`:
   ```php
   'auth' => [
       'dev_bypass' => false,
       'parent_db'  => [
           'driver' => 'mysql',
           'host'   => '<parent host>',
           'name'   => '<parent db name>',
           'user'   => '<read-only user>',
           'password' => '<…>',
           'table'      => '<users table>',
           'col_id'     => 'id',
           'col_uname'  => 'username',
           'col_display'=> 'full_name',
           'col_role'   => 'role',
           'col_active' => 'is_active',
       ],
   ],
   ```
2. Replace the `TODO` block in `backend/src/Controllers/AuthController.php`
   (method `sso`) with the real lookup. A skeleton lives in the same method's
   comments.
3. The role coming out of the parent DB should map to one of
   `admin / operator / viewer` — adjust `mapRole()` (you'll need to add this
   helper) to translate the parent's role names to ours.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Akses Ditolak` / `Access denied` screen with no error | URL has no `?username=` AND no token in localStorage | Visit with `?username=admin` once to mint a token |
| 501 `SSO parent-DB lookup not yet configured` | `dev_bypass` is false but parent_db not implemented | Set `dev_bypass => true` in `config.php` (dev) or finish the TODO (prod) |
| 401 from `/api/auth/me` after refresh | Token expired or `auth.secret` changed | Visit with `?username=…` to mint a fresh token |
| 400 `username is required` | Frontend hit `/api/auth/sso` with empty body | Check the param value — empty / whitespace-only is rejected |
| Login works once but next refresh shows blocked | localStorage not persisted (private window?) | Use a normal browser window |

---

See also:
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — production setup
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) §9 — full API surface
- [`DATABASE.md`](./DATABASE.md) §10 — `users` table (SSO shadow rows)
- [`DATABASE.md`](./DATABASE.md) §12 — `operation_log` (audit trail of who did what)
