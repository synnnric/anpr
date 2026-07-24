# Entry Inspection — Full Inbound/Outbound Request Trace

A complete, real end-to-end flow captured from the live system: one vehicle entering
lane **RJ001**, inspected, cleared (PASS), and released. Every inbound callback and
outbound request is shown with its actual payload and timeline offset.

- **Source record:** inspection **#102**, plate **B2884SCP**, lane **RJ001**
- **Captured:** 2026-07-07 15:19:17 → 15:20:42 (release), device reset cycle to +218s
- **Lane mode:** `full` (face-driven `/leave`), auto-open ON, CORX relay road blocker
- **T0 = 15:19:17** (recognition / `/come`); all offsets below are relative to T0

> Offsets carry ±5s cron granularity (the worker's `/api/cron/tick` runs every 5s,
> which drives the deferred `/leave` and blocker-open).

---

## 1. Participants & transports

| Party | Address | Talks to us via |
|---|---|---|
| **ANPR camera** (entry) | SN `320dc55b-d6d6c442`, IP 192.168.2.100 | **MQTT** (Mosquitto 1883, `admin/admin123`) |
| **Vendor S300 platform** | `http://192.168.2.145:18001` | **HTTP** — posts callbacks to our backend; we POST its API |
| **Exit ANPR camera** | SN `EXIT-CAM-001` | **MQTT** (whitelist ops) |
| **CORX road-blocker relay** | topic `testsubscribe` / ACK `testpublish`, res `LANE1` | **MQTT** |
| **Our backend** | `http://<host>/anpr_backend` | receives all inbound; enqueues outbound |
| **Our worker** | — | drains MQTT queue, publishes; posts recognition → `/api/s300/come` |

**Two inbound transports:** MQTT (camera recognition + heartbeats + relay ACK) and
HTTP (vendor S300 callbacks). **Two outbound transports:** HTTP (S300 API) and MQTT
(camera control, whitelist, blocker relay). The backend never speaks MQTT directly —
it enqueues into `anprc_mqtt_outbound_queue`; the worker publishes.

---

## 2. Endpoint / topic reference

### Inbound — vendor S300 platform → our backend (HTTP POST)
| Route | cmdNo | Meaning |
|---|---|---|
| `/overseas/s300/work-status` | 322 | operating-state changes (0 ready, 1 inspecting, 6 self-test) |
| `/overseas/s300/uvis` | — | undercarriage verdict (image + object count) — **the decision trigger** |
| `/overseas/s300/face-image` | 323 | driver/occupant face capture (infrared/visible) |
| `/overseas/s300/video-record` | 325 | recorded clips per camera (z1/z2/y1/y2/zc/yc) — arrives **after** `/leave` |
| `/overseas/s300/video-real-time` | 325 | live stream URLs per camera |
| `/overseas/s300/x-ray` | — | x-ray artifact (when routed to x-ray) |
| `/overseas/s300/reset-complete` | 326 | device-reset done — **the real S300 never sends this** (timer-based instead) |

### Inbound — ANPR camera → our backend (MQTT, topic `{sn}/device/message/up/{name}`)
| message | Meaning |
|---|---|
| `keep_alive` | heartbeat, every ~10s |
| `quick_ivs_result` | fast plate pre-result |
| `ivs_result` | **full recognition** (plate + images) → worker triggers `/come` |

### Outbound — our backend → vendor S300 platform (HTTP POST, base `http://192.168.2.145:18001`)
| Path | When |
|---|---|
| `/api/v1/channel-s300/come/{ch}` | on recognition — start the inspection |
| `/api/v1/channel-s300/leave/{ch}` | deferred close — reset device + trigger recorded video |
| `/api/v1/channel-s300/recapture/{ch}` | manual re-capture |
| `/api/v1/device-s300/audio-prompt/{ch}` | on FAIL — back-up voice prompt |
| `/api/v1/device-s300/{manual-reset,emergency-stop,read-work-status}/{ch}` | operator controls |

### Outbound — our backend → devices (MQTT, via queue)
| command | Target | When |
|---|---|---|
| `gpio_out` | entry camera SN | entry-gate pulse on recognition |
| `serial_data` | entry camera SN | KF control card: green light / voice / LED plate |
| `white_list_operator` | exit camera SN | add cleared plate to exit whitelist |
| `corx_relay` | CORX relay | lower (open) the road blocker on pass |

### Operator/worker-facing routes on our backend (HTTP)
`/api/s300/come/{ch}` (worker posts recognition here) · `/api/s300/leave/{ch}` ·
`/api/s300/manual-reset/{ch}` · `/api/s300/emergency-stop/{ch}` · `/api/s300/audio-prompt`.

---

## 3. The full timeline (record #102)

Legend — **IN**=inbound to us, **OUT**=outbound from us, **OP**=our internal decision/log.

```
+  0s  IN  MQTT   ivs_result            RECOGNITION plate=B2884SCP (conf 100) → triggers /come
                  (quick_ivs_result fires the same instant with the fast pre-result)
+  0s  OUT MQTT   gpio_out              entry-gate pulse  {io:0, value:2, delay:500}
+  0s  OUT MQTT   serial_data           green light (KF card SET_RELAY_STATUS)
+  1s  OUT MQTT   serial_data           voice "Welcome"
+  1s  OUT MQTT   serial_data           LED "B2884SCP"
+  1s  OUT HTTP   POST .../come/RJ001   {licensePlateNo:"B2884SCP"} → 200 {operatingState:0 ready}
+  1s  IN  HTTP   work-status           {operatingState:1}  (device is now INSPECTING)
+ 14s  IN  HTTP   uvis                  verdict: objectCount 0, coords [] → CLEAN
+ 14s  OP         auto_decision         decision=PASS "Undercarriage clean"
+ 14s  OUT MQTT   white_list_operator   add B2884SCP to EXIT-CAM-001 (30-day window)
+ 14s  OP         blocker_open_scheduled  fallback delay_s=40 (face images will pull /leave in)
+ 45s  IN  HTTP   face-image            infrared #1
+ 50s  IN  HTTP   face-image            infrared #2
+ 60s  IN  HTTP   face-image            infrared #3  (last face → /leave armed ~+20s later)
+ 75s  IN  HTTP   video-record          z1,z2,y1,y2 clips + zc/yc empty; start/end times
+ 75s  OUT HTTP   POST .../leave/RJ001  → 200  (device reset + this triggers the recorded video)
+ 85s  OUT MQTT   corx_relay            lower blocker  {A01:210001, res:"LANE1"} on testsubscribe
+ 85s  OP         open_blocker → completed   inspection closed; blocker_cycle=lowered
+ 97s  IN  HTTP   work-status           {operatingState:6} then {0}  (self-test ↔ ready)
 …     IN  HTTP   work-status           6/0 cycling every ~30s to +218s (device self-resetting)
 —     IN  MQTT   keep_alive            camera heartbeat every ~10s throughout
```

Reset-complete (cmd 326) is **never received** — the device just cycles work-status
6→0. That is why completion is timer-driven, not signal-driven (see §5).

---

## 4. Message catalog (real payloads)

### 4.1 Recognition — IN, MQTT `320dc55b-d6d6c442/device/message/up/ivs_result`
Triggers the whole flow. The worker decodes it and POSTs `/api/s300/come/RJ001`.
```json
{
  "sn": "320dc55b-d6d6c442", "name": "ivs_result", "version": "1.0", "timestamp": 1783437557,
  "payload": { "AlarmInfoPlate": { "ipaddr": "192.168.2.100", "result": { "PlateResult": {
    "license": "QjI4ODRTQ1A=",            // base64 → "B2884SCP"
    "color": 3, "confidence": 100, "direction": 4,
    "pos": {"top":339,"left":433,"right":612,"bottom":427},
    "full_image_content": "/9j/4AAQSkZJRg…(base64 jpg)",
    "small_image_content": "/9j/4AAQSkZJRg…(base64 jpg)"
  }}}}
}
```
`quick_ivs_result` (same instant) carries the same `license` without the full images.

### 4.2 Entry-gate + greeting — OUT, MQTT to entry camera SN
```jsonc
// gpio_out — pulse the camera's barrier relay
{ "io": 0, "value": 2, "delay": 500 }
// serial_data — KF control card frames (CRC16/Modbus), one each:
{ "serialData": [{ "serialChannel": 0, "dataLen": 12, "data": "qlUAZAATAAEKdi6v" }] }  // green light
{ "serialData": [{ "serialChannel": 0, "dataLen": 12, "data": "/QAJAQFXZWxjb21l" }] }  // voice "Welcome"
{ "serialData": [{ "serialChannel": 0, "dataLen": 23, "data": "qlUAZAAnAAwBCgEAQjI4ODRTQ1A2ya8=" }] } // LED "B2884SCP"
```

### 4.3 /come — OUT, HTTP `POST /api/v1/channel-s300/come/RJ001`
```json
// request
{ "licensePlateNo": "B2884SCP" }
// response
{ "code": 200, "message": "success", "data": { "operatingState": 0, "desc": "就绪状态" } }
```

### 4.4 work-status — IN, HTTP `POST /overseas/s300/work-status`
```json
{ "channelNo": "RJ001", "cmdNo": 322, "data": { "operatingState": 1 } }
```
`operatingState`: **0** ready · **1** inspecting · **6** self-test (post-reset). The
6↔0 cycling after release is the device resetting itself.

### 4.5 uvis — IN, HTTP `POST /overseas/s300/uvis` — the decision trigger
Note the **empty `channel`** — the backend falls back to the most-recent active
inspection on the lane. `objectCount:0` + empty `coords` ⇒ clean ⇒ PASS.
```json
{ "channel": "", "params": {
    "inspectionId": 20260707232006, "imageType": 0,
    "objectCount": 0, "coords": [],
    "imageData": "/9j/4AAQSkZJRg…(base64 jpg)"
} }
```

### 4.6 face-image — IN, HTTP `POST /overseas/s300/face-image` (×3)
No camera/seat label in the payload — just an image URL (now reachable at
`192.168.2.145:18001`). Each arrival resets the `/leave` timer in `full` mode.
```json
{ "channelNo": "RJ001", "cmdNo": 323,
  "data": { "img": ["http://192.168.2.145:18001/resources/2026/07/07/infrared_1783438055556_task_…A0xx.jpg"] } }
```

### 4.7 whitelist add — OUT, MQTT `white_list_operator` to exit camera
```json
{ "operator_type": "update_or_add",
  "dldb_rec": { "plate": "B2884SCP", "enable": 1, "need_alarm": 0,
    "enable_time": "2026-07-07 22:19:31", "overdue_time": "2026-08-06 22:19:31" } }
```

### 4.8 video-record — IN, HTTP `POST /overseas/s300/video-record` (after /leave)
```json
{ "channelNo": "RJ001", "cmdNo": 325,
  "licensePlateNo": "B2884SCP",
  "startTime": "2026-07-07T23:19:15", "endTime": "2026-07-07T23:20:28",
  "data": [
    { "code": "z1", "url": "http://192.168.2.145:18001/resources/record-video/record/record/rv_…mp4" },
    { "code": "z2", "url": "…" }, { "code": "y1", "url": "…" }, { "code": "y2", "url": "…" },
    { "code": "zc", "url": "" }, { "code": "yc", "url": "" }
  ] }
```

### 4.9 /leave — OUT, HTTP `POST /api/v1/channel-s300/leave/RJ001`
Sent late on purpose (would abort the scan if sent at the verdict). Triggers the
vendor to reset the device **and** push the recorded video.
```json
{ "code": 200, "message": "success", "data": [] }
```

### 4.10 blocker open (lower) — OUT, MQTT `corx_relay` on `testsubscribe`
```json
{ "topic": "testsubscribe", "label": "blocker_open_RJ001",
  "body": { "A01": 210001, "res": "LANE1" },
  "ack":  { "pub_topic": "testpublish", "expect_ch": "A01", "res": "LANE1" } }
```
`A01` = lower/open (clear the lane). The relay ACKs on `testpublish`, which sets
`blocker_position`. **Raising is never sent by the backend** — hardware/manual only.

---

## 5. Timing rules that shaped this trace

| Step | Rule | This record |
|---|---|---|
| Recognition → `/come` | immediate on `ivs_result` | T0 |
| `/come` → UVIS verdict | vendor scan time (~10–17s) | +14s |
| Verdict → schedule `/leave` | `full`: fallback `blocker_open_delay_s` (40s), **reset to `face_leave_delay_s` (20s) after each face** | faces +45/+50/+60 → `/leave` +75s |
| `/leave` → blocker lower | `blocker_reset_interval_s` (7s) device-reset gap | +85s |
| blocker → complete | one-shot at phase 2 | +85s (`reset_completed_at`) |

Per-lane **mode** changes the middle rows:
- **full** (this record): `/leave` after the last face image.
- **timed**: `/leave` a fixed `s300_timed_seconds` after the verdict, ignoring faces.
- **skip**: `/leave` + blocker + complete in one shot the moment UVIS arrives.
- **none**: auto-PASS immediately, no S300 at all.

---

## 6. Notable real-world facts (from this and prior traces)

- **reset-complete (cmd 326) never arrives** from the real S300 — it only cycles
  work-status `6↔0`. Completion is therefore timer-driven, with a 30s watchdog.
- **UVIS `channel` is empty** on the real device — matched to the active inspection.
- **face-image has no driver/passenger or camera label** — one image URL per callback.
- **video-record arrives after `/leave`** (it is a consequence of `/leave`); face
  images arrive before it. This ordering is why `/leave` is keyed off the face stream.
- **`keep_alive`** every ~10s is the camera heartbeat, independent of any inspection.
- On **FAIL/SUSPECT** the blocker still opens (vehicle routed forward to x-ray, never
  turned back) and `/api/v1/device-s300/audio-prompt` plays the back-up prompt.
