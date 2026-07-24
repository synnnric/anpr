-- Per-lane S300 inspection MODE — a 4-way dropdown that replaces the binary
-- behavior_uvis_s300 toggle in the UI. behavior_uvis_s300 is KEPT and auto-synced
-- (mode 'none' → 0, else → 1) so existing flow checks keep working.
--   none  = no UVIS/S300 cycle — auto-PASS immediately (== old behavior_uvis_s300=0)
--   skip  = Skip S300: complete as soon as the UVIS verdict arrives (still /leave
--           to reset the device, then blocker + complete in one shot)
--   timed = fixed countdown AFTER the UVIS verdict, then /leave (ignores face images)
--   full  = current face-driven /leave (fires after the last face image) [default]
-- s300_timed_seconds = the countdown (seconds, from the UVIS verdict) for 'timed'.
-- Additive, idempotent. Backfills mode from the existing toggle.

ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS s300_inspection_mode VARCHAR(10) NOT NULL DEFAULT 'full';
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS s300_timed_seconds   SMALLINT   NOT NULL DEFAULT 15;

-- One-time backfill: lanes with the old toggle OFF become 'none', the rest 'full'.
-- Guarded to rows still at the fresh default so re-running never clobbers a set mode.
UPDATE anprc_channels
   SET s300_inspection_mode = CASE WHEN behavior_uvis_s300 = 0 THEN 'none' ELSE 'full' END
 WHERE s300_inspection_mode = 'full';
