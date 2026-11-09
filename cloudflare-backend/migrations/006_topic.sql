-- 006_topic.sql -- optional topic tag per question (used by the Analysis tab).
--
-- Apply ONCE to the live database BEFORE deploying the Worker that reads it:
--   npx wrangler d1 execute examgrader --remote --file=migrations/006_topic.sql
-- Running it twice fails with "duplicate column name", which is harmless.

ALTER TABLE questions ADD COLUMN topic TEXT NOT NULL DEFAULT '';
