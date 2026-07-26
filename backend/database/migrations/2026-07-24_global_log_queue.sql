-- Global logging queue (idempotent, additive).
-- The backend enqueues one row per push; the worker drains it and POSTs to the
-- partner receiver (gateCarEntry). event_id is the idempotency key the receiver
-- upserts on; two phases per entry: 'initial' (x-ray null) then 'followup'
-- (x-ray filled). A UNIQUE(event_id, phase) makes enqueue safe to retry.

CREATE TABLE IF NOT EXISTS anprc_global_log_queue (
    id           BIGSERIAL PRIMARY KEY,
    event_id     VARCHAR(96) NOT NULL,
    phase        VARCHAR(16) NOT NULL,          -- initial | followup
    payload      JSONB NOT NULL,
    status       VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | sent | failed
    attempts     INT NOT NULL DEFAULT 0,
    last_error   VARCHAR(512),
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    sent_at      TIMESTAMP,
    UNIQUE (event_id, phase)
);
CREATE INDEX IF NOT EXISTS idx_glog_pending ON anprc_global_log_queue (id)
    WHERE status = 'pending';

INSERT INTO anprc_settings (key_name, value) VALUES
    ('global_log_enabled', '0'),                                  -- turn on after deploy + endpoint confirmed
    ('global_log_url', 'http://10.10.33.143:5002/gateCarEntry'),
    ('public_base_url', '')                                       -- e.g. https://anprc-sigap.dpr.go.id ; '' = relative paths
ON CONFLICT (key_name) DO NOTHING;
