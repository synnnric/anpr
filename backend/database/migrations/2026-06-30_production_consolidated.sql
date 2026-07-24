-- ============================================================================
-- Production consolidated migration (2026-06-30)
-- ============================================================================
-- ONE idempotent, ADDITIVE migration to bring an existing database up to the
-- current feature set. Safe to run on a SHARED database:
--   * no DROP TABLE / DROP COLUMN — nothing the parent platform owns is touched
--   * every step guarded by IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT
--   * re-runnable — running it twice is a no-op
--
-- Rolls together (and supersedes) the recent per-feature migrations:
--   2026-06-25_blacklist_plates.sql
--   2026-06-25_vehicle_images.sql
--   2026-06-29_corx_blocker_relay.sql
-- The 2026-06-29_drop_channel_rb_cols.sql column-drop is INTENTIONALLY OMITTED:
-- no destructive DDL on a shared DB, and the current schema has no rb_* columns.
--
-- On a brand-new database, run schema.sql instead — it already contains all of
-- the below. This file is the safety net for a DB that predates these features.
-- ============================================================================
BEGIN;

-- 1. Vehicle snapshot image paths (from ivs_result full/small image content).
ALTER TABLE anprc_vehicles ADD COLUMN IF NOT EXISTS full_image_path  VARCHAR(512);
ALTER TABLE anprc_vehicles ADD COLUMN IF NOT EXISTS small_image_path VARCHAR(512);

-- 2. ANPR-stage deny list: a matching plate is refused entry at /come (entry
--    gate stays shut, no S300 inspection). Checked before VIP, so it overrides VIP.
CREATE TABLE IF NOT EXISTS anprc_blacklist_plates (
    id            SERIAL PRIMARY KEY,
    license_plate VARCHAR(32) NOT NULL UNIQUE,
    description   VARCHAR(255),
    enabled       SMALLINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 3. CORX CX-5104E-L road-blocker relay config. The relay is an MQTT client on
--    the site broker; the worker publishes raw per-channel pulse commands:
--      OPEN  (blocker DOWN / clears lane) -> {"<open_ch>":  <value>, "res": "<id>"}
--      CLOSE (blocker UP   / blocks lane) -> {"<close_ch>": <value>, "res": "<id>"}
--      STOP  (halt motion)                -> {"<stop_ch>":  <value>, "res": "<id>"}
--    value 210001 = vendor "pulse" (momentary press); res = <=15-char equipment id.
--    blocker_auto_open_enabled is OFF: the inspection flow does NOT touch the
--    blocker (collision risk, no vehicle sensor). Edit all of these in the
--    Settings / Road Blocker page without a code change.
INSERT INTO anprc_settings (key_name, value) VALUES
  ('blocker_relay_enabled',     '1'),
  ('blocker_relay_topic',       'testsubscribe'),
  ('blocker_relay_value',       '210001'),
  ('blocker_relay_res',         '123'),
  ('blocker_relay_open_ch',     'A01'),
  ('blocker_relay_close_ch',    'A02'),
  ('blocker_relay_stop_ch',     'A03'),
  ('blocker_auto_open_enabled', '0')
ON CONFLICT (key_name) DO NOTHING;

-- 4. S300 FAIL back-up audio: WAV URL the device downloads (audio-prompt cmd 335).
--    Empty by default; configurable in the S300 Settings UI.
INSERT INTO anprc_settings (key_name, value) VALUES
  ('s300_audio_failure_url', '')
ON CONFLICT (key_name) DO NOTHING;

COMMIT;
