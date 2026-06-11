-- Road-blocker close is now owned by the hardware controller by default.
-- The backend no longer sends a timed raise command — a lifting column rising
-- on a blind software timer is a crush hazard, and the controller's loop
-- detector is the correct place for that decision.
--
-- 'hardware'      (default) — backend issues no close command; controller self-closes.
-- 'backend_timer' (legacy)  — restore the old software-timed raise (crush risk).
BEGIN;

INSERT INTO settings (key_name, value) VALUES ('blocker_close_mode', 'hardware')
ON CONFLICT (key_name) DO NOTHING;

COMMIT;
