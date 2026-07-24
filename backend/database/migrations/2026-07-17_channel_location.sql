-- Channel location/zone for site mapping (e.g. "Gerbang Pancasila", "Gerbang 46").
-- Idempotent and additive — safe to re-run, safe on the shared prod DB.
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS location VARCHAR(64);
