# Production Deployment Guide

End-to-end instructions to deploy the ANPR + S300 platform on a fresh Linux
server. Tested against **Ubuntu 22.04 LTS**.

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first to understand what each
component does.

## 1. Target topology

```
┌───────────────────────────────────────────────────┐
│                  Production Server                 │
│                                                    │
│  ┌──────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Apache + PHP │  │ Mosquitto  │  │  Python    │  │
│  │  (port 80)   │  │  1883/8083 │  │  Worker    │  │
│  └──────┬───────┘  └─────┬──────┘  └─────┬──────┘  │
│         │                │                │         │
│         └─────────► MySQL :3306 ◄─────────┘         │
└───────────────────────┬───────────────────────────┘
                        │ LAN
   ┌────────────────────┼────────────────────────┐
   │                    │                        │
┌──┴────────┐    ┌──────┴──────┐         ┌──────┴──────┐
│ Entry ANPR│    │  Exit ANPR  │         │    S300     │
│  camera   │    │   camera    │         │  + UVIS     │
│           │    │ (whitelist  │         │  + Road     │
│           │    │   mode)     │         │   blocker   │
└───────────┘    └─────────────┘         └─────────────┘
```

All hardware sits on the same LAN as the server. The server must be reachable
from S300 (HTTP) for the inspection callbacks, and reach the road blocker (HTTP).
Cameras talk via MQTT to the server.

## 2. Server sizing

Minimum:
- 2 vCPU
- 4 GB RAM
- 40 GB disk (logs + image uploads grow over time)
- 1 Gbps NIC

This is comfortable for a single-lane deployment (one entry + one exit + one
S300). Each S300 inspection produces a UVIS image (~200 KB - 2 MB depending on
your config) — plan disk accordingly if you keep history long-term.

## 3. One-shot install script

The fastest path. Adjust the env vars at the top, then run end-to-end.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ====== Customise these ======
DB_APP_USER="anpr"
DB_APP_PASS="change-this-strong-password"
DB_NAME="anpr_s300"
DB_HOST="127.0.0.1"
DB_PORT="5432"

MQTT_USER="admin"     # broker auth is REQUIRED (allow_anonymous false) — see §4.3
MQTT_PASS="change-mqtt-pass"

# Auth — SSO from a parent portal (no local password). See docs/DEV_LOGIN.md.

# ====== Packages ======
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

(Continue with the per-component sections below.)

## 4. Component-by-component

### 4.1 PostgreSQL

```bash
# postgres ships ready to go on Ubuntu — just create the app user + DB
sudo -u postgres psql <<SQL
CREATE USER ${DB_APP_USER} WITH PASSWORD '${DB_APP_PASS}';
CREATE DATABASE ${DB_NAME} OWNER ${DB_APP_USER} ENCODING 'UTF8';
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_APP_USER};
SQL

# Optional hardening: restrict pg_hba.conf to local connections only.
# /etc/postgresql/16/main/pg_hba.conf — keep the default `local`/`host 127.0.0.1`
# rules; do NOT add any 0.0.0.0/0 entry.
sudo systemctl restart postgresql
```

Apply the schema (single consolidated file — no migrations needed for a fresh
install; the file is idempotent so re-running is safe):

```bash
cd /tmp
git clone <your-repo-url> anpr   # or rsync the project from your dev box
cd anpr/backend/database

PGPASSWORD=${DB_APP_PASS} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_APP_USER} \
  -d ${DB_NAME} -f schema.sql

# Apply any pending migrations (these are idempotent — safe to re-run):
for m in /tmp/anpr/backend/database/migrations/*.sql; do
  PGPASSWORD=${DB_APP_PASS} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_APP_USER} \
    -d ${DB_NAME} -f "$m"
done

# Auth note: the platform uses SSO from a parent portal (no local passwords).
# Local users are auto-created as shadow rows on first successful SSO login.
# In dev, set `auth.dev_bypass = true` in config.php — see docs/DEV_LOGIN.md.
```

> The PHP backend needs the `pdo_pgsql` extension. The `php-pgsql` apt package
> installs both `pgsql` and `pdo_pgsql`. Verify with `php -m | grep pgsql`.

### 4.2 PHP backend

```bash
# Copy the backend into the Apache document root
sudo mkdir -p /var/www/anpr_backend
sudo rsync -av --delete /tmp/anpr/backend/../ /var/www/anpr_backend/   # adjust to your layout
# OR if you laid it out exactly like dev: rsync of C:\xampp\htdocs\anpr_backend
sudo chown -R www-data:www-data /var/www/anpr_backend
sudo chmod -R 755 /var/www/anpr_backend
sudo chmod -R 775 /var/www/anpr_backend/uploads /var/www/anpr_backend/logs
```

Configure the database connection in `config/config.php`:

```php
'database' => [
    'driver'   => 'pgsql',
    'host'     => '127.0.0.1',
    'port'     => 5432,
    'name'     => 'anpr_s300',
    'user'     => 'anpr',
    'password' => 'change-this-strong-password',   // = $DB_APP_PASS
],
'auth' => [
    'secret'    => 'GENERATE-A-LONG-RANDOM-STRING-HERE',   // openssl rand -hex 32
    'token_ttl' => 86400 * 7,
    'dev_bypass' => false,                                 // MUST be false in production
    'parent_db' => [
        'driver'      => 'mysql',                          // or 'pgsql' — match the parent
        'host'        => '<parent platform DB host>',
        'port'        => 3306,
        'name'        => '<parent platform DB name>',
        'user'        => '<read-only user>',
        'password'    => '<password>',
        'table'       => 'tbl_users',                      // adjust to real parent schema
        'col_id'      => 'id',
        'col_uname'   => 'username',
        'col_display' => 'full_name',
        'col_role'    => 'role',
        'col_active'  => 'is_active',
    ],
],
'app' => [
    'debug' => false,                    // IMPORTANT: turn off in prod
    ...
],
```

Apache virtual host:

```apache
# /etc/apache2/sites-available/anpr.conf
<VirtualHost *:80>
    ServerName  anpr.yourcompany.local
    DocumentRoot /var/www/anpr_backend/public

    <Directory /var/www/anpr_backend>
        AllowOverride All
        Require all granted
    </Directory>

    # Front-end static build (built separately, see §4.5)
    Alias /app /var/www/anpr_frontend/dist
    <Directory /var/www/anpr_frontend/dist>
        Options FollowSymLinks
        AllowOverride None
        Require all granted
        # SPA fallback so React-Router or page reloads work
        FallbackResource /index.html
    </Directory>

    # SSE needs unbuffered output
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

Verify:
```bash
curl -s http://localhost/api/health
# {"code":200,"message":"ok","data":{"time":"..."}}
```

### 4.3 Mosquitto MQTT broker

```bash
sudo tee /etc/mosquitto/conf.d/anpr.conf >/dev/null <<'CFG'
# TCP listener — used by cameras and the Python worker
listener 1883
protocol mqtt

# WebSocket listener — used by the dashboard for live preview (optional)
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

# Authentication
allow_anonymous false
password_file /etc/mosquitto/passwd
CFG

# Create credentials (user `admin` is the convention used across this guide)
sudo mosquitto_passwd -c -b /etc/mosquitto/passwd "${MQTT_USER:-admin}" "${MQTT_PASS:-change-mqtt-pass}"
sudo chown mosquitto:mosquitto /etc/mosquitto/passwd
sudo chmod 640 /etc/mosquitto/passwd

sudo systemctl restart mosquitto
sudo systemctl enable  mosquitto

# Verify
mosquitto_sub -h localhost -u "${MQTT_USER:-admin}" -P "${MQTT_PASS:-change-mqtt-pass}" -t test &
mosquitto_pub -h localhost -u "${MQTT_USER:-admin}" -P "${MQTT_PASS:-change-mqtt-pass}" -t test -m hello
```

> **Authentication is required.** The broker runs with `allow_anonymous false`, so
> **every** client must supply the credentials (user `admin` above):
> - **Worker** — `MQTT_USERNAME`/`MQTT_PASSWORD` in `/opt/anpr-worker/.env` (§4.4).
> - **Cameras** — set the username/password in each camera's MQTT config.
> - **Dashboard live panel** (MQTT-over-WebSocket on :8083) — enter the credentials
>   on the **Koneksi MQTT** page.
> - **Debug** — add `-u admin -P <pass>` to every `mosquitto_sub`/`mosquitto_pub`.
>
> The `password_file` must be **readable by the account the broker runs as** — on
> this systemd/Debian install that's the `mosquitto` user (the `chown` above); on
> other OSes (e.g. the Windows service running as LocalSystem) grant that account
> read access, or the broker fails to start with the file in place.

### 4.4 Python worker (systemd)

```bash
sudo useradd --system --shell /usr/sbin/nologin --home /opt/anpr-worker anpr
sudo mkdir -p /opt/anpr-worker
sudo rsync -av --exclude .venv /tmp/anpr/worker/ /opt/anpr-worker/
sudo chown -R anpr:anpr /opt/anpr-worker

# Configure
sudo -u anpr cp /opt/anpr-worker/.env.example /opt/anpr-worker/.env
sudo nano /opt/anpr-worker/.env
#   MQTT_BROKER=mqtt://127.0.0.1:1883
#   MQTT_USERNAME=admin            # required — must match the broker password file
#   MQTT_PASSWORD=change-mqtt-pass
#   BACKEND_URL=http://127.0.0.1
#   FALLBACK_CHANNEL=RJ001

# Virtualenv + deps
cd /opt/anpr-worker
sudo -u anpr python3 -m venv .venv
sudo -u anpr .venv/bin/pip install -r requirements.txt

# Install + start the service
sudo cp anpr-mqtt-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anpr-mqtt-worker

# Watch it run
sudo journalctl -u anpr-mqtt-worker -f
```

You should see within seconds:
```
INFO   MQTT connected
INFO   subscribed: device/+/message/up/ivs_result
```

### 4.5 React dashboard (static build)

```bash
# On your dev / build machine (NOT the prod server, ideally):
cd frontend
echo "VITE_API_BASE=http://anpr.yourcompany.local" > .env.production
npm ci
npm run build

# Copy the build output to the server
rsync -av dist/ user@prod:/var/www/anpr_frontend/dist/

# On the server:
sudo chown -R www-data:www-data /var/www/anpr_frontend
```

Dashboard is now reachable at `http://anpr.yourcompany.local/app/`.

Login: authenticated via SSO from the parent portal — the portal opens the
dashboard with `?username=<user>` appended. For first-time setup or smoke
testing before the parent is wired, enable dev bypass per
[`DEV_LOGIN.md`](./DEV_LOGIN.md) and visit `?username=admin`.

### 4.6 Initial configuration via the dashboard

Once everything is up:

1. **Channels** → edit `RJ001`:
   - `kind` = **entry**
   - `ANPR Device SN` = the **real entry camera's SN** (read off the camera's web UI)
   - `S300 Base URL` = `http://{s300-ip}:{port}`
   - Fill in Road Blocker fields (`IP`, `Port`, `Device No`, `Board ID`, `Column Num`)
   - `UVIS Timeout (sec)` = `30` (or your preference)

2. **Channels** → **New Channel** for `RJ002`:
   - `kind` = **exit**
   - `ANPR Device SN` = the **real exit camera's SN**
   - `Paired entry channel` = `RJ001`
   - S300 / road blocker fields can be left blank for exit

3. Go back to `RJ001` and set `Paired exit channel` = `RJ002`.

4. **Settings** → enable **Auto-start S300 Inspection** so plates trigger /come automatically.
   - *Optional* **entry gate** — if the entry ANPR camera drives its own barrier through
     a GPIO relay, set `entry_gate_open=1` so the platform pulses it on recognition (at
     `/come`, via `gpio_out`). Tune `entry_gate_io` (output index 0–3, default `0`),
     `entry_gate_value` (`0`=off, `1`=on, `2`=pulse — default `2`) and
     `entry_gate_pulse_ms` (default `1000`). Leave `entry_gate_open=0` (default) when the
     entry barrier is the road blocker only.

5. **VIP** tab → add any VIP plates you want to bypass S300.

6. **Exit camera config** — on the **exit ANPR camera's own web UI**, enable
   whitelist enforcement mode so it only opens for plates the platform has
   pushed via `white_list_operator`.

## 5. Hardware integration checklist

| Hardware | Setting on hardware | Setting in platform |
|---|---|---|
| Entry ANPR | MQTT broker = `your-server:1883`, anonymous or auth, plate-detection enabled | `channels.anpr_device_sn` = its SN |
| Exit ANPR | MQTT broker = `your-server:1883`, **whitelist mode ON**, barrier wired to GPIO | `channels.anpr_device_sn` = its SN; `channels.kind`=exit; `paired_channel_id`=entry |
| S300 device | Set its custom callback URLs (per protocol §III) → `OVERSEAS_WORK_STATUS_URL`, `_FACE_IMAGE_URL`, `_VIDEO_RECORD_URL`, `_RESET_COMPLETE_URL`, `_UVIS_URL` to your server's `/overseas/s300/*` paths. `OVERSEAS_PLATFORM_ENABLED=true` | `channels.s300_base_url` = `http://{s300-ip}:{port}`; channel number on S300 must match `channels.channel_no` |
| Road blocker | HTTP API enabled, deviceNo + board IDs configured | `channels.rb_ip`, `rb_port`, `rb_device_no`, `rb_board_id`, `rb_column_num` |

## 6. Firewall

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (Apache)
sudo ufw allow 443/tcp    # HTTPS if you front it with TLS
sudo ufw allow from 192.168.1.0/24 to any port 1883   # MQTT — restrict to camera VLAN
sudo ufw allow from 192.168.1.0/24 to any port 8083   # MQTT WS — same
# Postgres stays loopback-only; do NOT open 5432
sudo ufw enable
```

> Do **not** expose 1883 to the public internet. MQTT brokers are a frequent
> attack target.

## 7. TLS (recommended for production)

Wrap the dashboard + REST API in HTTPS using Certbot:

```bash
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
sudo certbot --apache -d anpr.yourcompany.local
```

After issuing, update the worker's `BACKEND_URL` to `https://anpr.yourcompany.local`
and restart it.

For MQTT-over-TLS (port 8883), add a separate listener block in mosquitto.conf
and use cert paths from `/etc/letsencrypt/live/...`. Cameras vary in their TLS
support — check before flipping the switch.

## 8. Backups

```bash
# Daily DB dump
sudo tee /etc/cron.daily/anpr-backup >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
TS=$(date +%F)
mkdir -p /backups/anpr
PGPASSWORD=$DB_APP_PASS pg_dump -h 127.0.0.1 -U anpr anpr_s300 \
  --format=custom --no-owner --no-privileges \
  | gzip > /backups/anpr/db-$TS.dump.gz
# Keep 30 days
find /backups/anpr -name 'db-*.dump.gz' -mtime +30 -delete
# Image uploads (UVIS + X-ray)
rsync -a /var/www/anpr_backend/uploads/ /backups/anpr/uploads/
EOF
sudo chmod +x /etc/cron.daily/anpr-backup

# Restore (when needed):
#   PGPASSWORD=$DB_APP_PASS pg_restore -h 127.0.0.1 -U anpr -d anpr_s300 \
#       --clean --if-exists < <(gunzip < /backups/anpr/db-YYYY-MM-DD.dump.gz)
```

## 9. Monitoring & health

| Check | Command |
|---|---|
| Worker alive | `systemctl is-active anpr-mqtt-worker` |
| Backend alive | `curl -fs http://localhost/api/health` |
| MQTT broker | `systemctl is-active mosquitto` |
| Postgres up | `systemctl is-active postgresql` |
| Worker logs | `journalctl -u anpr-mqtt-worker -f` |
| Apache errors | `tail -f /var/log/apache2/anpr-error.log` |
| Mosquitto logs | `tail -f /var/log/mosquitto/mosquitto.log` |
| DB stuck inspections | `psql -h 127.0.0.1 -U anpr -d anpr_s300 -c "SELECT id, license_plate, state, decision FROM inspections WHERE state NOT IN ('completed','vip_skipped','failed') ORDER BY id DESC LIMIT 10;"` |
| Pending MQTT queue | `psql -h 127.0.0.1 -U anpr -d anpr_s300 -c "SELECT * FROM mqtt_outbound_queue WHERE status='pending';"` |

Hook these into Prometheus / Nagios / your monitoring of choice.

## 10. Routine operations

| Task | How |
|---|---|
| Restart worker after code update | `sudo systemctl restart anpr-mqtt-worker` |
| Restart backend after PHP change | `sudo systemctl reload apache2` |
| Re-deploy frontend | rsync new `dist/` over the old one — no restart needed |
| Apply a new SQL migration | Drop `migration_NNN.sql` in `backend/database/`, run `psql -d anpr_s300 -f migration_NNN.sql` |
| Rotate logs | Already handled by logrotate for Apache + mosquitto; PHP worker logs to journald |
| Reset a stuck channel manually | UPDATE `anprc_inspections` SET `state='completed'`, `decision='fail'` WHERE id=X; then watchdog releases the channel |

## 11. Upgrade procedure

1. Pull new code on the build host: `git pull`
2. **Backend**: rsync `backend/` → `/var/www/anpr_backend/`; run any new migrations; `systemctl reload apache2`
3. **Worker**: rsync `worker/` → `/opt/anpr-worker/` (excluding `.venv`); if `requirements.txt` changed, `sudo -u anpr .venv/bin/pip install -r requirements.txt`; `systemctl restart anpr-mqtt-worker`
4. **Frontend**: rebuild and rsync `dist/`
5. Smoke test: trigger a vehicle through the simulator and watch journals.

## 12. Disaster recovery

| Scenario | Recovery |
|---|---|
| Lost the server entirely | Reinstall from backups: `pg_restore` the latest `db-*.dump.gz`, rsync `uploads/` back, redeploy code via §3-§4 |
| MQTT broker corruption | Stop mosquitto, delete `/var/lib/mosquitto/mosquitto.db`, restart; queued messages lost but new ones flow |
| Worker stuck in a loop | `systemctl restart anpr-mqtt-worker`; journal will show the cause |
| DB lockup | `systemctl restart postgresql`; investigate slow queries via `SELECT * FROM pg_stat_activity;` |

## 13. Cheat sheet — file locations

| Path | What |
|---|---|
| `/var/www/anpr_backend/` | PHP backend |
| `/var/www/anpr_backend/config/config.php` | DB + secret config |
| `/var/www/anpr_backend/uploads/` | UVIS + X-ray images |
| `/var/www/anpr_backend/logs/` | App logs + SSE stream file |
| `/var/www/anpr_frontend/dist/` | Built React app |
| `/opt/anpr-worker/` | Python worker |
| `/opt/anpr-worker/.env` | Worker config |
| `/etc/mosquitto/conf.d/anpr.conf` | Broker config |
| `/etc/mosquitto/passwd` | MQTT credentials |
| `/etc/systemd/system/anpr-mqtt-worker.service` | Worker systemd unit |
| `/etc/apache2/sites-available/anpr.conf` | Apache vhost |
| `/backups/anpr/` | DB + uploads backup |

## 14. What NOT to do in production

- ❌ Don't run with `app.debug = true` — leaks file paths in error responses.
- ❌ Don't expose port 1883 to the internet.
- ❌ Don't share the JWT `auth.secret` between dev and prod.
- ❌ Don't run the worker and dashboard simultaneously with the **browser**
  trigger enabled — the browser AutoTrigger has been removed in this build but
  if you re-enable it for testing, disable in prod to avoid double `/come` calls.
- ❌ Don't manually edit rows in `anprc_inspections` while the worker is live (lock
  contention + decision race).
- ❌ Don't store the MySQL root password in `config.php` — use the dedicated
  `anpr` user.

## 15. Going further

- **Multiple lanes**: just add more channel pairs in the database. The worker
  routes each plate by `anpr_device_sn`.
- **Multi-site**: deploy a fresh instance per site; share reporting via the
  visits table dumped to a central data warehouse.
- **LED-TV signage integration**: when the doc arrives, add a small HTTP call
  in `DecisionExecutor::openBlocker` and `sendBackUpAudio` to push the
  pass/suspect/fail message to the sign.
- **HA**: PHP backend + MySQL replicated; worker can run active/passive (two
  workers with different `MQTT_CLIENT_ID` — only one acts on each plate if you
  add a simple distributed lock, e.g. via MySQL row).

That's everything. If something explodes, start with `journalctl -u anpr-mqtt-worker -f`
and the Apache error log — they cover 90% of incidents.
