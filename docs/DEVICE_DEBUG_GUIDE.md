# Device-by-Device Debug Guide

Goal: prove every hop in the chain **in isolation**, bottom-up, and cross-check
what you actually observe against the protocol docs. If a device behaves
differently from what a doc claims, you've found either a misconfigured device
or a wrong doc — both worth fixing.

The chain:

```
ANPR camera ──MQTT──► broker ──MQTT──► worker ──HTTP──► backend ──HTTP──► S300
                                          │                  │
                                          │                  └─HTTP──► road blocker
                                          └──MQTT──► exit ANPR camera (whitelist)
backend ◄──HTTP── S300 callbacks (/overseas/s300/*)
```

Debug in **dependency order** — a green light at layer N only means anything if
N-1 was already green.

---

## 0. Environments & tooling

There are two environments and the commands differ slightly between them:

- **Production — AlmaLinux** (Linux). You run these probes over SSH on the prod
  box. **All command blocks below are written in bash for AlmaLinux** — that's
  the environment that talks to the real hardware.
- **Dev — Windows + XAMPP.** Same probes, same logic, just different shell
  mechanics. Translate each command with this table:

| Bash (AlmaLinux prod) | Windows dev (PowerShell) |
|-----------------------|--------------------------|
| `curl …` | `curl.exe …` (plain `curl` is an `Invoke-WebRequest` alias with different flags) |
| line continuation `\` | backtick `` ` `` |
| single-quoted JSON `'{"k":1}'` | double-quoted + escaped `"{\"k\":1}"` |
| `php` (on `PATH`) | `C:\xampp\php\php.exe` |
| `worker/.venv/bin/python worker/worker.py` | `worker\.venv\Scripts\python.exe worker\worker.py` |
| `/etc/.../backend/config/config.php` | `backend\config\config.php` |

Tools you need (install once):

| Tool | AlmaLinux (prod) | Windows (dev) |
|------|------------------|---------------|
| `curl` | preinstalled | `curl.exe` ships with Windows 10/11 |
| `mosquitto_pub` / `mosquitto_sub` | `sudo dnf install -y mosquitto` (the clients ship with the broker package) | install Mosquitto → `C:\Program Files\mosquitto\` |
| `psql` | `sudo dnf install -y postgresql` | ships with PostgreSQL |
| `php` | `sudo dnf install -y php-cli` | `C:\xampp\php\php.exe` |

Reference values for this project (from `backend/config/config.php`):

- Backend base URL: `http://127.0.0.1/anpr_backend`
  (on AlmaLinux this is whatever vhost/alias Apache/nginx serves `backend/public`
  under — substitute the prod hostname if it isn't `127.0.0.1`)
- MQTT broker: `127.0.0.1:1883`
- DB: host `127.0.0.1`, **port `5433`**, db `anpr_s300`, user `anpr`

> SELinux note (AlmaLinux): if Apache/nginx returns `502`/`permission denied`
> reaching the worker or the DB, check `getenforce` and the
> `httpd_can_network_connect` boolean (`sudo setsebool -P httpd_can_network_connect 1`)
> before blaming the app config.

---

## 1. PostgreSQL (the floor)

**Isolate:**

```bash
psql -h 127.0.0.1 -p 5433 -U anpr -d anpr_s300 -c "SELECT 1;"
```

**Expected:** a one-row `?column? = 1`. Then sanity-check the schema:

```bash
psql -h 127.0.0.1 -p 5433 -U anpr -d anpr_s300 -c "\dt"
psql -h 127.0.0.1 -p 5433 -U anpr -d anpr_s300 -c "SELECT key_name, value FROM settings;"
```

**Cross-check docs:** `docs/DATABASE.md` lists every table. The table list from
`\dt` must match. Confirm `anprc_settings` contains `blocker_close_mode` (default
`hardware`) and `auto_start_s300`.

**Common failures:**
- `could not connect` → wrong port (it's **5433**, not 5432) or service down
  (`sudo systemctl status postgresql` on AlmaLinux).
- `password authentication failed` → `config.php` and the role disagree, or
  `pg_hba.conf` isn't set to `md5`/`scram-sha-256` for the `anpr` role.

---

## 2. Backend (PHP / Apache)

**Isolate (no devices needed):**

```bash
curl -s http://127.0.0.1/anpr_backend/api/health
curl -s http://127.0.0.1/anpr_backend/
```

**Expected:** `{"code":200,"message":"ok",...}`. The root returns version + time.

Then prove DB-backed routes work end to end:

```bash
curl -s "http://127.0.0.1/anpr_backend/api/settings"
curl -s "http://127.0.0.1/anpr_backend/api/channels"
curl -s "http://127.0.0.1/anpr_backend/api/channels/by-no/RJ001/status"
```

**Expected:** `/api/channels/by-no/RJ001/status` returns `{ busy: false }` when the
lane is idle. This single call is what the worker uses as its "is the lane free?"
gate before `/come`.

**Cross-check docs:** the full route list in `backend/public/index.php` is the
source of truth. `docs/COMMUNICATION.md` and `ARCHITECTURE.md` describe these —
if a documented endpoint 404s, the doc is stale.

**Common failures:**
- `500` with debug on → exception is printed; read it. On AlmaLinux also tail
  `sudo journalctl -u httpd` or `/var/log/httpd/error_log`.
- `404` on a route that should exist → web-server rewrite/alias for
  `/anpr_backend` not pointing at `backend/public` (check the vhost / `.htaccess`
  and that `AllowOverride All` is set).

---

## 3. MQTT broker (mosquitto)

**Isolate** — open two terminals (two SSH sessions on prod).

Terminal A (subscribe to everything):

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t "device/#" -v
```

Terminal B (publish a fake message):

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 -t "device/TEST/message/up/keep_alive" -m '{"hello":1}'
```

**Expected:** Terminal A prints the topic + payload instantly. That proves the
broker routes `device/#` traffic — independent of cameras and worker.

**Cross-check docs:** `docs/COMMUNICATION.md` lists the real topics:
`device/{sn}/message/up/{ivs_result|gpio_in|barr_gate_status|keep_alive}` and the
`.../down/...` + `/reply` counterparts. The topic shape you publish here must
match those exactly or the worker's subscription filter won't pick real traffic up.

> On AlmaLinux confirm the broker is up and reachable: `sudo systemctl status mosquitto`,
> and that the firewall allows `1883` if the camera is on another host
> (`sudo firewall-cmd --add-port=1883/tcp`).

---

## 4. ANPR camera — entry (recognition in)

The camera **pushes autonomously**; you don't poll it. Watch its traffic:

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t "device/+/message/up/ivs_result" -v
```

**Expected:** drive a plate past (or use the simulator below) and a JSON
`ivs_result` appears. The plate sits at
`payload.AlarmInfoPlate.result.PlateResult.license` (base64) — that's exactly the
path the worker decodes (`worker.py: handle_recognition`).

**Simulate without hardware:**

```bash
node frontend/simulator.cjs        # entry camera
node frontend/exit_simulator.cjs   # exit camera
```

**Cross-check docs:** `COMMUNICATION.md` "typical entry-lane cycle" step 1, and
the MQTT protocol PDF §ivs_result. Verify `triggerType` and the `license`
base64 path — if the real camera nests them differently, the worker's decode path
is what must change, and the doc updated to match.

**Common failures:**
- Message arrives but worker ignores it → SN not on a configured channel, or the
  `keep_alive` `\x00` prefix issue (worker strips it; confirm with raw `-v` output).

---

## 5. S300 inspection device

Two directions — test each separately.

**5a. Platform → S300 (outbound).** The backend calls the S300 base URL. Trigger
it via the platform route:

```bash
curl -s -X POST "http://127.0.0.1/anpr_backend/api/s300/come/RJ001" \
  -H "Content-Type: application/json" -d '{"licensePlateNo":"B1234XYZ"}'
```

**Expected:** `code:200` and an inspection row is created. Verify:

```bash
curl -s "http://127.0.0.1/anpr_backend/api/inspections?limit=1"
```

To hit the device directly (bypass the platform), curl its own base URL — find it
on the channel row (`s300_base_url`) and call `/api/v1/channel-s300/leave/RJ001`,
etc. The exact paths the platform uses are in `S300Client` calls inside
`DecisionExecutor.php` and `S300Controller.php`.

**5b. S300 → Platform (callbacks).** The device POSTs back to
`/overseas/s300/*`. Simulate each callback to prove the backend handles them
without the real device:

```bash
# work-status: op=1 inspecting
curl -s -X POST "http://127.0.0.1/anpr_backend/overseas/s300/work-status" \
  -H "Content-Type: application/json" -d '{"channelNo":"RJ001","op":1}'

# uvis result: clean
curl -s -X POST "http://127.0.0.1/anpr_backend/overseas/s300/uvis" \
  -H "Content-Type: application/json" -d '{"channelNo":"RJ001","result":"clean"}'

# reset-complete
curl -s -X POST "http://127.0.0.1/anpr_backend/overseas/s300/reset-complete" \
  -H "Content-Type: application/json" -d '{"channelNo":"RJ001"}'
```

**Expected:** the UVIS callback drives `DecisionEngine` → a verdict; check the
inspection row's `decision` flips from `pending`. `reset-complete` frees the
channel (`/api/channels/by-no/RJ001/status` → `busy:false`).

**Cross-check docs:** the inbound paths in `index.php` (`/overseas/s300/*`)
**must** match the S300 protocol PDF byte-for-byte (the device is hard-coded to
those URLs). The field names (`op`, `result`, etc.) you send here should match
`InboundController` and the PDF. `COMMUNICATION.md` steps 4–7 describe the order.

**Common failures:**
- Device gets `404` on a callback → backend route path doesn't match the device's
  configured URL → the device retries forever. This is the #1 doc/config mismatch.
- UVIS never arrives → 30s `cron tick` watchdog forces `decision=fail`; see §8.

---

## 6. Road blocker (Qigong lifting columns)

> **Doc note:** this is an **HTTP REST** device (`RoadBlockerClient` →
> `http://{rb_ip}:{rb_port}`), *not* TCP. Older copies of `COMMUNICATION.md` say
> "TCP open road blocker" — that wording is wrong; the API is HTTP.

**Isolate — read status (safe, read-only):**

```bash
curl -s "http://{rb_ip}:{rb_port}/open/getStatus/{rb_device_no}"
```

**Expected:** JSON with a column position code — `01` descending, `03` lowered,
`05` rising, `07` raised, plus `controlTheDeviceOnline`.

**Isolate — operate (moves hardware; clear the lane first):**

```bash
# LOWER (open) the column — vehicle can pass
curl -s -X POST "http://{rb_ip}:{rb_port}/open/operation" \
  -H "Content-Type: application/json" \
  -d '{"deviceNo":"{rb_device_no}","ipCode":{"{rb_board_id}":1},"operationType":"liftingColumn_level","action":"down","liftingColumnNum":1}'
```

This is exactly the body `RoadBlockerClient::openColumn` sends. `action:"up"`
raises it.

**Cross-check docs:** `ROAD BLOCKER API.pdf` is the only authority. Confirm the
two endpoints (`GET /open/getStatus/{deviceNo}`, `POST /open/operation`) and the
status codes. **Key design fact to verify on site:** the API has *no*
vehicle-present / auto-close field — so closing must be done by the controller's
own loop detector (`blocker_close_mode='hardware'`, the default). If the lane
stays open after a pass, the controller's self-close wiring isn't done; see
`docs/DEVICE_SETUP_CHECKLIST.md`.

**Common failures:**
- `getStatus` works but `operation` does nothing → `ipCode`/`board_id`/column
  number wrong for your wiring.
- Connection refused → wrong `rb_port` on the channel row (and on AlmaLinux,
  confirm egress to the blocker's subnet isn't blocked by `firewalld`).

---

## 7. ANPR camera — exit (whitelist + auto-open)

The exit camera opens its own barrier when a plate is on its local whitelist.
The platform only **pre-authorizes** the plate.

**Isolate — push a whitelist add the way the worker does:**

```bash
mosquitto_pub -h 127.0.0.1 -p 1883 \
  -t "device/{exit_sn}/message/down/white_list_operator" \
  -m '{"id":"dbg1","sn":"{exit_sn}","name":"white_list_operator","version":"1.0","timestamp":1700000000,"payload":{"type":"white_list_operator","body":{"operator_type":"update_or_add","dldb_rec":{"plate":"B1234XYZ","enable":1,"create_time":"2026-06-11 10:00:00","enable_time":"2026-06-11 10:00:00","overdue_time":"2026-07-11 10:00:00","need_alarm":0,"time_seg_enable":0,"seg_time_start":"00:00:00","seg_time_end":"00:00:00"}}}}'
```

**Expected:** the camera ACKs on
`device/{exit_sn}/message/down/white_list_operator/reply` with `code:200`. Watch
it with `mosquitto_sub -t "device/+/message/down/+/reply" -v`. Then driving that
plate out should open the exit barrier.

**Cross-check docs:** MQTT protocol PDF **§7.8**. This is the schema the backend
now emits (`MqttOutbound::whitelistAdd`):
- `operator_type` = `update_or_add` (add) / `delete` / `select`
- `dldb_rec` is a **single object** (not an array)
- `create_time` is **required**; `need_alarm:0` = whitelist
- the envelope carries `payload.type` = `white_list_operator`

If the camera rejects the message, diff your payload against §7.8 field-by-field —
that's the most schema-sensitive message in the whole system.

**Common failures:**
- Camera not in **Whitelist mode** → it ignores the list entirely.
- Plate format mismatch (spaces, province char) → no match on exit.

---

## 8. Worker (the glue) — test last

Only meaningful once 1–7 are green, because the worker just wires them together.

**Run it in the foreground and read the log:**

```bash
worker/.venv/bin/python worker/worker.py
```

> In production the worker normally runs under **systemd** (e.g. `anpr-worker.service`),
> not in the foreground. To debug, stop the unit and run it by hand:
> `sudo systemctl stop anpr-worker` then the command above; live logs of the
> managed unit are `sudo journalctl -u anpr-worker -f`.

**Expected log lines on a healthy start:** dotenv loaded, MQTT connected
(`rc=0`), subscribed to `device/+/message/up/...`, and every ~5s a `cron tick`.

**Prove each worker responsibility in isolation:**
1. **Inbound trigger** — publish a fake `ivs_result` (see §4). Worker should log
   the decode and POST `/api/s300/come/...` (watch backend / `anprc_operation_log`).
2. **Outbound drain** — enqueue a command via any verdict, then watch the worker
   publish it (the `outbound: published ...` log line) and mark the queue row
   `sent`.
3. **Cron tick** — confirm `/api/cron/tick` is being POSTed every `TICK_INTERVAL_S`.

**Cross-check docs:** `worker/worker.py` top docstring lists its 4
responsibilities; `ARCHITECTURE.md` §13 says what the worker does vs doesn't. The
worker speaks **only** MQTT + backend HTTP — no DB — so it is the right place to
run on a separate server (just change `MQTT_BROKER` / `BACKEND_URL`).

**Common failures:**
- `int() argument ... ReasonCode` → paho-mqtt 2.x; already handled in `on_connect`.
- `ZoneInfoNotFoundError 'Asia/Jakarta'` → `pip install tzdata` (in requirements);
  on AlmaLinux you can instead `sudo dnf install -y tzdata`.
- Two workers fighting → singleton lock on port `18923`; second instance exits
  (watch for this if both a systemd unit and a hand-run copy are alive).

---

## 9. Full end-to-end smoke test

With everything green, run one car through and watch all four logs at once
(four SSH sessions on prod):

```bash
# Terminal 1: all MQTT
mosquitto_sub -h 127.0.0.1 -p 1883 -t "device/#" -v
# Terminal 2: worker
worker/.venv/bin/python worker/worker.py
# Terminal 3: simulate a plate in
node frontend/simulator.cjs
# Terminal 4: poll the audit trail
curl -s "http://127.0.0.1/anpr_backend/api/operation-log?limit=20"
```

**Expected order in the audit log** (matches `COMMUNICATION.md` cycle):
`come` → `auto_decision` → `open_blocker` → `whitelist_enqueue_add` →
`auto_leave`, then later `record-exit` + whitelist `delete`.

Each row's `status` (`success`/`failed`) tells you exactly which hop broke, and
the readable action labels (Audit Log page) map to these.

---

## Appendix — documentation discrepancies found while writing this guide

| Doc | Claim | Reality (code) | Status |
|-----|-------|----------------|--------|
| `COMMUNICATION.md` | "TCP open road blocker" | `RoadBlockerClient` uses **HTTP REST** on `rb_ip:rb_port` | fixed |
| whitelist payload (pre-fix) | `operator_type:add`, `dldb_rec` array, no `create_time` | §7.8 wants `update_or_add`, single object, `create_time` + `payload.type` | fixed in `MqttOutbound` / `worker.py` |
| `DEPLOYMENT.md` | "Ubuntu production deployment" | production runs **AlmaLinux** (this guide's command set assumes it) | flag for review |

When you confirm a real device's behavior against a doc here and they disagree,
add a row — keeping this table current is how the docs stay trustworthy.
