-- Flow change: FAIL/SUSPECT vehicles are no longer turned back (queue gridlock) —
-- they proceed through the S300 lane to the X-RAY for secondary inspection.
-- Seed the videotron display text used at that routing point (future integration).
-- Idempotent, additive only.

INSERT INTO anprc_settings (key_name, value)
VALUES ('videotron_xray_text', 'GO TO X-RAY')
ON CONFLICT (key_name) DO NOTHING;
