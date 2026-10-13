/**
 * Code.gs -- Google Sheets archive of the Cloudflare exam results.
 *
 * What it is: a script bound to a NEW spreadsheet ("Exam Grader Archive").
 * On a time trigger it asks the Worker which exams changed and rewrites two
 * tabs per exam:
 *     <exam id>            one row per attempt (scores, grade, integrity summary)
 *     <exam id> answers    one row per question per attempt
 * The live data stays in Cloudflare D1; this sheet is the readable copy for
 * teachers and an archive that does not depend on Cloudflare.
 *
 * Why a separate project: the production exam script is not touched. This one
 * only READS from the Worker (GET with a key) and writes to its own sheet.
 *
 * How it works, in short:
 *   1. GET <worker>/api/export/index           -> exams + a digest each
 *   2. skip exams whose digest equals the one stored at the last run
 *   3. GET <worker>/api/export/exams/<id>?after=...  (pages of 25) -> all attempts
 *   4. clear and rewrite the exam's tabs in one go (so overrides, regrades and
 *      deleted attempts are reflected; nothing is appended twice)
 *   5. store the new digest only after the tabs were written
 *
 * Safety: student answers are untrusted text. Text columns are formatted as
 * Plain text BEFORE writing, so a value such as =IMPORTXML(...) is stored as
 * text and never evaluated. Run selfTest() once to confirm this on your sheet.
 *
 * Setup: see README.md in this folder.
 */

var TZ = 'America/Bogota';
var TIME_BUDGET_MS = 4.5 * 60 * 1000;   // Apps Script stops a run at 6 minutes; resume next run
var MAX_CELL = 40000;                   // Sheets allows 50,000 characters per cell

var SUMMARY_HEADERS = [
  'Attempt ID', 'Started', 'Submitted', 'Graded', 'Exam', 'Set', 'Email', 'First name', 'Last name', 'Class',
  'Status', 'MC score', 'Open score', 'Penalty', 'Total', 'Max', 'Percentage', 'Grade',
  'Faults', 'Warnings', 'Away (s)', 'Pastes', 'Pasted chars', 'Email status'
];
// Zero-based positions of the columns that hold free text (names, emails...). They get Plain text format.
var SUMMARY_TEXT_COLUMNS = [0, 4, 5, 6, 7, 8, 9, 10, 17, 23];

var ANSWER_HEADERS = [
  'Attempt ID', 'Email', 'Set', 'Question ID', 'Type', 'Question', 'Answer', 'Correct answer',
  'Score', 'Max', 'Feedback', 'Teacher override'
];
var ANSWER_TEXT_COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7, 10];

// ---------------------------------------------------------------------------
// Pure helpers (no Google services): easy to test outside Apps Script
// ---------------------------------------------------------------------------

/** Strings are cut to the cell limit; numbers, booleans and null pass through ('' for null). */
function cleanCell(value) {
  if (value === null || value === undefined) { return ''; }
  if (typeof value === 'number' || typeof value === 'boolean') { return value; }
  var s = String(value);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + ' [cut]' : s;
}

/** Milliseconds since epoch -> "2026-10-12 08:15:03" in the school's time zone, or ''. */
function formatTime(ms) {
  if (!ms) { return ''; }
  return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd HH:mm:ss');
}

/** One summary row, in SUMMARY_HEADERS order. */
function summaryRow(a) {
  return [
    a.id, formatTime(a.startedAt), formatTime(a.submittedAt), formatTime(a.gradedAt), a.examId, a.set, a.email,
    a.firstName, a.lastName, a.class, a.status, a.mcScore, a.openScore, a.penalty, a.totalScore, a.maxScore,
    a.percentage, a.finalGrade, a.faults, a.warnings, Math.round((a.awayMs || 0) / 1000), a.pasteEvents,
    a.pasteChars, a.emailStatus
  ].map(cleanCell);
}

/** Answer rows of one attempt, in ANSWER_HEADERS order. */
function answerRows(a) {
  return (a.answers || []).map(function (x) {
    return [
      a.id, a.email, a.set, x.qid, x.type, x.question, x.answer, x.correct, x.score, x.max, x.feedback,
      x.overridden ? 'yes' : ''
    ].map(cleanCell);
  });
}

/** {summary: [[header], rows...], answers: [[header], rows...]} for a list of attempts. */
function buildTables(attempts) {
  var summary = [SUMMARY_HEADERS];
  var answers = [ANSWER_HEADERS];
  attempts.forEach(function (a) {
    summary.push(summaryRow(a));
    answerRows(a).forEach(function (r) { answers.push(r); });
  });
  return { summary: summary, answers: answers };
}

// ---------------------------------------------------------------------------
// Calls to the Worker
// ---------------------------------------------------------------------------

function config_() {
  var p = PropertiesService.getScriptProperties();
  var url = (p.getProperty('EXPORT_URL') || '').replace(/\/+$/, '');
  var key = p.getProperty('EXPORT_KEY') || '';
  if (!url || !key) { throw new Error('Set the EXPORT_URL and EXPORT_KEY script properties first (see README).'); }
  return { url: url, key: key };
}

function fetchJson_(cfg, path) {
  var res = UrlFetchApp.fetch(cfg.url + path, {
    method: 'get', headers: { Authorization: 'Bearer ' + cfg.key }, muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) { throw new Error('Worker answered ' + code + ' for ' + path + ': ' + res.getContentText().slice(0, 200)); }
  var data = JSON.parse(res.getContentText());
  if (!data.success) { throw new Error('Worker error for ' + path + ': ' + (data.error || 'unknown')); }
  return data;
}

/** Every attempt of an exam, following nextAfterId page by page. */
function fetchAllAttempts_(cfg, examId) {
  var all = [];
  var after = '';
  for (var guard = 0; guard < 200; guard++) {   // 200 pages x 25 = 5,000 attempts per exam
    var page = fetchJson_(cfg, '/api/export/exams/' + encodeURIComponent(examId) +
                          '?limit=25&after=' + encodeURIComponent(after));
    all = all.concat(page.attempts);
    if (!page.nextAfterId) { return all; }
    after = page.nextAfterId;
  }
  throw new Error('Exam ' + examId + ' has more attempts than this script handles in one run.');
}

// ---------------------------------------------------------------------------
// Writing the sheet
// ---------------------------------------------------------------------------

/** Replaces the whole content of a tab with `rows` (first row = headers). */
function writeTab_(ss, name, rows, textColumns) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  var width = rows[0].length;
  // Plain text FIRST so nothing a student typed can be interpreted as a formula.
  textColumns.forEach(function (col) {
    sheet.getRange(1, col + 1, Math.max(rows.length, 2), 1).setNumberFormat('@');
  });
  sheet.getRange(1, 1, rows.length, width).setValues(rows);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function exportExam_(ss, cfg, exam) {
  var attempts = fetchAllAttempts_(cfg, exam.id);
  var t = buildTables(attempts);
  writeTab_(ss, exam.id, t.summary, SUMMARY_TEXT_COLUMNS);
  writeTab_(ss, exam.id + ' answers', t.answers, ANSWER_TEXT_COLUMNS);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** The time trigger runs this. Safe to run by hand at any time. */
function exportAll() {
  var started = Date.now();
  var cfg = config_();
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var exams = fetchJson_(cfg, '/api/export/index').exams;
  var done = 0; var skipped = 0;

  for (var i = 0; i < exams.length; i++) {
    var exam = exams[i];
    var stored = props.getProperty('DIGEST_' + exam.id);
    if (stored === exam.digest) { skipped++; continue; }
    if (Date.now() - started > TIME_BUDGET_MS) { break; }      // the rest is picked up next run
    exportExam_(ss, cfg, exam);
    props.setProperty('DIGEST_' + exam.id, exam.digest);      // only after the tabs were written
    done++;
  }
  console.log('Archive: ' + done + ' exam(s) written, ' + skipped + ' unchanged, ' + exams.length + ' total.');
  return { written: done, unchanged: skipped, total: exams.length };
}

/** Forces a full rewrite on the next run (forgets what was exported). */
function forgetDigests() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('DIGEST_') === 0) { props.deleteProperty(k); }
  });
}

/** Creates the hourly trigger (run once; running it again does not duplicate it). */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'exportAll') { ScriptApp.deleteTrigger(t); }
  });
  ScriptApp.newTrigger('exportAll').timeBased().everyHours(1).create();
}

/**
 * Confirms that text starting with "=" is stored as text, not as a formula, in
 * the way this script writes it. Creates a scratch tab, checks, deletes it.
 */
function selfTest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.insertSheet('selftest_tmp');
  try {
    var evil = '=HYPERLINK("https://example.com","click")';
    sheet.getRange(1, 1, 1, 1).setNumberFormat('@');
    sheet.getRange(1, 1, 1, 1).setValues([[evil]]);
    var formula = sheet.getRange(1, 1).getFormula();
    var shown = sheet.getRange(1, 1).getValue();
    var ok = formula === '' && shown === evil;
    console.log(ok ? 'SELFTEST OK: formula-looking text is stored as text.'
                   : 'SELFTEST FAILED: formula=' + formula + ' value=' + shown);
    return ok;
  } finally {
    ss.deleteSheet(sheet);
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Exam archive')
    .addItem('Export now', 'exportAll')
    .addItem('Rewrite everything on next run', 'forgetDigests')
    .addItem('Install hourly trigger', 'installTrigger')
    .addItem('Self test (formula safety)', 'selfTest')
    .addToUi();
}
