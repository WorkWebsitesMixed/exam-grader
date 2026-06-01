# Exam Grader — Handoff Document

_Last updated: 2026-06-01 (session 3)_

---

## 1. The Goal

An AI-powered online exam system for Marymount school (Bogotá, Colombia), D&T classes. Students take timed exams in the browser; multiple-choice questions are graded server-side; open-ended questions are graded by Gemini AI. Teachers manage everything (questions, settings, overrides) through an admin panel. The system must prevent cheating, handle duplicate submissions, and email results automatically.

---

## 2. Current State

### What exists and works
- **Full student exam flow:** Google Sign-In (restricted to `@marymount.edu.co`) → set selection (A/B/C) with preview modal → student info form → timed exam → submission → AI grading → results screen.
- **Anti-cheating system:** Tab switch penalties (−1pt, −3pts, auto-submit on 3rd switch). Penalty capped at 4 server-side.
- **Timer:** Wall-clock based, persists across page refresh via `sessionStorage`. Results are held until timer hits 00:00 even if the student submits early.
- **MC grading:** Fully server-side. `correctIndex` is never sent to the client.
- **Open-ended grading:** Gemini 2.5 Flash with retry logic (429/503).
- **Results email:** HTML email sent to student's school address after submission via `MailApp`.
- **Student results page (`results.html`):** Students can review all past submissions with AI feedback and correct MC answers.
- **Admin panel (`admin.html`):** Password-protected. Grade distribution chart (grouped by final grade per set), class analysis, MC distractor analysis, grade override, exam settings, grade boundaries editor, question manager (add/edit/delete without touching the sheet), bulk recalculate, delete submission.
- **Question randomization and bank sampling** (`randomize_questions`, `questions_per_set`, `oe_per_set` in Config sheet) work independently.

### Accomplished in this session
- **Fixed duplicate submission UX (Option B):** Previously the duplicate check only fired server-side on final submission — the student would sit through the entire exam only to see a "Already Submitted" message at the very end.
  - Added `handleCheckDuplicate()` function to `Code.gs`, dispatched via `data.action === 'checkDuplicate'`.
  - Modified `startExam()` in `grader.html` to call this endpoint before showing questions or starting the timer.
  - If duplicate is detected: the student sees the blocked screen immediately after clicking "I Understand — Start Exam", before any questions or timer appear.
  - If the network call fails: the button re-enables and an error message prompts the student to retry (server-side duplicate guard still acts as final safety net).
  - **Requires a new Apps Script deployment to take effect.**

- **Guaranteed OE question count (`oe_per_set`):** Setting `questions_per_set = 10` without a type guarantee would always yield all-MC questions if the bank is mostly MC. Added `oe_per_set` config key so teachers can specify an exact OE count.
  - New sampling logic in `getQuestionsResponse()`: when both `questions_per_set > 0` and `oe_per_set > 0`, the bank is split into MC and OE pools; exactly `oe_per_set` OE questions are drawn first (capped at pool size), remaining slots fill with MC, then the combined set is shuffled if randomize is on. When `oe_per_set = 0`, the original behavior is preserved (backward compatible).
  - `oe_per_set = 0` added to `createConfigSheet()` defaults.
  - Admin panel ⚙ Exam Settings: new "Open-Ended per Set" number input with a hint explaining it only activates when Questions per Set > 0. Reads and saves via the existing config flow.
  - **Requires a new Apps Script deployment to take effect.**

- **MC Distractor Analysis panel:** New 🎯 collapsible panel in admin panel showing, per MC question, how many students picked each option. Helps identify widespread misconceptions.
  - Backend: `handleMcDistractors()` in `Code.gs` — reads Questions sheet for option texts and correct answer, tallies `STUDENT_ANSWER` from Detailed_Answers sheet, returns per-question option counts. Added to admin auth guard and dispatch in `doPost`.
  - Frontend: lazy-loads on panel open, set tabs (A/B/C), horizontal colored bars per option (green = correct, red = wrong), count + percentage, hover tooltip for full option text, skipped count, Refresh button.
  - **Requires a new Apps Script deployment to take effect.**

- **Grade Distribution chart:** Replaced the old "Score Distribution" percentage-bucket chart with a "Grade Distribution" chart. X-axis now shows actual grade values (1.0, 1.7, 2.3, etc.) collected dynamically from the data and sorted numerically. Grouped bars by set. No backend changes — `finalGrade` was already in the submissions response.

---

## 3. Open Tasks

### Immediate
- [ ] **Deploy new Code.gs version** — both the `checkDuplicate` action and the `oe_per_set` sampling logic require a new web app version deployed in the Apps Script editor (Deploy → Manage deployments → New version).

### Known pending features / bugs
- [ ] **Sets A and B have no questions yet** — the question bank only has Set C data (25 MC + 5 OE = 100 pts). Sets A and B need questions added via the admin Questions panel or directly in the sheet.
- [ ] **MailApp authorization** — email sending silently fails until the teacher runs a function that calls `MailApp` in the editor and approves the permission dialog. This is a one-time manual step per Apps Script project.
- [ ] **Encoding of `checkDuplicate` response** — currently uses `JSON.stringify` (fine, since it contains no user text). If names are ever included in the response, switch to `safeJson()`.
- [ ] **`duplicateScreen` is not in the CSS `display:none` list** — it uses inline `style="display:none"` which works, but is inconsistent with other screens managed via `.active` class. Low priority cosmetic issue.

---

## 4. Relevant Files & Tool Calls

| File | Path | Role |
|---|---|---|
| `Code.gs` | `exam-grader/Code.gs` | Google Apps Script backend — all server logic, grading, sheet I/O |
| `grader.html` | `exam-grader/grader.html` | Student-facing exam page |
| `results.html` | `exam-grader/results.html` | Student results history page |
| `admin.html` | `exam-grader/admin.html` | Teacher admin panel |
| `index.html` | `exam-grader/index.html` | Landing page (GitHub Pages) |

### Changes made this session

**`Code.gs`**
- Added dispatch line in `doPost`: `if (data.action === 'checkDuplicate') { return handleCheckDuplicate(data); }` (just before the admin actions block, ~line 521)
- Added `handleCheckDuplicate(data)` function before `handleSubmission()` (~line 554): verifies JWT, looks up email+set in Submissions sheet, returns `{duplicate: true/false}`
- Replaced the question bank sampling block in `getQuestionsResponse()` with a two-branch approach: when `oe_per_set > 0`, splits into typed pools and draws exact counts; otherwise falls through to the original logic
- Added `oe_per_set = 0` row to `createConfigSheet()` defaults

**`grader.html`**
- Replaced synchronous `startExam()` function (~line 878) with an async version that: validates fields, disables the button, POSTs `{action: 'checkDuplicate', idToken, email, set}`, then either shows the duplicate screen or proceeds to start the exam.

**`admin.html`**
- Added "Open-Ended per Set" `<input type="number" id="cfgOePerSet">` to the ⚙ Exam Settings config grid, with a hint note
- Added `cfgOePerSet` read in `applyConfig()` and write in `saveConfig()`

---

## 5. Blockers & Notes

### Critical rules to preserve
- **Never send `correctIndex` to the client.** MC grading must remain 100% server-side. The Questions sheet column exists but is deliberately stripped in `getQuestionsResponse()`.
- **Always use `safeJson()` for responses containing user-entered text** (names, answers, feedback). Plain status/error responses can use `JSON.stringify()`. Accentuated characters (é, á, ó) will garble otherwise.
- **`appShell` must be visible before `renderTable()` in admin.html.** The score distribution chart reads `clientWidth` — if the container is hidden when the chart renders, it draws at 0px width.
- **`questions_per_set`, `oe_per_set`, and `randomize_questions` are all independent config flags.** `oe_per_set` only activates when `questions_per_set > 0`; `randomize_questions` applies to both sampling paths.
- **Every `Code.gs` change requires a new web app deployment.** The URL does not change, but the version must be bumped manually in the Apps Script editor.

### Architecture constraints
- All JS must be ES5-compatible (Google Apps Script runtime). No `const`/`let` in Code.gs, no arrow functions, no template literals.
- No npm/Node. HTTP calls use `UrlFetchApp`, email uses `MailApp`, storage is Google Sheets via `SpreadsheetApp`.
- All pages are static HTML connected to the backend via `?src=<APPS_SCRIPT_URL>` query param.
- Admin password is checked on every admin POST — never cache it client-side beyond `sessionStorage`.

### Known data state
- ~20 fake test submissions in the Submissions sheet (for UI testing).
- Set C questions: 25 MC (2 pts each) + 5 OE (10 pts each) = 100 pts max.
- Google Client ID: `878760918876-psduvcg9tsudtggqoqk0cf02n63d5mou.apps.googleusercontent.com`
- Domain restriction: `hd: 'marymount.edu.co'` in both `grader.html` and `results.html`.
