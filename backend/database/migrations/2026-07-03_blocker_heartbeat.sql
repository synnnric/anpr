-- Road-blocker heartbeat monitoring. The CORX relay publishes a status/heartbeat
-- to its publish topic every ~10s; the worker persistently subscribes and pings
-- the backend, which stamps blocker_last_seen. The dashboard marks the blocker
-- online only when a heartbeat arrived recently (~30s) — a real liveness signal,
-- not just the enabled flag. Additive, idempotent.
BEGIN;
ALTER TABLE anprc_channels ADD COLUMN IF NOT EXISTS blocker_last_seen TIMESTAMP;
COMMIT;
