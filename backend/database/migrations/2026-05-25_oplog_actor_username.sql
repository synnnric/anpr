-- Rename operation_log.user_id (INT) to actor_username (VARCHAR(64)).
-- The local users table is now a shadow of the parent platform's SSO identities,
-- so the friendlier audit-log shape is the username itself, not an internal id.

BEGIN;

ALTER TABLE operation_log ADD COLUMN IF NOT EXISTS actor_username VARCHAR(64);

UPDATE operation_log ol
   SET actor_username = u.username
  FROM users u
 WHERE ol.user_id = u.id
   AND ol.actor_username IS NULL;

DROP INDEX IF EXISTS idx_oplog_user;
ALTER TABLE operation_log DROP COLUMN IF EXISTS user_id;
CREATE INDEX IF NOT EXISTS idx_oplog_actor ON operation_log (actor_username);

COMMIT;
