# Production Go-Live Checklist

What to change when moving from local/dev to a production server running
**HTTPS + WSS**. Use this together with [`DEPLOYMENT.md`](./DEPLOYMENT.md)
(server setup) and [`COMMUNICATION.md`](./COMMUNICATION.md) (who talks to whom).

The rule of thumb: **TLS toward people, plain toward machines.** Operators reach
the platform over HTTPS/WSS; the field devices (cameras, S300, CORX relay) stay
on plain MQTT/HTTP on an isolated device VLAN, because embedded gear has
unreliable TLS support.

---

## 1. Backend — `backend/config/config.prod.php`

Dev and prod configs are now separate files selected by `APP_ENV`. On the prod
server, copy `backend/config/config.prod.example.php` to `config.prod.php`,
fill in real values, and set `APP_ENV=prod` (Apache vhost: `SetEnv APP_ENV
prod`; CLI scripts: `APP_ENV=prod php ...`). Without `APP_ENV` the backend
falls back to plain `config.php`, so existing dev machines need no change.

| Setting | Dev value | Production |
|---|---|---|
| `app.debug` | `true` | **`false`** — debug=true leaks file paths in error responses |
| `app.cors_origins` | `['*']` | `['https://your-domain']` — lock to the real origin |
| `database.host` / `port` | `127.0.0.1` / `5433` | prod DB host / `5432` |
| `database.password` | `anpr_root_2026` | real prod DB password |
| `auth.secret` | `change-this-in-production-...` | **strong random secret** (do not reuse dev's) |
| `auth.dev_bypass` | `true` | **`false`** — otherwise any username is granted admin |
| `auth.parent_db.*` | `127.0.0.1` / `CHANGE_ME` | real parent-platform DB host + read-only creds (SSO lookup) |

## 2. Worker — `worker/.env`

Prod topology: the **worker + Mosquitto run on `10.10.33.143`**, the
**webservices (Apache backend + SPA) on `10.10.33.144`** — so the worker's
broker is local but its backend is remote. A ready-to-uncomment prod block is
in `worker/.env.example`.

| Var | Dev value | Production |
|---|---|---|
| `MQTT_BROKER` | `mqtt://127.0.0.1:1883` | `mqtt://10.10.33.143:8171` |
| `BACKEND_URL` | `http://127.0.0.1/anpr_backend` | `http://10.10.33.144/anpr_backend` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | `admin` / `admin123` | `sigap` / the prod broker password |

## 3. Frontend build (the mixed-content fix)

A page served over `https://` **cannot** open `ws://` or `http://` — the browser
blocks it silently. So:

- The API base resolves automatically (`frontend/src/services/apiBase.ts`):
  `VITE_API_BASE` if set at build time → otherwise a production build uses the
  SPA's **own origin** + `/anpr_backend` → dev falls back to
  `http://127.0.0.1/anpr_backend`. Since the prod SPA is served by the same
  Apache as the backend (`10.10.33.144`), **no `.env.production` is needed** —
  create one (see `frontend/.env.example`) only if the API lives on a
  different host than the SPA.
- **MQTT-over-WebSocket** default in `frontend/src/contexts/MqttContext.tsx`
  (`DEFAULT_CONFIG`): dev uses `brokerUrl: '127.0.0.1'`, `port: 8083`,
  `useSSL: false`. In prod operators' browsers use the **WSS endpoint**:
  `brokerUrl: wss-sigap.dpr.go.id`, `port: 9901`, `useSSL: true`, username
  `sigap` + the prod broker password (`mqttService.ts` builds
  `wss://{brokerUrl}:{port}/mqtt` — the `/mqtt` path matches). This value is
  stored per user in `localStorage`. The browser link is monitoring/display
  only — the inspection pipeline runs over the worker's raw-MQTT connection,
  so WSS latency never affects inspection processing.
- Rebuild and deploy: `npm run build` → ship `dist/`.

## 4. Mosquitto

- `allow_anonymous false` + `password_file` — **change `admin123`** to a real
  password, then update the worker `.env`, the frontend config, **and every
  camera + the CORX relay** to match.
- WebSocket listener `8083` → bind **loopback only** and reverse-proxy it (§5).
- Optional: an `8883` TLS listener if you want camera MQTT encrypted (support
  varies — test first).

## 5. Apache — `:443` virtual host

- Install the TLS cert; serve the SPA + `/anpr_backend` over HTTPS.
- Proxy WSS to Mosquitto's loopback websocket listener, so the browser only ever
  talks `https://host` + `wss://host/mqtt` (8083 never exposed, one cert):
  ```apache
  ProxyPass        /mqtt ws://127.0.0.1:8083/mqtt
  ProxyPassReverse /mqtt ws://127.0.0.1:8083/mqtt
  ```
- Keep a `:80` virtual host **on the device VLAN only** for the **S300
  callbacks** (`/overseas/s300/*`) unless the S300 accepts your cert — embedded
  HTTP clients often fail on self-signed / internal-CA certs.
- Disable directory listing and PHP debug output.

## 6. Database

Run **one** consolidated migration:
[`backend/database/migrations/2026-06-30_production_consolidated.sql`](../backend/database/migrations/2026-06-30_production_consolidated.sql).
It is idempotent, additive, and **contains no `DROP` statements**, so it is safe
on a shared database — it only `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
EXISTS`, and seeds settings `ON CONFLICT DO NOTHING`.

- **Fresh database:** run `schema.sql` instead — it already contains everything,
  including the blocker-relay settings seed. The consolidated migration is the
  safety net for an existing DB that predates the recent features.
- The legacy `rb_*` column-drop is **deliberately not** in the consolidated
  file — no destructive DDL on a shared DB, and the current schema has no `rb_*`
  columns anyway.

## 7. Runtime config in the DB (`anprc_channels` / `anprc_settings`)

Point these at the real hardware (editable in the UI, no code change):

- `s300_base_url` → real S300 `http://{ip}:{port}`
- `anpr_device_sn` (entry **and** exit) → real camera SNs
- `blocker_relay_topic` / `blocker_relay_res` → the real relay's topic + device id
- `blocker_auto_open_enabled` → keep **`0`** (collision risk; no vehicle sensor yet)
- `mqtt_broker_url` (seed default `ws://localhost:8083/mqtt`) → `wss://your-domain/mqtt`

## 8. On the devices themselves

- **Cameras:** broker = `10.10.33.143:8171` with the prod creds; exit camera in
  whitelist mode.
- **S300:** set `OVERSEAS_*_URL` (work-status / face / video / **uvis** / reset)
  to your server's `/overseas/s300/*`, and `OVERSEAS_PLATFORM_ENABLED=true`.
- **CORX relay:** broker = `10.10.33.143:8171`, prod creds, topics
  `testpublish` / `testsubscribe`.

## 9. Firewall

```
443/tcp   open  (HTTPS + WSS — operators)
80/tcp    device VLAN only  (S300 callbacks) — or 443 if the S300 cert works
8171/tcp  device VLAN only  (cameras, relay, worker) — never public
8083/tcp  loopback only     (proxied behind 443)
5432/tcp  loopback only
```

## 10. Secrets to rotate (never ship dev values)

- Broker password (`admin123`)
- DB password
- `auth.secret`
- `parent_db` password

---

## Port reference

### Inbound — clients connect **to the server**

| Port | Proto | Service | Who connects | Notes |
|---|---|---|---|---|
| 443 | HTTPS / WSS | Apache (SPA + API) + WSS proxy | operators' browsers | the public face |
| 80 | HTTP | Apache | **S300 callbacks** | device VLAN only |
| 8171 | MQTT | broker (10.10.33.143) | cameras, CORX relay, worker | device VLAN only, never public |
| 8083 | MQTT-WS | Mosquitto | (proxied behind 443) | loopback only |
| 8883 | MQTT-TLS | Mosquitto (optional) | cameras | only if TLS enabled |
| 5432 | TCP | PostgreSQL | backend | loopback only |

### Outbound — the **server connects out**

| Target | Port | For |
|---|---|---|
| S300 robot HTTP API `http://{s300_ip}:{port}/api/v1/...` | per-channel (e.g. 8086) | `/come`, `/leave`, `/capture`, `/audio-prompt` |
| WAV audio host (your file server) | e.g. 8084 | S300 downloads custom prompt audio |
| Videotron `http://192.168.51.7` | 80 | display push (only once wired into `worker.py`) |

### Device-side / infra

| Link | Port | Notes |
|---|---|---|
| NVR RTSP video streams | 554 / 8080 | inspection playback; consumed by the operator browser |
| CORX relay config tool | 60001/UDP | config-time only, not runtime |
