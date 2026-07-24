-- Remove the redundant behavior_road_blocker column. It gated whether the flow
-- lowers the road blocker — the SAME thing blocker_auto_open already governs
-- (and in the UI it was indistinguishable from the auto-open toggle). Consolidated
-- onto: blocker_relay_enabled (lane HAS a blocker) + blocker_auto_open (flow
-- auto-lowers on pass). Idempotent, safe (unused by the app after this change).

ALTER TABLE anprc_channels DROP COLUMN IF EXISTS behavior_road_blocker;
