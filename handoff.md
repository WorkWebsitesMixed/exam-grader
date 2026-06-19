# Exam Grader — Handoff Document

_Last updated: 2026-06-10 (session 6)_

---

## 1. The Goal

An AI-powered online exam system for Marymount school (Bogotá, Colombia), D&T classes. Students take timed exams in the browser; multiple-choice questions are graded server-side; open-ended questions are graded by Gemini AI. Teachers manage everything (questions, settings, overrides) through an admin panel. The system must prevent cheating, handle duplicate submissions, and email results automatically.

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

### Immediate
- [ ] **Deploy updated Code.gs** (session 5 + 6 fixes) — requires a new web app version (Deploy → Manage deployments → New version). After deploying: run **Regrade All MC** to fix MAX_SCORE/AI_FEEDBACK columns (session 5), and add the 9 `set_*` keys to the Config sheet or just Save Settings once from the admin panel (session 6).

### In progress / agreed but not yet built

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

- **Never send `correctIndex` to the client.** MC grading is 100% server-side.
- **`CorrectIndex` in the Questions sheet is 1-based (1=A … 4=D).** Code subtracts 1 before indexing. Writing 0 → cidx=−1 → `undefined` → every answer marked wrong. This has burned us twice.
- **`Exam_Grading.csv` CorrectIndex is also 1-based** — matches what the sheet expects. Do not revert to 0-based.
- **Always use `safeJson()` for responses containing user-entered text** (names, answers, feedback). Plain status responses can use `JSON.stringify()`. Accented characters (é, á, ó) will garble otherwise.
- **`appShell` must be visible before `renderTable()` in admin.html.** The chart reads `clientWidth` — if hidden, it draws at 0px.
- **Every `Code.gs` change requires a new web app deployment.** URL does not change; bump the version in Apps Script editor.
- **All JS in `Code.gs` must be ES5-compatible** (Google Apps Script runtime). No `const`/`let`, no arrow functions, no template literals.
- **Admin password checked on every admin POST** — never cache beyond `sessionStorage`.

### Known data state
- Google Client ID: `878760918876-psduvcg9tsudtggqoqk0cf02n63d5mou.apps.googleusercontent.com`
- Domain restriction: `hd: 'marymount.edu.co'` in `grader.html` and `results.html`
- Grade boundaries hardcoded as fallback in `GRADE_BOUNDARIES`; overridden at runtime by `grade_boundaries_A/B/C` in Config sheet
