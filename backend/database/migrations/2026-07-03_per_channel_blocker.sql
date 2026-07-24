-- ============================================================================
-- Per-channel (multi-lane) road-blocker relay + sensor interlock scaffold
-- ============================================================================
-- Moves the CORX relay config from the single global blocker_relay_* settings
-- to per-channel columns, so each lane drives its own relay (own topic/res).
-- The global settings remain the FALLBACK when a channel leaves these NULL, so
-- the existing single-lane setup keeps working unchanged.
--
-- Also adds the sensor-interlock + blocker-cycle runtime state used by the
-- automatic-flow gating (see InspectionService::getChannelStatus):
--   blocker_sensor : 'clear' | 'passing'  — 'passing' suppresses relay commands
--   blocker_cycle  : 'idle' | 'lowered' | 'passed' | 'raised'  — when auto-open
--                    is ON, the channel stays busy until the cycle returns to idle
--
-- Idempotent + additive: safe on the shared DB.
BEGIN;

-- Per-lane relay config (NULL => fall back to global blocker_relay_* settings).
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_enabled  SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_topic    VARCHAR(64);   -- command (subscribe) topic
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_pub_topic VARCHAR(64);  -- device status (publish) topic, for ACK
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_res      VARCHAR(16);   -- device id echoed back (lane key)
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_value    INT;           -- pulse magic (default 210001)
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_open_ch  VARCHAR(8);
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_close_ch VARCHAR(8);
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_relay_stop_ch  VARCHAR(8);

-- Runtime interlock state (driven by the future vehicle sensor).
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_sensor VARCHAR(16) NOT NULL DEFAULT 'clear';
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_cycle  VARCHAR(16) NOT NULL DEFAULT 'idle';

COMMIT;
