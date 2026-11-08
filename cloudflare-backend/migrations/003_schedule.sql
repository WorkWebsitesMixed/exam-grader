-- 003_schedule.sql -- optional opening window per exam.
--
-- Apply ONCE to the live database BEFORE deploying the Worker that reads these columns:
--   npx wrangler d1 execute examgrader --remote --file=migrations/003_schedule.sql
-- (Fresh databases created from the current schema.sql already have them.)
-- Running it twice fails with "duplicate column name", which is harmless.

ALTER TABLE exams ADD COLUMN opens_at INTEGER;
ALTER TABLE exams ADD COLUMN closes_at INTEGER;
