# Exam Grader — Handoff Document

_Last updated: 2026-10-08 (session 11 — decision to migrate the backend to Cloudflare; load and lab-network checks done)_

**→ Start at [§10 Cloudflare migration](#10-cloudflare-migration-start-here--as-of-2026-10-08-session-11).** §9 (the lab incident) is kept for history; §10 records what the checks found.

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
- ~~Admin panel still lacks an **Exam filter**~~ **DONE** — it exists (`admin.html:675`, applied in `getFiltered()`) and as of 2026-08-09 defaults to the active `exam_id`. The old note would have sent someone rebuilding a shipped feature.

### Known pending features / bugs
- [ ] **MailApp authorization** — email sending silently fails until the teacher manually runs any function calling `MailApp` in the Apps Script editor and approves the permission dialog. One-time step per project.
- [ ] **Encoding of `checkDuplicate` response** — uses `JSON.stringify`. If names are ever included, switch to `safeJson()`.
- [ ] **`duplicateScreen` CSS inconsistency** — uses inline `style="display:none"` instead of the `.active` class pattern. Low priority.

### Admin UX roadmap (agreed 2026-08-09)

Ordering principle: **the panel's failures are information-design failures, not visual ones.** Every settings bug so far (blank paper from an `exam_id` mismatch, 10 questions silently sampled down to 7, 83 ghost rows, a new submission buried at the bottom) was the UI staying silent about something the code already knew. Beautification is deferred until the tool stops misleading; revisit that order only if the system is being demoed to the school, where looks are the buying criterion.

Root cause of the settings panel specifically: **it is the Config sheet rendered as a form** — one field per sheet row, in sheet order. It is organised by storage, not by task, which is why it reads as an undifferentiated wall.

#### Tier 1 — prevents known failures — **DONE 2026-08-09**
- [x] **Live paper preview** at the top of Exam Settings — question count, marks, per-type breakdown, realistic duration, recomputed on every change. Mirrors `Code.gs` filter + sampling maths; verified against the sample paper (10 q / 31 marks, and the 10→7 sampling drop).
- [x] **Diagnostic empty state** — a paper that would be blank says so, lists the `Exam` tags that *do* exist with counts, and offers one-click fixes.
- [x] **Save guard** — saving an exam that is ON but would serve a blank paper requires confirmation.
- [x] **Exam filter defaults to the active exam**; row count states what is hidden.
- [x] **Table defaults to newest-first**; timestamps sort as instants, blank-timestamp rows sink.

**Gotcha found while building this (`fd31ef9`):** the question bank is fetched **lazily** — `loadQuestions()` originally ran only when the Questions panel was first expanded. `allQuestions.length === 0` therefore meant *either* "not fetched yet" *or* "genuinely empty", and the preview reported "No questions exist yet" on every fresh page load. Now tracked explicitly via `questionsLoaded` / `questionsLoading` / `questionsFailed`, and the preview fetches what it needs rather than reporting on absent data. The `failed` flag exists because the `catch` handler calls `updatePaperPreview()`, which would otherwise re-fire the failing request in a loop. **If you add anything else that reads `allQuestions`, check `questionsLoaded` first.**

#### Tier 2 — weekly friction

**Batch 1 — DONE 2026-08-10 (implemented, not yet browser-verified — see §8 item 6):**
- [x] **Regroup Exam Settings by task, not by sheet order.** Implemented as: *This Exam* (active/id/title/subtitle/duration) · *Who Sits It* (classes, set mode) · *How It's Assembled* (IGCSE, sampling) · *What Students See* (set cards) · *Security* (password).
- [x] **Distinguish Exam ID from Exam Title.** Exam ID now lives in its own bordered callout with copy stating it must match the Questions sheet's `Exam` column; Title stays plain/decorative.
- [x] **Hide fields that cannot apply.** Set B/C card-label fields (`#setBCFields`) are hidden (not just dimmed) when Question Sets is Single, toggled live via `applySetModeUI()`. IGCSE-dead sampling fields keep the existing dim+disable but now also show an inline reason.
- [x] **Fix button hierarchy.** Recalculate All Grades / Regrade All MC moved to a separate collapsible **Maintenance** block below Exam Settings. Save Settings is now a sticky bottom bar (`#stickySaveBar`) that only appears once `configDirty` is set — no longer a static button buried at the end of a long scroll.
- [x] **Move the admin password out of the middle of the form**, into its own Security section, with a retype-to-confirm field (client-side only, blocks save on mismatch).

**Batch 2 — DONE 2026-08-10, same session (follow-up polish after seeing batch 1 rendered — see §8 item 7):**
- [x] Exam Active + Exam ID now share one row instead of stacking.
- [x] IGCSE toggle is inline with Randomize/Q-per-set/OE-per-set (was forced full-width) — its description now wraps at column width like OE-per-set's, instead of running the full page width.
- [x] Security is now collapsed by default, click to expand (was always-visible even though rarely touched).
- [x] Class Options is 9 preset checkboxes (`10A`–`12C`) instead of a free-text CSV field — still writes the same `class_options` config key.
- [x] **Recalculate All Grades / Regrade All MC are now exam-scoped** via the toolbar Exam filter, and disabled outright when that filter is "All Exams." This is the one item in this batch that touched `Code.gs` (see §5 Key Changes) — **deployed 2026-08-10, backend now `@10`.**
- [x] Class Options + Question Sets now share one row, matching the Exam Active + Exam ID row above them.

**Still open:**
- [ ] **Replace the 9 native `alert()`/`confirm()` calls** with inline confirmations and a toast stack. Includes the save guard's `confirm()` added in Tier 1 (still marked `TODO (Tier 2)` in `admin.html` — untouched by batch 1).
- [ ] **Responsive layout — there are currently `0` media queries.** A 9-column submissions table is unusable on a tablet; card layout below ~700px.
- [ ] **`randomize_questions` toggle disabled-with-reason** — batch 1 added the reason text for the IGCSE-forced-off case; re-check whether the control itself still ever "reads as broken" outside that case before closing this out.
- [ ] **Replace the magic zeros.** `QUESTIONS PER SET (0 = ALL)` and `OPEN-ENDED PER SET (0 = NO GUARANTEE)` encode logic in their labels — two different meanings of `0` in adjacent fields. A "use all questions" checkbox revealing a number input says it without the riddle.

#### Tier 3 — visual (deferred; do not start before the consolidation below)
- [ ] **Blocker: 135 inline `style="..."` attributes** bypass the 10 CSS custom properties that already exist. Any theming change means hunting 135 sites and missing some. Consolidation is the unavoidable first step of any redesign.
- [ ] Type scale, consistent card/elevation treatment, spacing rhythm.
- [ ] Emoji icons (⚙ 📐 📝) → inline SVG. Emoji render differently per OS and read as unfinished; cheapest credibility win.
- [ ] Dark mode — genuinely useful for late-night marking.

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
- **(session 9)** `handleBulkRecalc(data)` and `handleRegradeAllMC(data)` now take the request `data` and accept an optional `examId`, skipping Submissions rows whose `EXAM_ID` column doesn't case-insensitively match — same pattern as `handleResendEmails`. `Detailed_Answers` has no exam column of its own, so `handleRegradeAllMC` first builds a `validTs` set of timestamps from Submissions filtered by `examId`, then only regrades Detailed_Answers rows whose timestamp is in that set. **Deployed 2026-08-10 — backend `@10`.**

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
- **(session 9, Tier 2 batches 1+2)** Exam Settings regrouped into five sections; Exam ID split visually from Exam Title; Exam Active + Exam ID share a row; Set B/C card-label fields hidden under single-set mode; IGCSE-disabled sampling fields show an inline reason; IGCSE toggle is now inline like its siblings; Security is its own closed-by-default sub-section; Class Options is 9 hardcoded checkboxes (`10A`–`12C`) instead of free-text CSV; Recalculate/Regrade moved to a new Maintenance block, scoped to the toolbar Exam filter, disabled when that filter is "All Exams"; Save Settings is a sticky bar gated on a `configDirty` flag; added a password retype-confirm field.

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

1. [x] **DONE 2026-08-09** — Script Property in the v2 project: `RETAKE_EXEMPT_EMAILS = andres.forero@marymount.edu.co`. Confirmed working: the same account submitted `GK_test` twice.
2. [x] **DONE 2026-08-09** — `clasp push` → `clasp deploy -i AKfycbye…` → **`@7`** (push alone does not move `/exec`)
3. [x] **DONE 2026-08-09** — merged `v2-igcse` → `main` (fast-forward, `f8782b4..9bdfd39`) and pushed. Pages config confirmed `source: {branch: main, path: /}`; build `1141853070` status `built`; live `admin.html` verified **byte-identical** to local v2.
4. [x] **DONE 2026-08-09 — smoke test green.** Verified end-to-end with `sample_exam_general_knowledge.csv`:
   - **Auth (automated):** `?action=config` returns **no** `admin_password` (only the `_required`/`_configured` flags, both `true`); POST `getSubmissions` with no password, a wrong password, and an **unrouted action** all return `{"success":false,"error":"Unauthorized"}` — deny-by-default confirmed live.
   - **Student flow:** full submission graded — 12/31 = 39%, grade 2. MC graded server-side, `short` matched exactly, all five `openEnded` marked against their rubrics with paragraph feedback. Claude correctly rejected the vague seasons answer and caught a CO₂/ozone-layer confusion, i.e. it is genuinely reading the rubric.
   - **`Detailed_Answers`** auto-created with correct headers and one row per question.
   - **Retake exemption** works (two submissions, same account, same exam).
   - **Admin panel** loads submissions with the correct password.
   - **Not yet verified:** results **email delivery** (see MailApp note in *Known pending features*), and that `myresults` returns only the requesting student's own row.
5. [ ] **Irreversible, only after 4 is green — MANUAL, Andrés's personal account:** archive deployments `AKfycby0QSDa…` and `AKfycbxLSz18…`; delete or lock sharing on the old production spreadsheet (real student PII). Cannot be automated from this repo: the old v1 Apps Script project's `scriptId` is unknown (it was never clasp-managed), and the old spreadsheet lives in `anfforerobe@gmail.com`, which is not the account any local tooling is connected to. **Ordering note:** the v1 system is the only rollback path if step 4 fails, so do not destroy it first.
6. [x] **DONE 2026-08-09** — `exam-grader-v2-preview` retired: Pages site deleted (now 404) and repo **archived** (reversible; not deleted). Production Pages unaffected (200).

### Test exam

`sample_exam_general_knowledge.csv` (repo root, **git-ignored on purpose** — see `.gitignore`; this repo is public and Pages serves its root, so a committed mark scheme would be world-downloadable). 10 general-knowledge questions, 31 marks: 2 `mc`, 3 `short`, 5 `openEnded`, all `Set A`, `Exam = GK_TEST`.

To use it: paste the rows under the existing `Questions` header, set Config `exam_id = GK_TEST` (isolates it — a non-empty `Exam` cell only loads when it matches the active `exam_id`; **matched case-insensitively since `965890d`**), raise `exam_duration_minutes` from 15, test, then set `exam_id` back to `0445_Paper4`. The Paper 4 rows stay untouched throughout.

---

## 8. Session 9 wrap-up (superseded — see §9 for the current entry point)

**Status: v2 is live and proven.** Backend at `@10`, frontend on `main` via Pages, full student flow verified end-to-end.

**Housekeeping:** the local repo folder moved from `.../Marymount/D&T Classes/exam-grader` to `.../Marymount/exam-grader` (now a sibling of `D&T Classes`, `Curriculum`, etc., rather than nested under D&T Classes) — no effect on git remote, GitHub Pages, or the Apps Script deployment, all of which are keyed off the repo/project itself, not the local path.

### Session 8 blocking items — resolved 2026-08-10

1. [x] **Submissions sheet cleared** — dev-test ghost rows removed (Andrés, manual).
2. [x] **Results emails confirmed working** — Andrés received the email for the last test exam.
3. [ ] **Rotate the admin password** — still open. Note: hashing the stored password is a `Code.gs` **code change**, not something to do in the sheet — `getAdminPassword()` (Code.gs:136) and `checkAdminAuthResult()` (Code.gs:184) would need to hash with `Utilities.computeDigest` before comparing, and the save path (Code.gs:~1259) would hash before writing. Not yet implemented; for now, "rotate" means just typing a new plaintext value into the admin panel's password field.
4. [ ] **Lock the old v1 spreadsheet** — this is a Google Sheets **sharing-settings** action (Share → Manage access → remove all non-owner collaborators / restrict general access), not a code change. Still blocked on Andrés doing it manually from the `anfforerobe@gmail.com` account (§7 runbook step 5) — no local tooling has access there.
5. [x] **Workbook renamed** to "Exam Grader Production".

### In progress — Admin UX Tier 2 (batch 1, session 9)

6. [ ] **Tier 2 batch 1 implemented, not yet verified in a live browser.** Per the roadmap's own priority order, did in one pass:
   - Regrouped Exam Settings into five task-based sections: *This Exam*, *Who Sits It*, *How It's Assembled*, *What Students See*, *Security*.
   - Exam ID pulled into its own callout, visually distinct from the decorative Exam Title, with explicit copy that it must match the Questions sheet's `Exam` column.
   - Set B/C card-label fields now hidden (not just left inert) when Question Sets is Single; IGCSE-disabled sampling fields now show an inline reason instead of just dimming.
   - Recalculate All Grades / Regrade All MC moved out of Exam Settings into a new separate collapsible **Maintenance** block.
   - Save Settings is now a sticky bottom bar that only appears once a field is actually dirty (`configDirty` flag, mirrors the existing `ppBound` pattern), instead of sitting fixed at the bottom of a long scroll.
   - Added a password retype-to-confirm field (client-side only; blocks save on mismatch, never sent to the server).
   - All changes are in `admin.html` only — no `Code.gs` touched, so no `clasp deploy` needed, just the normal `git push` to `main` for Pages to pick it up.
   - **Verified:** JS syntax check passes, no duplicate element IDs, markup renders (confirmed via local `http.server` + curl). **Not verified:** actual click-through in a browser — no browser automation was available this session. Test before trusting: open `admin.html?src=<prod exec>` locally, toggle Question Sets and IGCSE, edit a field and confirm the sticky bar appears/disappears correctly, try a mismatched password confirm.
   - **Deferred to a later Tier 2 batch** (independent of this restructuring): replace the 9 native `alert()`/`confirm()` calls with inline confirmations/toasts (including the blank-paper save guard, still a native `confirm()`), responsive layout (0 media queries), the magic-zero input redesign.

7. [ ] **Tier 2 batch 2 implemented (same session), on top of batch 1 — also not yet browser-verified.** Follow-up requests after seeing batch 1's screenshots:
   - **Exam Active + Exam ID** now sit in one row (toggle beside the ID callout) instead of stacked.
   - **IGCSE toggle** is now an inline field like Randomize/Q-per-set/OE-per-set (was forced full-width), so its helper paragraph wraps at column width instead of running edge-to-edge.
   - **Security** is now its own collapsed-by-default sub-section inside Exam Settings (click "Security" to expand) — the password fields aren't the first thing visible.
   - **Class Options** changed from a free-text CSV input to 9 preset checkboxes (`10A`–`12C`), hardcoded in `admin.html` (`.cfgClassCheckbox` elements). Still writes the same `class_options` CSV config key, so `grader.html`'s section dropdown is unaffected. **Deliberately not built to scale to other grades/a future sale** — Andrés floated hardcoding 1st–12th now, hidden until needed; agreed that's speculative given the sell-to-school decision is still open and Phase 5's per-teacher-copy model may want per-teacher class lists anyway. Revisit only once that decision is made.
   - **Recalculate All Grades / Regrade All MC are now exam-scoped, not global.** This required a `Code.gs` change (not just `admin.html`): `handleBulkRecalc` and `handleRegradeAllMC` (Code.gs) now take the POST body's `data` and accept an optional `examId`, filtering by the Submissions sheet's `EXAM_ID` column exactly like `handleResendEmails` already did (case-insensitive match). The two buttons read the existing toolbar **Exam filter** (no new dropdown) and send its value as `examId`; **both buttons are disabled outright when the filter is on "All Exams"** — Andrés confirmed he wants a specific exam required, not just a warning, since a mis-scoped bulk rewrite across every exam at once is the exact failure mode being avoided.
   - Follow-up polish (batch 2, same session): Class Options → 9 checkboxes, Exam Active + Exam ID + Question Sets/Class Options paired onto shared rows, IGCSE toggle made inline, Security collapsed by default. See the full batch-2 bullet list in the Admin UX roadmap section below.
   - **DEPLOYED 2026-08-10.** Committed (`36ac15a`), pushed to `main` (Pages picks up `admin.html`/`handoff.md` automatically), and `Code.gs` pushed + deployed via `clasp deploy -i AKfycbye…` → backend now **`@10`**. Verified: JS + Apps Script syntax both check clean via `node --check`. **Still not browser-tested** — no browser automation was available this session. Before trusting it with real data: toggle the Exam filter and confirm the Maintenance buttons enable/disable, run Recalculate against the `GK_TEST` exam and confirm other exams' rows are untouched, click through the regrouped Exam Settings sections.

### Then, to finish the cutover

8. [ ] **Retire v1** — §7 runbook step 5 (same manual action as item 4 above, plus archiving the two old deployments). Unblocked since the smoke test is green.

### Then, product work

9. [ ] **Build a real IGCSE paper** — this is what the system exists for. Turn IGCSE mode back on, use the marking-scheme PDF uploader (`generateRubrics`). Andrés has tried this before; re-verify it end-to-end, it's the one major feature the GK smoke test did **not** exercise.
10. [ ] **Phase 5** — multi-teacher template-copy model + registry.

### Decisions still open
- **Sell to the school or not.** Unresolved, and it changes priorities: it moves Tier 3 visual work up, and makes ownership of the master template, frontend repo and OAuth client urgent (see *Accounts* — the OAuth client is on the work account, everything else on the personal one).
- **Email sender account** — stays personal for now; see §Email sender for why moving to Workspace is risky.

---

## 9. NEXT STEPS (start here — as of 2026-09-27, session 10, IN PROGRESS)

**Live incident, unresolved.** Andrés opened the exam on 26 computers at once in a school computer lab (via Veyon) and every student in that one course got: `Error — Could not connect to the server. Check your internet connection and refresh.`

### What was shipped this session (deployed, backend `@11`, frontend on `main`)

Two changes went out **before** the root cause was confirmed, on the reasonable-but-incomplete theory that this was Apps Script struggling under simultaneous load:

1. **`grader.html`** — `?action=questions` load now retries up to 4× with backoff (1.5s/3s/6s/10s), shows "Server is busy, retrying (n/4)…", and only shows the final error (with a "Try again" button) after all 4 attempts fail. Non-JSON responses are caught explicitly (`fetchQuestionsJson()`) instead of falling into the generic catch.
2. **`Code.gs`** — `getQuestionsResponse()` now reads Config + Questions through a new `readExamSheetsCached_()` helper, cached 30s via `CacheService.getScriptCache()` (key `exam_sheets_v1`, skipped if payload ≥90KB). Per-request shuffling/sampling still happens after the cache read, so randomization is unaffected. **Side effect to remember:** an admin edit to a question or a Config value can now take up to 30s to reach students, where before it was instant.

Ad-hoc curl checks against the live `/exec?action=questions` (both before and after this deploy) showed real variance — some requests ~1-3s, some 26-44s, one outright 404 — confirming the backend genuinely struggles under concurrent load. **But this is not what's hitting Andrés's class** (see below), so the retry/cache changes are a real robustness improvement but did not fix the reported bug.

### Root cause — narrowed, not yet confirmed

Andrés retried on **3 different computers, more than 10 minutes apart** (i.e. not a simultaneous-burst scenario), and got the same failure every time, even after the retry logic was live (Chrome DevTools console showed all 4 retry attempts failing). Console evidence (screenshot, 2026-09-23):

```
Failed to load resource: net::ERR_FAILED   script.google.com/ma…?action=questions
Load attempt N failed: TypeError: Failed to fetch   (at fetchQuestionsJson)
Access to fetch at 'https://script.google.com/macros/s/AKfycbye…/exec?action=questions'
  from origin 'https://workwebsitesmixed.github.io' has been blocked by CORS policy:
  No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

This is a different failure mode than "Apps Script is slow": the browser never received a body to parse — the request itself failed (`net::ERR_FAILED`), and the CORS message is the browser's generic description of *any* failed cross-origin fetch, not proof of an actual missing-CORS-header response from Google. Backend code always sends `success:true/false` JSON with no CORS restriction, and curl from this machine gets clean 200 JSON every time (see 2026-09-23 checks above in git history of this file / conversation). That combination — fails consistently from that lab's computers/network, works fine from elsewhere, "blocked by CORS" on what should be a plain fetch — points at the **school network/computer-lab environment**, not the Apps Script backend:
- A school firewall/content filter blocking or interfering with `script.google.com` / `script.googleusercontent.com` (most likely — explains "every computer in that lab, every time, still failing 10+ min later").
- Less likely: Google rate-limiting that lab's shared public IP after the 26-at-once burst (would expect this to clear well within 10 minutes).
- Also possible but unconfirmed: something specific to that lab's browser/proxy/Veyon image (extension, forced proxy, MITM cert) rather than the network edge itself.

### Diagnostic steps requested, **not yet answered by Andrés**

1. On one of the affected lab computers, open directly in a new tab:
   `https://script.google.com/macros/s/AKfycbyeQbG1xIFVgK6XNeZ1iECYOBll4rv4zrICDPMcj2xGQwhUNvPhkGJN-gAWD4D5M9KeDQ/exec?action=questions`
   — does it return raw JSON, or an error/block page (and which one)?
2. On the same computer, tether to a phone hotspot and reload the exam — does it work? (Isolates "school network" vs. "that computer/browser".)
3. Do Andrés's other courses, on the same lab network, load the exam fine? (Isolates "this lab" vs. "the whole school network".)

### Next actions (in order)

1. [ ] **Get answers to the 3 diagnostic steps above** — nothing else should be attempted until this narrows network vs. Google-throttling vs. local-machine.
2. [ ] **If it's a school network/filter block:** this is not fixable from the codebase. Options: ask school IT to allowlist `script.google.com` and `script.googleusercontent.com`; or have Andrés run the exam from a network that isn't filtered (e.g. mobile hotspot) for that lab.
3. [ ] **If it's Google throttling the lab's shared IP:** consider adding jitter to the initial page load (spread the 26 simultaneous requests over a few seconds) — not yet built, low priority until diagnostics rule the network theory in or out.
4. [ ] **If it's something lab-specific (proxy/extension/Veyon image):** would need IT/Andrés to inspect that machine image directly; nothing to do from this repo.
5. [ ] Once resolved, **decide whether to keep the 30s sheet-read cache** — it's a genuine improvement for concurrent-load robustness independent of this incident, but the "admin edits take ≤30s to land" tradeoff should be a conscious keep, not an accident.
6. [ ] Carry forward all unresolved items from §8 below (admin password rotation, old v1 spreadsheet lockdown, Tier 2 batches 1-2 still not browser-verified, real IGCSE paper build, Phase 5) — none of that changed this session.

---

## 10. Cloudflare migration (START HERE — as of 2026-10-08, session 11)

### Status
Andrés decided to migrate the backend from Apps Script to **Cloudflare Workers + D1 + Queues** (free plan). Target: 60 simultaneous exam starts must work (25 is normal); grading may be slow, access may not. Frontend stays on GitHub Pages (`?src=` points at the backend). **No rewrite has started.** Only throwaway test tooling exists, in `tools/loadtest/` (untracked in git; see Key files). Production (Apps Script `@11`, Pages) is untouched except one temporary file (`labcheck.html`, see Blocked).

### What the checks found
- **Load test (deployed test Worker):** 205/205 requests returned 200. 120 simultaneous `POST /start` (D1 insert): p95 959 ms; 60 simultaneous: p95 542 ms; `GET /exam` p95 ≤ 268 ms. Not measured: CPU time (free plan allows 10 ms/request) — read it in the dashboard (Workers & Pages > examgrader-loadtest > Metrics).
- **Lab network (run `lab1`, 19 of 26 PCs, Windows Chrome/Edge; 7 PCs would not wake remotely):** 0 failures in 57 tries on every address, including `workers.dev` and Apps Script (p50 1.1 s, p95 2.8 s, max 3.6 s). The school network does not block Google, Drive, or `workers.dev` in this lab. The 2026-09-23 failure did **not** reproduce, so its cause is still unknown (unverified guesses: transient Apps Script overload, or the heavier real exam path with `checkDuplicate` + token verification). The burst was only partly simultaneous (reports spread over 49 s) and only requested `?action=questions`.
- **Single-user Apps Script runs earlier the same day:** one Windows PC got 2 timeouts of 15 s out of 3 tries (`?action=questions`).
- **Security gaps found in current `Code.gs`** (the old handoff treated them as done; the new backend must make them real):
  1. `@marymount.edu.co` is not validated server-side: `verifyGoogleToken` (Code.gs:213) checks only `aud`; with no `idToken` the server uses the client's email (Code.gs:781-793); the sheet row stores `data.email` (Code.gs:906), not the verified one.
  2. Total max score is computed from the answers the student sends (Code.gs:890-892): omitting hard questions raises the percentage.
  3. One-attempt guard is read-then-append with no lock (race).
  4. Google's docs say tokeninfo is for debugging, not production.
  5. `GRADING_MODEL = 'claude-sonnet-4-6'`: Anthropic's rate-limits page marks Sonnet 4.x deprecated (the model-deprecations page was not checked).

### Decisions made (and why)
- Migrate to Cloudflare Workers + D1 — Apps Script caps 30 simultaneous executions per user (Google quotas page) and was measured at 26–44 s per request under load.
- **Admin panel is rewritten directly on the Worker**; Google Sheets become export/backup only — Andrés's choice.
- **Results email stays only as a backup relay through Apps Script `MailApp`** — Cloudflare Email Sending is "Not available" on Workers Free; Resend free is 100/day (3,000/month) and was not checked for a domain requirement.
- **A reload mid-exam resumes the same attempt** (attempt row created at `/start`, UNIQUE(exam, email, set)); the submit is authenticated by attempt id, not by the Google token (which expires).
- **Grading model moves to `claude-sonnet-5-5`** in the rewrite (not changed in the current `Code.gs`).
- **Grading:** one Cloudflare Queue message per submission, status column in D1, cron sweep to re-enqueue stuck rows (free-plan queue retention is fixed at 24 h; consumer wall time 15 min, CPU 30 s by default).
- **D1 is the single store; KV is not used** (needs the UNIQUE guard; KV free writes are 1,000/day).
- Questions served as a cacheable `GET /exam` (no `correctIndex`, no rubric); in standard mode, sampling and option order are assigned in `/start` and stored with the attempt; the server grades against the stored list, not what the client sends.
- **Images move off Google Drive** (`drive.google.com/thumbnail` is an undocumented endpoint; one past incident of images not loading in some exams, cause unproven). Content-hash URLs `/img/<hash>` with a year of cache, plus retry on `<img>` error in `grader.html`.
- Cutover: old and new backends run side by side by handing out different `?src=` links per class; rollback = give the old link.

### Next steps (in order)
1. ~~Answers to the four open questions~~ **Done 2026-10-10** (see the update under *Blocked*). ~~Write schema and endpoint spec~~ **Done**: `cloudflare-backend/schema.sql`, `cloudflare-backend/API.md`.
2. **Slice 1 of the real Worker is built and tested locally** in `cloudflare-backend/` (36 passing tests via `npm test`; bundles and answers requests in local `workerd`). **Deployed by Andrés on 2026-10-10** to `https://examgrader-api.marymount-exams.workers.dev` (version `303905f9-d882-4734-a64e-e819b744f6f5`): D1 `examgrader` id `dcf91992-4ec2-40e0-baca-8ab34b9b5426`, R2 bucket `exam-files`, queue `examgrader-grading`, secrets `ANTHROPIC_API_KEY` and `SESSION_SECRET` set, `teachers` seeded with the two emails, cron every minute. No exam or questions exist in the remote D1 yet and no frontend points at it. **Pending:** `SESSION_SECRET` was pasted into the chat by accident on 2026-10-10: rotate it with `npx wrangler secret put SESSION_SECRET` (invalidates open admin sessions only). `wrangler.toml` now sets `preview_urls = false`; redeploy to apply. Slice 2 still to build: images (R2 + `GET /img/<hash>`), PDF jobs as queue jobs, email relay + `resend-emails`, export endpoint, distractors; then slice 3: the frontend adapters in `grader.html`, `admin.html`, `results.html`, and a one-off script that imports an existing exam's Config/Questions from the sheet.
3. Test before relying on it: CPU cost of RS256 Google token verification on the free plan; whether D1 `batch()` counts each statement toward the 50 queries/invocation limit (design with ≤ 5 queries per invocation meanwhile); whether the large-PDF tools (extractQuestions, generateRubrics) fit in 10 ms or must run as queue jobs.
4. ~~Check whether enabling R2 requires a payment method~~ **Confirmed 2026-10-10 (Andrés's screenshot of the activation screen): it does.** Free tier shown: 10 GB-month, 1 M Class A, 10 M Class B; overage $0.015/GB-month, $4.50/M Class A, $0.36/M Class B. Andrés is willing to use a low-balance virtual card; he has not activated it yet (unverified).
5. Remove the temporary test infrastructure when finished (see Gotchas).
6. Carry forward from §8–§9: admin password rotation, locking the old v1 spreadsheet, browser-verifying Tier 2 admin batches, building a real IGCSE paper, Phase 5.

### Blocked / waiting on the user
- **Update 2026-10-10:** (a) answered — Google sign-in with a teachers allowlist, seeded with `andres.forero@marymount.edu.co` and `felipe.velasquez@marymount.edu.co`, more teachers only when it scales; (b) answered — R2, activated by Andrés (no bucket created yet; he may add a budget alert in the R2 billing panel). Still open: (c) autosave and (d) history migration.
- **Four open questions (original wording):** (a) admin access: Google sign-in with a teacher email allowlist (recommended; today there is no login throttling and the password is plaintext) vs shared password; (b) images: R2 (10 GB/month, 1 M Class A, 10 M Class B, free egress) vs D1 BLOB (2 MB per row); (c) server-side autosave of answers every ~30 s (about 7,000 D1 writes per 60-student session vs 100,000/day cap); (d) migrate existing submissions into D1 or keep them in the sheet as archive.
- **`labcheck.html` is committed on `main`** (commit `f786639`, "Add temporary lab check page"; a later update with the report-to-Worker code was meant to be committed too — unverified which commit). Andrés must remove it from `main` when the lab tests end.
- 7 lab PCs could not be tested (remote wake-up failed).

### Key files and commands
- `tools/loadtest/worker/src/index.js` — test Worker: `GET /exam`, `POST /start`, `GET /ping`, `POST /report`, `GET /reports?run=<tag>`.
- `tools/loadtest/worker/{wrangler.toml,schema.sql,package.json}` — config (D1 binding `DB`), tables `attempts` and `lab_reports`, wrangler 4.148.0 installed locally.
- `tools/loadtest/loadtest.mjs` — burst script. `node loadtest.mjs --url https://examgrader-loadtest.marymount-exams.workers.dev --waves 25,60,120 --gap 15`; optional `--baseline <apps script /exec>` (loads production; run outside class).
- `tools/loadtest/labcheck.html` — lab network probe (copy to repo root to publish). Burst mode: `...labcheck.html?run=<tag>&src=<exec url>&worker=<worker url>`; read the aggregate at `<worker>/reports?run=<tag>`. Verdicts: OK, FLAKY, NOCORS (answered without CORS: Apps Script error page OR a filter's block page; the browser cannot tell), UNREACHABLE.
- `tools/loadtest/README.md` — setup and cleanup steps.
- Cloudflare account: `anfforerobe@gmail.com`, account id `86e7f13a45d21c1249dfcf06dc457770`, workers.dev subdomain `marymount-exams` (renamed in the dashboard), Worker `https://examgrader-loadtest.marymount-exams.workers.dev`, D1 `examgrader-loadtest` id `f87eb99e-49f2-4e2e-8403-53cf59c67558` (region ENAM). Test data in run tag `selftest` is a fake report.
- Git: branch `cloudflare-migration` exists (created from `main`, no commits); Andrés is currently on `main` with `tools/` untracked.

### Gotchas
- The workers.dev account subdomain cannot be changed through the API with the wrangler OAuth token (PUT creates only; PATCH rejected). Change it in the dashboard; changing it breaks every URL already handed out.
- `wrangler deploy` auto-registered the subdomain as `examgrader-loadtest` the first time; a new Worker URL takes a few minutes to resolve (about 3 minutes observed).
- A D1 table with a `TEXT PRIMARY KEY` plus a UNIQUE constraint costs 3 rows written per insert (two indexes), not 2. The pricing page says every index adds a written row.
- GitHub Pages takes 1–2 minutes to publish a push; a 404 right after pushing is normal.
- `pkill -f "wrangler dev"` inside a Bash command kills the command's own shell (the pattern matches itself).
- The wrangler login token is stored at `~/.config/.wrangler/config/default.toml`.
- Cloudflare free limits used (all from official pages, fetched 2026-10-08): Workers 100,000 requests/day, 10 ms CPU, 50 subrequests; D1 5 M rows read/day, 100,000 rows written/day, 500 MB per database, 50 queries/invocation; Queues 10,000 operations/day; KV 1,000 writes/day; Apps Script 30 simultaneous executions/user, 100 emails/day (consumer); Anthropic Sonnet 5.5 Start tier 1,000 RPM, 2 M ITPM, 400 k OTPM (new organizations may start on a lower Evaluation tier). Sources: developers.cloudflare.com/{workers/platform/limits,d1/platform/pricing,d1/platform/limits,queues/platform/limits,kv/platform/limits,r2/pricing,email-service/platform/pricing}, developers.google.com/apps-script/guides/services/quotas, platform.claude.com/docs/en/api/rate-limits.
- Cleanup of the throwaway infra: `npx wrangler delete` and `npx wrangler d1 delete examgrader-loadtest` from `tools/loadtest/worker`.

### Log
- 2026-10-13 (day of G11 set B) — Andrés sits G11 set B today on the new backend. Checked: exam `G11_T1_W1-5` is closed in D1 (45 min, 11A/11B/11C, triple mode but only set B has questions; the page skips empty sets, grader.html:729); `main` still serves the OLD grader.html (the v3 pages exist only on `cloudflare-migration`; trial merge into `main` is clean, main only has the extra `labcheck.html`), so a merge to `main` is required before students can use the new link. Built a safety valve for false positives of the integrity rules: `PUT /api/admin/attempts/:id/penalty {penalty 0..4}` + a control in the attempt detail of admin3 (event log kept as evidence; recalculate keeps the chosen value; the detail now shows the stored penalty). 132 tests. Worker must be redeployed for it. Student link: `https://workwebsitesmixed.github.io/exam-grader/grader.html?src=https://examgrader-api.marymount-exams.workers.dev&exam=G11_T1_W1-5`. Still never tried: real Google sign-in on grader.html v3 in a real browser (his own account is retake-exempt, so he can smoke-test it while the exam is closed and delete the attempt afterwards). Relay (email) not activated; after activating it, "Resend emails" in Tools converts already-graded attempts too.
- 2026-10-12 (Sheets archive) — Andrés chose the export to the Sheet. Built `src/export.js` (`GET /api/export/index`, `GET /api/export/exams/:id`, own `EXPORT_KEY` bearer, pages of 25, digest per exam) and `tools/sheet-archive/` (Apps Script bound to a NEW spreadsheet; hourly trigger; two tabs per exam, rewritten only when the digest changed; Plain-text columns so student text is never a formula; menu with Export now / Install trigger / Self test). Decisions: a separate script and spreadsheet (production Code.gs and the old sheet untouched), full rewrite per changed exam rather than append (so overrides/regrades/deletes are reflected). 130 tests; the pure part of the real `Code.gs` is tested in a vm against real endpoint data. **Activation (Andrés):** `openssl rand -hex 24`, `npx wrangler secret put EXPORT_KEY`, `npx wrangler deploy`, then the README steps in `tools/sheet-archive/` (the Self test item must report `SELFTEST OK`; it is the only check that needs a real sheet). Not committed.
- 2026-10-12 (PDF import) — Andrés dropped migrating old exams; the next G10 exam (`exams/10/M2_mock_T1/`, 14 questions, 45 marks, 10 figures `G10_M2_Q<n>_*.png`, mark scheme PDF next to the question PDF) is the test for the PDF tool. Built: `src/claude.js` refactor (`callMessages`, `askModelWithPdf`, 4xx other than auth/429 are now permanent errors with the service's text), `src/jobs.js` (create/run/get job, queue consumer, sweep stops stuck jobs after 20 min), `GET /api/admin/images`, and the **Import from PDF** screen in admin3 (Questions tab): question paper PDF -> review cards (every field editable) -> multi-file figure upload with suggestions by `Q<n>` in the file name (two figures with the same number are NOT guessed) -> optional marking-scheme PDF fills the correct option / accepted answers / rubric -> explicit Import (bulk, paper order kept via position). Extraction prompt = the old one plus `label` (printed number) and `figure` (printed figure label), and sub-parts carry their shared introduction in the text. Bug found while building: CORS preflight did not allow `X-Filename`, so image uploads would have been blocked in a real browser (jsdom does not enforce CORS); fixed and tested. Limitations: one figure per question row (each sub-part gets its own copy of the figure; Q11 of the mock needs Fig. 11.1 on part (a) and Fig. 11.2 on later parts, chosen by hand); MC answer keys come only from the marking scheme and the page refuses to import an MC without a chosen key. 122 tests. **Worker must be redeployed** (`npx wrangler deploy`; no migration needed). Not yet run against the real model: the fake model proves the plumbing, not the quality of the extraction. Not committed (Andrés commits).
- 2026-10-12 (email relay + images) — Andrés asked for result emails for G11 set B and to keep advancing. **Email:** `src/mail.js` (message body ported from `sendResultsEmail`, every student/question string HTML-escaped; relay call with 20 s timeout, never throws). Sent by the once-a-minute sweep (8 per run, parallel), only for graded attempts with `email_status='pending'` whose `deadline_at` has passed (same rule as `/api/result`; otherwise an early finisher would receive the answers during the exam). `POST /api/admin/exams/:id/resend-emails {class?,set?}` sets graded attempts back to pending (409 `email_disabled` without `MAIL_RELAY_URL`); button in admin3 Tools; email state shown in the attempts list. Relay = separate Apps Script project `tools/mail-relay/Code.gs` (+ README with setup): key check, school-domain recipients only, size limits, quota check; the production `Code.gs` is untouched. **To activate:** create the relay project, set its `MAIL_RELAY_KEY` property, `npx wrangler secret put MAIL_RELAY_KEY`, put the `/exec` URL in `MAIL_RELAY_URL` in `wrangler.toml`, `npx wrangler deploy`. Until then `email_status` stays `none`. Quota: MailApp 100 recipients/day on a consumer account, 1,500 on Workspace; failures show as `failed` and can be resent. **Images:** `src/images.js`: `POST /api/admin/images` (raw body, <= 2 MB, type decided from magic bytes, PNG/JPEG/GIF/WebP only, no SVG), stored in R2 as `img/<sha256>`, deduplicated; public `GET /img/<hash>` with `immutable` cache + `nosniff`. admin3 question form: file picker, downscale to <= 1600 px in the browser, preview, remove. Not done: migrating the OLD Drive images of past exams (plan: a tool that downloads them and emits `wrangler r2 object put` + SQL), PDF import / rubric generation jobs, export for the Sheets archive / Raspberry Pi, distractor analysis. 112 tests pass. Committed and pushed to branch `cloudflare-migration` by Claude at Andrés's explicit request (`ae7453f` and later).
- 2026-10-11 (admin panel v3) — Andrés applied `migrations/002_integrity.sql`, rotated `SESSION_SECRET` and redeployed (version 56aa36c9); the live `/api/exam` works. His exam `G11_T1_W1-5` was still `exam_active: true` at that point. Approved option B (new page, old `admin.html` untouched) and built **`admin3.html`** at the repo root: Google sign-in against the `teachers` table, exam selector with open/close switch, tabs Attempts (filters, sorting, integrity column, detail with event timeline and per-question overrides, delete), Questions (add/edit/delete; an edit keeps the attached image hash), Settings (title, duration, type, sets, classes, sampling, default, grade boundaries and set cards per set), Tools (recalculate, regrade MC, similarity report), Teachers (admin role only), New exam. Security choices: backend URL fixed to the production Worker (`?src=` honoured only when the page itself runs on localhost, so a crafted link cannot capture the Google token); all database/student text goes through a `h()` builder using textContent only (tested with markup in a name and an answer). Tested in jsdom against the real Worker: `tests/admin-page.test.js`, 14 tests, 99 total pass. **Not built yet** (need backend pieces): image upload (R2), PDF import / rubric generation, resend emails, export, distractor analysis. Not yet tried in a real browser with real Google sign-in: serve the repo root with `python3 -m http.server 8000` and open `http://localhost:8000/admin3.html`.
- 2026-10-12 (focus rule removed) — At Andrés's request the focus-loss (`unfocus`) rule was removed from `grader.html`: the school computers have one screen, teacher tools such as Veyon can take focus, and he wants students free to think without typing (the rule never measured typing or idleness). Still active: tab hidden, window shrunk below 75% of screen width (split screen), right-click, copy/cut/paste/drop. Known consequence: another window merely overlapping on the same screen, without hiding the tab or resizing, is not detected. 85 tests pass.
- 2026-10-12 (anti-cheat rebuild) — Rules decided with Andrés: copy/cut/paste/drop = fault at once (and blocked); tab leave, window split/overlay/second screen (focus lost > 2 s or window < 75% of screen width) and right-click = first time a warning, then faults; warnings never count; each fault = -1 point (**my assumption**, Andrés gave no number for the non-clipboard faults; one constant `FAULT_POINTS` in `src/integrity.js` and `INTEGRITY` in `grader.html`); the 3rd fault submits the exam (the server does it too). Server derives everything from an events log (`attempts.events` + summary columns); built `src/integrity.js`, `src/similarity.js` (no AI, no tokens), queue job + `/api/admin/exams/:id/similarity`, `tools/integrity-report.mjs`, `migrations/002_integrity.sql`, client rules in `grader.html` (new backend only; old Apps Script path keeps the old rules). 85 tests pass. **Deploy order matters: apply `migrations/002_integrity.sql` to the live D1 BEFORE `wrangler deploy`**, otherwise saves fail on missing columns. Not yet tried in a real browser: the 2 s focus-loss rule may produce false positives (address bar, DevTools, OS pop-ups) and needs a real-device trial. Andrés's earlier real test (second monitor with answers in a PDF, copy/paste) went undetected because the old control only watched tab visibility; the new rules target exactly that.
- 2026-10-12 — Anti-cheat review. Git history shows the old system only ever had the tab-switch control (`visibilitychange`: strike 1 = -1, strike 2 = -3 more, strike 3 = auto-submit); there was never copy/paste, context-menu, fullscreen or blur blocking, so nothing was lost in the adapter. Added `tests/anticheat.test.js` (5 tests, 60 total pass) proving the control works on the new backend through the real page: warning, count stored server-side on each switch, penalty 1/4, auto-submit on strike 3, strikes survive a reload, a client cannot lower its count. Andrés's real test attempt (graded, 57/57, `tab_switches` 0) shows no switch was recorded; he has not said whether he switched tabs. Known limits, unchanged from before: only tab visibility is watched (a second device, split screen or an overlay window do not fire it), it is enforced by the browser, and only the count is kept, not when or for how long. Proposed, not built: per-attempt integrity log (away intervals, paste events) shown to teachers as evidence, and answer-similarity report between classmates. His exam `G11_T1_W1-5` was still `active = 1` after the trial; verify it is closed and `duration_min` is 45.
- 2026-10-11 (results page) — `results.html` adapter: same backend rule as `grader.html` (host `*.workers.dev` or `&api=v3`), POSTs `<base>/api/myresults`; shows only graded exams past their deadline and says so when the list is empty. Old path untouched. 3 jsdom tests (55 total pass). Not yet tried with real Google sign-in. Next: admin panel (decision pending) and images/R2.
- 2026-10-11 — Imported G11 set B (exam id `G11_T1_W1-5`, 10 questions, 57 points, standard mode, 45 min, imported CLOSED) into the live D1 and verified counts. Built the **`grader.html` adapter** (new backend chosen by `?src=` host `*.workers.dev` or `&api=v3`; exam picked with `&exam=<id>`): load from `/api/exam`, `/api/start` (create-or-resume), 30 s autosave, submit with retry, timer from the server deadline, result polling after the deadline, printed-order answer indexes. Old Apps Script path untouched (284 lines added, 1 replaced). Tested in jsdom against the real Worker code (52 tests pass). Bug caught by the tests: the host check compared 11 characters of a 12-character suffix. **Not yet tried in a real browser with real Google sign-in**; steps in `cloudflare-backend/README.md` (last section). Not merged to main, so the live page is unchanged.
- 2026-10-10 (importer) — Built `cloudflare-backend/tools/import-sheet.mjs` (Questions CSV [+ Config CSV] -> reviewed SQL file, self-checked against `schema.sql`, imported CLOSED by default; 45 tests pass). Verified on the local sample exam: 10 questions, 31 points, matching the old figures. Not yet run against the live D1. The real G11 set B exam does not exist yet: Andrés will write it with the exam-set skill (same CSV format), then import it with `--exam <id> --sets B`.
- 2026-10-10 (later) — Deployed slice 1 (see Next steps 2). **CPU measured on the real platform** with a `/bench` endpoint in the throwaway Worker (RS256 verify + ~30 KB JSON parse/serialize; bursts of 25, 60, 120 simultaneous, 205/205 returned 200, 0 errors): Cloudflare analytics reported CPU p50 0.64–0.71 ms and p99 1.39–1.61 ms per request (only 44 of the 205 invocations had appeared in the analytics when read; free-plan limit is 10 ms). Remote smoke test: `/api/exam` 404 exam_not_found (no exam yet), `/api/start` without token 401, `/api/admin/exams` without session 401.
- 2026-10-10 — Decisions closed (admin via Google allowlist, R2 for images, autosave yes, history stays in the sheet); wrote `schema.sql` + `API.md`; built slice 1 of the Worker with tests (see Next steps 2). Spec deviations while building: tab-switch penalty derived server-side (1 switch = 1, 2+ = 4); bulk recalc/regrade paged in chunks of 40 because of D1's 50 queries/invocation; an invalid API key now sets `status='error'` instead of silently scoring 0.
- 2026-10-08 — Read the code and verified the findings above; fetched official limits; built `tools/loadtest/`; created and deployed the test Worker and D1; load test passed; lab burst (19 PCs) showed no network block; decided to migrate; recorded decisions in the project memory.
