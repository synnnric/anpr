# ANPR MQTT Worker (Python)

Headless daemon that subscribes to the MQTT broker and is the **sole trigger
source** for S300 inspections. The React dashboard is monitoring + admin only.

## What it does

1. Subscribes to `device/+/message/up/ivs_result` on the MQTT broker.
2. On each plate detection:
   - Decodes the base64 license number.
   - POSTs `/api/vehicles` to record the detection in MySQL.
   - If `auto_start_s300` setting is on AND the matched channel is free,
     POSTs `/api/s300/come/{channelNo}` (VIP / busy guard / decision engine
     are all enforced server-side).
3. Every `TICK_INTERVAL_S` (default 5 s) POSTs `/api/cron/tick` so the
   30-second UVIS-timeout sweep runs even without a browser.
4. De-duplicates plates within `DEDUPE_WINDOW_S` (default 10 s) — a real
   ANPR camera emits the same plate several times per pass.

## Requirements

- Python 3.10+
- `paho-mqtt >= 2.0` (the only runtime dependency)

## Local dev (Windows / XAMPP)

```bash
cd worker
python -m venv .venv
.venv\Scripts\activate              # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env              # then edit if needed
python worker.py
```

Run alongside the simulators:
- `frontend/simulator.cjs`      → publishes fake plates over MQTT
- `frontend/s300_simulator.cjs` → fakes the S300 device on HTTP :8086
- `worker/worker.py`            → this worker

## Production deploy (Linux)

```bash
# 1. Create runtime user + directory
sudo useradd -r -s /usr/sbin/nologin anpr
sudo mkdir -p /opt/anpr-worker
sudo chown anpr:anpr /opt/anpr-worker

# 2. Copy worker files (from your build host)
sudo rsync -av --exclude .venv ./ /opt/anpr-worker/
sudo cp .env.example /opt/anpr-worker/.env
sudo nano /opt/anpr-worker/.env      # set MQTT_BROKER, BACKEND_URL, credentials

# 3. Install Python + create venv + deps
sudo apt install -y python3 python3-venv
cd /opt/anpr-worker
sudo -u anpr python3 -m venv .venv
sudo -u anpr .venv/bin/pip install -r requirements.txt

# 4. Install the systemd unit
sudo cp anpr-mqtt-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anpr-mqtt-worker

# 5. Verify
sudo systemctl status anpr-mqtt-worker
sudo journalctl -u anpr-mqtt-worker -f
```

## Environment variables

| Variable           | Default                              | Purpose |
|--------------------|--------------------------------------|---------|
| `MQTT_BROKER`      | `mqtt://127.0.0.1:1883`              | Raw TCP MQTT URL (not WebSocket) |
| `MQTT_USERNAME`    | (none)                               | Optional broker auth |
| `MQTT_PASSWORD`    | (none)                               | Optional broker auth |
| `MQTT_CLIENT_ID`   | `anpr_worker_<ts>`                   | Stable client ID recommended in prod |
| `BACKEND_URL`      | `http://127.0.0.1/anpr_backend`      | Where the PHP backend is reachable |
| `TICK_INTERVAL_S`  | `5`                                  | UVIS-timeout sweep cadence (seconds) |
| `SETTINGS_POLL_S`  | `10`                                 | Settings cache refresh (seconds) |
| `CHANNELS_POLL_S`  | `30`                                 | Channels cache refresh (seconds) |
| `DEDUPE_WINDOW_S`  | `10`                                 | Same-plate dedupe window (seconds) |
| `FALLBACK_CHANNEL` | `RJ001`                              | Used when ANPR SN is unmapped |
| `HTTP_TIMEOUT_S`   | `10`                                 | Backend request timeout (seconds) |

## Sample log

```
2026-05-11T18:42:00 [INFO] Starting ANPR MQTT Worker
2026-05-11T18:42:00 [INFO] MQTT connected
2026-05-11T18:42:00 [INFO] subscribed: device/+/message/up/ivs_result
2026-05-11T18:42:09 [INFO] detected plate "B1234XYZ" sn=265e1040-... confidence=87 direction=4
2026-05-11T18:42:09 [INFO]   vehicle logged (id=42)
2026-05-11T18:42:09 [INFO]   /come ok — inspection #19
2026-05-11T18:42:14 [INFO] tick: forced fail for inspection #14 (TIMEOUT) — UVIS scan not received within timeout
```

## Service management

```bash
sudo systemctl restart anpr-mqtt-worker
sudo systemctl stop    anpr-mqtt-worker
sudo systemctl disable anpr-mqtt-worker
```

## Dashboard role in production

Once this worker is running, the React dashboard is **for monitoring and
admin only** — no auto-trigger logic in the browser. Build it with
`npm run build` and serve `frontend/dist/` as static files. Operators open
it to:
- Watch the live recognition feed and inspection decisions
- Review history
- Manage VIP plates and channels
- Toggle `auto_start_s300` and other settings (the worker reads these every 10s)
- Hit Emergency Stop

## Keeping this in sync

The following logic exists in both Python and PHP — when one changes,
update the other:

- Plate decode + vehicle fields → `worker.py::handle_recognition`
  vs. `frontend/src/contexts/MqttContext.tsx`
- /come trigger flow → `worker.py::handle_recognition`
  vs. backend `S300Controller::come` (defines the contract this worker calls)
- Decision tuning (timeouts, fields) → `worker.py` (cosmetic only — backend is source of truth)
