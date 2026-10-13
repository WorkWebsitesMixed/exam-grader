/**
 * sheet-archive.test.js -- the pure part of tools/sheet-archive/Code.gs, run
 * against real data from the export endpoint.
 *
 * The Apps Script file is loaded into a vm context with only `Utilities`
 * stubbed, so what is tested is the actual file, not a copy. The Google
 * services (SpreadsheetApp, UrlFetchApp) are not exercised here; the README's
 * "Self test" menu item covers the one thing only a real sheet can confirm
 * (that Plain text format stops formulas).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeWorld, seedExam } from './helpers.js';

const SOURCE = readFileSync(new URL('../../tools/sheet-archive/Code.gs', import.meta.url), 'utf8');

function loadScript() {
  const context = {
    console,
    Utilities: {
      // Same shape as Utilities.formatDate; only the format used by the script is supported.
      formatDate: (date, tz, fmt) => {
        assert.equal(fmt, 'yyyy-MM-dd HH:mm:ss');
        const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(date);
        return parts;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context;
}

test('tables built from real export data line up with the headers', async () => {
  const w = await makeWorld();
  w.env.EXPORT_KEY = 'k';
  await seedExam(w);
  const s = await w.call('POST', '/api/start', { body: {
    idToken: await w.google.token({ email: 'ana@marymount.edu.co' }), exam: 'EX1', set: 'A',
    firstName: 'Ana', lastName: 'Pérez', class: '10A' } });
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q1: 1, Q2: 'Paris', Q3: '=1+1 rígido' } } });
  await w.drainQueue();
  const exp = await w.call('GET', '/api/export/exams/EX1', { headers: { Authorization: 'Bearer k' } });

  const gs = loadScript();
  const t = gs.buildTables(exp.json.attempts);
  assert.equal(t.summary.length, 2);
  assert.equal(t.answers.length, 4);                        // header + 3 questions
  for (const row of t.summary) { assert.equal(row.length, gs.SUMMARY_HEADERS.length); }
  for (const row of t.answers) { assert.equal(row.length, gs.ANSWER_HEADERS.length); }

  const col = (name) => gs.SUMMARY_HEADERS.indexOf(name);
  const r = t.summary[1];
  assert.equal(r[col('Last name')], 'Pérez');
  assert.equal(r[col('Total')], 9);                          // numbers stay numbers
  assert.equal(typeof r[col('Total')], 'number');
  assert.equal(r[col('Status')], 'graded');
  assert.match(r[col('Started')], /^2026-10-12 \d\d:\d\d:\d\d$/);

  const acol = (name) => gs.ANSWER_HEADERS.indexOf(name);
  const open = t.answers.find((row) => row[acol('Question ID')] === 'Q3');
  assert.equal(open[acol('Answer')], '=1+1 rígido');         // kept verbatim; safety is the Plain text format

  // Every column that can hold student text is declared as text.
  const textAnswer = ['Attempt ID', 'Email', 'Question', 'Answer', 'Correct answer', 'Feedback'];
  textAnswer.forEach((name) => assert.ok(gs.ANSWER_TEXT_COLUMNS.includes(acol(name)), name));
  ['Email', 'First name', 'Last name', 'Class'].forEach((name) =>
    assert.ok(gs.SUMMARY_TEXT_COLUMNS.includes(col(name)), name));
});

test('cleanCell handles nulls, numbers and very long text', () => {
  const gs = loadScript();
  assert.equal(gs.cleanCell(null), '');
  assert.equal(gs.cleanCell(0), 0);
  assert.equal(gs.cleanCell('a'), 'a');
  const long = gs.cleanCell('x'.repeat(50000));
  assert.ok(long.length < 41000);
  assert.ok(long.endsWith('[cut]'));
});
