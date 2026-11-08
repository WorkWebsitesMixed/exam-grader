-- 004_header.sql -- exam header fields (grade, term, teacher, directions, goals).
--
-- Apply ONCE to the live database BEFORE deploying the Worker that reads them:
--   npx wrangler d1 execute examgrader --remote --file=migrations/004_header.sql
-- (Fresh databases created from the current schema.sql already have them.)
-- Running it twice fails with "duplicate column name", which is harmless.

ALTER TABLE exams ADD COLUMN grade_level TEXT NOT NULL DEFAULT '';
ALTER TABLE exams ADD COLUMN term TEXT NOT NULL DEFAULT '';
ALTER TABLE exams ADD COLUMN term_year INTEGER;
ALTER TABLE exams ADD COLUMN teacher TEXT NOT NULL DEFAULT 'Andrés Forero';
ALTER TABLE exams ADD COLUMN directions TEXT NOT NULL DEFAULT '';
ALTER TABLE exams ADD COLUMN goals_override TEXT NOT NULL DEFAULT '';
