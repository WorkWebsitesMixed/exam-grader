#!/usr/bin/env node
/**
 * import-sheet.mjs -- turns an exam kept in the old Google Sheet format into a
 * SQL file for the new D1 database.
 *
 * Role: bridge between the old system (Questions + Config sheets, exported as
 * CSV) and the new backend. It does NOT talk to Cloudflare: it writes a
 * reviewable .sql file and checks it against schema.sql in memory first, so a
 * mistake is found on your laptop, not in the live database. You then run the
 * file yourself with `wrangler d1 execute`.
 *
 * How to get the inputs:
 *   Questions CSV : Google Sheet > tab "Questions" > File > Download > CSV.
 *                   (It is the same format the exam-set skill writes.)
 *   Config CSV    : optional, same for the "Config" tab. Only exam settings are
 *                   read; admin_password and any key containing password,
 *                   secret, token or api_key is ignored on purpose.
 *
 * Usage:
 *   node tools/import-sheet.mjs --questions Questions.csv --exam G11_B_T4 \
 *        [--config Config.csv] [--sets B] [--title "..."] [--duration 60] \
 *        [--type igcse|standard] [--set-mode single|triple] \
 *        [--active] [--default] [--replace] [--out import.sql]
 *
 *   --exam      id of the exam in the new system. Rows are taken when their
 *               `Exam` column equals it (case-insensitive) or is empty (the old
 *               rule: empty = belongs to every exam).
 *   --sets      only import these sets, e.g. B or A,B (default: all).
 *   --active    open the exam to students. Without it the exam is imported
 *               CLOSED so nothing goes live by accident.
 *   --default   make it the exam served when a link has no ?exam=.
 *   --replace   first delete the questions of this exam (only the selected
 *               sets), so a re-import mirrors the sheet exactly. Attempts and
 *               results are never touched.
 *
 * Re-running is safe: questions are upserted by (exam, set, id) and an
 * existing exam's open/closed and default flags are preserved.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { normalizeQuestion } from '../src/admin.js';
import { parseBoundaryString } from '../src/grading.js';

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180): quoted fields, doubled quotes, commas and line breaks
// inside quotes, optional BOM. A hand-rolled parser keeps the tool dependency-
// free; exam text routinely contains commas and quotes.
// ---------------------------------------------------------------------------
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); }
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') { i++; }
      row.push(field); field = ''; rows.push(row); row = [];
    } else { field += ch; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Turns CSV rows into objects keyed by the (lower-cased) header names. */
function rowsToObjects(rows) {
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] === undefined ? '' : r[i]).trim(); });
    return o;
  });
}

/** SQL literal: numbers as-is, null as NULL, strings single-quoted with '' escaping. */
function lit(v) {
  if (v === null || v === undefined) { return 'NULL'; }
  if (typeof v === 'number') { return String(v); }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const TYPE_ALIASES = { mc: 'mc', short: 'short', openended: 'openEnded', open: 'openEnded' };
const SECRET_KEY = /password|secret|token|api_?key/i;

// ---------------------------------------------------------------------------
// Config sheet -> exam settings
// ---------------------------------------------------------------------------
function readConfig(configCsv, warnings) {
  const cfg = {};
  if (!configCsv) { return cfg; }
  for (const r of parseCsv(configCsv)) {
    const key = (r[0] || '').trim();
    if (!key || key.toLowerCase() === 'key') { continue; }
    if (SECRET_KEY.test(key)) { warnings.push(`Config key "${key}" ignored (secret).`); continue; }
    cfg[key] = (r[1] || '').trim();
  }
  return cfg;
}

/** Maps old Config keys to the columns of the `exams` table. */
function examFromConfig(cfg, opts, warnings) {
  const boundaries = {};
  ['A', 'B', 'C'].forEach((s) => {
    const raw = cfg['grade_boundaries_' + s];
    if (!raw) { return; }
    const parsed = parseBoundaryString(raw);
    if (parsed) { boundaries[s] = parsed; } else { warnings.push(`grade_boundaries_${s} could not be read; default boundaries will be used.`); }
  });
  const cards = {};
  ['a', 'b', 'c'].forEach((k) => {
    const label = cfg[`set_${k}_label`];
    if (label !== undefined || cfg[`set_${k}_max_grade`] !== undefined) {
      cards[k.toUpperCase()] = { label: label || '', max_grade: cfg[`set_${k}_max_grade`] || '',
                                 description: cfg[`set_${k}_description`] || '' };
    }
  });
  const bool = (v) => (String(v || '').toLowerCase() === 'true' ? 1 : 0);
  return {
    title: opts.title || cfg.exam_title || opts.examId,
    subtitle: cfg.exam_subtitle || '',
    duration: Number(opts.duration || cfg.exam_duration_minutes) || 60,
    examType: opts.type || (cfg.exam_type === 'standard' ? 'standard' : 'igcse'),
    setMode: opts.setMode || (cfg.set_mode === 'triple' ? 'triple' : 'single'),
    classOptions: (cfg.class_options || '').split(',').map((s) => s.trim()).filter(Boolean),
    questionsPerSet: Number(cfg.questions_per_set) || 0,
    oePerSet: Number(cfg.oe_per_set) || 0,
    randomize: bool(cfg.randomize_questions),
    boundaries, cards,
  };
}

// ---------------------------------------------------------------------------
// The conversion. Returns {sql, summary, warnings, errors}; never throws on bad
// data (errors are collected so the teacher sees all problems in one run).
// ---------------------------------------------------------------------------
export function buildImport({ questionsCsv, configCsv = '', examId, sets = [], title, duration, type, setMode,
                              active = false, makeDefault = false, replace = false, now = Date.now() }) {
  const warnings = [];
  const errors = [];
  if (!examId || !/^[A-Za-z0-9_-]{1,40}$/.test(examId)) {
    return { sql: '', summary: null, warnings, errors: ['--exam must be 1-40 letters, digits, _ or -'] };
  }

  const cfg = readConfig(configCsv, warnings);
  const exam = examFromConfig(cfg, { examId, title, duration, type, setMode }, warnings);

  const parsed = parseCsv(questionsCsv);
  if (parsed.length < 2) { return { sql: '', summary: null, warnings, errors: ['The questions CSV has no data rows.'] }; }
  const header = parsed[0].map((h) => h.trim().toLowerCase());
  for (const need of ['set', 'id', 'type', 'points', 'text']) {
    if (!header.includes(need)) { errors.push(`Missing column "${need}" in the questions CSV.`); }
  }
  if (errors.length) { return { sql: '', summary: null, warnings, errors }; }

  const wantSets = sets.map((s) => s.toUpperCase());
  const rows = rowsToObjects(parsed);
  const questions = [];
  const perSetCounter = {};
  const imagesSkipped = [];
  const mcIndexes = [];

  rows.forEach((r, i) => {
    const line = i + 2;                                   // CSV line number, counting the header
    if (!r.id || !r.text) { return; }                     // blank filler rows, as the old code did
    const rowExam = (r.exam || '').trim();
    if (rowExam && rowExam.toLowerCase() !== examId.toLowerCase()) { return; }
    const setId = (r.set || '').toUpperCase();
    if (wantSets.length && !wantSets.includes(setId)) { return; }

    const type = TYPE_ALIASES[(r.type || '').toLowerCase()];
    if (!type) { errors.push(`Line ${line} (${r.id}): unknown type "${r.type}".`); return; }

    const input = { set: setId, id: r.id, section: r.section, type, points: Number(r.points), text: r.text };
    if (type === 'mc') {
      input.options = [r.option_a, r.option_b, r.option_c, r.option_d];
      input.legacyCorrectIndex = Number(r.correctindex);   // old sheets are 1-based
      mcIndexes.push(Number(r.correctindex));
    } else if (type === 'short') {
      // Old convention: accepted answers live in the Rubric column, comma separated.
      input.accepted = (r.rubric || '').split(',');
    } else {
      input.rubric = r.rubric;
      if (!r.rubric) { warnings.push(`Line ${line} (${r.id}): open-ended question has no rubric; it will be graded with an empty rubric.`); }
    }
    if (r.image) { imagesSkipped.push(`${r.id} (Drive id ${r.image})`); }

    perSetCounter[setId] = (perSetCounter[setId] || 0) + 1;
    input.position = perSetCounter[setId];                 // keeps the sheet's order (IGCSE order is fixed)
    try { questions.push(normalizeQuestion(input)); }
    catch (e) { errors.push(`Line ${line} (${r.id}): ${e.message}`); }
  });

  // Only say "nothing matched" when no row was rejected; otherwise the row errors already explain it.
  if (!questions.length && !errors.length) { errors.push(`No questions matched exam "${examId}"${wantSets.length ? ' and sets ' + wantSets.join(',') : ''}.`); }

  // A sheet whose MC answers include 0 is almost certainly 0-based: the old
  // code subtracted 1, so a 0 meant "no correct answer". Say so loudly.
  if (mcIndexes.includes(0)) {
    errors.push('Some mc rows have CorrectIndex 0. The old sheet is 1-based (1=A ... 4=D); fix those rows or confirm the file is 0-based.');
  }
  const seen = new Set();
  for (const q of questions) {
    const k = q.set_id + '/' + q.qid;
    if (seen.has(k)) { errors.push(`Duplicate question id ${k}.`); }
    seen.add(k);
  }
  if (imagesSkipped.length) {
    warnings.push(`${imagesSkipped.length} question(s) reference Drive images that are NOT migrated yet (images arrive with the R2 slice): ${imagesSkipped.join(', ')}.`);
  }

  // Summary per set: counts and points, so the teacher can compare with the printed paper.
  const summary = {};
  for (const q of questions) {
    const s = summary[q.set_id] || (summary[q.set_id] = { questions: 0, points: 0, mc: 0, short: 0, openEnded: 0 });
    s.questions++; s.points += q.points; s[q.type]++;
  }

  if (errors.length) { return { sql: '', summary, warnings, errors }; }

  const out = [];
  out.push(`-- Generated by tools/import-sheet.mjs for exam ${examId} on ${new Date(now).toISOString()}`);
  out.push(`-- Sets: ${Object.keys(summary).join(', ')}. ${questions.length} question(s). Exam is imported ${active ? 'ACTIVE' : 'CLOSED'}.`);
  out.push(
    'INSERT INTO exams (id, title, subtitle, active, is_default, duration_min, exam_type, set_mode, class_options, ' +
    'questions_per_set, oe_per_set, randomize, grade_boundaries, set_cards, created_at, updated_at) VALUES (' +
    [lit(examId), lit(exam.title), lit(exam.subtitle), active ? 1 : 0, 0, exam.duration, lit(exam.examType),
     lit(exam.setMode), lit(JSON.stringify(exam.classOptions)), exam.questionsPerSet, exam.oePerSet, exam.randomize,
     lit(JSON.stringify(exam.boundaries)), lit(JSON.stringify(exam.cards)), now, now].join(', ') + ') ' +
    'ON CONFLICT(id) DO UPDATE SET title = excluded.title, subtitle = excluded.subtitle, ' +
    'duration_min = excluded.duration_min, exam_type = excluded.exam_type, set_mode = excluded.set_mode, ' +
    'class_options = excluded.class_options, questions_per_set = excluded.questions_per_set, ' +
    'oe_per_set = excluded.oe_per_set, randomize = excluded.randomize, grade_boundaries = excluded.grade_boundaries, ' +
    'set_cards = excluded.set_cards, updated_at = excluded.updated_at;');
  if (active) { out.push(`UPDATE exams SET active = 1 WHERE id = ${lit(examId)};`); }
  if (makeDefault) {
    out.push(`UPDATE exams SET is_default = 0 WHERE id != ${lit(examId)};`);
    out.push(`UPDATE exams SET is_default = 1 WHERE id = ${lit(examId)};`);
  }
  if (replace) {
    const inList = Object.keys(summary).map(lit).join(', ');
    out.push(`DELETE FROM questions WHERE exam_id = ${lit(examId)} AND set_id IN (${inList});`);
  }
  for (const q of questions) {
    out.push(
      'INSERT INTO questions (exam_id, set_id, qid, position, section, type, points, text, options, correct_index, ' +
      'rubric, accepted_answers) VALUES (' +
      [lit(examId), lit(q.set_id), lit(q.qid), q.position, lit(q.section), lit(q.type), q.points, lit(q.text),
       lit(q.options), q.correct_index === null ? 'NULL' : q.correct_index, lit(q.rubric), lit(q.accepted_answers)].join(', ') + ') ' +
      'ON CONFLICT(exam_id, set_id, qid) DO UPDATE SET position = excluded.position, section = excluded.section, ' +
      'type = excluded.type, points = excluded.points, text = excluded.text, options = excluded.options, ' +
      'correct_index = excluded.correct_index, rubric = excluded.rubric, accepted_answers = excluded.accepted_answers;');
  }
  return { sql: out.join('\n') + '\n', summary, warnings, errors };
}

/**
 * Applies the generated SQL to an in-memory database built from schema.sql, so
 * constraint violations (CHECK, UNIQUE, NOT NULL) show up before anything
 * reaches Cloudflare. Returns the number of questions found afterwards.
 */
export function selfCheck(sql, schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  db.exec(sql);
  return db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function cli() {
  const args = {};
  const flags = new Set(['active', 'default', 'replace']);
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) { continue; }
    const key = a.slice(2);
    if (flags.has(key)) { args[key] = true; } else { args[key] = process.argv[++i]; }
  }
  if (!args.questions || !args.exam) {
    console.error('Usage: node tools/import-sheet.mjs --questions Questions.csv --exam <id> [--config Config.csv] [--sets B] ' +
                  '[--title ..] [--duration 60] [--type igcse|standard] [--set-mode single|triple] [--active] [--default] [--replace] [--out file.sql]');
    process.exit(1);
  }

  const result = buildImport({
    questionsCsv: readFileSync(args.questions, 'utf8'),
    configCsv: args.config ? readFileSync(args.config, 'utf8') : '',
    examId: args.exam,
    sets: args.sets ? args.sets.split(',') : [],
    title: args.title, duration: args.duration, type: args.type, setMode: args['set-mode'],
    active: !!args.active, makeDefault: !!args.default, replace: !!args.replace,
  });

  result.warnings.forEach((w) => console.warn('WARNING: ' + w));
  if (result.summary) {
    console.log('\nWhat will be imported:');
    for (const [set, s] of Object.entries(result.summary)) {
      console.log(`  Set ${set}: ${s.questions} questions, ${s.points} points (mc ${s.mc}, short ${s.short}, open-ended ${s.openEnded})`);
    }
  }
  if (result.errors.length) {
    result.errors.forEach((e) => console.error('ERROR: ' + e));
    console.error('\nNothing was written. Fix the problems above and run again.');
    process.exit(1);
  }

  const schema = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');
  const n = selfCheck(result.sql, schema);
  const out = args.out || `import-${args.exam}.sql`;
  writeFileSync(out, result.sql);
  console.log(`\nSelf-check passed (${n} questions load cleanly into schema.sql).`);
  console.log(`Wrote ${out}. To apply it to the live database run:`);
  console.log(`  npx wrangler d1 execute examgrader --remote --file=${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { cli(); }
