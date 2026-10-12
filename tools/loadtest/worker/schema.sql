-- schema.sql -- the single table used by the load-test Worker's /start endpoint.
--
-- It mimics the real "attempt" row of the planned design: one row per
-- (exam, student, set), created when the student starts. The UNIQUE constraint
-- is what will replace the racy "read the sheet, then append" duplicate guard
-- in Code.gs: the database itself refuses a second row, atomically.
--
-- Cost note (D1 pricing page): every index adds one extra "row written" per
-- insert, so each new attempt here counts as 2 rows written (table + the
-- UNIQUE index). /start returns meta.rows_written so we can confirm that.

CREATE TABLE IF NOT EXISTS attempts (
  id         TEXT PRIMARY KEY,          -- random id the student's browser keeps
  exam_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  set_id     TEXT NOT NULL,
  started_at INTEGER NOT NULL,          -- server clock, ms since epoch
  UNIQUE (exam_id, email, set_id)       -- one attempt per student per exam+set
);

-- lab_reports: one row per browser that ran labcheck.html with a &worker= URL.
-- Lets us run the check on all 26 lab PCs at once (e.g. opened through Veyon)
-- and read one summary instead of copy-pasting 26 reports. `run` is a free tag
-- (&run=lab1) that groups one burst. No IP address and no student data are
-- stored: only the user agent and the probe results.
CREATE TABLE IF NOT EXISTS lab_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         TEXT NOT NULL,
  received_at INTEGER NOT NULL,   -- server clock, ms since epoch
  user_agent  TEXT,
  results     TEXT NOT NULL       -- JSON array, one entry per probe
);
CREATE INDEX IF NOT EXISTS idx_lab_reports_run ON lab_reports (run);
