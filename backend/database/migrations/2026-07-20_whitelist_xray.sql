-- Whitelist-only lanes no longer deny — non-whitelisted vehicles enter and are
-- routed to the x-ray, so the voice prompt directs instead of refusing.
-- Only replaces the untouched old default (customized values are kept).
UPDATE anprc_settings SET value = 'Unregistered Vehicle. Go To X-RAY'
 WHERE key_name = 'whitelist_deny_voice_text'
   AND value = 'Vehicle not registered. Access denied.';
