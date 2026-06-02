# Exam Grader — Handoff Document

_Last updated: 2026-06-02 (session 4)_

---

## 1. The Goal

An AI-powered online exam system for Marymount school (Bogotá, Colombia), D&T classes. Students take timed exams in the browser; multiple-choice questions are graded server-side; open-ended questions are graded by Gemini AI. Teachers manage everything (questions, settings, overrides) through an admin panel. The system must prevent cheating, handle duplicate submissions, and email results automatically.

---

## 2. Current State

### What exists and works
- **Full student exam flow:** Google Sign-In (restricted to `@marymount.edu.co`) → set selection (A/B/C) with preview modal → student info form → timed exam → submission → AI grading → results screen.
- **Anti-cheating system:** Tab switch penalties (−1pt, −3pts, auto-submit on 3rd switch). Penalty capped at 4 server-side.
- **Timer:** Wall-clock based, persists across page refresh via `sessionStorage`. Results are held until timer hits 00:00 even if the student submits early.
- **MC grading:** Fully server-side. `correctIndex` is never sent to the client. `CorrectIndex` in the CSV/Questions sheet is **1-based** (1=A, 2=B, 3=C, 4=D); code converts with `cidx = Number(qr[10]) - 1` before indexing into the 0-based options array.
- **Open-ended grading:** Gemini 2.5 Flash (`gemini-2.5-flash`) with retry logic (429/503). Prompt explicitly instructs the model to award partial marks and comment directly on what the student wrote (not re-explain the concept). `maxOutputTokens: 500`.
- **Gemini API key:** Stored in Apps Script Script Properties under key `GEMINI_API_KEY`. Never hardcoded. Read at runtime via `PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')`.
- **Results email:** HTML email sent to student's school address after submission via `MailApp`.
- **Student results page (`results.html`):** Students can review all past submissions with AI feedback and correct MC answers.
- **Admin panel (`admin.html`):** Password-protected. Grade distribution chart, class analysis, MC distractor analysis, grade override, exam settings, grade boundaries editor, question manager, bulk recalculate, Regrade All MC, Reload submissions, delete submission.
- **Question randomization and bank sampling** (`randomize_questions`, `questions_per_set`, `oe_per_set` in Config sheet) work independently.
- **Duplicate guard:** `email + set` — blocks re-submission of the same set. This key will expand to `email + set + exam_id` once multi-exam support is built (see Next Features).

### Accomplished in session 4

#### API key security fix
- Removed hardcoded Gemini API key from `Code.gs`. Key was publicly exposed in git, causing Google to revoke it (all OE grading returned 403 errors).
- Key now lives in Apps Script Script Properties (`GEMINI_API_KEY`). To set: Apps Script editor → ⚙ Project Settings → Script Properties → Add `GEMINI_API_KEY`.
- Added explicit 403 branch in `callGeminiAPI`: returns `SCORE: 0 / FEEDBACK: Grading unavailable (API key not configured or invalid)` instead of the generic error.

#### OE grading prompt improvements
- Prompt now explicitly says "Award partial marks when the rubric says to" — fixes cases where students with a partially correct answer were receiving 0/max.
- FEEDBACK instruction changed to "comment directly on what this student wrote — what they got right and/or wrong" — stops Gemini from re-explaining the concept instead of evaluating the answer.
- `maxOutputTokens` raised from 400 → 500 to prevent mid-sentence truncation.

#### CorrectIndex off-by-one fix (critical bug)
- **Bug:** `questionMap[qid] = {correctText: opts[cidx]}` was using the raw CSV value (1-based) as a 0-based array index, so every question's `correctText` pointed to the option one position past the correct one. CorrectIndex=4 gave `opts[4] = undefined`, so those questions could never be marked correct.
- **Fix:** `var cidx = Number(qr[10]) - 1;` in `handleSubmission` (line ~649) and in the new `handleRegradeAllMC`.
- This bug predated session 4; all prior MC grading was incorrect.

#### Question bank CSV updated
- Removed 4 questions about thermistor and trimmer: `C_MC04` (NTC definition), `C_MC08` (trimmer purpose), `C_MC12` (trimmer resistance effect), `C_OE03` (NTC thermistor OE).
- Filled in `CorrectIndex` (1-based) for all 19 remaining MC questions.
- File: `/home/andresforero/Documents/Marymount/10th planning/Project/Exam Grading - Questions.csv`

#### Admin panel — Regrade All MC button
- Purple button next to "Recalculate All Grades" in the ⚙ Exam Settings panel.
- Calls `action: 'regrademc'` → `handleRegradeAllMC()` in `Code.gs`.
- Reads current correct-answer key from Questions sheet, re-evaluates every MC row in Detailed_Answers (updates `Correct_Answer`, `Is_Correct`, `AI_Score`, `AI_Feedback` columns), tallies new MC score per submission (matched by timestamp), writes new `MC_SCORE` to Submissions, then runs `recalcRow` to update `Total_Score`, `Percentage`, `Final_Grade`.
- Shows confirmation dialog, disables button while running, reports count of regraded submissions, reloads the table when done.

#### Admin panel — Reload button
- Small secondary button in the submissions toolbar, left of "Export CSV".
- Calls `loadSubmissions()` without a full page refresh — useful after regrading or when new submissions come in during an exam session.
- Fixed `loadSubmissions()` to `return` its promise (was missing), so `.finally` works correctly in both Reload and Regrade flows.

---

## 3. Open Tasks

### Immediate
- [ ] **Deploy new Code.gs version** — API key fix, CorrectIndex fix, `handleRegradeAllMC`, and `regrademc` action all require a new web app deployment (Deploy → Manage deployments → New version).

### In progress / agreed but not yet built

#### Resend Results Emails button
- **Agreed design:** Button in the submissions toolbar. Respects the current class, set, and **date** filters (date filter to be added alongside this feature). Shows "Send X emails?" confirmation before firing.
- Backend: new `action: 'resendEmails'` → reads Submissions + Detailed_Answers, reconstructs the same HTML email body used at submission time, calls `MailApp` for each filtered row.
- MailApp quota: 100/day (free Gmail), 1500/day (Workspace). Confirm dialog should show the count so the teacher is aware.
- Not yet implemented.

#### Multi-exam support (Option A — single spreadsheet)
**Architecture decided:**
- Add `exam_id` config key (e.g. `exam_LDR`, `exam_transistors`). Teacher changes this in ⚙ Exam Settings before each new exam.
- Add `Exam` column to Questions sheet — questions are filtered by the active `exam_id` when serving to students.
- Add `EXAM_ID` column to Submissions sheet — all new submissions tagged with the active `exam_id`.
- Duplicate guard changes from `email + set` to `email + set + exam_id`.
- Admin panel gets an Exam filter (alongside class/set). Stats (chart, class analysis, distractor analysis) respect the active exam filter. Old submissions stay visible but filtered.
- Sets A/B/C remain independent per exam (Exam 1 has its own A/B/C, Exam 2 has its own A/B/C).
- One URL for students all term — teacher just changes `exam_id` in Config between exams.
- **Not yet implemented.** This is the next major feature to build.

### Known pending features / bugs
- [ ] **Sets A and B have no questions yet** — question bank only has Set C data. Sets A and B need questions added via the admin Questions panel or directly in the sheet.
- [ ] **MailApp authorization** — email sending silently fails until the teacher runs a function that calls `MailApp` in the editor and approves the permission dialog. One-time manual step per Apps Script project.
- [ ] **Encoding of `checkDuplicate` response** — currently uses `JSON.stringify`. If names are ever included in the response, switch to `safeJson()`.
- [ ] **`duplicateScreen` CSS inconsistency** — uses inline `style="display:none"` instead of the `.active` class pattern used by other screens. Low priority cosmetic issue.

### Future feature — New question types (not yet started, needs design decisions)
Three new server-side-graded question types discussed and agreed on in principle:
- **True/False** — treat as 2-option MC (CorrectIndex 1=True, 2=False), flows through existing MC pipeline.
- **Fill in the Blank** — single-line text input; teacher defines comma-separated accepted answers; server grades by normalizing (trim + lowercase).
- **Numeric with tolerance** — number input; teacher sets correct value and tolerance margin; server checks `|student − correct| ≤ tolerance`.

**Open design questions:**
1. Should FITB/numeric scores add to the existing "MC Score" column (no schema change) or should that column be renamed "Auto Score"?
2. Should `oe_per_set` sampling treat TF/FITB/numeric as MC (non-OE slots), or can teachers guarantee minimums of specific types?

---

## 4. Relevant Files & Tool Calls

| File | Path | Role |
|---|---|---|
| `Code.gs` | `exam-grader/Code.gs` | Google Apps Script backend — all server logic, grading, sheet I/O |
| `grader.html` | `exam-grader/grader.html` | Student-facing exam page |
| `results.html` | `exam-grader/results.html` | Student results history page |
| `admin.html` | `exam-grader/admin.html` | Teacher admin panel |
| `index.html` | `exam-grader/index.html` | Landing page (GitHub Pages) |
| `Exam Grading - Questions.csv` | `/home/andresforero/Documents/Marymount/10th planning/Project/` | Source of truth for question bank (Set C only). Import via admin Questions panel or paste into sheet. |

### Key changes by file (cumulative across all sessions)

**`Code.gs`**
- `GEMINI_API_KEY` read from `PropertiesService`, never hardcoded
- `callGeminiAPI`: explicit 403 branch with clear error message; `maxOutputTokens: 500`
- `gradeWithGemini`: improved prompt — partial marks instruction, feedback must reference student's specific answer
- `var cidx = Number(qr[10]) - 1` in `handleSubmission` (CorrectIndex off-by-one fix)
- `handleRegradeAllMC()`: re-grades all MC from current question key, updates Detailed_Answers + Submissions
- `'regrademc'` added to admin auth guard array and `doPost` dispatch
- `handleCheckDuplicate(data)`: verifies JWT, checks email+set in Submissions, returns `{duplicate: true/false}`
- `handleMcDistractors()`: tallies student answers per MC option, returns option counts with correct flag
- `oe_per_set` sampling: when `oe_per_set > 0`, splits bank into typed pools and draws exact OE count first
- `oe_per_set = 0` added to `createConfigSheet()` defaults

**`grader.html`**
- `startExam()` is async: POSTs `checkDuplicate` before showing questions or starting timer; shows duplicate screen immediately on match; re-enables button on network error

**`admin.html`**
- Regrade All MC button (purple, ⚙ Settings panel) → `regradeAllMC()` → `action: 'regrademc'`
- Reload button (toolbar) → `reloadSubmissions()` → `loadSubmissions()` without page refresh
- `loadSubmissions()` now returns its promise (was missing `return`)
- "Open-Ended per Set" input added to ⚙ Exam Settings; wired into `applyConfig()` and `saveConfig()`
- 🎯 MC Distractor Analysis collapsible panel (set tabs, lazy load, horizontal bars, green=correct/red=wrong)
- Grade Distribution chart: x-axis shows actual grade values sorted numerically, grouped bars by set

---

## 5. Blockers & Notes

### Critical rules to preserve
- **Never send `correctIndex` to the client.** MC grading must remain 100% server-side.
- **`CorrectIndex` in Questions sheet is 1-based (1=A … 4=D).** Always subtract 1 before indexing into the 0-based options array. This is easy to get wrong — it caused a major grading bug.
- **Always use `safeJson()` for responses containing user-entered text** (names, answers, feedback). Plain status/error responses can use `JSON.stringify()`. Accentuated characters (é, á, ó) will garble otherwise.
- **`appShell` must be visible before `renderTable()` in admin.html.** The chart reads `clientWidth` — if hidden, it draws at 0px width.
- **`questions_per_set`, `oe_per_set`, and `randomize_questions` are all independent.** `oe_per_set` only activates when `questions_per_set > 0`.
- **Every `Code.gs` change requires a new web app deployment.** URL does not change, but version must be bumped manually in the Apps Script editor.

### Architecture constraints
- All JS must be ES5-compatible (Google Apps Script runtime). No `const`/`let` in `Code.gs`, no arrow functions, no template literals.
- No npm/Node. HTTP calls use `UrlFetchApp`, email uses `MailApp`, storage is Google Sheets via `SpreadsheetApp`.
- All pages are static HTML connected to the backend via `?src=<APPS_SCRIPT_URL>` query param.
- Admin password is checked on every admin POST — never cache beyond `sessionStorage`.

### Known data state
- Set C questions: 19 MC + 5 OE (thermistor/trimmer questions removed). `CorrectIndex` filled in for all MC questions.
- Sets A and B: no questions yet.
- Google Client ID: `878760918876-psduvcg9tsudtggqoqk0cf02n63d5mou.apps.googleusercontent.com`
- Domain restriction: `hd: 'marymount.edu.co'` in both `grader.html` and `results.html`.
