-- /leave now fires face_leave_delay_s (default 3s) after the FIRST face image,
-- instead of always waiting blocker_open_delay_s from the verdict. The vendor
-- streams face images during the scan (before /leave) and the recorded video
-- only after /leave, so the first face is a reliable "scan producing output"
-- cue. blocker_open_delay_s stays as the FALLBACK for when no face image comes.
-- Additive, idempotent.

INSERT INTO anprc_settings (key_name, value) VALUES ('face_leave_delay_s', '3')
ON CONFLICT (key_name) DO NOTHING;
