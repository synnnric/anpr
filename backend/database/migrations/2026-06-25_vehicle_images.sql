-- Store the vehicle snapshot images captured from ivs_result
-- (full_image_content = full scene, small_image_content = plate close-up).
-- Saved to files by ImageStorage; these columns hold the relative paths.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS full_image_path  VARCHAR(512);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS small_image_path VARCHAR(512);
