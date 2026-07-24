# Checklist Go-Live Produksi

Apa yang harus diubah saat berpindah dari lokal/dev ke server produksi yang
menjalankan **HTTPS + WSS**. Pakai bersama [`DEPLOYMENT.id.md`](./DEPLOYMENT.id.md)
(setup server) dan [`COMMUNICATION.id.md`](./COMMUNICATION.id.md) (siapa bicara
dengan siapa).

Prinsipnya: **TLS ke arah orang, polos ke arah mesin.** Operator mengakses
platform via HTTPS/WSS; perangkat lapangan (kamera, S300, relay CORX) tetap pada
MQTT/HTTP polos di VLAN perangkat terisolasi, karena dukungan TLS pada perangkat
embedded sering tidak andal.

---

## 1. Backend — `backend/config/config.prod.php`

Config dev dan prod kini file terpisah yang dipilih lewat `APP_ENV`. Di server
prod, salin `backend/config/config.prod.example.php` ke `config.prod.php`, isi
nilai asli, lalu set `APP_ENV=prod` (vhost Apache: `SetEnv APP_ENV prod`; skrip
CLI: `APP_ENV=prod php ...`). Tanpa `APP_ENV` backend jatuh kembali ke
`config.php` biasa, jadi mesin dev tidak perlu diubah.

| Setting | Nilai dev | Produksi |
|---|---|---|
| `app.debug` | `true` | **`false`** — debug=true membocorkan path file pada respons error |
| `app.cors_origins` | `['*']` | `['https://domain-anda']` — kunci ke origin asli |
| `database.host` / `port` | `127.0.0.1` / `5433` | host DB prod / `5432` |
| `database.password` | `anpr_root_2026` | password DB prod asli |
| `auth.secret` | `change-this-in-production-...` | **secret acak kuat** (jangan pakai ulang punya dev) |
| `auth.dev_bypass` | `true` | **`false`** — kalau tidak, username apa pun jadi admin |
| `auth.parent_db.*` | `127.0.0.1` / `CHANGE_ME` | host DB platform induk asli + kredensial read-only (lookup SSO) |

## 2. Worker — `worker/.env`

Topologi prod: **worker + Mosquitto berjalan di `10.10.33.143`**, **webservices
(backend Apache + SPA) di `10.10.33.144`** — jadi broker-nya lokal bagi worker
tetapi backend-nya remote. Blok prod siap-uncomment ada di
`worker/.env.example`.

| Var | Nilai dev | Produksi |
|---|---|---|
| `MQTT_BROKER` | `mqtt://127.0.0.1:1883` | `mqtt://10.10.33.143:8171` |
| `BACKEND_URL` | `http://127.0.0.1/anpr_backend` | `http://10.10.33.144/anpr_backend` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | `admin` / `admin123` | `sigap` / password broker prod |

## 3. Build Frontend (perbaikan mixed-content)

Halaman yang disajikan via `https://` **tidak bisa** membuka `ws://` atau
`http://` — browser memblokirnya diam-diam. Maka:

- Base URL API kini otomatis (`frontend/src/services/apiBase.ts`):
  `VITE_API_BASE` jika diset saat build → jika tidak, build produksi memakai
  **origin SPA sendiri** + `/anpr_backend` → dev jatuh ke
  `http://127.0.0.1/anpr_backend`. Karena SPA prod disajikan oleh Apache yang
  sama dengan backend (`10.10.33.144`), **`.env.production` tidak diperlukan** —
  buat (lihat `frontend/.env.example`) hanya jika API berada di host yang
  berbeda dari SPA.
- Default **MQTT-over-WebSocket** di `frontend/src/contexts/MqttContext.tsx`
  (`DEFAULT_CONFIG`): dev memakai `brokerUrl: '127.0.0.1'`, `port: 8083`,
  `useSSL: false`. Di prod browser operator memakai **endpoint WSS**:
  `brokerUrl: wss-sigap.dpr.go.id`, `port: 9901`, `useSSL: true`, username
  `sigap` + password broker prod (`mqttService.ts` membangun
  `wss://{brokerUrl}:{port}/mqtt` — path `/mqtt` sudah cocok). Nilai ini
  disimpan per pengguna di `localStorage`. Koneksi browser hanya untuk
  monitoring/tampilan — pipeline inspeksi berjalan lewat koneksi raw-MQTT
  worker, jadi latensi WSS tidak pernah memengaruhi pemrosesan inspeksi.
- Build ulang dan deploy: `npm run build` → kirim `dist/`.

## 4. Mosquitto

- `allow_anonymous false` + `password_file` — **ganti `admin123`** dengan
  password asli, lalu update worker `.env`, config frontend, **dan setiap kamera
  + relay CORX** agar cocok.
- Listener WebSocket `8083` → bind **loopback saja** dan reverse-proxy (§5).
- Opsional: listener TLS `8883` jika ingin MQTT kamera terenkripsi (dukungan
  bervariasi — tes dulu).

## 5. Apache — virtual host `:443`

- Pasang sertifikat TLS; sajikan SPA + `/anpr_backend` via HTTPS.
- Proxy WSS ke listener websocket loopback Mosquitto, sehingga browser hanya
  bicara `https://host` + `wss://host/mqtt` (8083 tidak pernah terekspos, satu
  sertifikat):
  ```apache
  ProxyPass        /mqtt ws://127.0.0.1:8083/mqtt
  ProxyPassReverse /mqtt ws://127.0.0.1:8083/mqtt
  ```
- Pertahankan virtual host `:80` **di VLAN perangkat saja** untuk **callback
  S300** (`/overseas/s300/*`) kecuali S300 menerima sertifikat Anda — klien HTTP
  embedded sering gagal pada sertifikat self-signed / CA internal.
- Matikan directory listing dan output debug PHP.

## 6. Database

Jalankan **satu** migrasi konsolidasi:
[`backend/database/migrations/2026-06-30_production_consolidated.sql`](../backend/database/migrations/2026-06-30_production_consolidated.sql).
Idempoten, hanya menambah, dan **tanpa pernyataan `DROP`**, jadi aman untuk
database bersama — hanya `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
EXISTS`, dan seed setting `ON CONFLICT DO NOTHING`.

- **Database baru:** jalankan `schema.sql` saja — sudah berisi semuanya,
  termasuk seed setting relay blocker. Migrasi konsolidasi adalah jaring
  pengaman untuk DB lama yang belum punya fitur terbaru.
- Drop kolom legacy `rb_*` **sengaja tidak** ada di file konsolidasi — tanpa DDL
  destruktif pada DB bersama, dan skema saat ini memang tidak punya kolom `rb_*`.

## 7. Config runtime di DB (`anprc_channels` / `anprc_settings`)

Arahkan ke hardware asli (bisa diedit di UI, tanpa ubah kode):

- `s300_base_url` → S300 asli `http://{ip}:{port}`
- `anpr_device_sn` (entry **dan** exit) → SN kamera asli
- `blocker_relay_topic` / `blocker_relay_res` → topik + device id relay asli
- `blocker_auto_open_enabled` → tetap **`0`** (risiko tabrakan; belum ada sensor kendaraan)
- `mqtt_broker_url` (default seed `ws://localhost:8083/mqtt`) → `wss://domain-anda/mqtt`

## 8. Di perangkat itu sendiri

- **Kamera:** broker = `10.10.33.143:8171` dengan kredensial prod; kamera exit
  dalam mode whitelist.
- **S300:** set `OVERSEAS_*_URL` (work-status / face / video / **uvis** / reset)
  ke `/overseas/s300/*` server Anda, dan `OVERSEAS_PLATFORM_ENABLED=true`.
- **Relay CORX:** broker = `10.10.33.143:8171`, kredensial prod, topik
  `testpublish` / `testsubscribe`.

## 9. Firewall

```
443/tcp   buka  (HTTPS + WSS — operator)
80/tcp    VLAN perangkat saja  (callback S300) — atau 443 jika sertifikat S300 cocok
8171/tcp  VLAN perangkat saja  (kamera, relay, worker) — jangan pernah publik
8083/tcp  loopback saja        (di-proxy di balik 443)
5432/tcp  loopback saja
```

## 10. Rahasia yang harus dirotasi (jangan kirim nilai dev)

- Password broker (`admin123`)
- Password DB
- `auth.secret`
- Password `parent_db`

---

## Referensi port

### Inbound — klien terhubung **ke server**

| Port | Proto | Layanan | Siapa terhubung | Catatan |
|---|---|---|---|---|
| 443 | HTTPS / WSS | Apache (SPA + API) + proxy WSS | browser operator | wajah publik |
| 80 | HTTP | Apache | **callback S300** | VLAN perangkat saja |
| 8171 | MQTT | broker (10.10.33.143) | kamera, relay CORX, worker | VLAN perangkat saja, jangan publik |
| 8083 | MQTT-WS | Mosquitto | (di-proxy di balik 443) | loopback saja |
| 8883 | MQTT-TLS | Mosquitto (opsional) | kamera | hanya jika TLS aktif |
| 5432 | TCP | PostgreSQL | backend | loopback saja |

### Outbound — **server terhubung keluar**

| Target | Port | Untuk |
|---|---|---|
| API HTTP robot S300 `http://{s300_ip}:{port}/api/v1/...` | per-channel (mis. 8086) | `/come`, `/leave`, `/capture`, `/audio-prompt` |
| Host audio WAV (file server Anda) | mis. 8084 | S300 mengunduh audio prompt kustom |
| Videotron `http://192.168.51.7` | 80 | push tampilan (hanya setelah disambung ke `worker.py`) |

### Sisi perangkat / infra

| Tautan | Port | Catatan |
|---|---|---|
| Stream video RTSP NVR | 554 / 8080 | playback inspeksi; dikonsumsi browser operator |
| Tool konfigurasi relay CORX | 60001/UDP | hanya saat konfigurasi, bukan runtime |
