# Sheets archive (Apps Script)

A readable copy of the exam results in Google Sheets, refreshed every hour from the Cloudflare Worker. The live data stays in Cloudflare; the production exam script is not touched.

## Setup (once)

1. **Worker side.** From `cloudflare-backend/`:
   ```bash
   openssl rand -hex 24          # copy the output; you need it twice
   npx wrangler secret put EXPORT_KEY   # paste it when prompted
   npx wrangler deploy
   ```
2. **New spreadsheet.** In Google Sheets create a blank spreadsheet named `Exam Grader Archive`. Use the school account that should own the archive.
3. **Script.** In that spreadsheet: **Extensions -> Apps Script**. Replace `Code.gs` with `tools/sheet-archive/Code.gs` from this repo and save.
4. **Properties.** Project Settings (gear) -> **Script properties** -> add:
   - `EXPORT_URL` = `https://examgrader-api.marymount-exams.workers.dev`
   - `EXPORT_KEY` = the same value as in step 1
5. **Authorize and test.** Reload the spreadsheet; a menu **Exam archive** appears. Run, in this order:
   1. **Self test (formula safety)** -> the Apps Script log must say `SELFTEST OK`.
   2. **Export now** -> one pair of tabs per exam appears.
   3. **Install hourly trigger**.

## What you get

For each exam with attempts: a tab `<exam id>` (one row per student: scores, grade, faults, warnings, time away, pastes, email status) and a tab `<exam id> answers` (one row per question: the question, the answer, the correct answer, score, feedback, whether you overrode the score).

An exam is rewritten only when it changed (new attempt, regrade, override, deletion). A run that hits Apps Script's time limit simply continues next hour.

## Notes

- Student answers are written to **Plain text** columns so that text starting with `=`, `+`, `-` or `@` is never evaluated as a formula. The self test checks this on your sheet.
- Do not edit the exported tabs: they are overwritten. Make your own tab with formulas that read from them.
- The old history stays in the old spreadsheet. This archive only contains attempts taken on the Cloudflare backend.
- Rotating the key: run `npx wrangler secret put EXPORT_KEY` again and update the `EXPORT_KEY` script property.

## Pulling the same data from another machine (for example the Raspberry Pi)

The Worker routes are plain HTTPS with a bearer key, so any machine can fetch them:

```bash
KEY=...   # the EXPORT_KEY value; keep it in a file readable only by you
BASE=https://examgrader-api.marymount-exams.workers.dev
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/export/index"
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/export/exams/G10_M2_T1?limit=25&after="
```

Follow `nextAfterId` until it is `null`. The JSON contains student names, emails and answers: store it with the same care as the sheet.
