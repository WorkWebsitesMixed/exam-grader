-- 005_subject.sql -- subject name printed next to the teacher in the exam header.
--
-- Apply ONCE to the live database BEFORE deploying the Worker that reads it:
--   npx wrangler d1 execute examgrader --remote --file=migrations/005_subject.sql
-- Running it twice fails with "duplicate column name", which is harmless.

ALTER TABLE exams ADD COLUMN subject TEXT NOT NULL DEFAULT 'Design & Technology';
