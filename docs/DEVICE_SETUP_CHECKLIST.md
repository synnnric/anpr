# Device Setup Checklist

Step-by-step checklist for bringing real hardware online and replacing the
simulators. Tick boxes as you go.

Companion docs:
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — server / OS / service install
- [`COMMUNICATION.md`](./COMMUNICATION.md) — exact topics, endpoints, payloads
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — high-level flows
- [`DATABASE.md`](./DATABASE.md) — `anprc_channels` table reference

---

## 0. Before you touch any device

- [ ] Confirm the platform is up and the dashboard at `http(s)://<host>/` shows **Backend / Database / Broker / Worker = OK** (System Health row).
- [ ] You can log in as `admin` and see the **Users**, **Channels**, and **Dashboard** pages.
- [ ] **Stop every simulator** before plugging in the real device with the same SN. Two clients with the same `sn` publishing simultaneously will double-write rows.
  ```powershell
  Get-Process node, python -ErrorAction SilentlyContinue
  ```
- [ ] Note down the production IP/hostname of the platform — every device will be pointed at it.
- [ ] Note down each device's serial number / IP — you'll paste these into the `anprc_channels` table.

---

## 1. Platform settings (one-time)

- [ ] Change `auth.secret` in `config/config.php` to a fresh 64-char random string. Invalidates the dev tokens.
- [ ] Flip `app.debug` to `false` in `config/config.php` so stack traces don't leak.
- [ ] Set `auth.dev_bypass` to `false` in `config/config.php` and fill in `auth.parent_db` with the parent portal's DB credentials + column mapping. See [`DEV_LOGIN.md`](./DEV_LOGIN.md) for the schema-mapping reference.
- [ ] Confirm SSO login works end-to-end from the parent portal: clicking the platform link in the parent UI should land on the dashboard with the right role badge, no manual `?username=` parameter required.
- [ ] Verify `settings.auto_start_s300 = 1` if you want the worker to auto-trigger inspections on plate detection (most installs do).
- [ ] Verify `settings.blocker_auto_close_sec` matches your gate's traversal time (default 8s; bump for slower gates).

---

## 2. Mosquitto broker (already running per DEPLOYMENT.md)

- [ ] Firewall: allow inbound TCP **1883** (devices) and **8083** (browser WebSocket) from your camera VLAN only.
- [ ] If devices are on the public internet (avoid this), terminate TLS at Nginx: port `8883` for MQTT-over-TLS, `8084` for WebSocket-secure.
- [ ] Optional: enable Mosquitto username/password (`mosquitto_passwd`) and set `MQTT_USERNAME` / `MQTT_PASSWORD` in `worker/.env`. Update camera firmware MQTT settings to match.

---

## 3. Entry ANPR camera

### A. Camera-side configuration

- [ ] Power the camera up. Note its **factory IP** (often `192.168.1.100`).
- [ ] Open the camera's web UI (browser → factory IP, default `admin` / blank or `admin`).
- [ ] Set its **static IP** to a routable address on the platform's network.
- [ ] **MQTT settings** (usually under *Network → Cloud / MQTT*):
  - [ ] Broker host = platform IP
  - [ ] Broker port = `1883`
  - [ ] Client ID / SN = the device's serial (keep the factory value, or change — but match what you'll put in the DB)
  - [ ] Username/password = whatever you configured in step 2 (or blank if anonymous)
  - [ ] Heartbeat / keep_alive interval = **≤ 30 s** (default 10 s is fine)
- [ ] Save + reboot the camera.

### B. Platform-side configuration

- [ ] In **psql**, insert/update the entry channel:
  ```sql
  UPDATE channels
     SET anpr_device_sn = '<real entry SN>',
         s300_base_url  = 'http://<real-camera-arm-ip>:8086',
         rb_ip          = '<road-blocker-ip>',
         rb_port        = <port>,
         rb_device_no   = '<device-no>',
         rb_board_id    = '<board>',
         rb_column_num  = 1,
         name           = 'Main Gate Lane 1'
   WHERE channel_no = 'RJ001';
  ```
  (Or use the **Camera Robotic Arm → Channels** tab to edit through the UI.)

### C. Verification

- [ ] On the dashboard, the `RJ001` device chip turns 🟢 **ONLINE** with "Heartbeat <30 s ago".
- [ ] **MQTT Logs** page → filter by the entry SN → you see `keep_alive` arriving regularly.
- [ ] Drive (or wave) a test plate past the camera → `ivs_result` appears in MQTT Logs with the correct plate text.

### D. Protocol compliance check

Cross-check the real camera against [`COMMUNICATION.md` → ANPR Cameras](./COMMUNICATION.md#anpr-cameras-entry--exit). The worker's parser only understands the documented topic and payload shapes — anything else will be silently dropped.

- [ ] **All 4 up-topics arrive** — in **MQTT Logs → Inbound** filter by the entry SN. You should see each of:
  - [ ] `keep_alive` — every ~10 s · **purpose:** the *only* signal that drives ONLINE/STALE/OFFLINE on the dashboard. No keep_alive = the device is treated as offline even if it's still pushing plates.
  - [ ] `ivs_result` — on every plate recognition · **purpose:** the trigger event. Worker reads it → calls `/api/s300/come/{ch}` to start an inspection (entry) or `/api/visits/record-exit` to close the visit (exit).
  - [ ] `gpio_in` — on every loop-detector / IO trigger · **purpose:** informational; surfaces presence/induction-loop activity in MQTT Logs and lets you correlate "car sat on the loop but camera didn't fire".
  - [ ] `barr_gate_status` — on every physical barrier move · **purpose:** informational diagnostic; lets you tell whether a missing pass was a camera issue or a barrier-stuck-down issue.

  Missing topic → open the camera web UI → *Network → Cloud / MQTT → Event filter* and enable the missing event family.

- [ ] **`ivs_result` payload shape matches** — open one `ivs_result` row in MQTT Logs, inspect the JSON, and confirm the documented path exists:
  - [ ] `AlarmInfoPlate.result.PlateResult.license` is present and base64-encoded (the plate displays correctly on the dashboard)
  - [ ] `AlarmInfoPlate.result.PlateResult.confidence`, `direction`, `colorType`, `triggerType`, `unique_id` are populated

  If the plate is at a different path (e.g. `Result.Plate`), the firmware is on a different protocol revision — the worker's plate extractor only walks the documented path, so plates won't be recognised. File a firmware mismatch ticket.

- [ ] **Broker-level sanity** — confirm the camera reaches the broker independently of the platform:
  ```powershell
  mosquitto_sub -h <broker-ip> -t "device/<entry-sn>/message/up/+" -v
  ```
  Silent for >30 s → camera isn't reaching Mosquitto (firewall / wrong host / wrong port / wrong client credentials). Fix at the camera, not the platform.

---

## 4. Exit ANPR camera

Same steps as Entry, except:

- [ ] Channel row: use `channel_no = 'RJ002'` (or whatever you've named the exit channel).
- [ ] `kind = 'exit'`.
- [ ] `paired_channel_id` = the entry channel's `id` (so the platform knows which entry pairs with this exit for whitelist sync).
- [ ] Entry channel's `paired_channel_id` should also point back at this exit channel — or rely on the fallback "first enabled exit channel".

### Whitelist mode (critical)

The exit camera must be in **whitelist mode** so it only opens for vehicles the platform has authorised. Per the camera vendor's docs:

- [ ] In the camera's web UI, set "Recognition Mode" / "List Mode" = **Whitelist** (or "Permit-only").
- [ ] Empty the local whitelist — the platform will populate it via MQTT `white_list_operator` commands every time an entry inspection PASSes.

### Verification

- [ ] After an entry PASS for plate `X`, look at MQTT Logs **Outbound** tab — you should see `white_list_operator` with `operator_type: "add"` sent to the exit camera SN.
- [ ] Drive plate `X` past the exit camera → barrier opens, exit `ivs_result` shows up, platform calls `/api/visits/record-exit`, and the same MQTT Logs page later shows a follow-up `white_list_operator` with `operator_type: "delete"` cleaning the plate off the whitelist.

### Protocol compliance check (exit-specific)

In addition to the four up-topic checks from section 3.D, verify the **down** direction works — this is unique to the exit camera:

- [ ] **Down-topic delivery** — after an entry PASS, **MQTT Logs → Outbound** must show `device/<exit-sn>/message/down/white_list_operator` with the documented body shape:
  - [ ] `operator_type: "add"` · **purpose:** authorises a single plate at the exit camera (it's in *whitelist* mode and refuses unknown plates by default).
  - [ ] `dldb_rec[].plate` matches the entry plate · **purpose:** identifies exactly which plate is being authorised.
  - [ ] `enable_time` and `overdue_time` are set (one-time-pass window) · **purpose:** the camera auto-expires the entry — prevents a vehicle from coming back hours later on the same authorisation.

- [ ] **Camera ACK** — after the down-publish, **MQTT Logs → Inbound** for the exit SN should show a matching `device/<exit-sn>/message/down/white_list_operator/reply` with `code: 0`. No reply → camera firmware isn't subscribed to the down topic, or its MQTT ACL denies subscribes on `down/+`.
- [ ] **Whitelist actually applied** — drive plate `X` past the exit camera within `enable_time` → barrier opens. If barrier stays closed despite the `add` succeeding, the camera received the message but didn't enrol the plate (check that **Whitelist mode** is actually `Whitelist`, not `Blacklist` or `Disabled`).
- [ ] **Delete after exit** — once the vehicle exits, a follow-up `white_list_operator { operator_type: "delete", plate: "X" }` should appear in Outbound + Inbound reply within 5 s. Missing → worker not running, or `paired_channel_id` not wired up.

---

## 5. Camera Robotic Arm (S300)

The robot is **HTTP, not MQTT**. The platform is both the HTTP server (for its callbacks) and the HTTP client (for commands).

### Device-side

- [ ] Power up the arm, set its static IP.
- [ ] In the arm's controller UI, set **Platform callback base URL** to:
  ```
  http://<platform-host>/anpr_backend/overseas/s300
  ```
  This is where the arm POSTs its `work-status`, `face-image`, `video-record`, `uvis`, and `reset-complete` events.
- [ ] Set the **channel ID** the arm reports under — usually `RJ001` (matches `channels.channel_no`).
- [ ] Confirm the arm has no X-ray module configured — this deployment ignores X-ray callbacks.

### Platform-side

- [ ] In `anprc_channels` row for the entry channel: `s300_base_url = 'http://<arm-ip>:<arm-port>'`.
  The platform will call `/api/v1/channel-s300/come/{channelNo}`, `/leave/{channelNo}`, etc. on this URL.
- [ ] `uvis_timeout_sec = 30` (or whatever the arm's UVIS-scan worst case is). Inspections without a UVIS callback by this deadline auto-FAIL.

### Verification

- [ ] Dashboard → entry channel → **Camera Robotic Arm** card shows **READY** (green) with latency.
- [ ] Trigger one entry detection. The card should flip to **BUSY** while the cycle runs.
- [ ] The S300's web UI should show the same cycle progressing (Ready → Inspecting → Resetting → Ready).
- [ ] After completion, **Recent Decisions** on the dashboard shows a `pass` / `suspect` / `fail` row.

### Protocol compliance check

Cross-check the real arm against [`COMMUNICATION.md` → S300 Inspection Robot](./COMMUNICATION.md#s300-inspection-robot). Trigger a single inspection, then walk through both directions:

- [ ] **All 5 inbound callbacks hit the platform during one cycle.** Tail Apache's access log while the cycle runs:
  ```powershell
  Get-Content C:\xampp\apache\logs\access.log -Tail 50 -Wait
  ```
  You should observe (order may vary; multiple `work-status` are normal):
  - [ ] `POST /overseas/s300/work-status` — at least once each for op=6 (started) → 1 (inspecting) → 2 (resetting) → 3 (completed) · **purpose:** drives the platform's inspection state machine (`inspections.state`). Without it the inspection never advances past `pending`.
  - [ ] `POST /overseas/s300/face-image` — twice (driver + passenger) · **purpose:** captures the driver + passenger photos that show up in the inspection detail page; used for audit / post-incident review.
  - [ ] `POST /overseas/s300/video-record` — once · **purpose:** records paths to the inspection's video clips for later playback.
  - [ ] `POST /overseas/s300/uvis` — once, body carries `result` clean/suspect · **purpose:** this is *the* decision input. DecisionEngine reads `result` and decides `pass` / `suspect` / `fail`. Missing this → inspection auto-FAILs at `uvis_timeout_sec`.
  - [ ] `POST /overseas/s300/reset-complete` — once, after op=2 · **purpose:** the "channel is free again" signal. Without it the channel stays BUSY and the next vehicle can't be inspected.

  Missing route → the arm's **callback base URL** is wrong, or that callback is disabled in firmware. Re-check section 5 "Device-side".

- [ ] **`operating_state` values stay within the documented enum** (0=ready · 1=inspecting · 2=resetting · 3=completed · 4=e-stop · 5=failed · 6=started). Open the inspection in **Inspections** page → `current_operating_state` column should only ever take values 0–6. Out-of-range value (e.g. 99) ⇒ different protocol revision on the firmware.

- [ ] **All outbound commands succeed.** Open `anprc_inspection_status_logs` for the test inspection:
  ```sql
  SELECT created_at, event, http_status, error
    FROM inspection_status_logs
   WHERE inspection_id = <id>
   ORDER BY id;
  ```
  Each of the documented outbound endpoints called by the platform during this cycle must return HTTP 200:
  - [ ] `POST {s300_base_url}/come/RJ001` (worker auto-trigger) · **purpose:** tells the arm "a vehicle with plate X is here, start the inspection cycle".
  - [ ] `GET  {s300_base_url}/leave/RJ001` (DecisionExecutor on completion) · **purpose:** tells the arm "decision is done, release the vehicle and start your reset". Without this the arm sits in `inspecting` forever.

  HTTP timeout / connection refused → `s300_base_url` wrong, or the arm's HTTP server isn't on the documented port.

- [ ] **Watchdog path works.** Force a stall (kill the arm controller mid-cycle). Within `uvis_timeout_sec`, `/api/cron/tick` should call:
  - [ ] `POST /read-work-status/{ch}` · **purpose:** re-queries the arm's current state in case a `work-status` callback was lost in transit.
  - [ ] `POST /manual-reset/{ch}` · **purpose:** force-resets a stuck arm so the channel doesn't stay BUSY forever.

  Both visible in `anprc_inspection_status_logs`. No such rows → cron isn't running.

---

## 6. Road blocker

REST API, no MQTT. Per [Qigong AIoT spec](../%E3%80%90SSRD251030-04305%E3%80%91Road%20Blocker%20Communication%20Protocol.pdf):

### Device-side

- [ ] Power up the controller, set its static IP.
- [ ] Note down `deviceNo`, `boardId` (e.g. `"01"`), and how many columns are on each board.

### Platform-side

In `anprc_channels` row for the entry channel:

- [ ] `rb_ip` = controller IP
- [ ] `rb_port` = controller HTTP port (default `8088`)
- [ ] `rb_device_no` = the value the controller expects (case sensitive — e.g. `DEV001` not `DEVICE_001`)
- [ ] `rb_board_id` = the specific board this gate uses (e.g. `01`)
- [ ] `rb_column_num` = the column number on that board (typically `1`)

### Verification

- [ ] Dashboard → entry channel → **Road Blocker** card shows **ONLINE** with `controller_online = true`, and the column reads `Raised (7)`.
- [ ] Trigger one entry detection that ends in PASS. The card should briefly show `Descending (1)` → `Lowered (3)`, then 8 s later `Rising (5)` → `Raised (7)`.
- [ ] Confirm `inspections.blocker_closed_at` populates correctly after each PASS:
  ```sql
  SELECT id, license_plate, decision,
         EXTRACT(EPOCH FROM (blocker_closed_at - blocker_opened_at))::int AS open_for_s
    FROM inspections WHERE blocker_opened = 1 ORDER BY id DESC LIMIT 5;
  ```

### Protocol compliance check

Cross-check against [`COMMUNICATION.md` → Road Blocker](./COMMUNICATION.md#road-blocker) and the [Qigong AIoT spec](../【SSRD251030-04305】Road%20Blocker%20Communication%20Protocol.pdf):

- [ ] **TCP reachability** — from the platform host:
  ```powershell
  Test-NetConnection <rb_ip> -Port <rb_port>
  ```
  `TcpTestSucceeded : True` → controller is up and routable. False → controller off / firewall / wrong port.

- [ ] **Status framing accepted** — dashboard **Road Blocker** card reads `controller_online = true`. If the TCP test above succeeds but this shows `false`, the controller IS reachable but the documented `deviceNo` / `boardId` framing doesn't match the firmware — recheck `rb_device_no` and `rb_board_id` (case sensitive: `DEV001` ≠ `dev001`).

- [ ] **Column-state sequence on PASS matches the documented enum.** During one PASS cycle, the dashboard card should walk through exactly:
  ```
  7 (Raised) → 1 (Descending) → 3 (Lowered) → 5 (Rising) → 7 (Raised)
  ```
  Each value is the controller's reported column state:
  - `7 (Raised)` — default blocking state, no vehicle authorised
  - `1 (Descending)` — actively lowering after DecisionExecutor opened it on PASS
  - `3 (Lowered)` — fully down, vehicle can drive across
  - `5 (Rising)` — re-arming after `blocker_auto_close_sec` (~8 s) elapsed
  - `7 (Raised)` — back to default, ready for next vehicle

  Common deviations:
  - [ ] Stays at `7` → command not received (`rb_column_num` wrong, or backend can't write to the socket)
  - [ ] Jumps `7 → 5 → 7` → controller heard "raise" instead of "lower" (column numbering inverted)
  - [ ] Stops at `3` and never rises again → cron isn't running so `blocker_auto_close_sec` never fires

- [ ] **Manual frame test** (optional, only if the above is misbehaving) — using `ncat` / a TCP test tool, send the documented "raise column 1" packet for `rb_device_no` + `rb_board_id`. The controller should reply with the documented status frame. If the reply differs, the firmware is on a different protocol revision and `RoadBlockerService` won't parse it.

---

## 7. End-to-end smoke test

Once all four real devices are in place:

- [ ] **Live entry** — drive a known plate through the entry lane. Confirm in this order:
  1. Plate appears on **MQTT Logs → Inbound** for the entry SN
  2. An `anprc_inspections` row is created (state=`started` → `inspecting` → `resetting` → `completed`)
  3. The arm finishes its UVIS scan within `uvis_timeout_sec`
  4. **Recent Decisions** logs a `pass` (or `suspect` / `fail`)
  5. On PASS, the road blocker drops, vehicle drives through, ~8 s later it raises
  6. The exit camera's local whitelist now contains this plate
- [ ] **Live exit** — drive the same vehicle through the exit lane.
  1. Exit camera barrier opens (whitelist hit)
  2. **MQTT Logs → Inbound** shows the exit `ivs_result`
  3. The visit row flips to `status='completed'` and `exit_at` populates
  4. The exit camera's whitelist gets a follow-up `delete` for that plate
- [ ] **FAIL path** — force a UVIS timeout (e.g. cover the arm's sensor or use a known dirty undercarriage). Confirm:
  - Blocker **stays raised**
  - `decision = 'fail'`
  - Failure TTS audio plays on the camera/speaker
  - `visits.status = 'denied_entry'`
- [ ] **Orphan exit** — drive an unknown plate at the exit camera. Should remain blocked; a `anprc_visits` row with `status='orphan_exit'` appears.
- [ ] **Heartbeat-loss alarm** — power off one camera. Within 30 s its dashboard chip turns 🔴 **STALE / OFFLINE**. Power back on; it should recover within 30 s.

---

## 8. Operations / monitoring (after go-live)

- [ ] Set up the cron tick: a systemd timer or external cron must call the worker every 5 s (the bundled `worker.py` already does this; just confirm the service is `enabled`).
- [ ] Confirm `worker_last_seen_at` in `anprc_settings` is updating every 5 s (dashboard Worker card is green).
- [ ] Add log rotation for:
  - `C:\xampp\htdocs\anpr_backend\logs\app-*.log` (PHP errors)
  - `worker/worker.err.log`
  - `/var/log/mosquitto/mosquitto.log`
- [ ] Set up nightly backups of the `anpr_s300` database (see DEPLOYMENT.md).
- [ ] Configure an external uptime monitor to hit `/api/health` every minute.
- [ ] Decide retention for `anprc_mqtt_inbound_log` — at ~1 row per camera per 10 s, this table grows ~8 600 rows / camera / day. Schedule a nightly `DELETE FROM mqtt_inbound_log WHERE received_at < NOW() - INTERVAL '30 days';` if you don't need indefinite history.

---

## Quick reference — where the device ID goes

| Real device              | Goes into                          |
|--------------------------|------------------------------------|
| Entry camera serial      | `channels.anpr_device_sn` (RJ001)  |
| Exit camera serial       | `channels.anpr_device_sn` (RJ002)  |
| Camera Robotic Arm URL   | `channels.s300_base_url` (RJ001)   |
| Road blocker IP:port     | `channels.rb_ip`, `channels.rb_port` (RJ001) |
| Road blocker device no.  | `channels.rb_device_no` (RJ001)    |
| Road blocker board       | `channels.rb_board_id` (RJ001)     |
| Road blocker column      | `channels.rb_column_num` (RJ001)   |

---

## When something breaks

| Symptom                                                | First place to look                                   |
|--------------------------------------------------------|--------------------------------------------------------|
| Dashboard says ANPR is **STALE**                       | Camera power / network / wrong broker IP in firmware  |
| Plate detected but no inspection starts                | `settings.auto_start_s300 = 0`, or `auto_start_channel` doesn't match the camera's channel |
| Inspection always FAILs with "UVIS scan not received"  | Arm not reachable on `s300_base_url`, or wrong channel ID in arm firmware, or `uvis_timeout_sec` too short |
| Blocker stays down forever                             | Cron not running (`worker_last_seen_at` stale), or `rb_*` values misconfigured |
| Exit camera doesn't open for a PASS plate              | Whitelist mode not enabled on the camera, or `paired_channel_id` not set on the entry channel |
| Lots of orphan exits                                   | Exit camera detecting before entry registers, or two clients publishing under the same SN |
