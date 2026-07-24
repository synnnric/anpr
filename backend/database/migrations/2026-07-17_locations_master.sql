-- Master list of site locations/zones — feeds the channel form dropdown.
-- Channels reference locations BY NAME (anprc_channels.location varchar), so
-- deleting a master row never breaks existing channels.
-- Idempotent and additive — safe to re-run, safe on the shared prod DB.
CREATE TABLE IF NOT EXISTS anprc_locations (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO anprc_locations (name) VALUES
    ('Gerbang Pancasila'),
    ('Gerbang 46')
ON CONFLICT (name) DO NOTHING;
