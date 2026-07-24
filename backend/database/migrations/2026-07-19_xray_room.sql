-- X-ray room loop (idempotent, additive).
-- New channel kind 'xray': the room's own ANPR camera — any recognized plate
-- opens the room's ENTRY gate (the room's EXIT gate is vendor-driven by the
-- x-ray receipt). xray_clearance_window_s (CP-adjustable, default 60 min) is
-- used both to link an inbound scan to a recent inspection and to allow
-- inspection-free re-entry at the main lane after a PASSED scan.

ALTER TYPE anprc_channel_kind ADD VALUE IF NOT EXISTS 'xray';

INSERT INTO anprc_settings (key_name, value) VALUES
    ('xray_clearance_window_s', '3600')
ON CONFLICT (key_name) DO NOTHING;
