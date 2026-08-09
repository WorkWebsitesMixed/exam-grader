# Exam Grader — Handoff Document

_Last updated: 2026-08-09 (session 8 — security hardening + Path A cutover)_

---

## 0. v2 STATUS (read this first)

The project is mid-**v2 rebuild** to support **Cambridge IGCSE mock exams**. Everything in §1–§6 that predates v2 is historical (v1, Gemini-based). Code lives in git via **clasp** (manages `Code.gs` + `appsscript.json` only; the HTML is the GitHub Pages frontend).

**⚠️ As of 2026-08-09 the project is executing the "Path A" cutover — see §7. The old rule "never touch the live `/exec` or `main`" is RETIRED.** v2 is being promoted to production, which requires merging `v2-igcse` into `main` and decommissioning the old v1 project.

**Architecture (confirmed):** Apps Script is a **pure JSON API**; the HTML (grader/admin/results/index) is the **GitHub Pages frontend** and finds the backend via a `?src=<exec-url>` query param.

**v2 build status — Phases 0–4 done & validated; preview deployed:**
- **Backend = Claude** (Anthropic Messages API via `UrlFetchApp`); key in Script Property `ANTHROPIC_API_KEY`; `GRADING_MODEL = 'claude-sonnet-4-6'`. OE answers get a **detailed paragraph** of feedback.
- **Question types:** `mc`, `openEnded` (AI), `short` (hybrid: exact normalized match → AI fallback). Short accepted-answers live in the **Rubric** column. Rubric/accepted answers are **never sent to students** (server reads them from the sheet at grade time).
- **IGCSE mode** (`exam_type` config = `standard`|`igcse`): backend ENFORCES standardization — ignores `randomize_questions`, `questions_per_set`, `oe_per_set`, and skips MC option shuffling (fixed printed order); admin greys out those controls.
- **PDF features (Claude document blocks):** import questions from the question-paper PDF (verbatim text/marks/type — figures NOT auto-extracted); generate per-question rubrics + short accepted-answers from the marking-scheme PDF (`generateRubrics`).
- **Question images:** stored in each teacher's own Drive (`DriveApp`, link-shared), embedded via `https://drive.google.com/thumbnail?id=<id>&sz=w1600`. Reuse picker (one upload, many references = same file id); grader renders a shared figure **once per contiguous run** (safe because IGCSE order is fixed).
- **Admin:** statistics panels removed; settings collapsed by default; `set_mode` single|triple (single skips set selection + preview).
- **Questions sheet now has 14 cols** (added `Image` as col 14, after `Exam`).
- **Preview deployed:** `https://workwebsitesmixed.github.io/exam-grader-v2-preview/` (separate public repo in the WorkWebsitesMixed org → same Sign-In origin as production; points at the dev backend). Full student flow validated end-to-end.

**Remaining:** Phase 5 (multi-teacher template-copy model + registry); real go-live deploy; (future) question bank with topic+grade tags. Deferred: drawing/annotation answers (canvas + vision).

---

## 1. The Goal

An AI-powered online exam system for Marymount school (Bogotá, Colombia), D&T classes. Students take timed exams in the browser; multiple-choice and short answers are graded server-side; open-ended (and ambiguous short) answers are graded by **Claude**. Teachers manage everything (questions, settings, marking schemes, overrides) through an admin panel. The system must prevent cheating, handle duplicate submissions, and email results automatically.

---

## 2. Current State

### What exists and works
- **Full student exam flow:** Google Sign-In (restricted to `@marymount.edu.co`) → set selection (A/B/C) with preview modal → student info form → timed exam → submission → AI grading → results screen.
- **Anti-cheating system:** Tab switch penalties (−1pt, −3pts, auto-submit on 3rd switch). Penalty capped at 4 server-side.
- **Timer:** Wall-clock based, persists across page refresh via `sessionStorage`. Results are held until timer hits 00:00 even if the student submits early.
- **MC grading:** Fully server-side. `correctIndex` is never sent to the client. `CorrectIndex` in the Questions sheet is **1-based** (1=A, 2=B, 3=C, 4=D); code converts with `cidx = Number(qr[10]) - 1` before indexing into the 0-based options array.
- **Open-ended grading:** Gemini 2.5 Flash (`gemini-2.5-flash`) with retry logic (429/503). Prompt explicitly instructs the model to award partial marks and comment directly on what the student wrote. `maxOutputTokens: 500`. Feedback regex captures full multi-line responses.
- **Gemini API key:** Stored in Apps Script Script Properties under key `GEMINI_API_KEY`. Never hardcoded. Read at runtime via `PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')`.
- **Results email:** HTML email sent to student's school address after submission via `MailApp`.
- **Student results page (`results.html`):** Students can review all past submissions with AI feedback and correct MC answers.
- **Admin panel (`admin.html`):** Password-protected. Grade distribution chart, class analysis, MC distractor analysis, grade override, exam settings, grade boundaries editor, question manager, bulk recalculate, Regrade All MC, Reload submissions, delete submission.
- **Question randomization and bank sampling** (`randomize_questions`, `questions_per_set`, `oe_per_set` in Config sheet) work independently.
- **Duplicate guard:** `email + set + exam_id` — blocks re-submission of the same set within the same exam.
- **Set card labels configurable from admin:** `set_a_label`, `set_a_max_grade`, `set_a_description` (and B, C equivalents) in Config sheet control the set selection cards on the exam page. No longer hardcoded in `grader.html`.

### Question bank — current state
- **Source of truth:** `/home/andresforero/Documents/Marymount/10th planning/Project/Exam_Grading.csv`
- **Set A:** 5 open-ended (A_1–A_5) + 5 MC (A_6–A_10) = 10 questions
- **Set B:** 5 open-ended (B_1–B_5) + 5 MC (B_6–B_10) = 10 questions
- **Set C:** 5 open-ended (C_1–C_5) + 5 MC (C_6–C_10) = 10 questions
- **Yggdrasil:** 3 open-ended challenge questions (YGG_1–YGG_3), no MC
- All MC `CorrectIndex` values are **1-based** (1–4). MC answer positions are distributed across all four options — correct answer is not always option A.
- Open-ended `CorrectIndex` cells are intentionally blank.
- To load into the system: paste CSV content into the Questions sheet, or use the admin Questions panel. The Questions sheet has a 13th column `Exam` (blank = belongs to all exams).

---

## 3. Session History

### Session 7 (2026-06-19 → 06-20) — v2 IGCSE rebuild

Major rebuild on the `v2-igcse` branch against a dev Apps Script copy; live site untouched. Adopted **clasp** so `.gs`/`.html` live in git.

- **Phase 0 — production-safe setup:** committed v1 snapshot to `main`; branched `v2-igcse`; wired clasp to the dev backend (manages only `Code.gs` + `appsscript.json`; HTML excluded via `.claspignore`). Confirmed Apps Script = JSON API, HTML = Pages frontend via `?src=`.
- **Phase 1 — Claude grading:** replaced Gemini with the Anthropic Messages API (`callClaudeAPI`, `gradeOpenEnded`); one detailed paragraph per OE answer; `ANTHROPIC_API_KEY` in Script Properties.
- **Phase 2 — admin UX:** removed all statistics panels (grade chart, class analysis, MC distractors, summary cards); settings collapse by default; `set_mode` single|triple toggle (single skips set selection + preview → class → exam).
- **Phase 3 — question images:** `Image` column (14th); `uploadImage` saves to the teacher's Drive (`DriveApp`, link-shared); rendered in grader/admin/edit form.
- **Phase 4a — short type:** exact normalized match, **server-authoritative** (rubric/accepted answers read from sheet, no longer sent to students — closed a leak).
- **Phase 4b — PDF import:** `extractQuestions` sends the question paper to Claude → verbatim questions JSON → `addQuestionsBulk`. Figures attached by hand afterward.
- **Phase 4c — IGCSE mode:** `exam_type` toggle enforces standardization (no randomize/sample, fixed MC option order, greyed controls); marking-scheme PDF → `generateRubrics` writes a rubric per OE question and accepted-answers per short question (`extractJsonObject_`).
- **Phase 4d — reusable figures:** `listImages` gallery + reuse picker (same file id across questions); grader suppresses a figure repeated from the previous question.
- **Phase 4 polish:** short grading made **hybrid** (exact → AI fallback via `gradeShortWithAI_`); distinct "Short" type label in the admin question list.
- **Validation:** deployed a Pages **preview** (separate org repo `exam-grader-v2-preview`, same origin) and validated the full student flow (single-set, images/dedupe, short inputs, fixed order, live grading).
- **Ops lessons:** `clasp push` only updates HEAD — must `clasp deploy -i <id>` to update the live `/exec` (frozen version); this caused a "feature not working" red herring. Google **OAuth client is on the work account**; Apps Script/Drive/GitHub are on personal (matters for the sell-to-school plan).

### Session 6 (2026-06-10)

#### Set card labels driven from Config sheet (was hardcoded)
- **Problem:** Set A/B/C cards on the exam page showed hardcoded label, max grade, and description (e.g. "SET A — Standard / Maximum Grade: 2.3 / Foundational questions."). When the teacher changed rubrics so all sets used the same grade ceiling, the cards still showed stale values.
- **Fix — `Code.gs`:** Added 9 default rows to `createConfigSheet()`: `set_a_label`, `set_a_max_grade`, `set_a_description` (and B, C equivalents). Defaults match the old hardcoded values so existing spreadsheets see no change until the teacher edits them.
- **Fix — `grader.html`:** Added a loop at the end of `applyConfig()` that overwrites `SET_META[set].label/maxGrade/description` from the config keys before `buildSetOptions()` reads them. Hardcoded fallback values in `SET_META` remain as a safety net if the keys are absent.
- **Fix — `admin.html`:** Added "Set Card Labels" subsection inside ⚙ Exam Settings config-grid with 9 inputs (label, max grade, description per set). Wired into `applyConfig()` (populates fields on load) and `saveConfig()` (includes keys in the POST).
- **Deployment note:** `createConfigSheet` only runs for new spreadsheets. Existing installations must manually add the 9 keys to the Config sheet, or save via the admin panel once (the Save button upserts all keys including blank ones).

#### Multi-exam support discussion
- Teacher needs to run exams for 10th, 11th, and 12th grade simultaneously — different topics, not just different sets.
- **Two options discussed:** (A) URL-parameter routing (`?exam=exam_id`) with one spreadsheet; (B) separate deployment per grade for full isolation.
- Option A recommended: teacher posts a different link per grade in each Google Classroom. Minimal code change, all results in one place, existing `exam_id` duplicate guard already supports it.
- **Teacher resolved multi-exam routing independently** — no code changes made this session.

### Session 5 (2026-06-03)

#### `handleRegradeAllMC` — wrong column range (critical bug)
- **Bug:** Regrade wrote 4 values (`correctText, isCorrect, earned, feedback`) to columns 11–14 (CORRECT_ANSWER through MAX_SCORE). This put `feedback` text into the MAX_SCORE cell, making `Number("Correct") = 0` → admin showed "4/0 pts". AI_FEEDBACK (col 15) was never touched, so it kept the stale "Incorrect. Correct answer: " string from the original broken submission.
- **Fix:** Changed `getRange(…, 1, 4)` → `getRange(…, 1, 5)` and inserted `maxPts` as the 4th value, so the write correctly covers CORRECT_ANSWER, IS_CORRECT, AI_SCORE, MAX_SCORE, AI_FEEDBACK in one pass.

#### Feedback regex — truncated at first newline
- **Bug:** `FEEDBACK:?\s+([^\n].+)` stopped at the first `\n`, so any Gemini response that wrapped across lines was silently cut mid-sentence.
- **Fix:** Changed to `FEEDBACK:?\s+([\s\S]+)` — captures all text after the FEEDBACK label including newlines. The fallback regex block was removed as it is now redundant.

#### CorrectIndex in CSV — 0-based vs 1-based mismatch (critical bug)
- **Bug:** `Exam_Grading.csv` had 0-based CorrectIndex values (0=A…3=D). `Code.gs` subtracts 1 (`Number(qr[10]) - 1`), expecting 1-based. CorrectIndex=0 → cidx=−1 → `opts[−1]=undefined` → blank correct answer for every MC question in Sets B and C.
- **Fix:** All 15 MC CorrectIndex values in the CSV converted to 1-based (1=A…4=D). Values now range 1–4.

#### MC answer position shuffle (Sets B and C)
- All 10 Set B and C MC questions previously had the correct answer at Option A (CorrectIndex was 0 for all). This made it trivially easy to guess.
- Correct answers redistributed: B set uses positions B, D, C, A, B; C set uses positions C, A, D, B, C.
- Options reordered in the CSV to match — rubric text unchanged (references answer text, not position).

### Session 4 (2026-06-02)

#### API key security fix
- Removed hardcoded Gemini API key from `Code.gs`. Key was publicly exposed in git, causing Google to revoke it (all OE grading returned 403 errors).
- Key now lives in Apps Script Script Properties (`GEMINI_API_KEY`). To set: Apps Script editor → ⚙ Project Settings → Script Properties → Add `GEMINI_API_KEY`.
- Added explicit 403 branch in `callGeminiAPI`: returns `SCORE: 0 / FEEDBACK: Grading unavailable (API key not configured or invalid)` instead of the generic error.

#### OE grading prompt improvements
- Prompt now explicitly says "Award partial marks when the rubric says to."
- FEEDBACK instruction changed to "comment directly on what this student wrote — what they got right and/or wrong."
- `maxOutputTokens` raised from 400 → 500.

#### CorrectIndex off-by-one fix in grading code
- **Bug:** `questionMap[qid] = {correctText: opts[cidx]}` used the raw CSV value (1-based) as a 0-based index, so every `correctText` pointed one position past the correct answer. CorrectIndex=4 gave `opts[4]=undefined`.
- **Fix:** `var cidx = Number(qr[10]) - 1;` in `handleSubmission` and `handleRegradeAllMC`.

#### Admin panel additions
- **Regrade All MC button** (purple, ⚙ Settings panel) → `action: 'regrademc'` → `handleRegradeAllMC()`. Re-reads question key, updates Detailed_Answers, recalculates totals.
- **Reload button** (toolbar) → `loadSubmissions()` without page refresh.
- `loadSubmissions()` now returns its promise (missing `return` was breaking `.finally`).
- "Open-Ended per Set" input wired into `applyConfig()` and `saveConfig()`.
- MC Distractor Analysis panel (set tabs, lazy load, horizontal bars, green=correct/red=wrong).
- Grade Distribution chart: x-axis sorted numerically, grouped bars by set.

#### `grader.html`
- `startExam()` is async: POSTs `checkDuplicate` before showing questions; shows duplicate screen immediately on match.

---

## 4. Open Tasks

### Immediate (v2)
- [ ] **Phase 5 — multi-teacher template-copy model + registry.** Each teacher runs their own copy bound to their own Google account (data in their Drive, their quota); main admin gates access. Decide ownership of the master template, shared frontend repo, and OAuth client given the possible **sell-to-school**.
- [ ] **Real go-live** of v2 — **decided: Path A, promote the dev copy. See §7 for the runbook and current progress.**
- [ ] **Remove temporary helpers before handover:** `testClaudeGrading()`, `testImageSetup()` in `Code.gs`; the `http://localhost:8000` dev origin in the OAuth client.
- [ ] (Future) **Question bank** — tag questions by topic + grade to save/reuse across exams.

### v1-era items (still valid for the live site; re-evaluate for v2)

#### Resend Results Emails button
- **Agreed design:** Button in the submissions toolbar. Respects current class, set, and date filters. Shows "Send X emails?" confirmation before firing.
- Backend: `action: 'resendEmails'` → reads Submissions + Detailed_Answers, reconstructs HTML email, calls `MailApp` per row.
- MailApp quota: 100/day (free Gmail), 1500/day (Workspace). Confirm dialog should show count.
- Already implemented in `Code.gs` (`handleResendEmails`) but not yet wired to a button in `admin.html`.

#### Multi-exam support (concurrent exams — different grades/topics)
- Teacher resolved routing independently (session 6).
- Admin panel still lacks an **Exam filter** — when multiple `exam_id` values exist in Submissions, the admin shows all of them mixed together. Stats, grade distribution, and distractor analysis should respect an exam filter the same way they respect class/set filters.
- **Not yet implemented** (admin filter side).

### Known pending features / bugs
- [ ] **MailApp authorization** — email sending silently fails until the teacher manually runs any function calling `MailApp` in the Apps Script editor and approves the permission dialog. One-time step per project.
- [ ] **Encoding of `checkDuplicate` response** — uses `JSON.stringify`. If names are ever included, switch to `safeJson()`.
- [ ] **`duplicateScreen` CSS inconsistency** — uses inline `style="display:none"` instead of the `.active` class pattern. Low priority.

### Future — New question types (not yet started)
- **True/False** — 2-option MC (CorrectIndex 1=True, 2=False), flows through existing MC pipeline.
- **Fill in the Blank** — single-line text; teacher defines comma-separated accepted answers; server grades by normalizing (trim + lowercase).
- **Numeric with tolerance** — number input; teacher sets correct value and margin; server checks `|student − correct| ≤ tolerance`.

**Open design questions:**
1. Should FITB/numeric scores add to MC Score (no schema change) or rename that column "Auto Score"?
2. Should `oe_per_set` sampling treat TF/FITB/numeric as MC slots, or can teachers guarantee minimums of specific types?

---

## 5. Relevant Files

| File | Path | Role |
|---|---|---|
| `Code.gs` | `exam-grader/Code.gs` | Apps Script backend — all server logic, grading, sheet I/O |
| `grader.html` | `exam-grader/grader.html` | Student-facing exam page |
| `results.html` | `exam-grader/results.html` | Student results history page |
| `admin.html` | `exam-grader/admin.html` | Teacher admin panel |
| `index.html` | `exam-grader/index.html` | Landing page (GitHub Pages) |
| `Exam_Grading.csv` | `/home/andresforero/Documents/Marymount/10th planning/Project/` | Source of truth for question bank (Sets A, B, C, Yggdrasil). Paste into Questions sheet to load. |

### Key changes by file (cumulative)

**`Code.gs`**
- `GEMINI_API_KEY` read from `PropertiesService`, never hardcoded
- `callGeminiAPI`: explicit 403 branch; `maxOutputTokens: 500`; feedback regex changed to `[\s\S]+` to capture multi-line responses
- `gradeWithGemini`: partial marks instruction; feedback must reference student's specific answer
- `var cidx = Number(qr[10]) - 1` in `handleSubmission` and `handleRegradeAllMC` (CorrectIndex 1-based→0-based conversion)
- `handleRegradeAllMC()`: writes 5 columns (CORRECT_ANSWER, IS_CORRECT, AI_SCORE, MAX_SCORE, AI_FEEDBACK) — was incorrectly writing 4, corrupting MAX_SCORE
- `'regrademc'` in admin auth guard and `doPost` dispatch
- `handleCheckDuplicate(data)`: verifies JWT, checks `email + set + exam_id` in Submissions
- `handleMcDistractors()`: tallies student answers per MC option, returns option counts with correct flag
- `handleResendEmails()`: implemented, not yet wired to admin UI button
- `oe_per_set` sampling: splits bank into typed pools, draws exact OE count first
- `oe_per_set = 0` in `createConfigSheet()` defaults
- `createConfigSheet()` adds 9 set-card config defaults: `set_a_label`, `set_a_max_grade`, `set_a_description` (and B, C)

**`grader.html`**
- `startExam()` async: POSTs `checkDuplicate` before showing questions; handles duplicate + network-error states
- `applyConfig()` now overwrites `SET_META` from `set_*` config keys before `buildSetOptions()` renders the cards

**`admin.html`**
- Regrade All MC button (purple, ⚙ Settings) → `action: 'regrademc'`
- Reload button (toolbar) → `loadSubmissions()` without page refresh
- `loadSubmissions()` returns its promise
- "Open-Ended per Set" input in ⚙ Exam Settings
- MC Distractor Analysis collapsible panel (set tabs, lazy load, horizontal bars)
- Grade Distribution chart: sorted numeric x-axis, grouped bars by set
- "Set Card Labels" subsection in ⚙ Exam Settings: 9 inputs (label, max grade, description per set A/B/C), wired to `applyConfig()` and `saveConfig()`

---

## 6. Critical Rules

- **~~(v2) Build on `v2-igcse` against the DEV backend. Never touch the live `/exec` or `main`.~~ RETIRED 2026-08-09** — that rule protected a *running* v1 while v2 was built alongside it. Path A (§7) decommissions v1, and the cutover requires both forbidden actions (merge into `main`, archive the old deployments). Do not reinstate it.
- **Admin auth FAILS CLOSED** (`checkAdminAuthResult`, commit `cdd069b`). With no `admin_password` in the Config sheet, every admin action is denied. **Never blank that cell.** Each spreadsheet has its own password — a mismatch while testing looks like a bug but isn't. There is **no login throttling anywhere**, so password *length* is the only real defense on an `ANYONE_ANONYMOUS` endpoint.
- **`doPost` is deny-by-default.** Public actions are an allowlist (`['', 'submit']`); everything else requires the admin password. Adding a handler to the router does **not** expose it — but do not add anything to `publicActions` without checking it returns no PII.
- **Config secrets leave through one choke point only** — `publicConfig_()` / `isSecretConfigKey_()`. Any new key containing `password`/`secret`/`api_key`/`token` is stripped automatically. Do not hand-roll a second strip.
- **(v2) After any `Code.gs` push, run `clasp deploy -i <dev deploymentId>`** or the change won't be live on `/exec` (it serves a frozen version; `clasp push` only updates HEAD). See §Known data state for the id.
- **(v2) Rubrics & short accepted-answers are NEVER sent to students** — the server reads them from the Questions sheet at grade time.
- **(v2) IGCSE mode must stay standardized** — backend forces off randomization/sampling and fixes MC option order; do not reintroduce per-student variation for IGCSE exams.
- **(v2) Questions sheet is 14 columns** — `…Rubric | Exam | Image`. For `short` questions, accepted answers are stored in the `Rubric` column.
- **Never send `correctIndex` to the client.** MC grading is 100% server-side.
- **`CorrectIndex` in the Questions sheet is 1-based (1=A … 4=D).** Code subtracts 1 before indexing. Writing 0 → cidx=−1 → `undefined` → every answer marked wrong. This has burned us twice.
- **`Exam_Grading.csv` CorrectIndex is also 1-based** — matches what the sheet expects. Do not revert to 0-based.
- **Always use `safeJson()` for responses containing user-entered text** (names, answers, feedback). Plain status responses can use `JSON.stringify()`. Accented characters (é, á, ó) will garble otherwise.
- **`appShell` must be visible before `renderTable()` in admin.html.** The chart reads `clientWidth` — if hidden, it draws at 0px.
- **Deploying `Code.gs`:** v1 — bump the web-app version in the editor. **v2 — `clasp push` then `clasp deploy -i <deploymentId>`** (push alone does not update `/exec`).
- **All JS in `Code.gs` must be ES5-compatible** (Google Apps Script runtime). No `const`/`let`, no arrow functions, no template literals.
- **Admin password checked on every admin POST** — never cache beyond `sessionStorage`.

### Known data state
- Google Client ID: `878760918876-psduvcg9tsudtggqoqk0cf02n63d5mou.apps.googleusercontent.com`
- Domain restriction: `hd: 'marymount.edu.co'` in `grader.html` and `results.html`
- Grade boundaries hardcoded as fallback in `GRADE_BOUNDARIES`; overridden at runtime by `grade_boundaries_A/B/C` in Config sheet

### v2 deployments & accounts (session 7)
- **Dev backend `/exec`** (build/test here): `https://script.google.com/macros/s/AKfycbyeQbG1xIFVgK6XNeZ1iECYOBll4rv4zrICDPMcj2xGQwhUNvPhkGJN-gAWD4D5M9KeDQ/exec` (deployment id `AKfycbye…`, use with `clasp deploy -i`). A `@HEAD` deployment `AKfycbzoaDdPausIF6rukZXzyDFgFy6yp_2JUp-scuiw9Bpa` always serves the latest push.
- **OLD v1 production backend `/exec`** — separate Apps Script project, **being retired under Path A (§7):** `…/macros/s/AKfycby0QSDaQ6TiLvxshHo-lhspmSHK1xCBKrF3xMY1Ev1RCkL6lNx6TYcvGZbDFHQsVwlQ/exec`. An older deployment of the same project is `AKfycbxLSz18SVbUgO0uZTUE…`. Both to be archived.
- **Script Properties required per project:** `ANTHROPIC_API_KEY` (grading) and `RETAKE_EXEMPT_EMAILS` (comma-separated; listed accounts may retake any exam indefinitely, for trialling quizzes before students see them — honored **only** for a `verifyGoogleToken`-verified identity, and inert while unset). Neither is ever stored in the Config sheet.
- **`/exec` URLs are not secrets.** Every student's browser has one. The frontend has **no hardcoded backend URL** — all four pages read `?src=` from the query string with no fallback, so "repointing the frontend" is just changing the link you hand out. Rotating the URL buys nothing; security rests entirely on the admin password.
- **Production frontend (Pages):** `https://workwebsitesmixed.github.io/exam-grader/` (repo `WorkWebsitesMixed/exam-grader`, an org Dyrtull admins). **v2 preview:** `https://workwebsitesmixed.github.io/exam-grader-v2-preview/` (public repo, points at dev backend).
- **Accounts:** GitHub login `Dyrtull`. OAuth client `878760918876-…` is in the **work/school** Google account; Apps Script, Drive, dev Google-Cloud projects, and GitHub are on the **personal** account — relevant to a future school handover.
- **Local dev preview:** `python3 -m http.server 8000` in the repo; `http://localhost:8000` is an authorized OAuth origin. Open `localhost:8000/<page>.html?src=<dev /exec>`.

---

## 7. Path A cutover (session 8, 2026-08-09)

**Decision: the dev project BECOMES production.** The v2 Apps Script project (`scriptId 1ul28l8OTQKJ6X1v3L8Lfku5o-Jt1mZKCQASTBaGU93Cr50OUsGEnHwqd`, deployment `AKfycbye…`) takes over; the old v1 project and its spreadsheet are retired.

**Why Path A and not "port v2 into the existing production project":** Andrés confirmed the **old production sheet's data does not matter** — no grade migration needed. That is the only thing that makes A viable; if the historical grades had been needed, porting into the live project (keeping its URL and sheet) was the lower-risk path. Accepted cost: the `/exec` URL changes, so every link already handed out must be reissued.

**Consequence — "retire" is an action, not neglect.** The old spreadsheet holds real student names, emails and grades. Retiring it means deleting it or locking down its sharing, not abandoning it.

### Production links (v2)

Backend: `https://script.google.com/macros/s/AKfycbyeQbG1xIFVgK6XNeZ1iECYOBll4rv4zrICDPMcj2xGQwhUNvPhkGJN-gAWD4D5M9KeDQ/exec`

Append `?src=<that URL>` to any page. `index.html` is a hub that builds the other three links for you.

| | URL |
|---|---|
| Hub | `https://workwebsitesmixed.github.io/exam-grader/?src=<exec>` |
| Student exam | `https://workwebsitesmixed.github.io/exam-grader/grader.html?src=<exec>` |
| Student results | `https://workwebsitesmixed.github.io/exam-grader/results.html?src=<exec>` |
| Admin (keep private) | `https://workwebsitesmixed.github.io/exam-grader/admin.html?src=<exec>` |

### Runbook

1. [ ] Script Property in the v2 project: `RETAKE_EXEMPT_EMAILS = andres.forero@marymount.edu.co` *(manual — Apps Script UI)*
2. [x] **DONE 2026-08-09** — `clasp push` → `clasp deploy -i AKfycbye…` → **`@7`** (push alone does not move `/exec`)
3. [x] **DONE 2026-08-09** — merged `v2-igcse` → `main` (fast-forward, `f8782b4..9bdfd39`) and pushed. Pages config confirmed `source: {branch: main, path: /}`; build `1141853070` status `built`; live `admin.html` verified **byte-identical** to local v2.
4. [ ] Smoke test — *automated half done 2026-08-09:* `?action=config` returns **no** `admin_password` (only the `_required`/`_configured` flags, both `true`); POST `getSubmissions` with no password, with a wrong password, and an **unrouted** action all return `{"success":false,"error":"Unauthorized"}` — deny-by-default confirmed on the live deployment. *(Still manual, needs the password / a browser:* clear `sessionStorage` in open admin tabs first — a password cached from before `cdd069b` is now rejected and looks like a bug. Verify the correct password loads submissions; student submit end-to-end; `myresults` returns only that student's own row; the exempt account can retake.*)*
5. [ ] **Irreversible, only after 4 is green — MANUAL, Andrés's personal account:** archive deployments `AKfycby0QSDa…` and `AKfycbxLSz18…`; delete or lock sharing on the old production spreadsheet (real student PII). Cannot be automated from this repo: the old v1 Apps Script project's `scriptId` is unknown (it was never clasp-managed), and the old spreadsheet lives in `anfforerobe@gmail.com`, which is not the account any local tooling is connected to. **Ordering note:** the v1 system is the only rollback path if step 4 fails, so do not destroy it first.
6. [x] **DONE 2026-08-09** — `exam-grader-v2-preview` retired: Pages site deleted (now 404) and repo **archived** (reversible; not deleted). Production Pages unaffected (200).

### Test exam

`sample_exam_general_knowledge.csv` (repo root, **git-ignored on purpose** — see `.gitignore`; this repo is public and Pages serves its root, so a committed mark scheme would be world-downloadable). 10 general-knowledge questions, 31 marks: 2 `mc`, 3 `short`, 5 `openEnded`, all `Set A`, `Exam = GK_TEST`.

To use it: paste the rows under the existing `Questions` header, set Config `exam_id = GK_TEST` (isolates it — a non-empty `Exam` cell only loads when it matches the active `exam_id`), raise `exam_duration_minutes` from 15, test, then set `exam_id` back to `0445_Paper4`. The Paper 4 rows stay untouched throughout.
