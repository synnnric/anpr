-- Namespace every ANPR object with an `anprc_` prefix so the platform can share
-- a single PostgreSQL database with another platform without name collisions.
--
-- Renames TABLES, ENUM TYPES, and the updated_at trigger FUNCTION. Columns are
-- intentionally NOT renamed (they are scoped to their table, so they can never
-- collide with another platform's columns — and leaving them keeps the REST/JSON
-- field names, and therefore the whole frontend, unchanged).
--
-- Dependent objects (sequences, indexes, triggers, PK/UNIQUE constraints) keep
-- their original names; PostgreSQL binds them by OID, so they keep working after
-- the table rename. A FRESH install via schema.sql gets fully anprc_-derived
-- sequence/PK names automatically.
--
-- Idempotent: safe to run if some or all objects are already renamed.
-- Apply to an EXISTING (unprefixed) database. A new database should just load
-- schema.sql, which is already prefixed.

BEGIN;

-- ---- Tables (IF EXISTS skips anything already renamed) ----
ALTER TABLE IF EXISTS channels                  RENAME TO anprc_channels;
ALTER TABLE IF EXISTS vehicles                  RENAME TO anprc_vehicles;
ALTER TABLE IF EXISTS inspections               RENAME TO anprc_inspections;
ALTER TABLE IF EXISTS inspection_status_logs    RENAME TO anprc_inspection_status_logs;
ALTER TABLE IF EXISTS inspection_face_images    RENAME TO anprc_inspection_face_images;
ALTER TABLE IF EXISTS inspection_video_streams  RENAME TO anprc_inspection_video_streams;
ALTER TABLE IF EXISTS inspection_uvis           RENAME TO anprc_inspection_uvis;
ALTER TABLE IF EXISTS inspection_uvis_coords    RENAME TO anprc_inspection_uvis_coords;
ALTER TABLE IF EXISTS audio_prompts             RENAME TO anprc_audio_prompts;
ALTER TABLE IF EXISTS users                     RENAME TO anprc_users;
ALTER TABLE IF EXISTS operation_log             RENAME TO anprc_operation_log;
ALTER TABLE IF EXISTS settings                  RENAME TO anprc_settings;
ALTER TABLE IF EXISTS inbound_events_raw        RENAME TO anprc_inbound_events_raw;
ALTER TABLE IF EXISTS vip_plates                RENAME TO anprc_vip_plates;
ALTER TABLE IF EXISTS blacklist_plates          RENAME TO anprc_blacklist_plates;
ALTER TABLE IF EXISTS visits                    RENAME TO anprc_visits;
ALTER TABLE IF EXISTS mqtt_outbound_queue       RENAME TO anprc_mqtt_outbound_queue;
ALTER TABLE IF EXISTS mqtt_inbound_log          RENAME TO anprc_mqtt_inbound_log;

-- ---- ENUM types (no IF EXISTS for ALTER TYPE; swallow "doesn't exist") ----
DO $$ BEGIN ALTER TYPE inspection_state    RENAME TO anprc_inspection_state;    EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE inspection_decision RENAME TO anprc_inspection_decision; EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE channel_kind        RENAME TO anprc_channel_kind;        EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE visit_status        RENAME TO anprc_visit_status;        EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE user_role           RENAME TO anprc_user_role;           EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE op_status           RENAME TO anprc_op_status;           EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE mqtt_queue_status   RENAME TO anprc_mqtt_queue_status;   EXCEPTION WHEN undefined_object THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- ---- updated_at trigger function (triggers reference it by OID, keep working) ----
DO $$ BEGIN
    ALTER FUNCTION trg_set_updated_at() RENAME TO anprc_trg_set_updated_at;
EXCEPTION WHEN undefined_function THEN NULL; WHEN undefined_object THEN NULL; WHEN duplicate_function THEN NULL; END $$;

COMMIT;
