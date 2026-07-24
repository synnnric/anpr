-- Physical blocker position, confirmed by the relay ACK (not inferred).
-- The relay echoes our command on its publish topic within ~220ms; that ACK
-- tells us which channel pulsed, and per the hardware the column then reaches
-- and HOLDS that position (mid-travel/stuck cases are out of scope):
--   lower (open_ch) ACK -> 'down'   raise (close_ch) ACK -> 'up'
-- 'unknown' until the first confirmed command; a 'stop' leaves it unknown.
-- Idempotent, additive.

ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_position VARCHAR(8) NOT NULL DEFAULT 'unknown';
