# Device Communication Reference

How every device in the platform talks: which protocol, which topic / endpoint,
in which direction, and what payload it carries. Read this alongside
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the higher-level component view.

---

## The actors

| Device / process | Protocol | Connects to | Identifier |
|------------------|----------|-------------|------------|
| Entry ANPR camera (RJ001) | MQTT (pub/sub) | Mosquitto :1883 | `sn = 265e1040-85e01fb7` |
| Exit ANPR camera (RJ002)  | MQTT (pub/sub) | Mosquitto :1883 | `sn = EXIT-CAM-001` |
| S300 inspection robot     | HTTP (both directions) | platform :80 + s300 :8086 | `channel_no = RJ001`, `s300_base_url` |
| Road blocker              | HTTP REST      | rb_ip : rb_port | `rb_device_no`, `rb_board_id` |
| Python worker             | MQTT + HTTP    | broker :1883 + backend :80 | one per platform |
| Frontend (browser tab)    | HTTP + MQTT WS | backend :80 + broker :8083 | one per user |

The platform itself is the orchestrator. It never reaches devices directly
through a hard-coded address — every endpoint is pulled from the `anprc_channels`
table at runtime, so swapping hardware is a config change, not a code change.

---

## ANPR Cameras (entry + exit)

Both cameras speak **only MQTT**. The broker is the single integration point —
the platform never opens a TCP socket to the camera, and the camera never POSTs
HTTP back to the platform.

**Authentication (required).** Mosquitto runs with `allow_anonymous false` and a
`password_file`; every client must log in (default user `admin`). The camera
carries the broker username/password in its MQTT config — anonymous connections
are refused.

**Two topic layouts are valid.** The documented form is
`device/{sn}/message/up/{name}` (and `.../down/{name}`). Some real cameras put
the **SN first** instead — `{sn}/device/message/up/{name}` (and
`{sn}/device/message/down/{name}`). The worker subscribes to **both** up-layouts
and publishes each down-command to **both** layouts, so a device gets it on
whichever form it actually uses. Topics below show the documented form; the
sn-first variant is equivalent.

### Up (camera → platform)

| Topic | When | Payload (key fields) |
|-------|------|----------------------|
| `device/{sn}/message/up/ivs_result`     | every plate recognition | `AlarmInfoPlate.result.PlateResult.license` (base64), `confidence`, `direction`, `colorType`, `triggerType`, `unique_id`; snapshot images `full_image_content` (full scene) + `small_image_content` (plate close-up), both base64 JPEG |
| `device/{sn}/message/up/keep_alive`     | every 10 s | `timestamp` |
| `device/{sn}/message/up/gpio_in`        | IO trigger (loop detector etc.) | `AlarmGioIn.TriggerResult.source`, `value` |
| `device/{sn}/message/up/barr_gate_status` | physical gate up / down | `gate_status`, `connect_status`, `enable` |

### Down (platform → camera)

| Topic | When the platform sends it | Payload (key fields) |
|-------|---------------------------|----------------------|
| `device/{sn}/message/down/white_list_operator` | exit-camera one-time-pass add (on entry PASS / VIP_PASS) and delete (on exit detection) | `operator_type`: `add` ‖ `delete`; for add: `dldb_rec[].plate`, `enable_time`, `overdue_time`; for delete: `plate` |
| `device/{sn}/message/down/gpio_out`            | open the entry camera's own barrier gate — sent to the ENTRY camera at `/come` on recognition, and by the manual "Buka Gerbang Langsung" override button on the Device Control page — protocol §7.2 | `io` 0-3 (relay), `value` 0=OFF ‖ 1=ON ‖ 2=Pulse, `delay` ms 500-5000. Camera ACKs on `.../down/gpio_out/reply` with `{code:200,...}` |
| `device/{sn}/message/down/tts_voice`           | failure prompt ("please back out") | indexed audio |
| `device/{sn}/message/down/{cmd}/reply`         | camera ACKs every down command | `code`, original `id` |

**Vehicle snapshot images.** From each `ivs_result` the worker extracts
`full_image_content` + `small_image_content` and forwards them to the backend
(`POST /api/vehicles`), which decodes and saves them as files; they're shown on
the inspection detail (Inspeksi Kendaraan).

**Whitelist mode on the exit camera** — the exit ANPR refuses any plate that's
not on its local whitelist. The platform writes to that whitelist via
`white_list_operator` when a vehicle passes inspection at the entry. When the
vehicle exits, the worker removes the entry. That is how "exit only opens for
vehicles that came in" is enforced.

---

## S300 Inspection Robot

**Pure HTTP, both directions.** No MQTT. The platform runs an HTTP server
(under `/overseas/s300/...`) for inbound callbacks, and acts as an HTTP client
for outbound commands.

### Inbound (S300 → platform)

| Method + path | S300 cmd | What it carries |
|---------------|----------|-----------------|
| `POST /overseas/s300/work-status`    | 322 | `operating_state`: 0=ready · 1=inspecting · 2=resetting · 3=completed · 4=e-stop · 5=failed · 6=started |
| `POST /overseas/s300/face-image`     | 323 | base64 JPEG of driver / passenger |
| `POST /overseas/s300/video-record`   | 325 | video stream paths |
| `POST /overseas/s300/uvis`           | 326 | undercarriage scan — `result`: clean / suspect, cargo coords |
| `POST /overseas/s300/reset-complete` | 326 | "reset finished, ready for the next vehicle" |

### Outbound (platform → S300)

| Method + path | Used by | What the platform asks |
|---------------|---------|------------------------|
| `POST {s300_base_url}/come/{ch}`             | worker (auto on entry plate) or operator | start the cycle; body `{ licensePlateNo }` |
| `GET  {s300_base_url}/capture/{ch}`          | operator | force an extra capture |
| `GET  {s300_base_url}/leave/{ch}`            | DecisionExecutor | release vehicle, begin reset |
| `POST {s300_base_url}/emergency-stop/{ch}`   | operator | abort |
| `POST {s300_base_url}/manual-reset/{ch}`     | operator | force-reset from stuck state |
| `POST {s300_base_url}/read-work-status/{ch}` | watchdog | re-read state on suspected stall |
| `POST {s300_base_url}/audio-prompt`          | DecisionExecutor (fail) | play indexed audio (failure prompt = index 7) |

### S300 state vs platform state

The `anprc_inspections` table tracks both:

- `current_operating_state` — mirror of what S300 last reported (column = the
  raw 0-5 number from cmd 322).
- `state` — the platform's lifecycle (`pending` → `started` → `inspecting` →
  `resetting` → `completed`).

Only HTTP events from S300 and the `reset-complete` callback move `state`
forward. This separation is why a momentary `work-status=3` doesn't prematurely
mark the inspection completed — the platform waits for `reset-complete`.

---

## Road Blocker

**HTTP REST** to `http://rb_ip:rb_port` (`POST /open/operation`,
`GET /open/getStatus/{deviceNo}`), with the device's `rb_board_id` +
`rb_device_no` + `rb_column_num` carried in the JSON body. Called only by
the backend's `RoadBlockerClient` from `DecisionExecutor` when the decision is
PASS / SUSPECT / VIP_PASS. Backend only ever LOWERS (opens); raising is the
hardware's decision (`blocker_close_mode='hardware'`). See `ROAD BLOCKER API.pdf`.

Each `anprc_channels` row carries everything needed:

```
rb_ip        VARCHAR(64)    e.g. 127.0.0.1
rb_port      INT            e.g. 8086
rb_device_no VARCHAR(64)    e.g. DEV001
rb_board_id  VARCHAR(64)    e.g. 01
rb_column_num INT           usually 1
```

---

## Python Worker (the bridge)

The worker has no UI, no persistent state, and no business logic beyond
"recognise, log, route". It exists so the platform keeps running when nobody
has the browser open.

It authenticates to the broker with `MQTT_USERNAME` / `MQTT_PASSWORD` from
`worker/.env` (the `admin` credentials), since anonymous is refused.

### Subscribes (MQTT)

| Topic | Purpose |
|-------|---------|
| `device/+/message/up/+` | catches every camera message (ivs_result, keep_alive, gpio_in, barr_gate_status) |
| `+/device/message/up/+` | same, for cameras using the sn-first topic layout |

### Publishes (MQTT)

| Topic | Source |
|-------|--------|
| `device/{sn}/message/down/{cmd}` **and** `{sn}/device/message/down/{cmd}` | drained from `anprc_mqtt_outbound_queue` — published to both layouts so the device receives it regardless of which it subscribes to |

### Backend calls (HTTP)

| Verb | Path | When |
|------|------|------|
| POST | `/api/mqtt-log/inbound`        | every received MQTT message (fire-and-forget) |
| POST | `/api/vehicles`                | audit row for every plate detection |
| GET  | `/api/channels/by-no/{ch}/status` | busy-check before triggering `/come` |
| POST | `/api/s300/come/{ch}`          | entry detection on a free channel, when `auto_start_s300=1` |
| POST | `/api/visits/record-exit`      | exit detection — closes visit or logs orphan_exit |
| POST | `/api/cron/tick`               | every 5 s — sweeps UVIS timeouts + reset watchdog |
| GET  | `/api/mqtt-queue/pending`      | drain pending outbound commands |
| POST | `/api/mqtt-queue/{id}/sent`    | ACK after successful MQTT publish |
| POST | `/api/mqtt-queue/{id}/failed`  | report failure (retried up to 5x) |
| GET  | `/api/settings`                | refresh `auto_start_s300`, `auto_start_channel` (every 10 s) |
| GET  | `/api/channels`                | refresh device SN ↔ channel routing (every 30 s) |

---

## Frontend (browser tab)

Two parallel channels:

- **HTTP** to `http://host/anpr_backend/api/*` — all DB-backed views (visits,
  inspections, MQTT logs, channel admin, VIP plates, settings).
- **MQTT WebSocket** to `ws://host:8083/mqtt` via `mqtt.js` — the live
  recognition panel, heartbeat indicator, IO events. **Same topics as the
  cameras**, just consumed in JS. The WS connection must supply the broker
  credentials (`admin`) too — anonymous is refused.

The frontend never triggers `/come`. That decision was deliberately moved into
the worker so the platform keeps logging and inspecting with the browser
closed.

---

## End-to-end: typical entry-lane cycle

```
1. car rolls up → entry ANPR detects plate "粤A12345"
   └─ MQTT: device/265e1040-85e01fb7/message/up/ivs_result   (camera → broker)

2. worker receives that message
   ├─ POST /api/mqtt-log/inbound          (log every msg, async)
   ├─ POST /api/vehicles                  (audit row)
   ├─ GET  /api/channels/by-no/RJ001/status   → busy=false
   └─ POST /api/s300/come/RJ001            (body { licensePlateNo })

3. backend
   ├─ creates inspection row (state=pending)
   ├─ opens the ENTRY camera's barrier: INSERT mqtt_outbound_queue (gpio_out)
   │     — the pre-inspection gate, opened on recognition so the car can pull in
   ├─ checks vip_plates → if hit, short-circuit to vip_pass + open blocker
   └─ HTTP POST → {s300_base_url}/come/RJ001

4. S300 starts the cycle, posts back periodically:
   ├─ POST /overseas/s300/work-status  (op=1 inspecting)
   ├─ POST /overseas/s300/face-image
   ├─ POST /overseas/s300/uvis         (clean / suspect)
   └─ POST /overseas/s300/work-status  (op=3 completed)

5. backend.DecisionEngine sees UVIS arrive → decides pass / suspect / fail
   └─ DecisionExecutor branches:
      pass / vip_pass:
        ├─ HTTP POST open road blocker  /open/operation (rb_ip:rb_port)
        ├─ INSERT mqtt_outbound_queue                  (white_list_operator → exit cam, add)
        └─ HTTP GET /leave/{ch}                        (release vehicle)
      suspect:
        └─ HOLD — no auto action. Wait for an operator to approve or reject:
             approve → same as pass (open road blocker + whitelist + /leave)
             reject  → same as fail (back-up audio + deny + /leave)
      fail:
        ├─ INSERT mqtt_outbound_queue                  (tts_voice "back out")
        ├─ mark visits row denied_entry
        └─ HTTP GET /leave/{ch}

6. worker drains the outbound queue
   └─ MQTT publish device/EXIT-CAM-001/message/down/white_list_operator
                                                 ↓
                                exit camera now allows that plate to pass

7. S300 finishes resetting → POST /overseas/s300/reset-complete
   └─ inspection row state=completed, channel free again

8. later, the same car drives out → exit ANPR detects "粤A12345"
   ├─ worker POSTs /api/visits/record-exit  → closes visit, marks completed
   └─ worker enqueues white_list_operator { delete } → MQTT to exit cam
                       (one-time-pass cleanup)
```

---

## How to observe each step in real time

| Step | Where to look |
|------|---------------|
| 1, 6, 8 (MQTT) | **MQTT Logs** page — filter by plate to see every camera message related to that vehicle |
| 2 (worker decisions) | worker stdout / `worker.err.log` |
| 3-5 (S300 ↔ platform HTTP) | **S300 Inspection** page → click the inspection row for the detail panel; raw events also visible in `anprc_inbound_events_raw` |
| 5 (decision + executor) | `anprc_inspection_status_logs` table |
| 6 (queue) | **MQTT Logs** page → Outbound tab |
| 8 (visit closure) | **Visits & Reports** page |
