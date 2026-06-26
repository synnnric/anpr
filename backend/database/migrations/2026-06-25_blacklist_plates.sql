-- ANPR-stage deny list. A matching plate is refused entry at /come (entry gate
-- stays shut, no S300 inspection started). Checked before the VIP bypass, so it
-- overrides VIP. Mirrors vip_plates.
CREATE TABLE IF NOT EXISTS blacklist_plates (
    id            SERIAL PRIMARY KEY,
    license_plate VARCHAR(32) NOT NULL UNIQUE,
    description   VARCHAR(255),
    enabled       SMALLINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
