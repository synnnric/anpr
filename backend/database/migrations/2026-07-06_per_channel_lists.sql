-- Per-channel VIP whitelist / blacklist:
--   * Each plate row can be scoped to ONE channel (channel_no) or apply to ALL
--     channels (channel_no NULL). The same plate may exist in several scopes.
--   * Each lane chooses which lists it ENFORCES via behaviour switches:
--     behavior_vip (VIP bypass) and behavior_blacklist (blacklist deny),
--     joining behavior_uvis_s300 / behavior_road_blocker. Default 1 = enforced.
--     e.g. lane 1 whitelist-only (behavior_blacklist=0), lane 2 both.
-- Also: entry/exit lanes are NOT paired anymore (enter any lane, exit any lane);
-- anprc_channels.paired_channel_id remains but is unused.
-- Idempotent; the only non-additive step swaps the plate UNIQUE constraint for a
-- scope-aware unique index (required so one plate can exist in two scopes).

ALTER TABLE anprc_vip_plates       ADD COLUMN IF NOT EXISTS channel_no VARCHAR(32);
ALTER TABLE anprc_blacklist_plates ADD COLUMN IF NOT EXISTS channel_no VARCHAR(32);

-- Replace UNIQUE(license_plate) with UNIQUE(license_plate, scope). The original
-- constraint name predates the anprc_ rename, so look it up instead of guessing.
DO $$
DECLARE c text;
BEGIN
    SELECT conname INTO c FROM pg_constraint
     WHERE conrelid = 'anprc_vip_plates'::regclass AND contype = 'u';
    IF c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE anprc_vip_plates DROP CONSTRAINT %I', c);
    END IF;
    SELECT conname INTO c FROM pg_constraint
     WHERE conrelid = 'anprc_blacklist_plates'::regclass AND contype = 'u';
    IF c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE anprc_blacklist_plates DROP CONSTRAINT %I', c);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vip_plate_scope
    ON anprc_vip_plates (license_plate, COALESCE(channel_no, '*'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_blacklist_plate_scope
    ON anprc_blacklist_plates (license_plate, COALESCE(channel_no, '*'));

ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS behavior_vip       SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS behavior_blacklist SMALLINT NOT NULL DEFAULT 1;

-- Whitelist-only lane: when 1, ONLY plates on the whitelist (VIP list, scoped to
-- this lane or all lanes) are admitted — everything else is denied at the ANPR
-- stage like a blacklist hit. Default 0 (lane admits everyone not blacklisted).
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS behavior_whitelist_only SMALLINT NOT NULL DEFAULT 0;

-- Voice/LED text announced on a whitelist-only denial (the blacklist voice/LED
-- enabled flags are reused as the on/off switches for deny announcements).
INSERT INTO anprc_settings (key_name, value) VALUES
    ('whitelist_deny_voice_text', 'Vehicle not registered. Access denied.'),
    ('whitelist_deny_led_text', 'NOT REGISTERED')
ON CONFLICT (key_name) DO NOTHING;
