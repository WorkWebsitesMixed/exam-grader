-- 007_grading.sql -- grading bookkeeping on attempts (audit phase P1).
--
--   grade_attempts      grading tries so far; grading stops as 'error' after 5
--   grading_started_at  when the current grading run claimed the row (ms)
--   tokens_in/out       model tokens this attempt has cost, all tries added up
--   needs_review        questions the model could not grade, waiting for the teacher
--
-- Apply ONCE to the live database BEFORE deploying the Worker that reads it:
--   npx wrangler d1 execute examgrader --remote --file=migrations/007_grading.sql
-- Additive only: the Worker that is live today ignores these columns, so the
-- order "migration first, deploy second" is safe.
-- Running it twice fails with "duplicate column name", which is harmless.

ALTER TABLE attempts ADD COLUMN grade_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN grading_started_at INTEGER;
ALTER TABLE attempts ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
