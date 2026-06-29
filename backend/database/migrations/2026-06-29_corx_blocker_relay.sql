-- CORX CX-5104E-L network relay replaces the (never-deployed) Qigong REST road
-- blocker. The relay is an MQTT client on the site broker; the worker publishes
-- raw per-channel pulse commands to its subscribe topic.
--
--   OPEN  (blocker DOWN / clears lane) -> {"<open_ch>":  <value>, "res": "<id>"}
--   CLOSE (blocker UP   / blocks lane) -> {"<close_ch>": <value>, "res": "<id>"}
--   STOP  (halt motion)                -> {"<stop_ch>":  <value>, "res": "<id>"}
--
-- value 210001 is the vendor "pulse" command (momentary press of the controller
-- button). res is a <=15-char equipment id the device echoes back. Edit these in
-- the Settings page / anprc_settings without code changes.
BEGIN;

-- blocker_auto_open_enabled: OFF by default — the inspection flow does NOT touch
-- the blocker (collision risk, no vehicle sensor). Set to '1' to re-enable
-- auto-open on a passed/suspect/VIP inspection.
INSERT INTO anprc_settings (key_name, value) VALUES
  ('blocker_relay_enabled',     '1'),
  ('blocker_relay_topic',       'testsubscribe'),
  ('blocker_relay_value',       '210001'),
  ('blocker_relay_res',         '123'),
  ('blocker_relay_open_ch',     'A01'),
  ('blocker_relay_close_ch',    'A02'),
  ('blocker_relay_stop_ch',     'A03'),
  ('blocker_auto_open_enabled', '0')
ON CONFLICT (key_name) DO NOTHING;

COMMIT;
