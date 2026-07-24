-- VIP / blacklist duration choice (idempotent, additive).
-- expires_at NULL = permanent; a past expires_at means the entry no longer
-- matches (isVip / isBlacklisted filter it out) but the row is kept visible
-- in the CP as "expired".

ALTER TABLE anprc_vip_plates       ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE anprc_blacklist_plates ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
