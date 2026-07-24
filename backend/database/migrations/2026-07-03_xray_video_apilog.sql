-- ============================================================================
-- Per-channel auto-open + X-ray inbound + real-time video stream kind
-- ============================================================================
-- Additive, idempotent, no drops.
BEGIN;

-- 1. Per-channel "auto-open on inspection pass" toggle (independent per lane).
--    NULL/0 = off; the global blocker_auto_open_enabled setting is the fallback.
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_auto_open SMALLINT NOT NULL DEFAULT 0;

-- 2. Distinguish real-time stream addresses (cmd 325, /video-real-time) from the
--    post-inspection recording files (3.7, /video-record) in the same table.
ALTER TABLE anprc_inspection_video_streams
    ADD COLUMN IF NOT EXISTS stream_kind VARCHAR(16) NOT NULL DEFAULT 'record';  -- 'record' | 'realtime'

-- 3. X-ray scan results (protocol 3.6). Images saved to files; metadata here.
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
    received_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_xray_inspection ON anprc_inspection_xray (inspection_id);
CREATE INDEX IF NOT EXISTS idx_xray_vehicle    ON anprc_inspection_xray (vehicle_number);
CREATE INDEX IF NOT EXISTS idx_xray_received   ON anprc_inspection_xray (received_at DESC);

COMMIT;
