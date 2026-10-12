# Exam Grader on Cloudflare — API and behaviour specification

**Status:** design for review (2026-10-10); slice 1 of the code (student flow, grading, queue, core admin) is built and tested locally, not deployed. See `README.md` for what is implemented. Companion file: `schema.sql`.

Spec changes made while building (all in the direction of the original rules): the tab-switch penalty is derived server-side from `tab_switches` (1 switch = 1 point, 2 or more = 4) instead of trusting the client's value; `reset` is an alias of delete; bulk recalculate/regrade work in chunks of 40 with a `nextAfterId` cursor because of D1's 50-queries-per-invocation limit.
Replaces `Code.gs` (Apps Script). The frontend stays on GitHub Pages and finds the backend through `?src=<worker base url>`.

## 1. Platform

Cloudflare Workers (free plan) + D1 (database) + R2 (images, PDFs) + Queues (grading, long jobs) + a cron trigger (sweep).
Free-plan numbers this relies on (official pages, fetched 2026-10-08): Workers 100,000 requests/day and 10 ms CPU/request; D1 100,000 rows written/day, 5 M read/day, 50 queries/invocation; Queues 10,000 operations/day, 24 h retention; R2 10 GB, 1 M Class A, 10 M Class B per month.

## 2. Conventions

- JSON in and out, UTF-8 (`Content-Type: application/json; charset=utf-8`). Accents survive natively; `safeJson()` was an Apps Script workaround and is not ported. Acceptance test: a name and an answer containing `é á ó ñ` round-trip unchanged through submit → admin detail → email.
- Responses: `{success:true, ...}` or `{success:false, error, code}`.
- CORS: echo the caller's `Origin` only if it is on an allowlist (`https://workwebsitesmixed.github.io`, `http://localhost:8000`). Student POSTs use `text/plain` bodies so no preflight is triggered.
- Student endpoints: no Google token after `/start`; the attempt id (random UUID) is the bearer for that attempt. Admin endpoints: `Authorization: Bearer <session>`.
- IDs of teachers and students are always lower-cased emails.

## 3. Student endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/exam?exam=<id>` | Public paper: config, set cards, and the full question bank **without** `correct_index`, `rubric`, `accepted_answers`. No `exam` → the exam with `is_default = 1`. Cacheable (`Cache-Control: public, max-age=30`). If the exam is inactive: `{config:{exam_active:'false'}}`. |
| `POST /api/start` | Body `{idToken, exam, set, firstName, lastName, class}`. Verifies the Google token (§6), then **creates or resumes** the attempt. Returns `{attemptId, startedAt, deadlineAt, serverNow, paper:{qids, optionOrder}, answers}`; or `{duplicate:true}` if that attempt is already `submitted` or later. |
| `POST /api/save` | Autosave. Body `{attemptId, answers, tabSwitches}`. Sent by the browser every 30 s **only when answers changed**. Rejected after `deadline_at` + 60 s grace, or once submitted. Returns `{success:true, savedAt}`. |
| `POST /api/submit` | Body `{attemptId, answers, tabSwitches}`. Idempotent. Sets `status='submitted'`, enqueues one grading message, returns `{status:'queued', deadlineAt}`. |
| `GET /api/result?attemptId=` | `{status}` while not graded. The graded result is returned **only when `status='graded'` and `now ≥ deadline_at`** (the "hold results until the timer ends" rule moves from the browser to the server). |
| `POST /api/myresults` | Body `{idToken}`. All **graded and past-deadline** attempts of that verified email, with per-question detail and the correct MC answers (for `results.html`). |
| `GET /img/<hash>` | Streams the image from R2 with `Cache-Control: public, max-age=31536000, immutable`. |

`/start` modes: in `igcse` mode the paper is every question of the set in fixed order and fixed option order (identical for everyone; `paper` is still stored). In `standard` mode, sampling (`questions_per_set`, `oe_per_set`, `randomize` — independent options) and MC option shuffling are done here and stored in `attempts.paper`.

## 4. Admin endpoints (all require a session; role `admin` where noted)

| Endpoint | Replaces (Code.gs action) |
|---|---|
| `POST /api/admin/login` `{idToken}` → session (HMAC-signed, ~8 h) | `verifyAdmin` |
| `GET/PUT /api/admin/exams`, `GET/PUT /api/admin/exams/:id` | `updateConfig`, config reads |
| `GET /api/admin/exams/:id/questions` (includes secrets) | `adminQuestions` |
| `POST/PUT/DELETE /api/admin/exams/:id/questions[/:qid]`, `POST .../questions/bulk` | `addQuestion`, `updateQuestion`, `deleteQuestion`, `addQuestionsBulk` |
| `POST /api/admin/images`, `GET /api/admin/images` | `uploadImage`, `listImages` (browser downscales to ≤ 1600 px first) |
| `POST /api/admin/exams/:id/extract`, `POST .../rubrics` → `{jobId}`; `GET /api/admin/jobs/:id` | `extractQuestions`, `generateRubrics` (queued, see §7) |
| `GET /api/admin/attempts?exam=`, `GET /api/admin/attempts/:id` | `submissions`, `details` |
| `PUT /api/admin/attempts/:id/overrides` | `override` |
| `DELETE /api/admin/attempts/:id`, `POST /api/admin/attempts/:id/reset` | `deleteSubmission` (+ new: reset a stuck attempt so the student can start again) |
| `POST /api/admin/exams/:id/recalculate`, `POST .../regrade-mc`, `POST .../resend-emails` | `recalculate`, `regrademc`, `resendEmails` — always scoped to one exam |
| `GET /api/admin/exams/:id/distractors` | `mcDistractors` |
| `GET/POST/DELETE /api/admin/teachers` (role admin) | new |
| `GET /api/admin/exams/:id/export` (JSON; also accepts `EXPORT_KEY`) | new: feeds the Sheets archive and the Raspberry Pi backup |

## 5. Grading (queue consumer `grade`, one message per submission)

1. Load the attempt and the questions named in `attempt.paper`. **`max_score` = sum of `points` over `paper`.** A qid missing from `answers` scores 0.
2. MC: compare the submitted printed-order index with `correct_index` (no text matching).
3. Short: normalized exact match against `accepted_answers`; on miss, one AI call with the same prompt as `gradeShortWithAI_`.
4. openEnded: Claude call with the rubric, model **`claude-sonnet-5-5`** (configurable variable), up to 3 retries on 429/5xx using queue `retry({delaySeconds})`, not `sleep`.
5. `penalty` comes from the integrity log (section 5b), never from a number the browser sends; score after penalty floored at 0; percentage and grade via the same boundary logic as `calculateGrade` in Code.gs (port with unit tests against known rows).
6. Write `results`, scores, `status='graded'`. Failures set `status='error'` + `grading_error`; the sweep retries.
7. If the student's email is verified and email is enabled, set `email_status='pending'` and enqueue a relay message (§8).

## 5b. Integrity (anti-cheating) and similarity — decided 2026-10-12

The browser reports **events**; the server derives faults and points (`src/integrity.js`).

| Event | Category | Rule |
|---|---|---|
| `copy`, `cut`, `paste`, `drop` | clipboard | fault at once, no warning; the action is also blocked in the page |
| `away` (tab hidden, minimised) | tab | first time a warning, then faults |
| `resize` (window narrower than 75% of the screen width: split screen on one monitor) | window | first time a warning, then faults. (`unfocus`, focus lost to another window, is still accepted by the server but the page no longer sends it: school computers have one screen and Veyon can take focus.) |
| `contextmenu` (right click) | menu | first time a warning, then faults; the menu is blocked |
| `back`, `bulk_input` | evidence | never a warning or a fault |

Each warning category has its own first warning. Warnings never count. Each fault costs **1 point** (`FAULT_POINTS`). The **3rd fault submits the exam**: the server does it itself when it receives the third fault in a `/api/save`, so a page that ignores the order cannot keep working. Events are append-only and idempotent (a re-sent `seq` is ignored); at most 300 are kept. An older cached page that only sends `tabSwitches` is converted to `away` events and ruled the same way.

Stored per attempt: `events` (the evidence), plus `faults`, `warnings`, `away_ms`, `paste_events`, `paste_chars`. `/api/admin/attempts/:id` returns the annotated timeline.

**Similarity report** (`POST/GET /api/admin/exams/:id/similarity`): computed in the queue consumer by `src/similarity.js`, with no AI model, so it costs no tokens. Open-ended answers of 25+ words are compared by overlap of 3-word phrases (phrases from the question itself are ignored); multiple choice by identical WRONG answers. A flagged pair is a reason to read both papers, not proof. Students on different sets are never compared; at most 150 graded attempts per exam.

Cron sweep (every minute): (a) `started` attempts past `deadline_at + 60 s` that have saved answers → mark `submitted` and enqueue (this is what rescues a student who closed the tab); (b) `grading` older than 10 min → re-enqueue; (c) `email_status='pending'` older than 10 min → re-enqueue.

## 6. Security model — each rule and where it is enforced

| Rule | Enforcement |
|---|---|
| `correct_index`, rubrics, accepted answers never reach students | `/api/exam` selects only public columns; secrets exist only in admin endpoints and the grader |
| MC graded server-side | §5 step 2 |
| Google token verified server-side, `@marymount.edu.co` only | RS256 signature checked with WebCrypto against `https://www.googleapis.com/oauth2/v3/certs`; require `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`}, `aud` = client id, `exp` valid, `email_verified`, `hd == marymount.edu.co` **and** email suffix. **A token is mandatory at `/start`; the client-supplied email is never used.** |
| One attempt per student per exam+set | `UNIQUE(exam_id, email, set_id)`; `/start` is an insert-or-resume |
| Teacher test accounts may retake | `teachers.retake_exempt`, honoured only for a verified identity |
| Tab-switch penalty capped server-side | §5 step 5 |
| Admin access | Google token → email must exist in `teachers` → Worker session; no shared password, no password in any response |
| Config secrets never leave | there is no config key/value store any more; secrets are Worker secrets (`ANTHROPIC_API_KEY`, `SESSION_SECRET`, `MAIL_RELAY_KEY`, `EXPORT_KEY`) |
| Time limit | `deadline_at` is server-side; `save`/`submit` after grace are rejected |

## 7. Long admin jobs

PDF import and rubric generation send a PDF to Claude. The browser uploads the PDF to R2 (`tmp/<jobId>.pdf`); a queue consumer reads it and calls Claude (queue consumer limits: 15 min wall time, 30 s CPU by default). The admin panel polls `GET /api/admin/jobs/:id`. This avoids the 10 ms CPU limit of normal requests. Unverified: whether even a request-time upload of a few MB fits in 10 ms, which is why uploads go straight to R2.

## 8. Email

Cloudflare Email Sending is not available on the free plan. Results email is a **best-effort backup relay**: the queue consumer POSTs `{key, to, subject, html}` to a small Apps Script web-app action that calls `MailApp.sendEmail` (consumer-account quota 100/day, same as today). The relay verifies `MAIL_RELAY_KEY` in a Script Property. The exam never waits on email; failure only sets `email_status='failed'`.

## 9. Archive and history

- Existing submissions stay in the Google Sheet as an **archive** (decision 2026-10-10). They are not imported into D1; `results.html` on the new backend shows only attempts taken after cutover.
- New results are exported to a Sheet by an Apps Script time trigger that calls `GET /api/admin/exams/:id/export`, so teachers keep a spreadsheet view. Optional later: the Raspberry Pi pulls the same endpoint nightly.

## 10. Free-tier budget (my estimate; assumptions stated)

Assumptions: 60 students, 60 min, 40 questions, autosave every 30 s only when changed (worst case every tick), 6 open-ended answers each.

| Resource | Per session (worst case) | Free cap | Share |
|---|---|---|---|
| Worker requests | 60 × (1 exam + 1 start + 120 saves + 1 submit + ~10 result polls + ~40 images) ≈ 10,300 | 100,000/day | ~10% |
| D1 rows written | start 3 + saves 120 + submit/status ~4 + grading ~3 → ≈ 130 × 60 ≈ 7,800 | 100,000/day | ~8% |
| Queue operations | 60 grade messages (+ retries, + email relay) — operations-per-message not verified; assume 3 → ~540 | 10,000/day | ~5% |
| Claude calls | 60 × ~7 = ~420 | Start tier 1,000 requests/min | queue concurrency capped at 5 |

Roughly 9 such sessions per day before the D1 write cap. When a daily cap is exceeded, D1 stops running queries, which would stop exam starts: add an admin-visible counter and alert at 70%.

## 11. Cutover

1. Build behind a new `?src=`; the production Apps Script and Pages stay untouched.
2. Frontend: `grader.html` / `admin.html` / `results.html` get an adapter chosen by the `src` host; the old flow keeps working against Apps Script until retired.
3. Pilot with one class on the new link; the other classes keep the old link. Rollback = hand out the old link.
4. Keep Apps Script alive after cutover only for the email relay and the Sheets export trigger.

## 12. Verify before relying on it

- CPU time of RS256 verification and of a ~30 KB submit body under the 10 ms free-plan limit (deployed Worker, dashboard metrics).
- Whether D1 `batch()` counts each statement against the 50-queries-per-invocation limit (design uses ≤ 5 per invocation).
- Queue operations counted per message.
- Whether D1 enforces the foreign keys declared in `schema.sql`.
- Behaviour when the daily D1 write cap is hit (documented: queries stop and return an error).
- The Sign-In button works unchanged from `github.io` with the Worker as backend (authorized JavaScript origins depend on the page origin, not the backend; untested).
