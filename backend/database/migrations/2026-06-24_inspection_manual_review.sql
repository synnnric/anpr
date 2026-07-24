-- Manual approve/reject flow for SUSPECT inspections.
--
-- Previously a "suspect" verdict auto-opened the barrier (same side effects as a
-- pass). The new flow holds the vehicle at the lane and waits for an operator to
-- approve (open barrier) or reject (back-up prompt + deny). These columns track
-- that review and who performed it.
--
--   review_status : NULL normally · 'pending' while awaiting a human ·
--                   'approved' / 'rejected' once decided
--   reviewed_by   : username of the approver / rejecter (operation_log keeps the
--                   full audit row; this is the quick-reference on the inspection)
--   reviewed_at   : when the human decided (UTC)

ALTER TABLE inspections ADD COLUMN IF NOT EXISTS review_status VARCHAR(16);
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS reviewed_by   VARCHAR(64);
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_insp_review_status ON inspections (review_status);
