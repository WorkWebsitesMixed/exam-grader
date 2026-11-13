# Exam Grader: exam-day runbook

What to check before, during and after an exam on the Cloudflare backend, and what to do when something breaks. Commands run from `cloudflare-backend/`. This file describes what exists today; it grows as the audit phases land (per-student deadlines, health banner, staging and backups are not built yet).

## Day before

1. `npm test` is green.
2. No deploy within 24 hours of an exam. If a deploy is unavoidable, apply any new migration first, then deploy, then run `QUIZ_TEST` end to end.
3. In admin3, open the exam: question count and marks, every figure loads, the class list is not empty, the opening window and duration are right.
4. Anthropic Console: the credit balance covers the exam. After the first exams graded with this version, the Attempts tab shows the tokens each exam used ("AI grading so far"), which is the number to size this with.

## 30 minutes before

1. The exam is `active` and its window is correct.
2. Open the student link in a private window and check that it reaches the sign-in screen.

## During

1. Attempts tab: the number of attempts started matches the students present.
2. A student locked out or on the wrong set: open her attempt, read the integrity timeline, delete the attempt only if she must start again.
3. Extra time for one student: open her attempt in Attempts (status In progress) and use "Add time". Her page picks it up within about a minute. A later Settings save no longer undoes it. Add the time BEFORE hers runs out; once the sweep has submitted the attempt (2.5 minutes after her deadline) it cannot be extended.

## At the hard stop

1. The sweep submits unfinished attempts about one minute after the deadline. Wait two to three minutes.
2. Attempts that stay "In progress" after that had nothing saved; decide those by hand.
3. Watch Submitted become Graded. With a whole class this takes several minutes: five attempts are graded at a time.

## After

1. **Errors.** If the Errors count is not zero, read the message on one of them, fix the cause, then press "Regrade N in error" in the Attempts tab.
   - "API key missing or invalid" or "Grading service error 4xx" with a credit message: fix the key or add credit in the Anthropic Console first.
   - "Stopped after 5 tries": the grading service was unavailable five times in a row. Regrading is safe; questions already graded in an earlier try are not paid for again.
2. **To review.** Attempts marked "N to review" have a question the AI could not grade (the reply was cut, declined, or had no score). It counts 0 and the student sees "Your teacher will mark this question" until you enter a score for it in the attempt.
3. **Wrong rubric or accepted answer.** Correct the question, then open each affected attempt and press "Grade again with AI". For a wrong multiple-choice key use Tools, "Regrade multiple choice" (no AI).
4. Results and emails are released at each student's own deadline.

## If it breaks

| Symptom | What to do |
|---|---|
| Students see "Could not reach the server" | `npx wrangler tail` to see the errors. If it started right after a deploy: `npx wrangler rollback`. |
| Saves fail after a deploy | A migration was not applied. Apply it (`npx wrangler d1 execute examgrader --remote --file=migrations/<file>.sql`) or roll back. |
| Grading does not advance | Nothing is lost: attempts stay Submitted. Check the Anthropic status page and the credit balance. The sweep re-enqueues attempts that have waited 30 minutes. |
| Many attempts in Error | See "After", step 1. |
| Error 1027 for everyone | The daily request limit of the free plan was reached. It resets at 00:00 UTC. Upgrading the plan in the Cloudflare dashboard should lift it (not tested). |
| Data damaged | D1 Time Travel restores to any minute of the last 7 days on the free plan (`npx wrangler d1 time-travel restore examgrader --timestamp=<unix seconds>`). |

## Deploying

1. `npm test`.
2. New migration, if any: `npx wrangler d1 execute examgrader --remote --file=migrations/<file>.sql`. Migrations only add columns, so the Worker that is live keeps working.
3. `npx wrangler deploy`.
4. Run `QUIZ_TEST`: start, answer, submit, wait for the grade, open the result.
5. Roll back with `npx wrangler rollback` if step 4 fails.

## Secrets

Set with `npx wrangler secret put <NAME>`; none is stored in the repo.

| Secret | Effect of rotating it |
|---|---|
| `SESSION_SECRET` | Every teacher is signed out and signs in again. Nothing else. |
| `ANTHROPIC_API_KEY` | None, if the new key is valid. Attempts that failed with the old key: "Regrade N in error". |
| `MAIL_RELAY_KEY` | Must be changed on both sides (Worker secret and the relay's script property), or emails fail. |
| `EXPORT_KEY` | Must be changed on both sides (Worker secret and the Sheets archive script). |
