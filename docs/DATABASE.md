# Database Reference

PostgreSQL 13+ schema for the ANPR + S300 platform. Canonical source:
[`backend/database/schema.sql`](../backend/database/schema.sql) — this document
mirrors it for humans.

> **`anprc_` prefix (shared-database namespacing).** Production runs in a
> PostgreSQL database shared with another platform, so every ANPR **table**,
> **ENUM type**, and the `updated_at` trigger **function** carries an `anprc_`
> prefix (e.g. `anprc_channels`, `anprc_inspection_state`). **Columns are NOT
> prefixed** — they are scoped to their table and can never collide, and keeping
> them leaves the REST/JSON field names (and the frontend) unchanged. Index,
> constraint, and trigger *names* keep their original form (e.g. `idx_channels_kind`)
> — they bind to the renamed objects by OID. Existing databases are migrated by
> `backend/database/migrations/2026-06-26_rename_to_anprc_prefix.sql`.

---

## Conventions

- **Engine:** PostgreSQL 13+, single schema `public`, single connection role `anpr`.
- **Timestamps:** all `TIMESTAMP` columns (no time-zone) store **UTC**.
  PHP inserts use `gmdate()`, Postgres defaults use `NOW()` (UTC because the
  container TZ is `Etc/UTC`). The frontend renders in the viewer's local
  timezone via `parsePgTs()`.
- **IDs:** `BIGSERIAL` for high-volume tables, `SERIAL` for low-volume.
- **Booleans:** stored as `SMALLINT` (`0`/`1`) for parity with the legacy
  MySQL schema this evolved from.
- **JSON payloads:** `JSONB` so they're query-able with the `->`, `->>`, and
  `@>` operators.
- **Updated-at triggers:** four tables maintain `updated_at` automatically via
  the `anprc_trg_set_updated_at()` function — `anprc_channels`, `anprc_inspections`, `anprc_visits`,
  `anprc_settings`. Every other table is append-only or uses manual updates.

## Enum types

| Enum | Values |
|---|---|
| `anprc_inspection_state` | `pending`, `started`, `inspecting`, `resetting`, `completed`, `emergency_stop`, `failed`, `vip_skipped` |
| `anprc_inspection_decision` | `pending`, `pass`, `suspect`, `fail`, `vip_pass` |
| `anprc_channel_kind` | `entry`, `exit`, `xray` |
| `anprc_visit_status` | `active`, `completed`, `orphan_exit`, `denied_entry` |
| `anprc_user_role` | `admin`, `operator`, `viewer` |
| `anprc_op_status` | `success`, `failed` |
| `anprc_mqtt_queue_status` | `pending`, `sent`, `failed` |

`kind = 'xray'` marks the x-ray room's own entry camera: any recognized plate
opens the room's entry gate (the room's exit gate is vendor-driven by the
x-ray receipt).

---

## Tables — grouped by concern

### 1. Topology — `anprc_locations` + `anprc_channels`

#### `anprc_locations`

Master list of site locations/zones (feeds the channel form's dropdown).
Channels reference these **by name** (`anprc_channels.location`), not by FK.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | VARCHAR(64) NOT NULL UNIQUE | e.g. `Gerbang Pancasila`, `Gerbang 46` (both seeded) |
| `created_at` | TIMESTAMP NOT NULL DEFAULT NOW() | |

#### `anprc_channels`

The platform's map of physical gates. Every lane / barrier is a channel row;
all per-lane configuration (which ANPR camera, which S300, which road blocker,
which behaviours the lane enforces) lives here.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `channel_no` | VARCHAR(32) UNIQUE | Stable channel ID (e.g. `RJ001`); used in API paths |
| `anpr_device_sn` | VARCHAR(64) | MQTT SN of the camera on this lane |
| `s300_base_url` | VARCHAR(255) NOT NULL | HTTP base URL for the S300 robot |
| `uvis_timeout_sec` | INT NOT NULL DEFAULT 30 | UVIS-scan timeout; FAIL after this |
| `failure_audio_index` | INT DEFAULT 7 | TTS index played on FAIL |
| `name` | VARCHAR(128) | Human-readable label |
| `location` | VARCHAR(64) | Site zone the lane belongs to (matches `anprc_locations.name`) |
| `kind` | `anprc_channel_kind` NOT NULL DEFAULT `entry` | `entry`, `exit`, or `xray` (x-ray room entry camera) |
| `paired_channel_id` | INT | **DEPRECATED (2026-07-06)** — lanes are not paired; vehicles enter/exit from any lane, whitelist ops fan out to ALL exit cameras |
| `enabled` | SMALLINT 0/1 | Soft-disable without deleting |

**Per-lane CORX road-blocker relay** (NULL columns fall back to the global
`blocker_relay_*` settings):

| Column | Type | Notes |
|---|---|---|
| `blocker_relay_enabled` | SMALLINT NOT NULL DEFAULT 0 | The lane HAS a relay-driven blocker |
| `blocker_relay_topic` | VARCHAR(64) | Command (subscribe) topic |
| `blocker_relay_pub_topic` | VARCHAR(64) | Device status (publish) topic, for ACK |
| `blocker_relay_res` | VARCHAR(16) | Device id echoed back (lane key) |
| `blocker_relay_value` | INT | Pulse magic (default 210001) |
| `blocker_relay_open_ch`, `blocker_relay_close_ch`, `blocker_relay_stop_ch` | VARCHAR(8) | Relay channels (e.g. `A01`/`A02`/`A03`) |
| `blocker_auto_open` | SMALLINT NOT NULL DEFAULT 0 | Per-lane "auto-open on inspection pass" (fallback: global `blocker_auto_open_enabled` setting) |
| `blocker_sensor` | VARCHAR(16) NOT NULL DEFAULT `clear` | Runtime interlock state from the (future) vehicle sensor: `clear` \| `passing` |
| `blocker_cycle` | VARCHAR(16) NOT NULL DEFAULT `idle` | `idle` \| `lowered` \| `passed` \| `raised` |
| `blocker_position` | VARCHAR(8) NOT NULL DEFAULT `unknown` | Physical position confirmed by the relay ACK: `down` \| `up` \| `unknown` |
| `blocker_last_seen` | TIMESTAMP | Last heartbeat from the relay's publish topic (liveness) |

**Per-lane behaviour switches** (multi-lane sites differ in installed
hardware). ANPR itself has no switch — recognition + barrier-open IS the entry
lane:

| Column | Type | Notes |
|---|---|---|
| `behavior_uvis_s300` | SMALLINT NOT NULL DEFAULT 1 | `0` auto-PASSES inspections with note `UVIS+S300 disabled` |
| `s300_inspection_mode` | VARCHAR(10) NOT NULL DEFAULT `full` | UI dropdown; keeps `behavior_uvis_s300` in sync (`none`→0, else→1). `none`=auto-pass (no S300); `skip`=complete when UVIS arrives (+`/leave`); `timed`=`/leave` `s300_timed_seconds` after the verdict, ignoring face images; `full`=face-driven `/leave` |
| `s300_timed_seconds` | SMALLINT NOT NULL DEFAULT 15 | The `timed` mode countdown |
| `behavior_vip` | SMALLINT NOT NULL DEFAULT 1 | Does this lane enforce the VIP list? |
| `behavior_blacklist` | SMALLINT NOT NULL DEFAULT 1 | Does this lane enforce the blacklist? |
| `behavior_whitelist_only` | SMALLINT NOT NULL DEFAULT 0 | `1` = only whitelisted (VIP-list) plates are admitted normally; unregistered vehicles are routed to the x-ray |

**Lane security mode** (x-ray routing policy):

| Column | Type | Notes |
|---|---|---|
| `security_mode` | VARCHAR(8) NOT NULL DEFAULT `green` | `red` = every vehicle to x-ray; `orange` = `security_random_pct` % of clean vehicles randomly routed (not-clean always routes); `green` = by inspection result only |
| `security_random_pct` | SMALLINT NOT NULL DEFAULT 20 | Random-routing percentage used by `orange` mode |

Indexes: `idx_channels_anpr_sn`, `idx_channels_kind`, `idx_channels_paired`.

### 2. Detection — `anprc_vehicles`

Append-only audit log. **Every plate the ANPR sees gets a row**, regardless of
whether it triggers an inspection.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `license_plate` | VARCHAR(32) NOT NULL | Decoded plate text |
| `plate_type`, `plate_color`, `car_color`, `confidence`, `direction`, `trigger_type` | INT | Raw ANPR metadata |
| `is_fake_plate` | SMALLINT | 0/1 — flagged by the camera |
| `anpr_device_sn` | VARCHAR(64) | Source camera |
| `image_path`, `image_fragment_path` | VARCHAR(512) | Device-reported snapshot paths (often empty) |
| `full_image_path` | VARCHAR(512) | Relative path to the saved full-scene snapshot (decoded from ivs_result `full_image_content`); the JPEG lives on disk under `uploads/vehicles/`, the DB holds only the path |
| `small_image_path` | VARCHAR(512) | Relative path to the plate close-up (from `small_image_content`) |
| `unique_id` | VARCHAR(64) | Per-camera unique detection ID |
| `detected_at` | TIMESTAMP NOT NULL | When the camera captured it |
| `created_at` | TIMESTAMP NOT NULL DEFAULT NOW() | When the backend recorded it |

Indexes: `idx_vehicles_plate`, `idx_vehicles_detected`, `idx_vehicles_unique`.

### 3. Inspection lifecycle — `anprc_inspections`

The heart of the system. One row per S300 cycle. Holds **two parallel
state fields**:

- `state` (`anprc_inspection_state`) — the platform's lifecycle: pending → started →
  inspecting → resetting → completed
- `current_operating_state` (SMALLINT 0-6) — direct mirror of what the S300
  most recently reported via `work-status` (cmd 322)

These are deliberately separate so the platform doesn't prematurely mark an
inspection complete on a transient `op=3` heartbeat. State only advances on
HTTP events (`/come`, `/leave`) and the `reset-complete` callback.

A **SUSPECT** verdict is held for human review: the row keeps `decision='suspect'`
with `review_status='pending'` and **no side-effects run** (no road blocker, no
`/leave`) until an operator approves or rejects it (recording `reviewed_by` /
`reviewed_at`). Approve then runs the pass-path; reject runs the fail-path.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `channel_no` | VARCHAR(32) NOT NULL | Lane this inspection ran on |
| `vehicle_id` | BIGINT | FK to `vehicles.id` — captured at `/come` time |
| `license_plate` | VARCHAR(32) NOT NULL | |
| `state` | `anprc_inspection_state` | Platform lifecycle |
| `decision` | `anprc_inspection_decision` | `pending`, `pass`, `suspect`, `fail`, `vip_pass` |
| `decision_reason` | VARCHAR(255) | Why (`Undercarriage clean`, `UVIS scan not received within timeout`, …) |
| `decision_at`, `decision_timeout_at` | TIMESTAMP | When decided, when it would have timed out |
| `xray_route` | VARCHAR(16) | Why the vehicle was routed to x-ray (NULL = not routed): `inspection` (fail/suspect verdict) · `security_red` · `security_random` · `manual` (operator button) · `blacklist` · `whitelist_only` (unregistered on a whitelist-only lane) |
| `review_status` | VARCHAR(16) | NULL normally; `pending` while a SUSPECT awaits manual review; `approved`/`rejected` once an operator decides |
| `reviewed_by` | VARCHAR(64) | Username of the approver/rejecter |
| `reviewed_at` | TIMESTAMP | When the human decided (UTC) |
| `blocker_opened` | SMALLINT 0/1 | Did we lower the column? |
| `blocker_opened_at`, `blocker_closed_at` | TIMESTAMP | Cron raises the column ~8s after open |
| `blocker_open_due_at` | TIMESTAMP | Deferred blocker open: set at the verdict to now + `blocker_open_delay_s`; the cron sweep opens the blocker + completes the inspection when due |
| `auto_leave_called` | SMALLINT 0/1 | Did the platform call `/leave`? |
| `current_operating_state` | SMALLINT | Latest cmd-322 number from S300 |
| `come_called_at`, `inspection_started_at`, `inspection_ended_at`, `leave_called_at`, `reset_completed_at` | TIMESTAMP | Step-by-step timeline |

Indexes: `idx_insp_channel`, `idx_insp_plate`, `idx_insp_state`,
`idx_insp_vehicle`, `idx_insp_decision`, `idx_insp_timeout`.

**Critical constraints:**

- **Partial unique index** `uq_one_active_inspection_per_channel` —
  ```
  CREATE UNIQUE INDEX uq_one_active_inspection_per_channel
      ON anprc_inspections (channel_no)
      WHERE state IN ('pending','started','inspecting','resetting');
  ```
  Race-proofs the busy-guard. Two `/come` arriving at the same millisecond
  can't both create active inspections; the second hits a `23505` violation
  which `S300Controller::come()` converts to a clean `409`.

- **Partial index** `idx_insp_blocker_open` — speeds up the cron sweep that
  closes opened-but-not-closed blockers older than `blocker_auto_close_sec`.

### 4. S300 callbacks — child detail tables

All keyed by `inspection_id` (a soft FK — no enforced reference because
S300 callbacks can arrive before the platform creates the inspection row, and
we want to keep the raw signal).

#### `anprc_inspection_status_logs`
Every `work-status` (cmd 322) callback. Useful for reconstructing the S300's
own timeline. `operating_state` is the SMALLINT 0-6 enum; `raw_payload` keeps
the full JSON.

#### `anprc_inspection_face_images`
Driver/passenger photos pushed via the `face-image` (cmd 323) endpoint. Stored
as URLs that point at the platform's `uploads/` directory.

#### `anprc_inspection_video_streams`
Video URLs from the S300 cameras. `camera_code` is the S300's internal channel
label (e.g. `A`, `B`); `stream_kind` distinguishes `record` (protocol 3.7
recorded video, default) from `realtime` (cmd 325 live streams).

#### `anprc_inspection_xray` (protocol 3.6 + §2.2.4 receipt)
One row per x-ray scan pushed by the vendor. The scan itself
(`vehicle_number`, `scan_started_at`/`scan_ended_at`, `is_anomaly`,
`anomaly_comments`, `scanner_operator`, `scanned_image_path`,
`plate_image_path`, `alarm_info` JSONB) is linked to a recent inspection via
`inspection_id` when one exists inside `xray_clearance_window_s`.

On top of the scan sits the **review + receipt flow**: a normal (no-anomaly)
scan is auto-receipted (`review_status='auto'`) when `xray_auto_receipt=1`;
an anomalous scan waits on the X-Ray tab for an operator verdict. The receipt
(`POST {vendor}/x-ray/{channelNo}`) opens the x-ray room's exit barrier on
`Result:true`.

| Column | Type | Notes |
|---|---|---|
| `review_status` | VARCHAR(16) NOT NULL DEFAULT `pending` | `pending` (awaiting operator) · `auto` (auto-passed, no anomaly) · `passed` · `denied` |
| `reviewed_by` | VARCHAR(128) | Operator username |
| `reviewed_at` | TIMESTAMP | When the operator decided (UTC) |
| `review_note` | VARCHAR(512) | Optional operator note |
| `receipt_result` | SMALLINT | `1` = `Result:true` (open barrier), `0` = `Result:false` |
| `receipt_status` | VARCHAR(16) | `sent` \| `failed` (NULL = not attempted) |
| `receipt_error` | VARCHAR(512) | Vendor/transport error on failure |
| `receipt_sent_at` | TIMESTAMP | When the receipt POST succeeded |

Indexes: `idx_xray_inspection`, `idx_xray_received (received_at DESC)`,
`idx_xray_review (review_status)`.

#### `anprc_inspection_uvis` + `anprc_inspection_uvis_coords`
Undercarriage scan result. `image_type` = 0 (clean) / 1 (suspect).
`object_count` is the number of detected foreign objects. When `>0`, child
rows in `anprc_inspection_uvis_coords` give bounding-box coordinates and confidence
for each detected object.

---

### 5. Visits & reporting — `anprc_visits`

The user-facing record of "vehicle X came in at Y and left at Z". One row per
arrival; updates in place on exit.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `license_plate` | VARCHAR(32) NOT NULL | |
| `entry_channel_no`, `exit_channel_no` | VARCHAR(32) | Where it came in / went out |
| `entry_inspection_id` | BIGINT | FK to the inspection that admitted it |
| `entry_at`, `exit_at` | TIMESTAMP | UTC; computed dwell = `exit_at - entry_at` |
| `status` | `anprc_visit_status` | `active` · `completed` · `orphan_exit` · `denied_entry` |
| `notes` | VARCHAR(255) | Free-form (used to log the FAIL reason on `denied_entry`) |
| `orphan_review` | VARCHAR(16) | Orphan-exit manual confirmation: `pending` · `allowed` · `denied` (NULL on non-orphan rows and legacy orphans). `allowed` opened the exit barrier |
| `orphan_reviewed_by` | VARCHAR(128) | Operator who confirmed/denied the orphan exit |
| `orphan_reviewed_at` | TIMESTAMP | When (UTC) |

Status transitions:

```
        VisitService::createEntry()                 VisitService::closeVisit()
inspections.PASS ───────────────────────► active ──────────────────────────► completed
                                            │
                                            │  DecisionExecutor (on FAIL)
                                            ▼
                                       denied_entry

         exit cam detects plate but no active visit
                            │
                            ▼
                       orphan_exit  (orphan_review='pending' → operator
                                     allows or denies opening the barrier)
```

Indexes: `idx_visits_plate`, `idx_visits_status`, `idx_visits_entry_at`,
`idx_visits_exit_at`, composite `idx_visits_active_plate (license_plate, status)` —
used to make `findActiveVisit()` O(index lookup) — and partial
`idx_visits_orphan_review ON (orphan_review) WHERE orphan_review = 'pending'`
for the CP's pending-confirmation poll.

### 6. MQTT — outbound queue + inbound log

#### `anprc_mqtt_outbound_queue`
The platform never calls `mqtt.publish()` directly. Anything destined for an
MQTT device is enqueued here; the Python worker drains the queue every 3s and
acks via `/api/mqtt-queue/{id}/sent|failed`. Survives backend restarts.

| Column | Type | Notes |
|---|---|---|
| `device_sn` | VARCHAR(64) NOT NULL | Target device |
| `command_name` | VARCHAR(64) NOT NULL | e.g. `white_list_operator`, `tts_voice` |
| `payload` | JSONB NOT NULL | Body of the MQTT command |
| `status` | `anprc_mqtt_queue_status` | `pending` → `sent` ‖ `failed` |
| `attempts` | INT | Worker increments on each try |
| `last_error` | TEXT | Last failure reason |
| `created_at`, `sent_at` | TIMESTAMP | UTC |

Indexes: composite `idx_mq_status_id (status, id)` for the
"give me the next N pending" worker query; `idx_mq_device` for per-device
filtering on the MQTT Logs page.

#### `anprc_mqtt_inbound_log`
Every MQTT message the worker subscribes to (`device/+/message/up/+`) gets a
row. Used by the MQTT Logs page and the dashboard's "Recent Plates" feed.

| Column | Type | Notes |
|---|---|---|
| `device_sn` | VARCHAR(64) NOT NULL | Parsed from the topic |
| `topic` | VARCHAR(255) NOT NULL | Full topic string |
| `message_name` | VARCHAR(64) NOT NULL | `ivs_result`, `keep_alive`, `gpio_in`, `barr_gate_status` |
| `license_plate` | VARCHAR(32) | Pre-extracted at ingest from `ivs_result` payloads — indexed for fast plate filtering |
| `payload` | JSONB | Full raw message body |
| `received_at` | TIMESTAMP NOT NULL DEFAULT NOW() | UTC |

Indexes: `idx_mqtt_in_sn`, `idx_mqtt_in_name`,
`idx_mqtt_in_received (received_at DESC)`,
composite `idx_mqtt_in_sn_recv (device_sn, received_at DESC)`,
partial `idx_mqtt_in_plate ON (license_plate) WHERE license_plate IS NOT NULL`.

### 7. HTTP inbound audit — `anprc_inbound_events_raw`

The S300 robot speaks HTTP to the platform. Every incoming S300 callback gets
a raw row here **before** any parsing, so we can replay corrupted events later
if a code bug ate them.

| Column | Type | Notes |
|---|---|---|
| `endpoint` | VARCHAR(64) NOT NULL | `work-status`, `face-image`, `video-record`, `uvis`, `reset-complete` |
| `cmd_no` | INT | S300 command number (322, 323, 325, 326) |
| `channel_no` | VARCHAR(32) | If the URL has it |
| `source_ip` | VARCHAR(45) | Caller's IP — for spotting misconfigured S300s |
| `raw_body` | TEXT | Verbatim POST body |
| `received_at` | TIMESTAMP NOT NULL DEFAULT NOW() | UTC |

### 8. Plate lists — `anprc_vip_plates` + `anprc_blacklist_plates`

Both lists share the same shape: lane-scoped, soft-disable, optional expiry.

#### `anprc_vip_plates` (whitelist)

Plates here bypass the entire S300 cycle: inspection is created with
`state='vip_skipped'`, `decision='vip_pass'`, blocker opens immediately, no
S300 call. Only enforced on lanes with `behavior_vip = 1`.

#### `anprc_blacklist_plates`

ANPR-stage list checked at `/come` **before** the VIP bypass, so it overrides
VIP. A blacklisted plate skips inspection and is routed to the x-ray
(`xray_route='blacklist'`, voice prompt `blacklist_voice_text`). Only enforced
on lanes with `behavior_blacklist = 1`.

Shared columns:

| Column | Type | Notes |
|---|---|---|
| `license_plate` | VARCHAR(32) NOT NULL | |
| `description` | VARCHAR(255) | |
| `enabled` | SMALLINT 0/1 | Soft-disable |
| `channel_no` | VARCHAR(32) | Lane scope: NULL = applies to ALL lanes; otherwise only that channel. The same plate may exist in several scopes (one row per lane) |
| `expires_at` | TIMESTAMP | NULL = permanent; a past `expires_at` means the entry no longer matches (`isVip` / `isBlacklisted` filter it out) but the row stays visible in the CP as "expired" |

Uniqueness: `uq_vip_plate_scope` / `uq_blacklist_plate_scope` on
`(license_plate, COALESCE(channel_no, '*'))` — one row per plate per scope.

### 9. Audio prompts — `anprc_audio_prompts`

Reference table of indexed TTS audio clips the platform can ask the S300 to
play (`/api/v1/device-s300/audio-prompt`). The default `failure_audio_index`
on `anprc_channels` is `7` ("please back out").

Composite uniqueness: `(audio_index, language)`.

### 10. Auth — `anprc_users`

The platform authenticates via SSO from a parent portal (see [`DEV_LOGIN.md`](./DEV_LOGIN.md)).
This table holds **shadow rows** — one per username the SSO endpoint has seen.
The shadow row is the source of truth for role + token attribution; the
`password_hash` column is kept (to satisfy NOT NULL) but is filled with an
unguessable random value because SSO users never log in with a password.

| Column | Type | Notes |
|---|---|---|
| `username` | VARCHAR(64) UNIQUE | Mirrors the parent platform's username |
| `password_hash` | VARCHAR(255) NOT NULL | Random for SSO users — never verified |
| `display_name` | VARCHAR(128) | Mirrored from parent on each login |
| `role` | `anprc_user_role` | `admin` · `operator` · `viewer` — mapped from parent role |
| `enabled` | SMALLINT 0/1 | Set to 1 on every successful SSO; 0 to lock out |

Rows are upserted by `AuthController::sso` on every successful login. With
`auth.dev_bypass = true` in `config.php`, any username creates a row with
`role = 'admin'` (handy for local dev).

### 11. Configuration — `anprc_settings`

Simple key/value store. Hot-reloaded by the worker every 10s.

Seeded keys (from `schema.sql`):

| Key | Default | Purpose |
|---|---|---|
| `platform_name` | "ANPR + S300 Integrated Platform" | Display name |
| `default_s300_base_url` | `http://192.168.1.50:8080` | Used when creating new channels |
| `mqtt_broker_url` | `ws://localhost:8083/mqtt` | Frontend MQTT WebSocket endpoint |
| `uvis_image_dir` | `uploads/uvis` | UVIS image storage path |
| `vip_plates` | empty | Legacy comma-separated list (use the `anprc_vip_plates` table instead) |
| `auto_start_s300` | `0` | Worker auto-triggers `/come` on detection when `1` |
| `auto_start_channel` | `RJ001` | Fallback channel when SN doesn't map |
| `blacklist_voice_enabled` | `1` | Speak on the entry camera when a blacklisted plate is seen |
| `blacklist_voice_text` | `Blacklisted Vehicle. Go To X-RAY` | Blacklist voice prompt (directs to x-ray, no longer denies) |
| `blacklist_led_enabled` | `1` | Show LED text for blacklisted plates |
| `blacklist_led_text` | `BLACKLIST` | LED text |
| `whitelist_deny_voice_text` | `Unregistered Vehicle. Go To X-RAY` | Whitelist-only lane prompt for unregistered vehicles (routes to x-ray; voice/LED on-switches shared with blacklist) |
| `whitelist_deny_led_text` | `NOT REGISTERED` | LED text on whitelist-only lanes |
| `s300_audio_failure_url` | empty | WAV file URL the S300 downloads for the FAIL back-up prompt (empty = none registered) |
| `videotron_xray_text` | `GO TO X-RAY` | Text the videotron shows a vehicle routed forward to the x-ray |
| `xray_channel_no` | `XRAY01` | Channel used in the receipt `POST /x-ray/{channelNo}` (protocol §2.2.4) |
| `xray_base_url` | empty | Vendor base URL for the receipt (empty = fall back to `default_s300_base_url`) |
| `xray_auto_receipt` | `1` | Auto-receipt a normal (no-anomaly) scan with `Result:true` |
| `xray_clearance_window_s` | `3600` | Window (s) for linking a scan to a recent inspection AND for inspection-free re-entry at the main lane after a PASSED scan |
| `s300_auto_leave_enabled` | `1` | Direct S300 `/leave` after a decision (the real device needs it to reset + emit the recorded video) |
| `face_leave_delay_s` | `3` | `/leave` fires this many seconds after the FIRST face image |
| `blocker_open_delay_s` | `60` | Fallback deferred-open delay when no face image ever arrives (counted from the UVIS verdict) |
| `blocker_reset_interval_s` | `7` | Extra gap between `/leave` and lowering the blocker, so the S300 can reset before the barrier moves |
| `blocker_auto_close_sec` | `8` | Seconds the column stays Lowered after PASS |
| `blocker_close_mode` | `hardware` | `hardware` = controller raises itself via its loop detector (safe default); `backend_timer` = legacy software-timed raise (crush risk) |
| `blocker_relay_enabled` | `1` | Global CORX CX-5104E-L relay switch (per-lane columns override) |
| `blocker_relay_topic` | `testsubscribe` | Relay command topic |
| `blocker_relay_value` | `210001` | Vendor "pulse" magic value |
| `blocker_relay_res` | `123` | Equipment id (≤15 chars) |
| `blocker_relay_open_ch` / `blocker_relay_close_ch` / `blocker_relay_stop_ch` | `A01` / `A02` / `A03` | Relay channels |
| `blocker_auto_open_enabled` | `0` | Global auto-open fallback; OFF = inspection flow never touches the blocker (collision risk) |

Runtime / CP-set keys (not seeded by `schema.sql`):

| Key | Purpose |
|---|---|
| `entry_gate_open` | When `1`, the platform opens the ANPR camera's own gate (via `gpio_out`) at `/come` |
| `entry_gate_io` | Camera output index (0-3) wired to that gate |
| `entry_gate_value` | gpio_out value: 0=OFF, 1=ON, 2=Pulse |
| `entry_gate_pulse_ms` | Pulse duration (ms) when `entry_gate_value=2` |
| `worker_last_seen_at` | Heartbeat written by every cron tick; stored as an offset-aware GMT+7 ISO-8601 string (not naive UTC) so it reads unambiguously |

### 12. Audit trail — `anprc_operation_log`

Append-only log of every platform action — both auto-decisions and manual
operator interventions. Powers the inspection-detail "Operations" tab and the
top-level **Audit Log** page (Diagnostics → Audit Log).

| Column | Type | Notes |
|---|---|---|
| `actor_username` | VARCHAR(64) | The SSO username that triggered the action. NULL for system-initiated actions (cron, decision pushes, S300 inbound callbacks). |
| `channel_no` | VARCHAR(32) | |
| `inspection_id` | BIGINT | |
| `action` | VARCHAR(64) NOT NULL | See action catalog below |
| `request_payload`, `response_payload` | JSONB | Both sides of the call |
| `status` | `anprc_op_status` | `success` · `failed` |
| `error_message` | TEXT | Populated on failure |

Indexes on `(actor_username)`, `(channel_no)`, `(inspection_id)`, `(action)`,
`(created_at)` — every common drill-down has an index.

> **Migration note**: This table used to have a `user_id INT` column. It was
> renamed to `actor_username VARCHAR(64)` so SSO usernames are the audit key
> (no internal user-id juggling). Migration script:
> `backend/database/migrations/2026-05-25_oplog_actor_username.sql`.

#### Action catalog (non-exhaustive)

| Category | Actions |
|---|---|
| Auth | `auth.sso_login` |
| Channels | `channel.create`, `channel.update`, `channel.delete` |
| Settings | `settings.update` |
| VIP plates | `vip.create`, `vip.update`, `vip.delete` |
| S300 (operator) | `come`, `come_vip_bypass`, `capture`, `leave`, `read_work_status`, `emergency_stop`, `manual_reset`, `audio_prompt`, `video_playback` |
| S300 (system) | `auto_decision`, `open_blocker`, `blocker_close`, `send_backup_audio`, `auto_leave`, `reset_watchdog`, `whitelist_enqueue_add`, `route_to_xray` |

---

## Soft relationships

The schema deliberately uses no `FOREIGN KEY` constraints. Each "child" table
keeps an integer parent ID, but the FK is enforced at the application layer.
Rationale:

- S300 callbacks (`anprc_inspection_status_logs`, `face_images`, etc.) can arrive
  before the platform creates the parent inspection row.
- Append-only audit tables (`anprc_vehicles`, `anprc_inbound_events_raw`, `anprc_operation_log`,
  `anprc_mqtt_inbound_log`) must accept rows even when the related entity has been
  hard-deleted.
- Schema migrations during the active development phase are simpler without
  FK cascades to maintain.

The relationship map below is therefore implicit, not constraint-enforced:

```
       ┌──────────────┐     ┌────────────────────────────────────────┐
       │  locations   │◄────│              channels                  │
       │  id, name    │name │  id, channel_no, kind, location,       │
       └──────────────┘     │  behavior_*, security_mode, blocker_*  │
                            └───────┬──────────────────┬─────────────┘
                                    │                  │
                                    │ channel_no       │ channel_no
                                    ▼                  ▼
       ┌──────────────────────────┐    ┌────────────────────┐
       │       inspections        │    │       visits       │
       │ id, channel_no,          │◄──┐│ id, plate,         │
       │ vehicle_id, plate,       │   ││ entry_inspection   │
       │ state, decision,         │   ││ status, entry_at   │
       │ xray_route, blocker_*    │   ││ exit_at, orphan_*  │
       └─┬──────┬──────┬───┬───┬──┘   │└────────────────────┘
         │      │      │   │   │      │
         │      │      │   │   │      │ entry_inspection_id
         │      │      │   │   │      └─────────────────────────────────
         │      │      │   │   │
         ▼      ▼      ▼   ▼   ▼
  status_logs face_  video_ uvis ──► uvis_coords
              images streams
                            xray  (scan + review/receipt)

                            ▲
                            │ vehicle_id
       ┌──────────────────┐ │
       │     vehicles     │─┘
       │ id, plate, sn    │
       │ detected_at      │
       └──────────────────┘

       ┌──────────────────┐    ┌──────────────────┐
       │ mqtt_outbound_   │    │ mqtt_inbound_log │
       │      queue       │    │  device_sn,      │
       │ device_sn, cmd,  │    │  topic, plate    │
       │ payload, status  │    │  payload         │
       └──────────────────┘    └──────────────────┘
              │                          ▲
              │ drained by worker        │ written by worker
              └──────────────────────────┘

  ┌────────────────┐ ┌──────────────────┐ ┌──────────────┐ ┌────────────────┐
  │   vip_plates   │ │ blacklist_plates │ │   settings   │ │ operation_log  │
  │ plate, scope,  │ │  plate, scope,   │ │  key, value  │ │ inspection_id  │
  │ expires_at     │ │  expires_at      │ └──────────────┘ │ action, status │
  └────────────────┘ └──────────────────┘                  └────────────────┘
```

---

## Notable race-protection patterns

1. **One active inspection per channel** — partial unique index on
   `inspections.channel_no WHERE state IN (active states)`. Replaces the
   check-then-insert busy-guard with an atomic constraint violation that the
   controller catches as a 409.

2. **MQTT command queue, not direct publish** — prevents the backend from
   blocking on an unreachable broker, lets retries happen out-of-band, and
   gives every command a permanent record.

3. **Settings-table heartbeat** — `worker_last_seen_at` updated by the cron
   tick, read by the dashboard. No special heartbeat table needed, no IPC.

4. **Append-only inbound logs** (`anprc_inbound_events_raw`, `anprc_mqtt_inbound_log`) —
   even when downstream parsing fails, the raw signal is preserved for replay
   or forensic analysis.

---

## Migrations

`schema.sql` is **consolidated** — it already contains every change below, so
a fresh install needs no migration scripts. The files in
`backend/database/migrations/` exist only to upgrade databases created before
the change they carry. Recent ones:

| File | What it does |
|---|---|
| `2026-07-17_xray_review.sql` | X-ray review/receipt columns + `idx_xray_review`; `security_mode` / `security_random_pct` on channels; `inspections.xray_route`; blacklist voice default → "Go To X-RAY"; seeds `xray_channel_no` / `xray_base_url` / `xray_auto_receipt` |
| `2026-07-19_orphan_review.sql` | `visits.orphan_review*` columns + partial `idx_visits_orphan_review` |
| `2026-07-19_xray_room.sql` | Adds `xray` to `anprc_channel_kind`; seeds `xray_clearance_window_s` |
| `2026-07-20_list_expiry.sql` | `expires_at` on `anprc_vip_plates` + `anprc_blacklist_plates` |
| `2026-07-20_whitelist_xray.sql` | Whitelist-only deny voice default → "Unregistered Vehicle. Go To X-RAY" |

---

## Seed data inserted on first run

- One `admin` shadow user (no usable password — SSO is the only login path;
  see [`DEV_LOGIN.md`](./DEV_LOGIN.md))
- Two `anprc_locations` rows: `Gerbang Pancasila`, `Gerbang 46`
- Default `anprc_settings` rows — platform name, MQTT broker, auto-start flags,
  blacklist/whitelist voice + LED texts, x-ray receipt config, S300 leave/delay
  timings, and the CORX blocker-relay defaults (see §11)
- One starter `channel` `RJ001` (entry)

Run `psql -f backend/database/schema.sql` against an empty database — the
`BEGIN ... COMMIT` transaction makes the whole import atomic, and every
`CREATE` is `IF NOT EXISTS` so re-running is a no-op.
