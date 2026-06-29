-- Drop the legacy per-channel Qigong road-blocker columns. The blocker is now a
-- single CORX relay driven over MQTT (config in anprc_settings, see
-- 2026-06-29_corx_blocker_relay.sql); these columns are dead.
BEGIN;

ALTER TABLE anprc_channels DROP COLUMN IF EXISTS rb_ip;
ALTER TABLE anprc_channels DROP COLUMN IF EXISTS rb_port;
ALTER TABLE anprc_channels DROP COLUMN IF EXISTS rb_device_no;
ALTER TABLE anprc_channels DROP COLUMN IF EXISTS rb_board_id;
ALTER TABLE anprc_channels DROP COLUMN IF EXISTS rb_column_num;

COMMIT;
