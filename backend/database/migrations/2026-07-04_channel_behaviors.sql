-- Per-channel behaviour switches: each lane can enable/disable a stage of the
-- entry flow independently (multi-lane sites differ in installed hardware).
--   behavior_uvis_s300    1 = UVIS + S300 inspection cycle; 0 = auto-PASS the
--                             inspection immediately with note 'UVIS+S300 disabled'
--   behavior_road_blocker 1 = road blocker participates in the flow (auto-open on
--                             pass / route-to-xray); 0 = flow never commands it
-- ANPR deliberately has NO switch: recognition + barrier-open IS the entry lane.
-- All default to 1 (yes) — unchecking is the exception. Manual controls on the
-- Road Blocker page are NOT affected by these flags.
-- Idempotent, additive only.

ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS behavior_uvis_s300    SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS behavior_road_blocker SMALLINT NOT NULL DEFAULT 1;
