# Device Debug Guide — probing the field devices from the servers

Field-engineer playbook: how to prove, **from the production servers**, whether
each device (ANPR cameras, S300 robot, X-Ray push, gates) is alive and talking
to the platform — and which side is broken when it isn't. All command blocks
are **bash on AlmaLinux**, run over SSH on the prod hosts. Read together with
[`COMMUNICATION.md`](./COMMUNICATION.md) (who talks to whom) and
[`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) (ports/topology).

## The hosts

| Host | Runs | You debug here when… |
|------|------|----------------------|
| `10.10.33.143` | Mosquitto broker (`:8171`) + Python worker | anything MQTT: cameras, relay, outbound commands |
| `10.10.33.144` | Apache: SPA + backend `/anpr_backend` + `/overseas/s300/*` callbacks | anything HTTP: S300/X-Ray callbacks, API, uploads |
| `10.10.34.95:18001` | vendor S300 platform (`s300_base_url`) | outbound `/come`, `/leave`, `/recapture` failures |
| dev laptop | broker `127.0.0.1:1883` + backend `http://127.0.0.1/anpr_backend` | same probes, dev creds |

**Broker credentials are mandatory** — Mosquitto runs `allow_anonymous false`,
so every `mosquitto_sub`/`mosquitto_pub` below needs `-u`/`-P`. Dev creds are
`admin` / `admin123`; **prod creds differ** (user `sigap` + the prod broker
password — ask the admin, never assume the dev pair works in prod). In the
examples, `-u USER -P 'PASS'` means "the creds for the environment you're on".

```bash
# Tooling (once, on 10.10.33.143 — clients ship with the broker package)
sudo dnf install -y mosquitto
```

---

## 1. MQTT probing (always with auth)

Run these **on `10.10.33.143`** (broker is local there; substitute
`-h 127.0.0.1 -p 1883` on dev).

```bash
# Watch ALL camera uplinks — both topic layouts at once (see §2)
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t 'device/+/message/up/#' -t '+/device/message/up/#'

# Watch one specific camera by SN (both layouts)
SN=320dc55b-d6d6c442
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t "device/$SN/message/up/#" -t "$SN/device/message/up/#"

# Prove the broker itself routes (publish + see it echo in another terminal)
mosquitto_pub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' \
  -t 'device/TEST/message/up/keep_alive' -m '{"hello":1}'
```

- `Connection error: Connection Refused: not authorised.` → wrong/missing
  `-u`/`-P` (or you used dev creds on prod).
- Connection refused (TCP) → broker down (`sudo systemctl status mosquitto`) or
  firewall (`sudo firewall-cmd --list-ports` — `8171/tcp` must be open to the
  device VLAN).

## 2. Two topic layouts — always probe both

Two layouts are live in the field, and **the platform handles both**
(`worker.py` subscribes to `device/+/message/up/+` **and**
`+/device/message/up/+`, and publishes down-commands to the layout each device
was seen using — both, until it has learned one):

| Layout | Up topic | Down topic |
|--------|----------|-----------|
| standard (docs/simulator) | `device/{sn}/message/up/{name}` | `device/{sn}/message/down/{name}` |
| SN-first (some real cameras) | `{sn}/device/message/up/{name}` | `{sn}/device/message/down/{name}` |

So when a camera "seems silent", **never** subscribe to just `device/#` — you
may be watching the wrong layout. Always use the dual `-t` subscription from
§1. If traffic shows up on the SN-first layout only, that's normal — no fix
needed, the worker learns it automatically.

## 3. Camera liveness — the `keep_alive` heartbeat

Every camera publishes `keep_alive` roughly **every 10 s**. That heartbeat is
the liveness signal for the whole MQTT leg: if you can see it, camera → broker
is healthy regardless of whether recognitions are flowing.

```bash
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t 'device/+/message/up/keep_alive' -t '+/device/message/up/keep_alive'
```

Where the CP shows the same signal:

- **Dashboard** — the device pills turn online/offline based on recent
  heartbeats.
- **MQTT Logs** page — filter message name `keep_alive` to see the raw stream
  per device SN (the worker forwards every inbound MQTT message to
  `POST /api/mqtt-log/inbound`, so a gap here can also mean the *worker* is
  down — cross-check with the `mosquitto_sub` above; see §7).

No heartbeat on either topic layout → camera side: power/network, wrong broker
IP/port (`10.10.33.143:8171`), or wrong broker credentials configured in the
camera.

## 4. Gate test via `gpio_out`

The **Device Control** page's "Open Gate" button sends a **bare relay pulse**
(no plate, no inspection): `POST /api/anpr/gate-open {channel_no}` builds a
`gpio_out` command from settings `entry_gate_io` (default `0`),
`entry_gate_value` (default `2` = pulse) and `entry_gate_pulse_ms` (default
`1000`), inserts it into the outbound queue (`anprc_mqtt_outbound_queue`), and
the **worker** publishes it to the camera's down-topic. The camera ACKs on
`.../down/gpio_out/reply` with `code:200`.

Trigger it from the shell (against `10.10.33.144`) while watching MQTT:

```bash
# Terminal A (on 10.10.33.143): watch downs + ACKs
mosquitto_sub -h 127.0.0.1 -p 8171 -u USER -P 'PASS' -v \
  -t 'device/+/message/down/#' -t '+/device/message/down/#'

# Terminal B: press the button, or equivalently
curl -s -X POST "http://10.10.33.144/anpr_backend/api/anpr/gate-open" \
  -H "Content-Type: application/json" -d '{"channel_no":"RJ001"}'
```

Verify the command actually left:

```bash
# Anything still pending? (should be empty within ~1 s — the worker drains every 0.5 s)
curl -s "http://10.10.33.144/anpr_backend/api/mqtt-queue/pending"
```

- **MQTT Logs → Outbound tab** shows each queued command with its status
  (`pending` → `sent` / `failed`).
- Command **stuck in `pending`** = nothing is draining the queue = **the worker
  is down** (§7). The backend only enqueues; it never publishes MQTT itself.
- `sent` but the gate doesn't move → watch Terminal A: did the camera ACK on
  `/reply`? No ACK → camera offline or wrong SN on the channel row
  (`anpr_device_sn`). ACK but no motion → relay wiring / `entry_gate_io`
  points at the wrong output.

## 5. S300 vendor callbacks (`/overseas/s300/*`)

The S300/X-Ray side POSTs to the backend on `10.10.33.144`. Every arrival is
recorded in `anprc_inbound_events_raw` and visible in the CP on the **API Log**
page (endpoint, source IP, body preview, timestamp) — that page is the first
place to check "did the vendor's call reach us at all".

Routes (from `backend/public/index.php`):

| Endpoint | Carries |
|----------|---------|
| `POST /overseas/s300/work-status` | `data.operatingState` 0-6 (cmd 322) |
| `POST /overseas/s300/face-image` | `data.img[]` — image **URLs** on the vendor platform |
| `POST /overseas/s300/uvis` | `params` — undercarriage scan result + coords |
| `POST /overseas/s300/video-real-time` | live stream addresses `data[]{code,url}` |
| `POST /overseas/s300/video-record` | recorded stream addresses, same shape |
| `POST /overseas/s300/reset-complete` | "ready for next vehicle" |
| `POST /overseas/s300/x-ray` | X-Ray scan images + anomaly result |

Minimal test POSTs from the server (any host that reaches `10.10.33.144`).
**Caution:** these create real rows, and `work-status`/`uvis` feed the decision
engine on a live inspection — test on an idle lane.

```bash
B=http://10.10.33.144/anpr_backend

curl -s -X POST $B/overseas/s300/work-status -H "Content-Type: application/json" \
  -d '{"cmdNo":322,"channelNo":"RJ001","data":{"operatingState":1}}'

curl -s -X POST $B/overseas/s300/face-image -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","data":{"img":["http://10.10.34.95/test-face.jpg"]}}'

curl -s -X POST $B/overseas/s300/uvis -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","params":{"inspectionId":"DBG-1","imageType":0,"objectCount":0,"coords":[]}}'

curl -s -X POST $B/overseas/s300/video-real-time -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","data":[{"code":"CAM1","url":"rtsp://10.10.34.95/live/1"}]}'

curl -s -X POST $B/overseas/s300/video-record -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001","data":[{"code":"CAM1","url":"rtsp://10.10.34.95/rec/1"}]}'

curl -s -X POST $B/overseas/s300/reset-complete -H "Content-Type: application/json" \
  -d '{"channelNo":"RJ001"}'
```

X-Ray push — note the **SN is the scan's unique id**: a repeated SN is
**deduped by design** (vendor retry guard — the backend replies `200 success`
but records nothing). So every test push needs a fresh SN, and "I posted twice
but only see one row" is correct behavior, not a bug. `IsAnomaly:true` keeps
the scan `pending` on the X-Ray tab (no receipt, exit barrier stays closed) —
the safe test value; a clean scan is auto-receipted when `xray_auto_receipt`
is on, which calls the vendor back and opens the exit barrier.

```bash
curl -s -X POST $B/overseas/s300/x-ray -H "Content-Type: application/json" \
  -d '{"SN":"DBG-'$(date +%s)'","VehicleNumber":"B1234XYZ","IsAnomaly":true,
       "AnomalyComments":"debug test","ScannerOperator":"field-eng",
       "DateScanStarted":"2026-07-22 10:00:00","DateScanEnded":"2026-07-22 10:01:00"}'
```

Expected reply from every endpoint: `{"code":200,"message":"success",...}`.
Then confirm the row on **API Log** (filter by endpoint). If the *vendor's*
pushes never appear there but yours do, the device is posting to the wrong URL
— its `OVERSEAS_*_URL` config must point at
`http://10.10.33.144/anpr_backend/overseas/s300/...`.

## 6. Uploaded media (`backend/uploads/`)

Decoded images are written under `backend/uploads/` and served at
`/anpr_backend/uploads/...` (config `uploads.public_url`):

| Subfolder | Written by | Content |
|-----------|-----------|---------|
| `vehicles/` | `POST /api/vehicles` | ANPR full-scene + plate close-up JPEGs |
| `uvis/` | `/overseas/s300/uvis` | undercarriage scan image |
| `xray/` | `/overseas/s300/x-ray` | X-Ray scan + plate image |
| `audio/` | placed manually | **WAV prompts the S300 downloads** (audio-prompt URLs) |

(Face images are *not* stored here — the vendor sends URLs, saved as-is in
`anprc_inspection_face_images`.)

When images 404 in the CP or fail to save, check — in this order, on
`10.10.33.144`:

```bash
BACKEND_DIR=/var/www/anpr_backend   # adjust to the real deploy path

# 1. Apache must own the tree (writes happen as apache)
ls -lZ $BACKEND_DIR/uploads
sudo chown -R apache:apache $BACKEND_DIR/uploads

# 2. SELinux: uploads must be writable content (httpd_sys_rw_content_t)
sudo semanage fcontext -a -t httpd_sys_rw_content_t "$BACKEND_DIR/uploads(/.*)?"
sudo restorecon -Rv $BACKEND_DIR/uploads

# 3. Serve check — any file in the folder must answer 200
curl -sI "http://10.10.33.144/anpr_backend/uploads/vehicles/$(ls $BACKEND_DIR/uploads/vehicles | head -1)"
```

Symptoms map: images **fail to save** (backend logs a write error, paths NULL
in DB) → ownership or SELinux label; images **saved but 404** → Apache alias
for `/anpr_backend` not exposing `uploads/`, or the file truly missing. The
S300 failing to play custom prompts → the WAV under `uploads/audio/` isn't
reachable from the device VLAN (curl the audio URL from `10.10.34.95`'s
network, not from localhost).

## 7. Worker health (`10.10.33.143`)

The worker is the only MQTT⇄HTTP bridge. When it is down, the broker and
backend both look "fine" in isolation while the platform is effectively dead:

- recognitions stop being processed (cameras still publish — you see them with
  `mosquitto_sub` — but no vehicle rows, no `/come`);
- the outbound queue **grows**: gate/blocker/whitelist commands pile up as
  `pending` and nothing physical moves;
- MQTT Logs stops receiving inbound entries;
- `POST /api/cron/tick` stops — the worker drives it every ~5 s, and it is
  what sweeps UVIS timeouts and the reset watchdog, so stuck inspections stop
  resolving too.

```bash
# Is it running? (systemd unit on prod)
sudo systemctl status anpr-worker
sudo journalctl -u anpr-worker -f          # live log; healthy = "MQTT connected",
                                           # "subscribed: device/+/message/up/+", tick lines

# Singleton lock — exactly one worker may hold 127.0.0.1:18923
ss -tlnp | grep 18923

# Queue draining? pending should be empty/small and shrinking
curl -s "http://10.10.33.144/anpr_backend/api/mqtt-queue/pending"
```

Restart with `sudo systemctl restart anpr-worker`. A hand-run copy
(`worker/.venv/bin/python worker/worker.py`) auto-kills a phantom instance
holding the lock, and the built-in watchdog force-exits a wedged process so
systemd (`Restart=on-failure`) revives it. Remember the worker's backend is
**remote** (`BACKEND_URL=http://10.10.33.144/anpr_backend` in `worker/.env`) —
if `.144` is unreachable from `.143`, the worker logs HTTP failures but keeps
running; fix the network, not the worker.

## 8. Quick triage table

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| Camera "silent" but powered | watching only one topic layout | dual `mosquitto_sub` from §1 (both layouts) |
| No `keep_alive` on either layout | camera→broker: network / wrong broker IP:port / wrong creds in camera | §3 sub; `sudo systemctl status mosquitto`; firewall `8171/tcp` |
| `not authorised` from mosquitto tools | missing/wrong `-u`/`-P` (dev creds on prod) | use the environment's creds (§1) |
| Heartbeats visible in `mosquitto_sub` but not on MQTT Logs page | worker down (it forwards to `/api/mqtt-log/inbound`) | `sudo systemctl status anpr-worker` (§7) |
| Plates recognized, nothing happens | worker down, or `auto_start_s300` off | §7; `curl .../api/settings` → `auto_start_s300` |
| Gate button "queued" but gate never moves | queue stuck `pending` → worker down; or camera not ACKing | `curl .../api/mqtt-queue/pending` (§4); watch `/reply` topic |
| Gate ACKs (`code:200`) but no motion | relay wiring / wrong `entry_gate_io` | settings `entry_gate_io/value/pulse_ms`; try another io |
| Gate opens **twice** per command | camera acting on both down-layouts before the worker learned its layout | restart-transient; persistent → check MQTT Logs outbound for double `sent` |
| S300 events missing in CP | device posting to wrong URL / port 80 blocked on device VLAN | **API Log** page; test POSTs from §5; Apache `access_log` on `.144` |
| X-Ray push "lost" | repeated SN → deduped by design | check `anprc_inspection_xray` for that SN; re-push with fresh SN (§5) |
| Images 404 / not saving | `apache:apache` ownership or SELinux label on `uploads/` | §6: `ls -lZ`, `chown`, `restorecon` |
| S300 doesn't play custom WAV | `uploads/audio/` URL unreachable from device VLAN | curl the audio URL from the device network (§6) |
| Inspections stuck, UVIS timeouts never fire | cron tick stopped → worker down | `journalctl -u anpr-worker -f` for tick lines (§7) |
| Vendor `/come`/`/leave` failing | vendor platform down / envelope `success:false` | `curl -s http://10.10.34.95:18001/` from `.144`; API Log + operation log for the response body |
