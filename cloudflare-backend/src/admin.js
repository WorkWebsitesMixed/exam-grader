/**
 * admin.js -- endpoints for the teacher admin panel.
 *
 * Role: replaces the password-protected actions of Code.gs (verifyAdmin,
 * updateConfig, question CRUD, submissions, override, delete, recalculate,
 * regrademc). Access works like this:
 *   1. POST /api/admin/login with a Google ID token. The email must exist in
 *      the `teachers` table; the Worker answers with a signed session (8 h).
 *   2. Every other admin request sends `Authorization: Bearer <session>`.
 *      The router also re-checks the teachers table on each request, so
 *      removing a teacher takes effect immediately.
 *
 * Bulk operations (recalculate, regrade) work in chunks of at most
 * MAX_UPDATES_PER_CALL rows and return a cursor, and the admin page repeats the
 * call until `nextAfterId` is null. Each chunk loads the exam and its questions
 * once and writes with one batch (D1's free plan allows 50 queries per invocation).
 *
 * Not in this file yet (next slice): image upload, PDF jobs, email resend,
 * export, distractor analysis.
 */

import { HttpError, clampInt } from './http.js';
import { verifyGoogleIdToken, signSession } from './auth.js';
import { DEFAULT_DIRECTIONS } from './header.js';
import { goalFor } from './goals.js';
import { calculateGrade, computeTotals, countNeedsReview, gradeQuestion } from './grading.js';
import { boundariesOf } from './queue.js';
import { assessEvents, parseEvents } from './integrity.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
// Attempts per bulk call (recalculate, regrade-mc). The whole chunk is written
// with ONE batch, so a call costs 4 queries however large the chunk is.
const MAX_UPDATES_PER_CALL = 40;
// A per-student extension may add at most this many minutes to the deadline.
const MAX_EXTRA_MINUTES = 180;
const MAX_REGRADE_PER_CALL = 20;  // each one is a queue send; the page repeats the call while `more` is true

// ---------- login ----------

export async function login(c) {
  const { env, deps, body } = c;
  // Domain is NOT required here: access is decided by the teachers table.
  const who = await verifyGoogleIdToken(body.idToken, env, deps, { requireSchoolDomain: false });
  const teacher = await env.DB.prepare('SELECT * FROM teachers WHERE email = ?').bind(who.email).first();
  if (!teacher) { throw new HttpError(403, 'not_a_teacher', 'This account is not authorized for the admin panel'); }
  const exp = deps.now() + SESSION_TTL_MS;
  const session = await signSession({ email: teacher.email, role: teacher.role, exp }, env.SESSION_SECRET);
  return { body: { success: true, session, email: teacher.email, role: teacher.role, expiresAt: exp } };
}

export async function me(c) {
  return { body: { success: true, email: c.teacher.email, role: c.teacher.role } };
}

// ---------- exams ----------

const EXAM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Validates grade boundaries: {A: [{grade, min}, ...], B: [...], C: [...]},
 * any set may be missing (it then uses the school scale). Checked on the
 * server, not only in the page, because a malformed list (for example an
 * object where the array should be) makes calculateGrade throw AFTER the model
 * calls of every attempt of that exam have been paid for.
 */
function cleanBoundaries(input) {
  const bad = (why) => new HttpError(400, 'bad_request', 'gradeBoundaries: ' + why);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) { throw bad('must be an object keyed by set'); }
  const out = {};
  for (const setId of Object.keys(input)) {
    if (!['A', 'B', 'C'].includes(setId)) { throw bad('unknown set ' + setId); }
    const list = input[setId];
    if (!Array.isArray(list) || list.length > 20) { throw bad('set ' + setId + ' must be a list of at most 20 entries'); }
    out[setId] = list.map((b) => {
      const grade = b && typeof b.grade === 'string' ? b.grade.trim() : '';
      const min = b ? b.min : NaN;
      if (!grade || grade.length > 10) { throw bad('each entry needs a grade (text, max 10 characters)'); }
      if (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 100) { throw bad('each min must be a number from 0 to 100'); }
      return { grade, min };
    });
  }
  return out;
}

/** Validates the editable exam fields; returns a {column: value} object of what was supplied. */
function examFields(body) {
  const out = {};
  const text = (v, max) => String(v).slice(0, max);
  if (body.title !== undefined) { out.title = text(body.title, 200); }
  if (body.subtitle !== undefined) { out.subtitle = text(body.subtitle, 300); }
  if (body.active !== undefined) { out.active = body.active ? 1 : 0; }
  // Opening window: epoch ms, or null/'' to clear that side. closes_at must be after opens_at.
  for (const [key, col] of [['opensAt', 'opens_at'], ['closesAt', 'closes_at']]) {
    if (body[key] === undefined) { continue; }
    if (body[key] === null || body[key] === '') { out[col] = null; continue; }
    const t = Number(body[key]);
    if (!Number.isFinite(t) || t < 0) { throw new HttpError(400, 'bad_request', key); }
    out[col] = Math.round(t);
  }
  if (out.opens_at && out.closes_at && out.closes_at <= out.opens_at) {
    throw new HttpError(400, 'bad_request', 'closesAt must be after opensAt');
  }
  // Header fields. gradeLevel/term are validated lists so a typo cannot silently lose the learning goal.
  if (body.gradeLevel !== undefined) {
    if (!['', '10', '11', '12'].includes(String(body.gradeLevel))) { throw new HttpError(400, 'bad_request', 'gradeLevel'); }
    out.grade_level = String(body.gradeLevel);
  }
  if (body.term !== undefined) {
    if (!['', 'I', 'II', 'III'].includes(String(body.term))) { throw new HttpError(400, 'bad_request', 'term'); }
    out.term = String(body.term);
  }
  if (body.termYear !== undefined) { out.term_year = body.termYear === null || body.termYear === '' ? null : clampInt(body.termYear, 2020, 2100); }
  if (body.teacher !== undefined) { out.teacher = text(body.teacher, 120); }
  if (body.subject !== undefined) { out.subject = text(body.subject, 120); }
  if (body.directions !== undefined) { out.directions = text(body.directions, 2000); }
  if (body.goalsOverride !== undefined) { out.goals_override = text(body.goalsOverride, 2000); }
  if (body.isDefault !== undefined) { out.is_default = body.isDefault ? 1 : 0; }
  if (body.durationMin !== undefined) { out.duration_min = clampInt(body.durationMin, 1, 600); }
  if (body.examType !== undefined) {
    if (!['igcse', 'standard'].includes(body.examType)) { throw new HttpError(400, 'bad_request', 'examType'); }
    out.exam_type = body.examType;
  }
  if (body.setMode !== undefined) {
    if (!['single', 'triple'].includes(body.setMode)) { throw new HttpError(400, 'bad_request', 'setMode'); }
    out.set_mode = body.setMode;
  }
  if (body.classOptions !== undefined) {
    if (!Array.isArray(body.classOptions)) { throw new HttpError(400, 'bad_request', 'classOptions'); }
    out.class_options = JSON.stringify(body.classOptions.map((s) => String(s).slice(0, 20)));
  }
  // questions_per_set and randomize are independent options; nothing joins them.
  if (body.questionsPerSet !== undefined) { out.questions_per_set = clampInt(body.questionsPerSet, 0, 1000); }
  if (body.oePerSet !== undefined) { out.oe_per_set = clampInt(body.oePerSet, 0, 1000); }
  if (body.randomize !== undefined) { out.randomize = body.randomize ? 1 : 0; }
  if (body.gradeBoundaries !== undefined) {
    out.grade_boundaries = JSON.stringify(cleanBoundaries(body.gradeBoundaries));
  }
  if (body.setCards !== undefined) {
    if (typeof body.setCards !== 'object' || body.setCards === null) { throw new HttpError(400, 'bad_request', 'setCards'); }
    out.set_cards = JSON.stringify(body.setCards);
  }
  return out;
}

/** The exam as the admin panel sees it (JSON columns expanded). */
function examView(e) {
  return {
    id: e.id, title: e.title, subtitle: e.subtitle, active: !!e.active, opensAt: e.opens_at, closesAt: e.closes_at, isDefault: !!e.is_default,
    durationMin: e.duration_min, examType: e.exam_type, setMode: e.set_mode,
    classOptions: JSON.parse(e.class_options || '[]'), questionsPerSet: e.questions_per_set,
    oePerSet: e.oe_per_set, randomize: !!e.randomize,
    gradeLevel: e.grade_level, term: e.term, termYear: e.term_year, teacher: e.teacher, subject: e.subject,
    // directions: what students will see (the stored text, or the default when empty);
    // goalsDefault: the department goal for this grade+term, shown as a hint in Settings.
    directions: e.directions || DEFAULT_DIRECTIONS, goalsOverride: e.goals_override,
    goalsDefault: goalFor(e.grade_level, e.term),
    gradeBoundaries: JSON.parse(e.grade_boundaries || '{}'), setCards: JSON.parse(e.set_cards || '{}'),
  };
}

async function requireExam(env, id) {
  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(id).first();
  if (!exam) { throw new HttpError(404, 'exam_not_found', 'Exam not found'); }
  return exam;
}

export async function listExams(c) {
  const { results } = await c.env.DB.prepare('SELECT * FROM exams ORDER BY created_at DESC').all();
  return { body: { success: true, exams: results.map(examView) } };
}

export async function getExamAdmin(c) {
  return { body: { success: true, exam: examView(await requireExam(c.env, c.params.id)) } };
}

export async function createExam(c) {
  const { env, deps, body } = c;
  const id = String(body.id || '');
  if (!EXAM_ID_RE.test(id)) { throw new HttpError(400, 'bad_request', 'id must be 1-40 letters, digits, _ or -'); }
  if (await env.DB.prepare('SELECT id FROM exams WHERE id = ?').bind(id).first()) {
    throw new HttpError(409, 'exam_exists', 'An exam with that id already exists');
  }
  const f = examFields(body);
  const now = deps.now();
  await env.DB.prepare(
    'INSERT INTO exams (id, title, subtitle, active, opens_at, closes_at, is_default, duration_min, exam_type, set_mode, class_options, ' +
    'questions_per_set, oe_per_set, randomize, grade_boundaries, set_cards, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, f.title || id, f.subtitle || '', f.active || 0, f.opens_at ?? null, f.closes_at ?? null, 0, f.duration_min || 60,
          f.exam_type || 'igcse', f.set_mode || 'single', f.class_options || '[]',
          f.questions_per_set || 0, f.oe_per_set || 0, f.randomize || 0,
          f.grade_boundaries || '{}', f.set_cards || '{}', now, now).run();
  // Header fields are not in the INSERT above (they have column defaults); set what was supplied.
  const extra = ['grade_level', 'term', 'term_year', 'teacher', 'subject', 'directions', 'goals_override'].filter((k) => f[k] !== undefined);
  if (extra.length) {
    await env.DB.prepare('UPDATE exams SET ' + extra.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?')
      .bind(...extra.map((k) => f[k]), id).run();
  }
  if (f.is_default) { await makeDefault(env, id); }
  return { body: { success: true, exam: examView(await requireExam(env, id)) } };
}

/** Only one exam may be the default: clears the flag on all the others. */
async function makeDefault(env, id) {
  await env.DB.prepare('UPDATE exams SET is_default = 0 WHERE id != ?').bind(id).run();
  await env.DB.prepare('UPDATE exams SET is_default = 1 WHERE id = ?').bind(id).run();
}

export async function updateExam(c) {
  const { env, deps, body } = c;
  const before = await requireExam(env, c.params.id);
  const f = examFields(body);
  const isDefault = f.is_default;
  delete f.is_default;  // handled separately to keep it exclusive
  const cols = Object.keys(f);
  if (cols.length) {
    const sql = 'UPDATE exams SET ' + cols.map((k) => k + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?';
    await env.DB.prepare(sql).bind(...cols.map((k) => f[k]), deps.now(), c.params.id).run();
  }
  // Setting or moving the closing time also shortens attempts already in progress,
  // so everyone is stopped at that moment (it never extends a deadline).
  // Only when the closing time actually CHANGED: the admin page sends it with
  // every Settings save, and re-applying an unchanged value would silently undo
  // an extension given earlier. Attempts whose deadline a teacher set by hand
  // (deadline_manual) are left alone either way.
  if (f.closes_at && f.closes_at !== before.closes_at) {
    await env.DB.prepare("UPDATE attempts SET deadline_at = ? WHERE exam_id = ? AND status = 'started' AND deadline_at > ? AND deadline_manual = 0")
      .bind(f.closes_at, c.params.id, f.closes_at).run();
  }
  if (isDefault === 1) { await makeDefault(env, c.params.id); }
  if (isDefault === 0) { await env.DB.prepare('UPDATE exams SET is_default = 0 WHERE id = ?').bind(c.params.id).run(); }
  return { body: { success: true, exam: examView(await requireExam(env, c.params.id)) } };
}

// ---------- questions ----------

const IMAGE_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Validates one question from the admin panel or a bulk import and returns the
 * row values. correct_index is 0-BASED (see schema.sql). Imports from the old
 * sheet, which was 1-based, send `legacyCorrectIndex` and it is converted here.
 */
export function normalizeQuestion(q) {
  const setId = String(q.set || '').toUpperCase();
  const qid = String(q.id || q.qid || '').trim();
  const type = String(q.type || '');
  const points = clampInt(q.points, 0, 100);
  const text = String(q.text || '').trim();
  if (!['A', 'B', 'C'].includes(setId)) { throw new HttpError(400, 'bad_question', 'set must be A, B or C'); }
  if (!qid || qid.length > 40) { throw new HttpError(400, 'bad_question', 'id is required (max 40 chars)'); }
  if (!['mc', 'short', 'openEnded'].includes(type)) { throw new HttpError(400, 'bad_question', 'type must be mc, short or openEnded'); }
  if (points < 1) { throw new HttpError(400, 'bad_question', 'points must be at least 1'); }
  if (!text) { throw new HttpError(400, 'bad_question', 'text is required'); }

  const row = { set_id: setId, qid, type, points, text, section: String(q.section || '').slice(0, 100),
                options: null, correct_index: null, rubric: '', accepted_answers: null, image_hash: null,
                // undefined = "not supplied": an edit that omits it keeps the stored topic.
                topic: q.topic === undefined ? undefined : String(q.topic).trim().slice(0, 60) };

  if (type === 'mc') {
    const options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()) : [];
    if (options.length !== 4 || options.some((o) => !o)) { throw new HttpError(400, 'bad_question', 'mc needs 4 non-empty options'); }
    const idx = q.correctIndex !== undefined ? Number(q.correctIndex)
              : q.legacyCorrectIndex !== undefined ? Number(q.legacyCorrectIndex) - 1 : NaN;
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) { throw new HttpError(400, 'bad_question', 'correct answer must be one of the 4 options'); }
    row.options = JSON.stringify(options);
    row.correct_index = idx;
  } else if (type === 'short') {
    const accepted = (Array.isArray(q.accepted) ? q.accepted : []).map((a) => String(a).trim()).filter(Boolean);
    if (!accepted.length) { throw new HttpError(400, 'bad_question', 'short needs at least one accepted answer'); }
    row.accepted_answers = JSON.stringify(accepted);
  } else {
    row.rubric = String(q.rubric || '');
  }

  if (q.imageHash) {
    if (!IMAGE_HASH_RE.test(String(q.imageHash))) { throw new HttpError(400, 'bad_question', 'imageHash is not a valid hash'); }
    row.image_hash = String(q.imageHash);
  }
  if (q.position !== undefined) { row.position = clampInt(q.position, 0, 100000); }
  return row;
}

/** Admin view of a question row (includes the secrets; students never get this). */
function questionView(r) {
  return {
    set: r.set_id, id: r.qid, position: r.position, section: r.section, type: r.type, points: r.points,
    text: r.text, options: r.options ? JSON.parse(r.options) : null, correctIndex: r.correct_index,
    rubric: r.rubric, accepted: r.accepted_answers ? JSON.parse(r.accepted_answers) : null,
    imageHash: r.image_hash, topic: r.topic || '',
  };
}

export async function listQuestions(c) {
  await requireExam(c.env, c.params.id);
  const { results } = await c.env.DB
    .prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY set_id, position').bind(c.params.id).all();
  return { body: { success: true, questions: results.map(questionView) } };
}

/** Next free position at the end of a set. */
async function nextPosition(env, examId, setId) {
  const row = await env.DB.prepare('SELECT MAX(position) AS m FROM questions WHERE exam_id = ? AND set_id = ?')
    .bind(examId, setId).first();
  return (row && row.m !== null ? row.m : 0) + 1;
}

async function insertQuestion(env, examId, r) {
  const position = r.position !== undefined ? r.position : await nextPosition(env, examId, r.set_id);
  try {
    await env.DB.prepare(
      'INSERT INTO questions (exam_id, set_id, qid, position, section, type, points, text, options, correct_index, ' +
      'rubric, accepted_answers, image_hash, topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(examId, r.set_id, r.qid, position, r.section, r.type, r.points, r.text, r.options, r.correct_index,
            r.rubric, r.accepted_answers, r.image_hash, r.topic || '').run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) { throw new HttpError(409, 'question_exists', 'Question id already exists in that set'); }
    throw e;
  }
}

export async function addQuestion(c) {
  await requireExam(c.env, c.params.id);
  await insertQuestion(c.env, c.params.id, normalizeQuestion(c.body));
  return { body: { success: true } };
}

/** Bulk import. All rows are validated first so a bad row rejects the whole batch. */
export async function addQuestionsBulk(c) {
  await requireExam(c.env, c.params.id);
  const list = Array.isArray(c.body.questions) ? c.body.questions : [];
  if (!list.length || list.length > 80) { throw new HttpError(400, 'bad_request', 'Send between 1 and 80 questions per call'); }
  const rows = list.map(normalizeQuestion);
  for (const r of rows) { await insertQuestion(c.env, c.params.id, r); }
  return { body: { success: true, added: rows.length } };
}

export async function updateQuestion(c) {
  const { env, params, body } = c;
  const existing = await env.DB
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND set_id = ? AND qid = ?')
    .bind(params.id, params.set, params.qid).first();
  if (!existing) { throw new HttpError(404, 'question_not_found', 'Question not found'); }
  // The (set, id) pair identifies the question and cannot be changed by an edit.
  const r = normalizeQuestion({ ...body, set: params.set, id: params.qid,
                                position: body.position !== undefined ? body.position : existing.position });
  await env.DB.prepare(
    'UPDATE questions SET position = ?, section = ?, type = ?, points = ?, text = ?, options = ?, ' +
    'correct_index = ?, rubric = ?, accepted_answers = ?, image_hash = ?, topic = ? WHERE id = ?')
    .bind(r.position, r.section, r.type, r.points, r.text, r.options, r.correct_index, r.rubric,
          r.accepted_answers, r.image_hash, r.topic === undefined ? existing.topic : r.topic, existing.id).run();
  return { body: { success: true } };
}

export async function deleteQuestion(c) {
  const { params } = c;
  await c.env.DB.prepare('DELETE FROM questions WHERE exam_id = ? AND set_id = ? AND qid = ?')
    .bind(params.id, params.set, params.qid).run();
  return { body: { success: true } };
}

// ---------- attempts ----------

export async function listAttempts(c) {
  const examId = c.url.searchParams.get('exam') || '';
  if (!examId) { throw new HttpError(400, 'bad_request', 'exam is required'); }
  const { results } = await c.env.DB.prepare(
    'SELECT id, exam_id, set_id, email, first_name, last_name, class, started_at, submitted_at, deadline_at, status, ' +
    'tab_switches, penalty, mc_score, open_score, total_score, max_score, percentage, final_grade, email_status, ' +
    'grading_error, faults, warnings, away_ms, paste_events, paste_chars, needs_review, tokens_in, tokens_out, ' +
    'answers_saved_at, deadline_manual FROM attempts WHERE exam_id = ? ORDER BY started_at DESC').bind(examId).all();
  return { body: { success: true, attempts: results.map((a) => ({
    id: a.id, examId: a.exam_id, set: a.set_id, email: a.email, firstName: a.first_name, lastName: a.last_name,
    class: a.class, timestamp: new Date(a.started_at).toISOString(), submittedAt: a.submitted_at,
    deadlineAt: a.deadline_at, status: a.status, tabSwitches: a.tab_switches, penalty: a.penalty,
    mcScore: a.mc_score, openScore: a.open_score, totalScore: a.total_score, maxScore: a.max_score,
    percentage: a.percentage, finalGrade: a.final_grade, emailStatus: a.email_status, gradingError: a.grading_error,
    // Integrity summary (details in the attempt view)
    faults: a.faults, warnings: a.warnings, awayMs: a.away_ms, pasteEvents: a.paste_events, pasteChars: a.paste_chars,
    // Grading bookkeeping: questions waiting for the teacher, and what the model calls cost.
    needsReview: a.needs_review, tokensIn: a.tokens_in, tokensOut: a.tokens_out,
    // savedAt null + status 'started' + deadline passed = "Expired, nothing saved"
    // (the sweep skips such attempts on purpose, see queue.js); deadlineManual = a teacher extended it.
    savedAt: a.answers_saved_at, deadlineManual: !!a.deadline_manual,
  })) } };
}

async function requireAttempt(env, id) {
  const a = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first();
  if (!a) { throw new HttpError(404, 'attempt_not_found', 'Attempt not found'); }
  return a;
}

export async function getAttempt(c) {
  const a = await requireAttempt(c.env, c.params.id);
  return { body: { success: true, attempt: {
    id: a.id, examId: a.exam_id, set: a.set_id, email: a.email, firstName: a.first_name, lastName: a.last_name,
    class: a.class, status: a.status, startedAt: a.started_at, deadlineAt: a.deadline_at,
    submittedAt: a.submitted_at, tabSwitches: a.tab_switches, penalty: a.penalty,
    paper: JSON.parse(a.paper), answers: JSON.parse(a.answers || '{}'),
    results: a.results ? JSON.parse(a.results) : null, overrides: JSON.parse(a.overrides || '{}'),
    mcScore: a.mc_score, openScore: a.open_score, totalScore: a.total_score, maxScore: a.max_score,
    percentage: a.percentage, finalGrade: a.final_grade, gradingError: a.grading_error,
    needsReview: a.needs_review, gradeAttempts: a.grade_attempts, tokensIn: a.tokens_in, tokensOut: a.tokens_out,
    savedAt: a.answers_saved_at, deadlineManual: !!a.deadline_manual,
    integrity: (() => {
      const v = assessEvents(parseEvents(a.events));
      return { faults: v.faults, warnings: v.warnings, penalty: v.penalty, awayMs: v.awayMs,
               pasteEvents: v.pasteEvents, pasteChars: v.pasteChars, bulkInputs: v.bulkInputs, events: v.events };
    })(),
  } } };
}

/** Loads the exam and the questions an attempt was served, in paper order. */
async function paperContext(env, attempt) {
  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(attempt.exam_id).first();
  const { results } = await env.DB
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND set_id = ?').bind(attempt.exam_id, attempt.set_id).all();
  return paperFrom(exam, results, attempt);
}

/** The attempt's questions in paper order, from already-loaded rows (no query). */
function paperFrom(exam, questionRows, attempt) {
  const byQid = new Map(questionRows.filter((q) => q.set_id === attempt.set_id).map((q) => [q.qid, q]));
  const paper = JSON.parse(attempt.paper);
  return { exam, paper, paperQuestions: paper.qids.map((id) => byQid.get(id)).filter(Boolean) };
}

/**
 * Builds the UPDATE that stores recalculated totals/grade (and results and
 * overrides) for one attempt, WITHOUT running it, so bulk tools can send many
 * of them in one batch. Returns {statement, totals}.
 */
function totalsStatement(env, attempt, exam, paperQuestions, results, overrides) {
  const totals = computeTotals(paperQuestions, results, overrides, attempt.penalty);
  const grade = calculateGrade(totals.percentage, attempt.set_id, boundariesOf(exam));
  const statement = env.DB.prepare(
    'UPDATE attempts SET results = ?, overrides = ?, mc_score = ?, open_score = ?, max_score = ?, total_score = ?, ' +
    'percentage = ?, final_grade = ?, needs_review = ? WHERE id = ?')
    // needs_review is recounted here because an override is what clears a "needs teacher review" flag.
    .bind(JSON.stringify(results), JSON.stringify(overrides), totals.mcScore, totals.openScore, totals.maxScore,
          totals.totalScore, totals.percentage, grade, countNeedsReview(paperQuestions, results, overrides), attempt.id);
  return { statement, totals: { ...totals, finalGrade: grade } };
}

/** Writes recalculated totals/grade (and optionally results/overrides) back to an attempt. */
async function writeTotals(env, attempt, exam, paperQuestions, results, overrides) {
  const built = totalsStatement(env, attempt, exam, paperQuestions, results, overrides);
  await built.statement.run();
  return built.totals;
}

/** Teacher score overrides for non-MC questions. null clears one. */
export async function setOverrides(c) {
  const a = await requireAttempt(c.env, c.params.id);
  if (a.status !== 'graded') { throw new HttpError(409, 'not_graded', 'Only graded attempts can be overridden'); }
  const { exam, paperQuestions } = await paperContext(c.env, a);
  const byQid = new Map(paperQuestions.map((q) => [q.qid, q]));
  const overrides = JSON.parse(a.overrides || '{}');
  const incoming = c.body.overrides && typeof c.body.overrides === 'object' ? c.body.overrides : {};

  for (const qid of Object.keys(incoming)) {
    const q = byQid.get(qid);
    if (!q || q.type === 'mc') { throw new HttpError(400, 'bad_override', 'Cannot override ' + qid); }
    const v = incoming[qid];
    if (v === null) { delete overrides[qid]; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > q.points) { throw new HttpError(400, 'bad_override', 'Score out of range for ' + qid); }
    overrides[qid] = n;
  }
  const t = await writeTotals(c.env, a, exam, paperQuestions, JSON.parse(a.results || '{}'), overrides);
  return { body: { success: true, finalGrade: t.finalGrade, percentage: t.percentage, openScore: t.openScore } };
}

/**
 * Sets the anti-cheating penalty of a graded attempt (0 removes it). Use it
 * when the integrity log shows a false positive, for example a right-click on
 * a spell-check suggestion. The event log is NOT touched: it stays as evidence,
 * and a later "recalculate" keeps the penalty chosen here because totals use
 * the stored value.
 */
export async function setPenalty(c) {
  const a = await requireAttempt(c.env, c.params.id);
  if (a.status !== 'graded') { throw new HttpError(409, 'not_graded', 'Only graded attempts can be changed'); }
  const penalty = Number(c.body.penalty);
  if (!Number.isInteger(penalty) || penalty < 0 || penalty > 4) {
    throw new HttpError(400, 'bad_request', 'penalty must be a whole number from 0 to 4');
  }
  const { exam, paperQuestions } = await paperContext(c.env, a);
  await c.env.DB.prepare('UPDATE attempts SET penalty = ? WHERE id = ?').bind(penalty, a.id).run();
  const t = await writeTotals(c.env, { ...a, penalty }, exam, paperQuestions,
                              JSON.parse(a.results || '{}'), JSON.parse(a.overrides || '{}'));
  return { body: { success: true, penalty, totalScore: t.totalScore, percentage: t.percentage, finalGrade: t.finalGrade } };
}

/** Deletes an attempt. The student can then start the exam again (this is also "reset"). */
export async function deleteAttempt(c) {
  await c.env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(c.params.id).run();
  return { body: { success: true } };
}

/**
 * PUT /api/admin/attempts/:id/deadline -- {extraMinutes}: gives one student
 * more time (a bad connection, a teacher-approved accommodation). The minutes
 * are added to the CURRENT deadline and the attempt is marked deadline_manual,
 * so a later change of the exam's closing time does not take them back. Only an
 * attempt still in progress can be extended. The student's page learns the new
 * deadline from its next autosave.
 */
export async function setDeadline(c) {
  const a = await requireAttempt(c.env, c.params.id);
  if (a.status !== 'started') { throw new HttpError(409, 'not_in_progress', 'Only an attempt in progress can be extended'); }
  const extra = Number(c.body.extraMinutes);
  if (!Number.isInteger(extra) || extra < 1 || extra > MAX_EXTRA_MINUTES) {
    throw new HttpError(400, 'bad_request', 'extraMinutes must be a whole number from 1 to ' + MAX_EXTRA_MINUTES);
  }
  // Counted from whichever is later, the stored deadline or now, so extending
  // an attempt that has just run out still gives the student the full minutes.
  const base = Math.max(a.deadline_at, c.deps.now());
  const deadline = base + extra * 60 * 1000;
  await c.env.DB.prepare("UPDATE attempts SET deadline_at = ?, deadline_manual = 1 WHERE id = ? AND status = 'started'")
    .bind(deadline, a.id).run();
  return { body: { success: true, deadlineAt: deadline } };
}

// ---------- regrade (calls the model again) ----------

// Sends an attempt back to the start of grading: status `submitted`, the try
// counter at zero and the stored results cleared so every written answer is
// marked again. Teacher overrides and the integrity penalty are kept.
const RESET_FOR_REGRADE =
  "UPDATE attempts SET status = 'submitted', results = NULL, grade_attempts = 0, grading_started_at = NULL, " +
  'grading_error = NULL, submitted_at = COALESCE(submitted_at, ?) ';

/**
 * Grades one attempt again with the model. Two uses:
 *   - an attempt in `error` (bad API key, no credit, 5 failed tries) once the cause is fixed;
 *   - a `graded` attempt after its rubric or accepted answers were corrected.
 * An attempt that is waiting or being graded right now is refused (409).
 */
export async function regradeAttempt(c) {
  const a = await requireAttempt(c.env, c.params.id);
  if (!['error', 'graded'].includes(a.status)) {
    throw new HttpError(409, 'not_regradable', 'Only attempts that are graded or in error can be graded again');
  }
  const r = await c.env.DB.prepare(RESET_FOR_REGRADE + "WHERE id = ? AND status IN ('error','graded')")
    .bind(c.deps.now(), a.id).run();
  if (r.meta.changes) { await c.env.GRADE_QUEUE.send({ type: 'grade', attemptId: a.id }); }
  return { body: { success: true, status: 'queued' } };
}

/**
 * Sends every `error` attempt of one exam back to grading, a few per call.
 * The page repeats the call while `more` is true. If a queue send fails the
 * attempt is already `submitted`, so the sweep enqueues it later.
 */
export async function regradeErrors(c) {
  await requireExam(c.env, c.params.id);
  const { results } = await c.env.DB.prepare("SELECT id FROM attempts WHERE exam_id = ? AND status = 'error' LIMIT ?")
    .bind(c.params.id, MAX_REGRADE_PER_CALL + 1).all();
  const ids = results.slice(0, MAX_REGRADE_PER_CALL).map((r) => r.id);
  if (ids.length) {
    await c.env.DB.prepare(RESET_FOR_REGRADE + "WHERE status = 'error' AND id IN (" + ids.map(() => '?').join(',') + ')')
      .bind(c.deps.now(), ...ids).run();
    for (const id of ids) { await c.env.GRADE_QUEUE.send({ type: 'grade', attemptId: id }); }
  }
  return { body: { success: true, queued: ids.length, more: results.length > MAX_REGRADE_PER_CALL } };
}

// ---------- bulk maintenance (always scoped to ONE exam) ----------

/**
 * Walks graded attempts of an exam in chunks. `perAttempt(attempt, ctx)` returns
 * the UPDATE statement to run for that attempt, or null to leave it. The admin
 * page repeats the call with the returned `nextAfterId` until it is null.
 *
 * Query cost per call is fixed at 4 (exam, questions, attempts, one batch of
 * updates). It used to be 3 per attempt, which went past D1's 50-per-invocation
 * limit for any class of more than about 15 graded attempts.
 */
async function bulkWalk(c, perAttempt) {
  const exam = await requireExam(c.env, c.params.id);
  const after = String(c.body.afterId || '');
  const { results: questionRows } = await c.env.DB.prepare('SELECT * FROM questions WHERE exam_id = ?').bind(exam.id).all();
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM attempts WHERE exam_id = ? AND status = 'graded' AND id > ? ORDER BY id LIMIT ?")
    .bind(c.params.id, after, MAX_UPDATES_PER_CALL).all();
  const statements = [];
  for (const a of results) {
    const statement = await perAttempt(a, paperFrom(exam, questionRows, a), exam);
    if (statement) { statements.push(statement); }
  }
  if (statements.length) { await c.env.DB.batch(statements); }
  const last = results.length === MAX_UPDATES_PER_CALL ? results[results.length - 1].id : null;
  return { body: { success: true, changed: statements.length, nextAfterId: last } };
}

/** Recomputes totals and grades (after boundaries or overrides changed). */
export async function recalculate(c) {
  return bulkWalk(c, async (a, { paperQuestions }, exam) =>
    totalsStatement(c.env, a, exam, paperQuestions, JSON.parse(a.results || '{}'), JSON.parse(a.overrides || '{}')).statement);
}

/**
 * Re-marks every MC answer against the CURRENT answer key (after a wrong key was
 * corrected). Stored answers are re-used; no model call is made.
 */
export async function regradeMc(c) {
  const noModel = async () => { throw new Error('MC regrade must not call the model'); };
  return bulkWalk(c, async (a, { paperQuestions }, exam) => {
    const answers = JSON.parse(a.answers || '{}');
    const results = JSON.parse(a.results || '{}');
    for (const q of paperQuestions) {
      if (q.type === 'mc') { results[q.qid] = await gradeQuestion(q, answers[q.qid], noModel); }
    }
    return totalsStatement(c.env, a, exam, paperQuestions, results, JSON.parse(a.overrides || '{}')).statement;
  });
}

// ---------- results email ----------

/**
 * Marks the graded attempts of an exam (optionally one class and/or set) as
 * 'pending' email again; the once-a-minute sweep sends them. Nothing is sent
 * from this request, so it stays fast however many students match.
 */
export async function resendEmails(c) {
  await requireExam(c.env, c.params.id);
  if (!c.env.MAIL_RELAY_URL) { throw new HttpError(409, 'email_disabled', 'Email relay is not configured'); }
  const klass = String(c.body.class || '').trim();
  const setId = String(c.body.set || '').trim().toUpperCase();
  let sql = "UPDATE attempts SET email_status = 'pending' WHERE exam_id = ? AND status = 'graded' AND email_status != 'pending'";
  const binds = [c.params.id];
  if (klass) { sql += ' AND class = ?'; binds.push(klass); }
  if (setId) { sql += ' AND set_id = ?'; binds.push(setId); }
  const r = await c.env.DB.prepare(sql).bind(...binds).run();
  return { body: { success: true, queued: r.meta.changes } };
}

// ---------- similarity report ----------

/** Queues a (re)computation of the similarity report for an exam. */
export async function requestSimilarity(c) {
  await requireExam(c.env, c.params.id);
  await c.env.DB.prepare(
    "INSERT INTO similarity_reports (exam_id, status) VALUES (?, 'queued') " +
    "ON CONFLICT(exam_id) DO UPDATE SET status = 'queued', error = NULL").bind(c.params.id).run();
  await c.env.GRADE_QUEUE.send({ type: 'similarity', examId: c.params.id });
  return { body: { success: true, status: 'queued' } };
}

export async function getSimilarity(c) {
  await requireExam(c.env, c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM similarity_reports WHERE exam_id = ?').bind(c.params.id).first();
  if (!row) { return { body: { success: true, status: 'none' } }; }
  return { body: { success: true, status: row.status, computedAt: row.computed_at,
                   error: row.error, report: row.output ? JSON.parse(row.output) : null } };
}

// ---------- teachers (admin role only) ----------

function requireAdminRole(c) {
  if (c.teacher.role !== 'admin') { throw new HttpError(403, 'forbidden', 'Admin role required'); }
}

export async function listTeachers(c) {
  requireAdminRole(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM teachers ORDER BY email').all();
  return { body: { success: true, teachers: results.map((t) => ({
    email: t.email, name: t.name, role: t.role, retakeExempt: !!t.retake_exempt })) } };
}

export async function addTeacher(c) {
  requireAdminRole(c);
  const email = String(c.body.email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { throw new HttpError(400, 'bad_request', 'A valid email is required'); }
  const role = c.body.role === 'admin' ? 'admin' : 'teacher';
  // This call also edits an existing row, so it could demote the only admin and
  // lock everyone out of the Teachers tab (fixing that needs a manual D1 edit).
  if (role !== 'admin') {
    const others = await c.env.DB.prepare("SELECT count(*) AS n FROM teachers WHERE role = 'admin' AND email != ?").bind(email).first();
    const current = await c.env.DB.prepare('SELECT role FROM teachers WHERE email = ?').bind(email).first();
    if (current && current.role === 'admin' && !others.n) {
      throw new HttpError(409, 'last_admin', 'There must be at least one admin');
    }
  }
  await c.env.DB.prepare(
    'INSERT INTO teachers (email, name, role, retake_exempt, added_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, retake_exempt = excluded.retake_exempt')
    .bind(email, String(c.body.name || '').slice(0, 100), role, c.body.retakeExempt ? 1 : 0, c.deps.now()).run();
  return { body: { success: true } };
}

export async function removeTeacher(c) {
  requireAdminRole(c);
  const email = decodeURIComponent(c.params.email).toLowerCase();
  if (email === c.teacher.email) { throw new HttpError(400, 'bad_request', 'You cannot remove yourself'); }
  await c.env.DB.prepare('DELETE FROM teachers WHERE email = ?').bind(email).run();
  return { body: { success: true } };
}
