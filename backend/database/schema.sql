-- ANPR + S300 Integration — PostgreSQL schema (consolidated)
-- Postgres 13+

BEGIN;

-- ============================================
-- ENUM types
-- ============================================
DO $$ BEGIN
    CREATE TYPE anprc_inspection_state AS ENUM (
        'pending','started','inspecting','resetting','completed',
        'emergency_stop','failed','vip_skipped'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE anprc_inspection_decision AS ENUM (
        'pending','pass','suspect','fail','vip_pass'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE anprc_channel_kind AS ENUM ('entry','exit','xray');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE anprc_visit_status AS ENUM ('active','completed','orphan_exit','denied_entry');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE anprc_user_role AS ENUM ('admin','operator','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE anprc_op_status AS ENUM ('success','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE anprc_mqtt_queue_status AS ENUM ('pending','sent','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================
-- channels
-- ============================================
-- Master list of site locations/zones (channel form dropdown). Channels
-- reference these BY NAME (anprc_channels.location), not by FK.
CREATE TABLE IF NOT EXISTS anprc_locations (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO anprc_locations (name) VALUES
    ('Gerbang Pancasila'),
    ('Gerbang 46')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS anprc_channels (
    id                 SERIAL PRIMARY KEY,
    channel_no         VARCHAR(32) NOT NULL UNIQUE,
    anpr_device_sn     VARCHAR(64),
    s300_base_url      VARCHAR(255) NOT NULL,
    uvis_timeout_sec   INT NOT NULL DEFAULT 30,
    failure_audio_index INT DEFAULT 7,
    name               VARCHAR(128),
    -- Site zone the lane belongs to (e.g. "Gerbang Pancasila", "Gerbang 46")
    location           VARCHAR(64),
    kind               anprc_channel_kind NOT NULL DEFAULT 'entry',
    -- DEPRECATED (2026-07-06): lanes are not paired — vehicles enter from any
    -- lane and exit from any lane; whitelist ops fan out to ALL exit cameras.
    paired_channel_id  INT,
    enabled            SMALLINT NOT NULL DEFAULT 1,
    -- Per-lane CORX road-blocker relay (NULL columns fall back to the global
    -- blocker_relay_* settings). See 2026-07-03_per_channel_blocker.sql.
    blocker_relay_enabled   SMALLINT NOT NULL DEFAULT 0,
    blocker_relay_topic     VARCHAR(64),   -- command (subscribe) topic
    blocker_relay_pub_topic VARCHAR(64),   -- device status (publish) topic, for ACK
    blocker_relay_res       VARCHAR(16),   -- device id echoed back (lane key)
    blocker_relay_value     INT,           -- pulse magic (default 210001)
    blocker_relay_open_ch   VARCHAR(8),
    blocker_relay_close_ch  VARCHAR(8),
    blocker_relay_stop_ch   VARCHAR(8),
    -- Per-lane "auto-open on inspection pass" (independent). Fallback: global
    -- blocker_auto_open_enabled setting.
    blocker_auto_open  SMALLINT NOT NULL DEFAULT 0,
    -- Runtime interlock state driven by the future vehicle sensor.
    blocker_sensor     VARCHAR(16) NOT NULL DEFAULT 'clear',  -- clear | passing
    blocker_cycle      VARCHAR(16) NOT NULL DEFAULT 'idle',   -- idle | lowered | passed | raised
    -- Physical position confirmed by the relay ACK: down | up | unknown.
    blocker_position   VARCHAR(8) NOT NULL DEFAULT 'unknown',
    -- Last heartbeat received from the relay's publish topic (liveness).
    blocker_last_seen  TIMESTAMP,
    -- Per-lane behaviour switches (multi-lane sites differ in installed hardware).
    -- behavior_uvis_s300=0 auto-PASSES inspections with note 'UVIS+S300 disabled'.
    -- behavior_vip / behavior_blacklist decide which plate lists a lane ENFORCES.
    -- ANPR has NO switch: recognition + barrier-open IS the entry lane.
    -- (Road blocker is NOT a behaviour switch: whether the flow lowers it is
    --  blocker_auto_open below; whether the lane HAS one is blocker_relay_enabled.)
    behavior_uvis_s300    SMALLINT NOT NULL DEFAULT 1,
    -- S300 inspection MODE (UI dropdown; keeps behavior_uvis_s300 in sync, none→0
    -- else→1). none=auto-pass (no S300); skip=complete when UVIS arrives (+/leave);
    -- timed=/leave s300_timed_seconds after the verdict, ignoring face images;
    -- full=face-driven /leave (default). s300_timed_seconds = the 'timed' countdown.
    s300_inspection_mode  VARCHAR(10) NOT NULL DEFAULT 'full',
    s300_timed_seconds    SMALLINT NOT NULL DEFAULT 15,
    behavior_vip          SMALLINT NOT NULL DEFAULT 1,
    behavior_blacklist    SMALLINT NOT NULL DEFAULT 1,
    -- Whitelist-only lane: 1 = ONLY whitelisted (VIP-list) plates are admitted;
    -- everything else is denied at the ANPR stage. Default 0 = admit all
    -- non-blacklisted plates.
    behavior_whitelist_only SMALLINT NOT NULL DEFAULT 0,
    -- Security mode (x-ray routing policy): red = every vehicle to x-ray;
    -- orange = security_random_pct % of clean vehicles randomly routed
    -- (not-clean always routes); green = by inspection result only.
    security_mode         VARCHAR(8) NOT NULL DEFAULT 'green',
    security_random_pct   SMALLINT NOT NULL DEFAULT 20,
    created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channels_anpr_sn  ON anprc_channels (anpr_device_sn);
CREATE INDEX IF NOT EXISTS idx_channels_kind     ON anprc_channels (kind);
CREATE INDEX IF NOT EXISTS idx_channels_paired   ON anprc_channels (paired_channel_id);

-- ============================================
-- vehicles (every plate detection)
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_vehicles (
    id                   BIGSERIAL PRIMARY KEY,
    license_plate        VARCHAR(32) NOT NULL,
    plate_type           INT,
    plate_color          INT,
    car_color            INT,
    confidence           INT,
    direction            INT,
    trigger_type         INT,
    is_fake_plate        SMALLINT,
    anpr_device_sn       VARCHAR(64),
    image_path           VARCHAR(512),
    image_fragment_path  VARCHAR(512),
    full_image_path      VARCHAR(512),   -- full scene snapshot (from ivs_result full_image_content)
    small_image_path     VARCHAR(512),   -- plate close-up (from ivs_result small_image_content)
    unique_id            VARCHAR(64),
    detected_at          TIMESTAMP NOT NULL,
    created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate     ON anprc_vehicles (license_plate);
CREATE INDEX IF NOT EXISTS idx_vehicles_detected  ON anprc_vehicles (detected_at);
CREATE INDEX IF NOT EXISTS idx_vehicles_unique    ON anprc_vehicles (unique_id);

-- ============================================
-- inspections
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_inspections (
    id                       BIGSERIAL PRIMARY KEY,
    channel_no               VARCHAR(32) NOT NULL,
    vehicle_id               BIGINT,
    license_plate            VARCHAR(32) NOT NULL,
    state                    anprc_inspection_state NOT NULL DEFAULT 'pending',
    decision                 anprc_inspection_decision NOT NULL DEFAULT 'pending',
    decision_reason          VARCHAR(255),
    decision_at              TIMESTAMP,
    decision_timeout_at      TIMESTAMP,
    -- Why the vehicle was routed to x-ray (NULL = not routed):
    -- inspection | security_red | security_random | manual | blacklist
    xray_route               VARCHAR(16),
    review_status            VARCHAR(16),          -- NULL · pending · approved · rejected (manual review of a SUSPECT)
    reviewed_by              VARCHAR(64),          -- username of approver / rejecter
    reviewed_at              TIMESTAMP,
    blocker_opened           SMALLINT NOT NULL DEFAULT 0,
    blocker_opened_at        TIMESTAMP,
    blocker_closed_at        TIMESTAMP,
    -- Deferred road-blocker open: set at the verdict to now + blocker_open_delay_s;
    -- the cron sweep opens the blocker + completes the inspection when due.
    blocker_open_due_at      TIMESTAMP,
    auto_leave_called        SMALLINT NOT NULL DEFAULT 0,
    current_operating_state  SMALLINT,
    come_called_at           TIMESTAMP,
    inspection_started_at    TIMESTAMP,
    inspection_ended_at      TIMESTAMP,
    leave_called_at          TIMESTAMP,
    reset_completed_at       TIMESTAMP,
    created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_insp_channel  ON anprc_inspections (channel_no);
CREATE INDEX IF NOT EXISTS idx_insp_plate    ON anprc_inspections (license_plate);
CREATE INDEX IF NOT EXISTS idx_insp_state    ON anprc_inspections (state);
CREATE INDEX IF NOT EXISTS idx_insp_review_status ON anprc_inspections (review_status);
CREATE INDEX IF NOT EXISTS idx_insp_vehicle  ON anprc_inspections (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_insp_decision ON anprc_inspections (decision);
CREATE INDEX IF NOT EXISTS idx_insp_timeout  ON anprc_inspections (decision_timeout_at);
CREATE INDEX IF NOT EXISTS idx_insp_blocker_open ON anprc_inspections (blocker_opened, blocker_opened_at)
    WHERE blocker_opened = 1 AND blocker_closed_at IS NULL;
-- Concurrency: at most one active inspection per channel. Race-proof busy guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_inspection_per_channel
    ON anprc_inspections (channel_no)
    WHERE state IN ('pending','started','inspecting','resetting');

-- ============================================
-- inspection_status_logs
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_inspection_status_logs (
    id              BIGSERIAL PRIMARY KEY,
    inspection_id   BIGINT,
    channel_no      VARCHAR(32) NOT NULL,
    operating_state SMALLINT NOT NULL,
    cmd_no          INT DEFAULT 322,
    raw_payload     JSONB,
    received_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_islog_inspection ON anprc_inspection_status_logs (inspection_id);
CREATE INDEX IF NOT EXISTS idx_islog_channel    ON anprc_inspection_status_logs (channel_no);
CREATE INDEX IF NOT EXISTS idx_islog_received   ON anprc_inspection_status_logs (received_at);

-- ============================================
-- inspection_face_images
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_inspection_face_images (
    id            BIGSERIAL PRIMARY KEY,
    inspection_id BIGINT,
    channel_no    VARCHAR(32) NOT NULL,
    image_url     VARCHAR(1024) NOT NULL,
    received_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_face_inspection ON anprc_inspection_face_images (inspection_id);
CREATE INDEX IF NOT EXISTS idx_face_channel    ON anprc_inspection_face_images (channel_no);

-- ============================================
-- inspection_video_streams
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_inspection_video_streams (
    id            BIGSERIAL PRIMARY KEY,
    inspection_id BIGINT,
    channel_no    VARCHAR(32) NOT NULL,
    camera_code   VARCHAR(8) NOT NULL,
    stream_url    VARCHAR(1024) NOT NULL,
    stream_kind   VARCHAR(16) NOT NULL DEFAULT 'record',  -- 'record' (3.7) | 'realtime' (cmd 325)
    received_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================
-- inspection_xray (protocol 3.6)
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_inspection_xray (
    id                 BIGSERIAL PRIMARY KEY,
    inspection_id      BIGINT,
    channel_no         VARCHAR(32),
    sn                 VARCHAR(64),
    vehicle_number     VARCHAR(32),
    scan_started_at    VARCHAR(32),
    scan_ended_at      VARCHAR(32),
    is_anomaly         SMALLINT NOT NULL DEFAULT 0,
    anomaly_comments   VARCHAR(512),
    scanner_operator   VARCHAR(128),
    scanned_image_path VARCHAR(512),
    plate_image_path   VARCHAR(512),
    alarm_info         JSONB,
    received_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Review + receipt flow (protocol §2.2.4 X-check receipt)
    review_status      VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending|auto|passed|denied
    reviewed_by        VARCHAR(128),
    reviewed_at        TIMESTAMP,
    review_note        VARCHAR(512),
    receipt_result     SMALLINT,        -- 1=Result:true (open), 0=Result:false
    receipt_status     VARCHAR(16),     -- sent|failed (NULL = not attempted)
    receipt_error      VARCHAR(512),
    receipt_sent_at    TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_xray_inspection ON anprc_inspection_xray (inspection_id);
CREATE INDEX IF NOT EXISTS idx_xray_received   ON anprc_inspection_xray (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_xray_review     ON anprc_inspection_xray (review_status);
CREATE INDEX IF NOT EXISTS idx_vstream_inspection ON anprc_inspection_video_streams (inspection_id);
CREATE INDEX IF NOT EXISTS idx_vstream_channel    ON anprc_inspection_video_streams (channel_no);

-- ============================================
-- inspection_uvis
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_inspection_uvis (
    id                 BIGSERIAL PRIMARY KEY,
    inspection_id      BIGINT,
    channel_no         VARCHAR(32) NOT NULL,
    s300_inspection_id BIGINT,
    image_type         SMALLINT NOT NULL,
    image_path         VARCHAR(512),
    object_count       INT DEFAULT 0,
    received_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uvis_inspection ON anprc_inspection_uvis (inspection_id);
CREATE INDEX IF NOT EXISTS idx_uvis_channel    ON anprc_inspection_uvis (channel_no);
CREATE INDEX IF NOT EXISTS idx_uvis_s300id     ON anprc_inspection_uvis (s300_inspection_id);

CREATE TABLE IF NOT EXISTS anprc_inspection_uvis_coords (
    id          BIGSERIAL PRIMARY KEY,
    uvis_id     BIGINT NOT NULL,
    confidence  NUMERIC(5,4),
    x1 INT NOT NULL,
    y1 INT NOT NULL,
    x2 INT NOT NULL,
    y2 INT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uvis_coords_uvis ON anprc_inspection_uvis_coords (uvis_id);

-- ============================================
-- audio_prompts
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_audio_prompts (
    id           SERIAL PRIMARY KEY,
    audio_index  INT NOT NULL,
    language     SMALLINT NOT NULL,
    url          VARCHAR(512) NOT NULL,
    description  VARCHAR(255),
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_audio_idx_lang UNIQUE (audio_index, language)
);

-- ============================================
-- users
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name  VARCHAR(128),
    role          anprc_user_role NOT NULL DEFAULT 'operator',
    enabled       SMALLINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================
-- operation_log
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_operation_log (
    id               BIGSERIAL PRIMARY KEY,
    actor_username   VARCHAR(64),
    channel_no       VARCHAR(32),
    inspection_id    BIGINT,
    action           VARCHAR(64) NOT NULL,
    request_payload  JSONB,
    response_payload JSONB,
    status           anprc_op_status NOT NULL,
    error_message    TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oplog_actor     ON anprc_operation_log (actor_username);
CREATE INDEX IF NOT EXISTS idx_oplog_channel   ON anprc_operation_log (channel_no);
CREATE INDEX IF NOT EXISTS idx_oplog_insp      ON anprc_operation_log (inspection_id);
CREATE INDEX IF NOT EXISTS idx_oplog_action    ON anprc_operation_log (action);
CREATE INDEX IF NOT EXISTS idx_oplog_created   ON anprc_operation_log (created_at);

-- ============================================
-- settings
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_settings (
    key_name   VARCHAR(64) PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================
-- inbound_events_raw
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_inbound_events_raw (
    id          BIGSERIAL PRIMARY KEY,
    endpoint    VARCHAR(64) NOT NULL,
    cmd_no      INT,
    channel_no  VARCHAR(32),
    source_ip   VARCHAR(45),
    raw_body    TEXT,
    received_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbound_endpoint ON anprc_inbound_events_raw (endpoint);
CREATE INDEX IF NOT EXISTS idx_inbound_channel  ON anprc_inbound_events_raw (channel_no);
CREATE INDEX IF NOT EXISTS idx_inbound_received ON anprc_inbound_events_raw (received_at);

-- ============================================
-- vip_plates
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_vip_plates (
    id            SERIAL PRIMARY KEY,
    license_plate VARCHAR(32) NOT NULL,
    description   VARCHAR(255),
    enabled       SMALLINT NOT NULL DEFAULT 1,
    -- Lane scope: NULL = applies to ALL lanes; otherwise only that channel_no.
    -- The same plate may exist in several scopes (one row per lane).
    channel_no    VARCHAR(32),
    -- NULL = permanent; past = expired (kept visible in the CP, no longer matches).
    expires_at    TIMESTAMP,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vip_plate_scope
    ON anprc_vip_plates (license_plate, COALESCE(channel_no, '*'));

-- ============================================
-- blacklist_plates
-- ANPR-stage deny list: a matching plate is refused entry at /come (entry gate
-- stays shut, no S300 inspection started). Checked before the VIP bypass, so
-- it overrides VIP.
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_blacklist_plates (
    id            SERIAL PRIMARY KEY,
    license_plate VARCHAR(32) NOT NULL,
    description   VARCHAR(255),
    enabled       SMALLINT NOT NULL DEFAULT 1,
    -- Lane scope: NULL = applies to ALL lanes; otherwise only that channel_no.
    channel_no    VARCHAR(32),
    -- NULL = permanent; past = expired (kept visible in the CP, no longer matches).
    expires_at    TIMESTAMP,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_blacklist_plate_scope
    ON anprc_blacklist_plates (license_plate, COALESCE(channel_no, '*'));

-- ============================================
-- visits
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_visits (
    id                  BIGSERIAL PRIMARY KEY,
    license_plate       VARCHAR(32) NOT NULL,
    entry_channel_no    VARCHAR(32),
    exit_channel_no     VARCHAR(32),
    entry_inspection_id BIGINT,
    entry_at            TIMESTAMP,
    exit_at             TIMESTAMP,
    status              anprc_visit_status NOT NULL DEFAULT 'active',
    notes               VARCHAR(255),
    -- Orphan-exit manual confirmation: pending | allowed | denied
    -- (NULL on non-orphan rows). 'allowed' opened the exit barrier.
    orphan_review       VARCHAR(16),
    orphan_reviewed_by  VARCHAR(128),
    orphan_reviewed_at  TIMESTAMP,
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visits_orphan_review ON anprc_visits (orphan_review)
    WHERE orphan_review = 'pending';
CREATE INDEX IF NOT EXISTS idx_visits_plate         ON anprc_visits (license_plate);
CREATE INDEX IF NOT EXISTS idx_visits_status        ON anprc_visits (status);
CREATE INDEX IF NOT EXISTS idx_visits_entry_at      ON anprc_visits (entry_at);
CREATE INDEX IF NOT EXISTS idx_visits_exit_at       ON anprc_visits (exit_at);
CREATE INDEX IF NOT EXISTS idx_visits_active_plate  ON anprc_visits (license_plate, status);

-- ============================================
-- mqtt_outbound_queue
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_mqtt_outbound_queue (
    id           BIGSERIAL PRIMARY KEY,
    device_sn    VARCHAR(64) NOT NULL,
    command_name VARCHAR(64) NOT NULL,
    payload      JSONB NOT NULL,
    status       anprc_mqtt_queue_status NOT NULL DEFAULT 'pending',
    attempts     INT NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    sent_at      TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mq_status_id ON anprc_mqtt_outbound_queue (status, id);
CREATE INDEX IF NOT EXISTS idx_mq_device    ON anprc_mqtt_outbound_queue (device_sn);

-- ============================================
-- mqtt_inbound_log — every MQTT message received from devices
-- ============================================
CREATE TABLE IF NOT EXISTS anprc_mqtt_inbound_log (
    id            BIGSERIAL PRIMARY KEY,
    device_sn     VARCHAR(64) NOT NULL,
    topic         VARCHAR(255) NOT NULL,
    message_name  VARCHAR(64) NOT NULL,
    license_plate VARCHAR(32),
    payload       JSONB,
    received_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mqtt_in_sn       ON anprc_mqtt_inbound_log (device_sn);
CREATE INDEX IF NOT EXISTS idx_mqtt_in_name     ON anprc_mqtt_inbound_log (message_name);
CREATE INDEX IF NOT EXISTS idx_mqtt_in_received ON anprc_mqtt_inbound_log (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_in_sn_recv  ON anprc_mqtt_inbound_log (device_sn, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_in_plate    ON anprc_mqtt_inbound_log (license_plate) WHERE license_plate IS NOT NULL;

-- ============================================
-- Triggers to maintain updated_at
-- ============================================
CREATE OR REPLACE FUNCTION anprc_trg_set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS channels_updated     ON anprc_channels;
CREATE TRIGGER channels_updated     BEFORE UPDATE ON anprc_channels     FOR EACH ROW EXECUTE FUNCTION anprc_trg_set_updated_at();
DROP TRIGGER IF EXISTS inspections_updated  ON anprc_inspections;
CREATE TRIGGER inspections_updated  BEFORE UPDATE ON anprc_inspections  FOR EACH ROW EXECUTE FUNCTION anprc_trg_set_updated_at();
DROP TRIGGER IF EXISTS visits_updated       ON anprc_visits;
CREATE TRIGGER visits_updated       BEFORE UPDATE ON anprc_visits       FOR EACH ROW EXECUTE FUNCTION anprc_trg_set_updated_at();
DROP TRIGGER IF EXISTS settings_updated     ON anprc_settings;
CREATE TRIGGER settings_updated     BEFORE UPDATE ON anprc_settings     FOR EACH ROW EXECUTE FUNCTION anprc_trg_set_updated_at();

-- ============================================
-- Seed
-- ============================================
INSERT INTO anprc_users (username, password_hash, display_name, role)
VALUES ('admin', '$2y$10$cnD5gSCPfu9i7qRvTU2cm.9NN4QN7oeaAziAI5veiAPuUlg97sHO2', 'Administrator', 'admin')
ON CONFLICT (username) DO NOTHING;

INSERT INTO anprc_settings (key_name, value) VALUES
    ('platform_name', 'ANPR + S300 Integrated Platform'),
    ('default_s300_base_url', 'http://192.168.1.50:8080'),
    ('mqtt_broker_url', 'ws://localhost:8083/mqtt'),
    ('uvis_image_dir', 'uploads/uvis'),
    ('vip_plates', ''),
    ('auto_start_s300', '0'),
    ('auto_start_channel', 'RJ001'),
    -- Blacklist alert on the entry camera (voice + LED) when a denied plate is seen.
    ('blacklist_voice_enabled', '1'),
    ('blacklist_voice_text', 'Blacklisted Vehicle. Go To X-RAY'),
    ('blacklist_led_enabled', '1'),
    ('blacklist_led_text', 'BLACKLIST'),
    -- Whitelist-only lane denial texts (voice/LED on-switches shared with blacklist).
    ('whitelist_deny_voice_text', 'Unregistered Vehicle. Go To X-RAY'),
    ('whitelist_deny_led_text', 'NOT REGISTERED'),
    -- WAV file URL the S300 downloads for the FAIL back-up prompt (audio-prompt).
    -- Empty = no file registered; set to a reachable http URL of a mono WAV.
    ('s300_audio_failure_url', ''),
    -- Text the videotron (future integration) shows a FAIL/SUSPECT vehicle that
    -- is routed forward to the x-ray instead of being turned back.
    ('videotron_xray_text', 'GO TO X-RAY'),
    -- X-ray receipt (protocol §2.2.4): channel used in POST /x-ray/{channelNo},
    -- vendor base URL (''=fall back to default_s300_base_url), and whether a
    -- normal (no-anomaly) scan is auto-receipted with Result:true.
    ('xray_channel_no', 'XRAY01'),
    ('xray_base_url', ''),
    ('xray_auto_receipt', '1'),
    -- Window (seconds) for linking a scan to a recent inspection AND for
    -- inspection-free re-entry at the main lane after a PASSED scan.
    ('xray_clearance_window_s', '3600'),
    -- Direct S300 /leave after a decision. ON: the real device needs it to reset
    -- and to emit the recorded video (vendor vehicleLeave → forwardVideoRecord).
    ('s300_auto_leave_enabled', '1'),
    -- /leave fires face_leave_delay_s after the FIRST face image (the scan is
    -- producing output). blocker_open_delay_s is the FALLBACK when no face image
    -- ever arrives (counted from the UVIS verdict).
    ('face_leave_delay_s', '3'),
    ('blocker_open_delay_s', '60'),
    -- Extra gap between that /leave and lowering the blocker, so the S300 can
    -- reset itself before the barrier moves. Applied by the cron sweep.
    ('blocker_reset_interval_s', '7'),
    ('blocker_auto_close_sec', '8'),
    -- Road-blocker close ownership: 'hardware' (controller raises itself via its
    -- loop detector — safe default) or 'backend_timer' (legacy software-timed
    -- raise; crush risk, only for controllers with no self-close).
    ('blocker_close_mode', 'hardware'),
    -- CORX CX-5104E-L relay (MQTT). Per-channel pulse commands published by the
    -- worker; value 210001 = vendor "pulse", res = <=15-char equipment id.
    -- auto_open OFF = inspection flow never touches the blocker (collision risk).
    ('blocker_relay_enabled',     '1'),
    ('blocker_relay_topic',       'testsubscribe'),
    ('blocker_relay_value',       '210001'),
    ('blocker_relay_res',         '123'),
    ('blocker_relay_open_ch',     'A01'),
    ('blocker_relay_close_ch',    'A02'),
    ('blocker_relay_stop_ch',     'A03'),
    ('blocker_auto_open_enabled', '0')
ON CONFLICT (key_name) DO NOTHING;

INSERT INTO anprc_channels (channel_no, s300_base_url, name, enabled, kind)
VALUES ('RJ001', 'http://192.168.1.50:8080', 'Main Gate Lane 1', 1, 'entry')
ON CONFLICT (channel_no) DO NOTHING;

COMMIT;
