# cloudflare-backend

Exam Grader backend on Cloudflare Workers + D1 + R2 + Queues. Design and
behaviour are specified in `API.md`; the database in `schema.sql`.
**Status: built and tested locally, NOT deployed.** Production (Apps Script)
is untouched.

## What is implemented (slice 1)

| Area | Where |
|---|---|
| Google token verification (RS256, `iss`/`aud`/`exp`/`hd`/domain), admin sessions | `src/auth.js` |
| Student flow: exam, start (create-or-resume), autosave, submit, held result, my results | `src/student.js` |
| Paper building (IGCSE fixed order, standard sampling/shuffle) | `src/paper.js` |
| Grading rules, totals, boundaries, penalty | `src/grading.js` |
| Claude client (retries, errors never become silent zeros) | `src/claude.js` |
| Queue consumer and once-a-minute sweep | `src/queue.js` |
| Admin: login, exams, questions (CRUD + bulk), attempts, overrides, delete/reset, recalculate, regrade MC, teachers | `src/admin.js` |
| Routing, CORS, error handling | `src/index.js`, `src/http.js` |
| Anti-cheating rules and evidence log (server-side) | `src/integrity.js` |
| Similarity between students' answers (no AI, no tokens) | `src/similarity.js` |
| Read the integrity + similarity report of an exam | `tools/integrity-report.mjs` |
| Import an exam from the old sheet (CSV -> reviewed SQL file) | `tools/import-sheet.mjs` |
| Student results page adapter (`../results.html`, same backend rule as `grader.html`) | `../results.html` |
| Student page adapter (`../grader.html`, new backend chosen by `?src=` host `*.workers.dev` or `&api=v3`) | `../grader.html` |

## Not implemented yet (next slices)

- Images: upload + `GET /img/<hash>` from R2.
- PDF jobs (extract questions, generate rubrics) as queue jobs.
- Results email relay (Apps Script `MailApp`) and `resend-emails`.
- Export endpoint (Sheets archive, Raspberry Pi backup) and distractor analysis.
- Frontend adapter for `admin.html` (`grader.html` and `results.html` are done).

## Importing an exam from the sheet

Export the `Questions` tab (and optionally `Config`) as CSV, then:

    cd cloudflare-backend
    node tools/import-sheet.mjs --questions Questions.csv --exam G11_B_T4 --sets B \
         --title "G11 Set B" --duration 60 --out import-G11_B_T4.sql
    npx wrangler d1 execute examgrader --remote --file=import-G11_B_T4.sql

The tool prints what it will import (questions and points per set), refuses a
0-based answer key, and checks the SQL against `schema.sql` in memory before
writing the file. The exam is imported CLOSED; add `--active` to open it and
`--default` to make it the exam served when a link has no `?exam=`.
Re-running updates questions in place. Drive images are NOT migrated yet: the
tool lists the questions that reference one.

## Tests

    npm install
    npm test        # 85 tests, no network, no Cloudflare account needed

The tests run the real handlers against real SQL (`node:sqlite`, loading
`schema.sql`) and verify real RS256 signatures from a fake Google. They cover
the security rules of `API.md` section 6.

## Deploying (you run these; nothing here is done yet)

    cd cloudflare-backend
    npx wrangler d1 create examgrader            # copy database_id into wrangler.toml
    npx wrangler d1 execute examgrader --remote --file=schema.sql
    npx wrangler r2 bucket create exam-files
    npx wrangler queues create examgrader-grading
    npx wrangler secret put ANTHROPIC_API_KEY
    npx wrangler secret put SESSION_SECRET       # any long random string
    npx wrangler d1 execute examgrader --remote --command \
      "INSERT INTO teachers (email,name,role,retake_exempt,added_at) VALUES
       ('andres.forero@marymount.edu.co','Andres Forero','admin',1,0),
       ('felipe.velasquez@marymount.edu.co','Felipe Velasquez','teacher',0,0)"
    npx wrangler deploy

Then measure CPU time per request in the dashboard (Workers & Pages >
examgrader-api > Metrics) under a burst: the free plan allows 10 ms and
RS256 verification has not been measured on the real platform yet.

## Trying the student page for real (before merging anything to main)

The adapter lives in `../grader.html` on this branch; GitHub Pages serves `main`,
so the live page is unchanged. To try it:

    cd ..                       # repo root
    python3 -m http.server 8000
    # open: http://localhost:8000/grader.html?src=https://examgrader-api.marymount-exams.workers.dev&exam=G11_T1_W1-5

`localhost:8000` is both an authorized Google Sign-In origin and on the
Worker's CORS allowlist. The exam must be open for the page to load it:

    npx wrangler d1 execute examgrader --remote --command "UPDATE exams SET active = 1 WHERE id = 'G11_T1_W1-5'"
    # and close it again afterwards:
    npx wrangler d1 execute examgrader --remote --command "UPDATE exams SET active = 0 WHERE id = 'G11_T1_W1-5'"

Teacher accounts in `teachers` with `retake_exempt = 1` can repeat the exam.

## Anti-cheating update (2026-10-12): apply in THIS order

The new code reads columns that do not exist in the live database yet, so the
migration must come first:

    cd cloudflare-backend
    npx wrangler d1 execute examgrader --remote --file=migrations/002_integrity.sql
    npx wrangler deploy

(Running the migration twice is harmless: it stops with "duplicate column".)

Read the report of an exam:

    node tools/integrity-report.mjs --exam G11_T1_W1-5
