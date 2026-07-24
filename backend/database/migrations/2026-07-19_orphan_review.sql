-- Orphan-exit manual confirmation (idempotent, additive).
-- An exit recognition with no active visit no longer just logs a row — the CP
-- pops a confirmation and an operator decides whether to open the exit barrier.
-- orphan_review: pending | allowed | denied (NULL on non-orphan rows and on
-- legacy orphan rows from before this flow).

ALTER TABLE anprc_visits ADD COLUMN IF NOT EXISTS orphan_review      VARCHAR(16);
ALTER TABLE anprc_visits ADD COLUMN IF NOT EXISTS orphan_reviewed_by VARCHAR(128);
ALTER TABLE anprc_visits ADD COLUMN IF NOT EXISTS orphan_reviewed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_visits_orphan_review ON anprc_visits (orphan_review)
    WHERE orphan_review = 'pending';
