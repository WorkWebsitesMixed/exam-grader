-- 008_deadline.sql -- per-student deadline extensions (audit phase P2, finding R7).
--
--   deadline_manual  1 when a teacher set this attempt's deadline by hand (extra
--                    minutes for one student). Changing the exam's closing time
--                    later must not undo it, so that update skips these rows.
--
-- Apply ONCE to the live database BEFORE deploying the Worker that reads it:
--   npx wrangler d1 execute examgrader --remote --file=migrations/008_deadline.sql
-- Additive only: the Worker that is live today ignores the column, so the
-- order "migration first, deploy second" is safe.
-- Running it twice fails with "duplicate column name", which is harmless.

ALTER TABLE attempts ADD COLUMN deadline_manual INTEGER NOT NULL DEFAULT 0;
