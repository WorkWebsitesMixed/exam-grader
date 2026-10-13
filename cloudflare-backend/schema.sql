-- schema.sql -- D1 (SQLite) schema for the exam-grader backend on Cloudflare.
--
-- STATUS: DESIGN PROPOSAL for review (2026-10-10). Not applied to any database.
-- It replaces the Google Sheets used by Code.gs (Config, Questions, Submissions,
-- Detailed_Answers). See API.md for the endpoints that read and write it.
--
-- Design rules that shape this file:
--   * D1 free plan: 100,000 rows written/day, 5 M rows read/day, 500 MB/database,
--     50 queries per Worker invocation. Every index adds one written row per
--     insert (pricing page), so indexes are kept to the ones a query needs.
--   * One attempt row holds the whole exam session (paper, answers, results) as
--     JSON columns, so a submission is a handful of writes, not 30+ rows.
--   * The server is the authority: the paper an attempt was served is stored in
--     the attempt and grading runs against THAT list, never against whatever
--     the client sends (fixes the "omit hard questions" hole in Code.gs).
--   * Timestamps are INTEGER milliseconds since epoch, server clock.

PRAGMA foreign_keys = ON;  -- enforcement in D1 not verified; app code also checks

-- ---------------------------------------------------------------------------
-- exams: one row per exam. Replaces the Config sheet's key/value rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exams (
  id               TEXT PRIMARY KEY,                 -- e.g. '0445_Paper4' (old Config.exam_id)
  title            TEXT NOT NULL,
  subtitle         TEXT NOT NULL DEFAULT '',
  active           INTEGER NOT NULL DEFAULT 0,       -- 1 = students may start it
  is_default       INTEGER NOT NULL DEFAULT 0,       -- 1 = served when a link has no &exam=
  duration_min     INTEGER NOT NULL DEFAULT 60,
  exam_type        TEXT NOT NULL DEFAULT 'igcse'
                   CHECK (exam_type IN ('igcse', 'standard')),
  set_mode         TEXT NOT NULL DEFAULT 'single'
                   CHECK (set_mode IN ('single', 'triple')),
  class_options    TEXT NOT NULL DEFAULT '[]',       -- JSON array, e.g. ["10A","10B"]
  -- Sampling options. questions_per_set and randomize are INDEPENDENT (never
  -- couple them with AND). All three are ignored when exam_type = 'igcse'.
  questions_per_set INTEGER NOT NULL DEFAULT 0,      -- 0 = all questions
  oe_per_set        INTEGER NOT NULL DEFAULT 0,      -- 0 = no guarantee
  randomize         INTEGER NOT NULL DEFAULT 0,
  -- {"A":[{"grade":"2.3","min":85},...],"B":[...],"C":[...]}  (same meaning as
  -- grade_boundaries_A/B/C in the old Config sheet)
  grade_boundaries  TEXT NOT NULL DEFAULT '{}',
  -- {"A":{"label":"...","max_grade":"2.3","description":"..."},"B":{...},"C":{...}}
  set_cards         TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- questions: replaces the 14-column Questions sheet.
-- Fields marked SECRET are never sent to students (correct_index, rubric,
-- accepted_answers); only the admin endpoints return them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id          TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  set_id           TEXT NOT NULL CHECK (set_id IN ('A', 'B', 'C')),
  qid              TEXT NOT NULL,                    -- teacher-visible id, e.g. 'A_6' or 'Q3b'
  position         INTEGER NOT NULL,                 -- fixed order in IGCSE mode
  section          TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL CHECK (type IN ('mc', 'short', 'openEnded')),
  points           INTEGER NOT NULL,
  text             TEXT NOT NULL,
  options          TEXT,                             -- JSON array of 4 strings, mc only
  -- SECRET. 0-BASED index into `options` (0=A ... 3=D). The old sheet was
  -- 1-BASED and that burned the project twice; the import converts (n - 1)
  -- and the CHECK makes a stray 1-based 4 impossible.
  correct_index    INTEGER CHECK (correct_index BETWEEN 0 AND 3),
  rubric           TEXT NOT NULL DEFAULT '',         -- SECRET. openEnded marking rubric
  accepted_answers TEXT,                             -- SECRET. JSON array, short only.
                                                     -- (Code.gs overloaded the Rubric column)
  image_hash       TEXT REFERENCES images(hash),
  UNIQUE (exam_id, set_id, qid)                      -- also serves lookups by exam
);

-- ---------------------------------------------------------------------------
-- images: metadata for figures stored in the R2 bucket (key 'img/<hash>').
-- The hash is the SHA-256 of the file bytes, so the URL /img/<hash> never
-- changes content and can be cached for a year. Replaces Drive thumbnails.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS images (
  hash          TEXT PRIMARY KEY,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  uploaded_by   TEXT NOT NULL,                       -- teacher email
  created_at    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- teachers: allowlist for the admin panel (Google sign-in).
-- Initial rows (seeded by a one-off command, not by the API):
--   andres.forero@marymount.edu.co   role admin, retake_exempt 1
--   felipe.velasquez@marymount.edu.co role teacher
-- retake_exempt replaces the RETAKE_EXEMPT_EMAILS script property; it is
-- honoured only for a verified Google identity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teachers (
  email         TEXT PRIMARY KEY,                    -- lower-cased
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('admin', 'teacher')),
  retake_exempt INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- attempts: one row per student per exam+set. Replaces Submissions AND
-- Detailed_Answers. Created at /start (not at submit), so a reload resumes it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attempts (
  id            TEXT PRIMARY KEY,                    -- random UUID; the student's bearer for save/submit
  exam_id       TEXT NOT NULL REFERENCES exams(id),
  set_id        TEXT NOT NULL,
  email         TEXT NOT NULL,                       -- from the VERIFIED Google token, never from the client
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  class         TEXT NOT NULL DEFAULT '',
  started_at    INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,                    -- started_at + duration; enforced server-side
  -- What this student was served: {"qids":["A_1",...],"optionOrder":{"A_6":[2,0,3,1]}}.
  -- Grading iterates over THIS list; a question the client omits scores 0.
  paper         TEXT NOT NULL,
  -- Autosaved and final answers: {"A_6":2,"A_1":"free text",...}. For mc the
  -- value is the index in the PRINTED option order (not the shuffled position).
  answers       TEXT NOT NULL DEFAULT '{}',
  answers_saved_at INTEGER,
  status        TEXT NOT NULL DEFAULT 'started'
                CHECK (status IN ('started','submitted','grading','graded','error')),
  submitted_at  INTEGER,
  tab_switches  INTEGER NOT NULL DEFAULT 0,          -- clamped 0..10 by the server
  penalty       INTEGER NOT NULL DEFAULT 0,          -- clamped 0..4 by the server
  -- Per question: {"A_6":{"type":"mc","score":2,"max":2,"correct":true,
  --                       "selected":"...","correctText":"..."},
  --                "A_1":{"type":"openEnded","score":3,"max":6,"feedback":"..."}}
  results       TEXT,
  overrides     TEXT NOT NULL DEFAULT '{}',          -- {"A_1":4} teacher score overrides by qid
  mc_score      INTEGER,
  open_score    INTEGER,
  max_score     INTEGER,                             -- sum of points over `paper`, not the client's list
  total_score   INTEGER,                             -- after penalty and overrides
  percentage    INTEGER,
  final_grade   TEXT,
  graded_at     INTEGER,
  grading_error TEXT,
  email_status  TEXT NOT NULL DEFAULT 'none'
                CHECK (email_status IN ('none','pending','sent','failed')),
  -- Integrity log (src/integrity.js). `events` is the evidence the browser
  -- reported (left tab, lost focus, right click, copy, paste...). The numeric
  -- columns are derived from it on every save so lists need not parse JSON.
  events        TEXT NOT NULL DEFAULT '[]',
  faults        INTEGER NOT NULL DEFAULT 0,          -- counted violations (3 = auto-submit)
  warnings      INTEGER NOT NULL DEFAULT 0,          -- first-time warnings (no penalty)
  away_ms       INTEGER NOT NULL DEFAULT 0,          -- total time away from the exam
  paste_events  INTEGER NOT NULL DEFAULT 0,
  paste_chars   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (exam_id, email, set_id)                    -- the one-attempt guard, atomic
);
-- Cron sweep: find expired 'started' attempts and stuck 'grading' ones.
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts (status, deadline_at);
-- results.html: all attempts of one student.
CREATE INDEX IF NOT EXISTS idx_attempts_email ON attempts (email);

-- ---------------------------------------------------------------------------
-- jobs: long admin tools that must not run inside one HTTP request
-- (PDF question extraction, rubric generation). The PDF goes to R2 under
-- 'tmp/<job id>.pdf'; a queue consumer calls Claude and writes `output`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('extractQuestions', 'generateRubrics')),
  exam_id    TEXT REFERENCES exams(id),
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','running','done','error')),
  input_key  TEXT,                                   -- R2 key of the uploaded PDF
  output     TEXT,                                   -- JSON result
  error      TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- similarity_reports: result of comparing the answers of one exam's students
-- (open-ended text overlap and shared wrong multiple-choice answers). Computed
-- in the queue consumer, never by a model, so it costs no tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS similarity_reports (
  exam_id     TEXT PRIMARY KEY REFERENCES exams(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','error')),
  computed_at INTEGER,
  output      TEXT,                                  -- JSON report
  error       TEXT
);
