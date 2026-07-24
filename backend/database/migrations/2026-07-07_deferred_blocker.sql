-- Deferred road-blocker open: the real S300 keeps pushing face images and the
-- recorded video for ~90s AFTER the UVIS verdict. So we DON'T lower the blocker
-- (or complete the inspection) at the verdict — we stamp when it's due and a
-- cron sweep opens the blocker + completes the inspection then, giving the
-- artifacts time to arrive and link. Delay is configurable (default 40s).
-- Auto-/leave is re-enabled (the real device needs it to reset + emit the
-- recorded video); it fires at the verdict, the blocker opens after the delay.
-- Idempotent, additive.

ALTER TABLE anprc_inspections ADD COLUMN IF NOT EXISTS blocker_open_due_at TIMESTAMP;

INSERT INTO anprc_settings (key_name, value) VALUES ('blocker_open_delay_s', '60')
ON CONFLICT (key_name) DO NOTHING;

-- User chose "auto /leave after verdict" — turn it on (was seeded '0' earlier).
UPDATE anprc_settings SET value = '1' WHERE key_name = 's300_auto_leave_enabled';
