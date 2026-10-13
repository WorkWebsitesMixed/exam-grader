/**
 * import.test.js -- the sheet importer: CSV edge cases, the 1-based -> 0-based
 * conversion, filters, secrets handling, and that the SQL it writes loads into
 * schema.sql without violating a constraint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv, buildImport, selfCheck } from '../tools/import-sheet.mjs';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const HEADER = 'Set,ID,Section,Type,Points,Text,Option_A,Option_B,Option_C,Option_D,CorrectIndex,Rubric,Exam,Image\n';

/** Builds a CSV from row arrays, quoting every field the way Google Sheets does. */
const csv = (rows) => HEADER + rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n';

const ROWS = [
  ['B', 'B_1', 'Section A', 'mc', 2, 'Which is "rigid", a triangle or square?', 'Square', 'Triangle', 'Circle', 'Line', 2, '', 'G11_B', ''],
  ['B', 'B_2', 'Section A', 'short', 1, 'Capital of Colombia?', '', '', '', '', '', 'Bogotá, bogota', 'G11_B', ''],
  ['B', 'B_3', 'Section B', 'openEnded', 6, 'Explain why.\nGive two reasons, María.', '', '', '', '', '', 'Award 1 mark per reason.', 'G11_B', ''],
  ['A', 'A_1', 'Section A', 'mc', 1, 'Other set', 'a', 'b', 'c', 'd', 1, '', 'G11_B', ''],
  ['B', 'X_1', 'Section A', 'mc', 1, 'Belongs to another exam', 'a', 'b', 'c', 'd', 1, '', 'OTHER', ''],
  ['B', 'ALL_1', 'Section A', 'mc', 1, 'Empty Exam = all exams', 'a', 'b', 'c', 'd', 4, '', '', ''],
];

test('parseCsv handles quotes, commas, line breaks inside fields, CRLF and BOM', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
});

test('imports one set of one exam, converting the 1-based answer key', () => {
  const r = buildImport({ questionsCsv: csv(ROWS), examId: 'G11_B', sets: ['B'], now: 1 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.summary, { B: { questions: 4, points: 10, mc: 2, short: 1, openEnded: 1 } });   // B_1,B_2,B_3 + ALL_1

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(r.sql);
  const q = db.prepare("SELECT * FROM questions WHERE qid = 'B_1'").get();
  assert.equal(q.correct_index, 1);                          // sheet said 2 (= B) -> 0-based 1
  assert.equal(db.prepare("SELECT correct_index FROM questions WHERE qid = 'ALL_1'").get().correct_index, 3);
  assert.deepEqual(JSON.parse(q.options), ['Square', 'Triangle', 'Circle', 'Line']);
  assert.equal(q.text, 'Which is "rigid", a triangle or square?');
  assert.deepEqual(JSON.parse(db.prepare("SELECT accepted_answers FROM questions WHERE qid = 'B_2'").get().accepted_answers), ['Bogotá', 'bogota']);
  assert.equal(db.prepare("SELECT text FROM questions WHERE qid = 'B_3'").get().text, 'Explain why.\nGive two reasons, María.');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE qid IN ('A_1','X_1')").get().n, 0);   // other set / other exam
  assert.deepEqual(db.prepare('SELECT qid FROM questions ORDER BY position').all().map((x) => x.qid), ['B_1', 'B_2', 'B_3', 'ALL_1']);
});

test('the exam is imported CLOSED unless --active is given', () => {
  const closed = buildImport({ questionsCsv: csv(ROWS), examId: 'G11_B', now: 1 });
  const open = buildImport({ questionsCsv: csv(ROWS), examId: 'G11_B', active: true, now: 1 });
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); db.exec(closed.sql);
  assert.equal(db.prepare('SELECT active FROM exams').get().active, 0);
  db.exec(open.sql);
  assert.equal(db.prepare('SELECT active FROM exams').get().active, 1);
});

test('re-import is idempotent and keeps the open/default flags of an existing exam', () => {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
  db.exec(buildImport({ questionsCsv: csv(ROWS), examId: 'G11_B', now: 1 }).sql);
  db.exec("UPDATE exams SET active = 1, is_default = 1 WHERE id = 'G11_B'");
  const edited = ROWS.map((r) => (r[1] === 'B_1' ? [...r.slice(0, 5), 'Edited text', ...r.slice(6)] : r));
  db.exec(buildImport({ questionsCsv: csv(edited), examId: 'G11_B', now: 2 }).sql);
  const e = db.prepare('SELECT active, is_default FROM exams').get();
  assert.equal(e.active, 1);
  assert.equal(e.is_default, 1);
  assert.equal(db.prepare("SELECT text FROM questions WHERE qid = 'B_1'").get().text, 'Edited text');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 5);
});

test('--replace removes questions that were deleted from the sheet', () => {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
  db.exec(buildImport({ questionsCsv: csv(ROWS), examId: 'G11_B', now: 1 }).sql);
  const fewer = ROWS.filter((r) => r[1] !== 'B_3');
  db.exec(buildImport({ questionsCsv: csv(fewer), examId: 'G11_B', replace: true, now: 2 }).sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE qid = 'B_3'").get().n, 0);
});

test('a 0-based sheet is refused instead of silently marking everything wrong', () => {
  const rows = [['B', 'B_1', 's', 'mc', 1, 't', 'a', 'b', 'c', 'd', 0, '', '', '']];
  const r = buildImport({ questionsCsv: csv(rows), examId: 'G11_B', now: 1 });
  assert.ok(r.errors.some((e) => /1-based/.test(e)));
  assert.equal(r.sql, '');
});

test('validation problems are all reported in one run, with line numbers', () => {
  const rows = [
    ['B', 'B_1', 's', 'mc', 1, 't', 'a', 'b', '', 'd', 2, '', '', ''],        // empty option
    ['B', 'B_2', 's', 'short', 1, 't', '', '', '', '', '', '', '', ''],       // no accepted answers
    ['B', 'B_3', 's', 'essay', 1, 't', '', '', '', '', '', '', '', ''],       // unknown type
  ];
  const r = buildImport({ questionsCsv: csv(rows), examId: 'G11_B', now: 1 });
  assert.equal(r.errors.length, 3);
  assert.ok(r.errors[0].startsWith('Line 2'));
});

test('Config: secrets ignored, boundaries/classes/set cards mapped, images reported not migrated', () => {
  const config = 'exam_id,0445_Paper4\nexam_title,Mock 4\nclass_options,"11A,11B"\nexam_duration_minutes,90\n' +
                 'admin_password,hunter2\nANTHROPIC_API_KEY,sk-123\ngrade_boundaries_B,"3.3:85,3.0:75,1.0:0"\n' +
                 'set_b_label,SET B\nset_b_max_grade,3.3\nset_b_description,Application\nexam_type,igcse\n';
  const rows = [['B', 'B_1', 's', 'mc', 1, 't', 'a', 'b', 'c', 'd', 1, '', '', 'DRIVEFILEID123']];
  const r = buildImport({ questionsCsv: csv(rows), configCsv: config, examId: '0445_Paper4', now: 1 });
  assert.ok(!r.sql.includes('hunter2') && !r.sql.includes('sk-123'));
  assert.ok(r.warnings.some((w) => /DRIVEFILEID123/.test(w)));
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); db.exec(r.sql);
  const e = db.prepare('SELECT * FROM exams').get();
  assert.equal(e.title, 'Mock 4');
  assert.equal(e.duration_min, 90);
  assert.deepEqual(JSON.parse(e.class_options), ['11A', '11B']);
  assert.deepEqual(JSON.parse(e.grade_boundaries).B[0], { grade: '3.3', min: 85 });
  assert.equal(JSON.parse(e.set_cards).B.label, 'SET B');
  assert.equal(db.prepare('SELECT image_hash FROM questions').get().image_hash, null);
});

test('quotes in text cannot break the SQL (no injection from sheet content)', () => {
  const rows = [['B', 'B_1', "Sec'tion", 'openEnded', 3, "Robert'); DROP TABLE exams;--", '', '', '', '', '', "it's fine", '', '']];
  const r = buildImport({ questionsCsv: csv(rows), examId: 'G11_B', now: 1 });
  assert.equal(selfCheck(r.sql, SCHEMA), 1);
  const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); db.exec(r.sql);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get().n, 1);
  assert.equal(db.prepare('SELECT text FROM questions').get().text, "Robert'); DROP TABLE exams;--");
});
