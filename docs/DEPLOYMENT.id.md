# Panduan Deployment Produksi

Instruksi end-to-end untuk mendeploy platform ANPR + S300 ke server Linux baru.
Diuji pada **Ubuntu 22.04 LTS**.

Baca [`ARCHITECTURE.id.md`](./ARCHITECTURE.id.md) terlebih dahulu untuk memahami
fungsi setiap komponen.

## 1. Topologi Target

```
┌───────────────────────────────────────────────────┐
│                  Server Produksi                   │
│                                                    │
│  ┌──────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Apache + PHP │  │ Mosquitto  │  │  Worker    │  │
│  │  (port 80)   │  │  1883/8083 │  │  Python    │  │
│  └──────┬───────┘  └─────┬──────┘  └─────┬──────┘  │
│         │                │                │         │
│         └──────► PostgreSQL :5432 ◄───────┘         │
└───────────────────────┬───────────────────────────┘
                        │ LAN
   ┌────────────────────┼────────────────────────┐
   │                    │                        │
┌──┴────────┐    ┌──────┴──────┐         ┌──────┴──────┐
│  Kamera   │    │   Kamera    │         │    S300     │
│  ANPR     │    │   ANPR      │         │  + UVIS     │
│  Masuk    │    │   Keluar    │         │  + Road     │
│           │    │ (mode       │         │   blocker   │
│           │    │  whitelist) │         │             │
└───────────┘    └─────────────┘         └─────────────┘
```

Semua perangkat berada di LAN yang sama dengan server. Server harus
dapat dijangkau dari S300 (HTTP) untuk callback inspeksi, dan dapat
menjangkau road blocker (HTTP). Kamera berkomunikasi via MQTT ke server.

## 2. Sizing Server

Minimum:
- 2 vCPU
- 4 GB RAM
- 40 GB disk (log + image upload akan tumbuh seiring waktu)
- 1 Gbps NIC

Spek ini nyaman untuk deployment single-lane (satu masuk + satu keluar + satu
S300). Setiap inspeksi S300 menghasilkan satu gambar UVIS (~200 KB - 2 MB
tergantung konfigurasi) — rencanakan disk sesuai retensi history yang Anda inginkan.

## 3. Skrip Install Satu Kali

Jalur tercepat. Sesuaikan variabel di atas, lalu jalankan end-to-end.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ====== Sesuaikan ini ======
DB_APP_USER="anpr"
DB_APP_PASS="ganti-password-kuat-ini"
DB_NAME="anpr_s300"
DB_HOST="127.0.0.1"
DB_PORT="5432"

MQTT_USER=""          # kosongkan untuk anonymous (LAN-only) atau set untuk auth
MQTT_PASS=""

# Auth — SSO dari portal induk (tidak ada password lokal). Lihat docs/DEV_LOGIN.id.md.

# ====== Paket ======
sudo apt update
sudo apt install -y \
  apache2 libapache2-mod-php php php-pgsql php-curl php-mbstring php-json \
  postgresql postgresql-client \
  mosquitto mosquitto-clients \
  python3 python3-venv python3-pip \
  git rsync curl

sudo a2enmod rewrite headers
sudo systemctl restart apache2
```

(Lanjutkan ke bagian per-komponen di bawah.)

## 4. Komponen per Komponen

### 4.1 PostgreSQL

```bash
# postgres siap pakai di Ubuntu — cukup buat user aplikasi + database
sudo -u postgres psql <<SQL
CREATE USER ${DB_APP_USER} WITH PASSWORD '${DB_APP_PASS}';
CREATE DATABASE ${DB_NAME} OWNER ${DB_APP_USER} ENCODING 'UTF8';
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_APP_USER};
SQL

# Hardening opsional: batasi pg_hba.conf agar hanya koneksi lokal.
# /etc/postgresql/16/main/pg_hba.conf — pertahankan rule default `local`/`host 127.0.0.1`;
# JANGAN tambah entry 0.0.0.0/0.
sudo systemctl restart postgresql
```

Terapkan schema (satu file konsolidasi — tidak perlu migrasi untuk fresh install;
file ini idempotent jadi aman dijalankan ulang):

```bash
cd /tmp
git clone <url-repo-anda> anpr   # atau rsync proyek dari dev box
cd anpr/backend/database

PGPASSWORD=${DB_APP_PASS} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_APP_USER} \
  -d ${DB_NAME} -f schema.sql

# Terapkan migrasi yang tertunda (idempoten — aman dijalankan ulang):
for m in /tmp/anpr/backend/database/migrations/*.sql; do
  PGPASSWORD=${DB_APP_PASS} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_APP_USER} \
    -d ${DB_NAME} -f "$m"
done

# Catatan auth: platform menggunakan SSO dari portal induk (tidak ada password
# lokal). User lokal dibuat otomatis sebagai shadow row pada login SSO pertama.
# Di dev, setel `auth.dev_bypass = true` di config.php — lihat docs/DEV_LOGIN.id.md.
```

> Backend PHP butuh extension `pdo_pgsql`. Paket apt `php-pgsql` menginstall
> `pgsql` dan `pdo_pgsql` sekaligus. Verifikasi: `php -m | grep pgsql`.

### 4.2 Backend PHP

```bash
# Salin backend ke document root Apache
sudo mkdir -p /var/www/anpr_backend
sudo rsync -av --delete /tmp/anpr/backend/../ /var/www/anpr_backend/   # sesuaikan layout
# ATAU jika Anda menempatkan persis seperti dev: rsync dari C:\xampp\htdocs\anpr_backend
sudo chown -R www-data:www-data /var/www/anpr_backend
sudo chmod -R 755 /var/www/anpr_backend
sudo chmod -R 775 /var/www/anpr_backend/uploads /var/www/anpr_backend/logs
```

Konfigurasi koneksi database di `config/config.php`:

```php
'database' => [
    'driver'   => 'pgsql',
    'host'     => '127.0.0.1',
    'port'     => 5432,
    'name'     => 'anpr_s300',
    'user'     => 'anpr',
    'password' => 'ganti-password-kuat-ini',   // = $DB_APP_PASS
],
'auth' => [
    'secret'    => 'BUAT-STRING-PANJANG-RANDOM-DI-SINI',   // openssl rand -hex 32
    'token_ttl' => 86400 * 7,
    'dev_bypass' => false,                                 // WAJIB false di produksi
    'parent_db' => [
        'driver'      => 'mysql',                          // atau 'pgsql' — sesuai induk
        'host'        => '<host DB portal induk>',
        'port'        => 3306,
        'name'        => '<nama DB portal induk>',
        'user'        => '<user read-only>',
        'password'    => '<password>',
        'table'       => 'tbl_users',                      // sesuaikan ke skema induk
        'col_id'      => 'id',
        'col_uname'   => 'username',
        'col_display' => 'full_name',
        'col_role'    => 'role',
        'col_active'  => 'is_active',
    ],
],
'app' => [
    'debug' => false,                    // PENTING: matikan di produksi
    ...
],
```

Virtual host Apache:

```apache
# /etc/apache2/sites-available/anpr.conf
<VirtualHost *:80>
    ServerName  anpr.perusahaananda.local
    DocumentRoot /var/www/anpr_backend/public

    <Directory /var/www/anpr_backend>
        AllowOverride All
        Require all granted
    </Directory>

    # Build statis frontend (dibuild terpisah, lihat §4.5)
    Alias /app /var/www/anpr_frontend/dist
    <Directory /var/www/anpr_frontend/dist>
        Options FollowSymLinks
        AllowOverride None
        Require all granted
        # Fallback SPA agar React-Router atau reload halaman bekerja
        FallbackResource /index.html
    </Directory>

    # SSE butuh output tidak di-buffer
    SetEnvIfNoCase Request_URI "/api/events/stream" no-gzip dont-vary

    ErrorLog  ${APACHE_LOG_DIR}/anpr-error.log
    CustomLog ${APACHE_LOG_DIR}/anpr-access.log combined
</VirtualHost>
```

```bash
sudo a2ensite anpr
sudo a2dissite 000-default
sudo apachectl configtest
sudo systemctl reload apache2
```

Verifikasi:
```bash
curl -s http://localhost/api/health
# {"code":200,"message":"ok","data":{"time":"..."}}
```

### 4.3 Mosquitto MQTT Broker

```bash
sudo tee /etc/mosquitto/conf.d/anpr.conf >/dev/null <<'CFG'
# Listener TCP — digunakan kamera dan worker Python
listener 1883
protocol mqtt

# Listener WebSocket — digunakan dashboard untuk preview live (opsional)
listener 8083
protocol websockets

# persistence
persistence true
persistence_location /var/lib/mosquitto/

# Logging
log_dest file /var/log/mosquitto/mosquitto.log
log_type error
log_type warning
log_type notice
log_type information

# Autentikasi
allow_anonymous false
password_file /etc/mosquitto/passwd
CFG

# Buat credential
sudo mosquitto_passwd -c -b /etc/mosquitto/passwd "${MQTT_USER:-anpr}" "${MQTT_PASS:-ganti-mqtt-pass}"
sudo chown mosquitto:mosquitto /etc/mosquitto/passwd
sudo chmod 640 /etc/mosquitto/passwd

sudo systemctl restart mosquitto
sudo systemctl enable  mosquitto

# Verifikasi
mosquitto_sub -h localhost -u "${MQTT_USER:-anpr}" -P "${MQTT_PASS:-ganti-mqtt-pass}" -t test &
mosquitto_pub -h localhost -u "${MQTT_USER:-anpr}" -P "${MQTT_PASS:-ganti-mqtt-pass}" -t test -m hello
```

> **Catatan keamanan LAN.** Jika server di LAN privat terpercaya hanya dengan
> kamera + worker, Anda bisa biarkan `allow_anonymous true` dan skip file
> password. Jika ada yang lain bisa mencapai :1883, pakai auth.

### 4.4 Worker Python (systemd)

```bash
sudo useradd --system --shell /usr/sbin/nologin --home /opt/anpr-worker anpr
sudo mkdir -p /opt/anpr-worker
sudo rsync -av --exclude .venv /tmp/anpr/worker/ /opt/anpr-worker/
sudo chown -R anpr:anpr /opt/anpr-worker

# Konfigurasi
sudo -u anpr cp /opt/anpr-worker/.env.example /opt/anpr-worker/.env
sudo nano /opt/anpr-worker/.env
#   MQTT_BROKER=mqtt://127.0.0.1:1883
#   MQTT_USERNAME=anpr
#   MQTT_PASSWORD=ganti-mqtt-pass
#   BACKEND_URL=http://127.0.0.1
#   FALLBACK_CHANNEL=RJ001

# Virtualenv + dependencies
cd /opt/anpr-worker
sudo -u anpr python3 -m venv .venv
sudo -u anpr .venv/bin/pip install -r requirements.txt

# Install + jalankan service
sudo cp anpr-mqtt-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anpr-mqtt-worker

# Pantau berjalan
sudo journalctl -u anpr-mqtt-worker -f
```

Anda akan melihat dalam hitungan detik:
```
INFO   MQTT connected
INFO   subscribed: device/+/message/up/ivs_result
```

### 4.5 Dashboard React (Build Statis)

```bash
# Di mesin dev / build (BUKAN server produksi, idealnya):
cd frontend
echo "VITE_API_BASE=http://anpr.perusahaananda.local" > .env.production
npm ci
npm run build

# Salin output build ke server
rsync -av dist/ user@prod:/var/www/anpr_frontend/dist/

# Di server:
sudo chown -R www-data:www-data /var/www/anpr_frontend
```

Dashboard sekarang dapat diakses di `http://anpr.perusahaananda.local/app/`.

Login: diautentikasi via SSO dari portal induk — portal membuka dashboard dengan
`?username=<user>` di URL. Untuk setup awal atau smoke test sebelum portal
induk tersambung, aktifkan dev bypass sesuai [`DEV_LOGIN.id.md`](./DEV_LOGIN.id.md)
dan kunjungi `?username=admin`.

### 4.6 Konfigurasi Awal lewat Dashboard

Setelah semua naik:

1. **Channels** → edit `RJ001`:
   - `kind` = **entry** (masuk)
   - `ANPR Device SN` = **SN kamera masuk asli** (baca di web UI kamera)
   - `S300 Base URL` = `http://{ip-s300}:{port}`
   - Isi field Road Blocker (`IP`, `Port`, `Device No`, `Board ID`, `Column Num`)
   - `UVIS Timeout (sec)` = `30` (atau preferensi Anda)

2. **Channels** → **New Channel** untuk `RJ002`:
   - `kind` = **exit** (keluar)
   - `ANPR Device SN` = **SN kamera keluar asli**
   - `Paired entry channel` = `RJ001`
   - Field S300 / road blocker bisa dikosongkan untuk exit

3. Kembali ke `RJ001` dan set `Paired exit channel` = `RJ002`.

4. **Settings** → aktifkan **Auto-start S300 Inspection** agar plat otomatis memicu /come.

5. Tab **VIP** → tambahkan plat VIP yang ingin melewati inspeksi S300.

6. **Konfigurasi kamera keluar** — di **web UI kamera ANPR keluar**, aktifkan
   mode whitelist enforcement agar palang hanya terbuka untuk plat yang
   sudah dipush platform via `white_list_operator`.

## 5. Checklist Integrasi Hardware

| Hardware | Setting di hardware | Setting di platform |
|---|---|---|
| ANPR Masuk | MQTT broker = `server-anda:1883`, anonymous atau auth, deteksi plat aktif | `channels.anpr_device_sn` = SN-nya |
| ANPR Keluar | MQTT broker = `server-anda:1883`, **mode whitelist ON**, palang terhubung ke GPIO | `channels.anpr_device_sn` = SN-nya; `channels.kind`=exit; `paired_channel_id`=entry |
| Perangkat S300 | Set URL callback kustom (per protokol §III) → `OVERSEAS_WORK_STATUS_URL`, `_FACE_IMAGE_URL`, `_VIDEO_RECORD_URL`, `_RESET_COMPLETE_URL`, `_UVIS_URL` ke path `/overseas/s300/*` server Anda. `OVERSEAS_PLATFORM_ENABLED=true` | `channels.s300_base_url` = `http://{ip-s300}:{port}`; nomor channel di S300 harus cocok `channels.channel_no` |
| Road Blocker | HTTP API aktif, deviceNo + board ID dikonfigurasi | `channels.rb_ip`, `rb_port`, `rb_device_no`, `rb_board_id`, `rb_column_num` |

## 6. Firewall

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (Apache)
sudo ufw allow 443/tcp    # HTTPS jika pakai TLS
sudo ufw allow from 192.168.1.0/24 to any port 1883   # MQTT — batasi ke VLAN kamera
sudo ufw allow from 192.168.1.0/24 to any port 8083   # MQTT WS — sama
# Postgres tetap loopback-only; JANGAN buka 5432
sudo ufw enable
```

> **JANGAN** ekspos port 1883 ke internet publik. MQTT broker target serangan favorit.

## 7. TLS (Direkomendasikan untuk Produksi)

Bungkus dashboard + REST API dengan HTTPS pakai Certbot:

```bash
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
sudo certbot --apache -d anpr.perusahaananda.local
```

Setelah issued, update `BACKEND_URL` worker ke `https://anpr.perusahaananda.local`
dan restart.

Untuk MQTT-over-TLS (port 8883), tambah blok listener terpisah di mosquitto.conf
dan pakai path cert dari `/etc/letsencrypt/live/...`. Dukungan TLS kamera
bervariasi — cek dulu sebelum mengaktifkan.

## 8. Backup

```bash
# Dump DB harian
sudo tee /etc/cron.daily/anpr-backup >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%F)
mkdir -p /backups/anpr
PGPASSWORD=$DB_APP_PASS pg_dump -h 127.0.0.1 -U anpr anpr_s300 \
  --format=custom --no-owner --no-privileges \
  | gzip > /backups/anpr/db-$TS.dump.gz
# Simpan 30 hari
find /backups/anpr -name 'db-*.dump.gz' -mtime +30 -delete
# Upload image (UVIS + X-ray)
rsync -a /var/www/anpr_backend/uploads/ /backups/anpr/uploads/
EOF
sudo chmod +x /etc/cron.daily/anpr-backup

# Restore (jika diperlukan):
#   PGPASSWORD=$DB_APP_PASS pg_restore -h 127.0.0.1 -U anpr -d anpr_s300 \
#       --clean --if-exists < <(gunzip < /backups/anpr/db-YYYY-MM-DD.dump.gz)
```

## 9. Monitoring & Kesehatan

| Cek | Perintah |
|---|---|
| Worker hidup | `systemctl is-active anpr-mqtt-worker` |
| Backend hidup | `curl -fs http://localhost/api/health` |
| MQTT broker | `systemctl is-active mosquitto` |
| Postgres hidup | `systemctl is-active postgresql` |
| Log worker | `journalctl -u anpr-mqtt-worker -f` |
| Error Apache | `tail -f /var/log/apache2/anpr-error.log` |
| Log Mosquitto | `tail -f /var/log/mosquitto/mosquitto.log` |
| Inspeksi DB macet | `psql -h 127.0.0.1 -U anpr -d anpr_s300 -c "SELECT id, license_plate, state, decision FROM inspections WHERE state NOT IN ('completed','vip_skipped','failed') ORDER BY id DESC LIMIT 10;"` |
| Antrian MQTT pending | `psql -h 127.0.0.1 -U anpr -d anpr_s300 -c "SELECT * FROM mqtt_outbound_queue WHERE status='pending';"` |

Hubungkan ke Prometheus / Nagios / monitoring pilihan Anda.

## 10. Operasi Rutin

| Tugas | Cara |
|---|---|
| Restart worker setelah update kode | `sudo systemctl restart anpr-mqtt-worker` |
| Restart backend setelah ubah PHP | `sudo systemctl reload apache2` |
| Re-deploy frontend | rsync `dist/` baru menimpa yang lama — tidak perlu restart |
| Terapkan migrasi SQL baru | Letakkan `migration_NNN.sql` di `backend/database/`, jalankan `psql -d anpr_s300 -f migration_NNN.sql` |
| Rotasi log | Sudah ditangani logrotate untuk Apache + mosquitto; worker PHP log ke journald |
| Reset channel macet manual | UPDATE `anprc_inspections` SET `state='completed'`, `decision='fail'` WHERE id=X; lalu watchdog akan melepaskan channel |

## 11. Prosedur Upgrade

1. Pull kode baru di build host: `git pull`
2. **Backend**: rsync `backend/` → `/var/www/anpr_backend/`; jalankan migrasi baru jika ada; `systemctl reload apache2`
3. **Worker**: rsync `worker/` → `/opt/anpr-worker/` (kecuali `.venv`); jika `requirements.txt` berubah, `sudo -u anpr .venv/bin/pip install -r requirements.txt`; `systemctl restart anpr-mqtt-worker`
4. **Frontend**: rebuild dan rsync `dist/`
5. Smoke test: jalankan kendaraan lewat simulator dan pantau journal.

## 12. Disaster Recovery

| Skenario | Pemulihan |
|---|---|
| Kehilangan server total | Reinstall dari backup: `pg_restore` `db-*.dump.gz` terbaru, rsync `uploads/` kembali, redeploy kode via §3-§4 |
| MQTT broker korup | Stop mosquitto, hapus `/var/lib/mosquitto/mosquitto.db`, restart; pesan antrean hilang tapi yang baru mengalir |
| Worker stuck loop | `systemctl restart anpr-mqtt-worker`; journal akan menunjukkan penyebab |
| DB lockup | `systemctl restart postgresql`; investigasi query lambat via `SELECT * FROM pg_stat_activity;` |

## 13. Cheat Sheet — Lokasi File

| Path | Apa |
|---|---|
| `/var/www/anpr_backend/` | Backend PHP |
| `/var/www/anpr_backend/config/config.php` | Config DB + secret |
| `/var/www/anpr_backend/uploads/` | Image UVIS + X-ray |
| `/var/www/anpr_backend/logs/` | Log aplikasi + stream SSE |
| `/var/www/anpr_frontend/dist/` | Build React |
| `/opt/anpr-worker/` | Worker Python |
| `/opt/anpr-worker/.env` | Config worker |
| `/etc/mosquitto/conf.d/anpr.conf` | Config broker |
| `/etc/mosquitto/passwd` | Credential MQTT |
| `/etc/systemd/system/anpr-mqtt-worker.service` | Unit systemd worker |
| `/etc/apache2/sites-available/anpr.conf` | Vhost Apache |
| `/backups/anpr/` | Backup DB + uploads |

## 14. Yang TIDAK Boleh Dilakukan di Produksi

- ❌ Jangan jalankan dengan `app.debug = true` — membocorkan path file dalam response error.
- ❌ Jangan ekspos port 1883 ke internet.
- ❌ Jangan share JWT `auth.secret` antara dev dan prod.
- ❌ Jangan jalankan worker dan dashboard bersamaan dengan trigger **browser**
  aktif — AutoTrigger browser sudah dihapus di build ini tapi jika Anda
  mengaktifkannya kembali untuk testing, nonaktifkan di prod agar tidak
  ada double `/come`.
- ❌ Jangan edit manual baris `anprc_inspections` saat worker hidup (kontensi lock +
  race decision).
- ❌ Jangan simpan password root MySQL di `config.php` — pakai user `anpr` khusus.

## 15. Skala Lebih Jauh

- **Multi-lane**: tambah saja pasangan channel di database. Worker me-route
  setiap plat berdasarkan `anpr_device_sn`.
- **Multi-site**: deploy instance fresh per site; share reporting via tabel
  visits di-dump ke data warehouse pusat.
- **Integrasi signage LED-TV**: ketika dokumentasi tiba, tambahkan HTTP call
  kecil di `DecisionExecutor::openBlocker` dan `sendBackUpAudio` untuk push
  pesan pass/suspect/fail ke sign.
- **HA**: Backend PHP + PostgreSQL replikasi; worker bisa jalan active/passive
  (dua worker dengan `MQTT_CLIENT_ID` berbeda — hanya satu aksi per plat jika
  Anda tambah simple distributed lock, mis. via row PostgreSQL).

Itu saja. Kalau ada yang meledak, mulai dari `journalctl -u anpr-mqtt-worker -f`
dan log error Apache — keduanya menutupi 90% insiden.
