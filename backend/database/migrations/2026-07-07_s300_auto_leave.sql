-- Direct S300 /leave after a decision is now OFF by default: the real S300
-- device self-resets (work-status operatingState 1→0), and a direct /leave
-- desyncs it — on the vendor it fires vehicleLeave/releaseResult/vehicle-out,
-- asserting the car departed while it may still be physically present.
-- Set to '1' only for a device/simulator that genuinely needs /leave to reset.
-- Idempotent, additive.

INSERT INTO anprc_settings (key_name, value)
VALUES ('s300_auto_leave_enabled', '0')
ON CONFLICT (key_name) DO NOTHING;
