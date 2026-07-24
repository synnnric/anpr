-- X-ray review + receipt flow (protocol §2.2.4 X-check receipt).
-- Idempotent and additive — safe to re-run, safe on the shared prod DB.
--
-- review_status: pending (awaiting operator) | auto (auto-passed, no anomaly)
--                | passed | denied
-- receipt_*    : outcome of POST {vendor}/x-ray/{channelNo}

ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS review_status   VARCHAR(16) NOT NULL DEFAULT 'pending';
ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS reviewed_by     VARCHAR(128);
ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS reviewed_at     TIMESTAMP;
ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS review_note     VARCHAR(512);
ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS receipt_result  SMALLINT;
ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS receipt_status  VARCHAR(16);
ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS receipt_error   VARCHAR(512);
ALTER TABLE anprc_inspection_xray ADD COLUMN IF NOT EXISTS receipt_sent_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_xray_review ON anprc_inspection_xray (review_status);

INSERT INTO anprc_settings (key_name, value) VALUES
    ('xray_channel_no', 'XRAY01'),
    ('xray_base_url', ''),
    ('xray_auto_receipt', '1')
ON CONFLICT (key_name) DO NOTHING;

-- Per-lane security mode (x-ray routing policy):
--   red    = every vehicle is routed to x-ray after inspection
--   orange = security_random_pct % of clean vehicles are randomly routed
--            (not-clean always routes, as in green)
--   green  = route by inspection result only (fail/suspect)
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS security_mode       VARCHAR(8) NOT NULL DEFAULT 'green';
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS security_random_pct SMALLINT NOT NULL DEFAULT 20;

-- Why an inspection was routed to x-ray (NULL = not routed):
-- inspection | security_red | security_random | manual | blacklist
ALTER TABLE anprc_inspections ADD COLUMN IF NOT EXISTS xray_route VARCHAR(16);

-- Blacklist flow no longer denies — the voice now directs the vehicle to the
-- x-ray. Only replaces the untouched old default (customized values are kept).
UPDATE anprc_settings SET value = 'Blacklisted Vehicle. Go To X-RAY'
 WHERE key_name = 'blacklist_voice_text'
   AND value = 'Blacklisted vehicle. Access denied.';
