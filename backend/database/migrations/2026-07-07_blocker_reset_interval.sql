-- Gap between the S300 /leave (device reset) and lowering the road blocker, so
-- the device has time to reset itself before the barrier moves. Applied as a
-- second phase in the cron deferred-close sweep. Default 7s. Additive.

INSERT INTO anprc_settings (key_name, value) VALUES ('blocker_reset_interval_s', '7')
ON CONFLICT (key_name) DO NOTHING;
