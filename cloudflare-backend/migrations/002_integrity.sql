-- 002_integrity.sql -- adds the integrity log and the similarity report.
--
-- Apply ONCE to a database created from the first schema.sql:
--   npx wrangler d1 execute examgrader --remote --file=migrations/002_integrity.sql
-- (Fresh databases created from the current schema.sql already have these.)
-- SQLite cannot "ADD COLUMN IF NOT EXISTS"; running this twice fails with
-- "duplicate column name", which is harmless: nothing is changed.

ALTER TABLE attempts ADD COLUMN events TEXT NOT NULL DEFAULT '[]';
ALTER TABLE attempts ADD COLUMN faults INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN warnings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN away_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN paste_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN paste_chars INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS similarity_reports (
  exam_id     TEXT PRIMARY KEY REFERENCES exams(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','error')),
  computed_at INTEGER,
  output      TEXT,
  error       TEXT
);
