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
 * MAX_UPDATES_PER_CALL rows and return a cursor: D1's free plan allows 50
 * queries per invocation, and the admin page simply repeats the call until
 * `nextAfterId` is null.
 *
 * Not in this file yet (next slice): image upload, PDF jobs, email resend,
 * export, distractor analysis.
 */

import { HttpError, clampInt } from './http.js';
import { verifyGoogleIdToken, signSession } from './auth.js';
import { calculateGrade, computeTotals, gradeQuestion } from './grading.js';
import { boundariesOf } from './queue.js';
import { assessEvents, parseEvents } from './integrity.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_UPDATES_PER_CALL = 40;  // + 2 selects stays under D1's 50 queries/invocation

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

/** Validates the editable exam fields; returns a {column: value} object of what was supplied. */
function examFields(body) {
  const out = {};
  const text = (v, max) => String(v).slice(0, max);
  if (body.title !== undefined) { out.title = text(body.title, 200); }
  if (body.subtitle !== undefined) { out.subtitle = text(body.subtitle, 300); }
  if (body.active !== undefined) { out.active = body.active ? 1 : 0; }
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
    if (typeof body.gradeBoundaries !== 'object' || body.gradeBoundaries === null) { throw new HttpError(400, 'bad_request', 'gradeBoundaries'); }
    out.grade_boundaries = JSON.stringify(body.gradeBoundaries);
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
    id: e.id, title: e.title, subtitle: e.subtitle, active: !!e.active, isDefault: !!e.is_default,
    durationMin: e.duration_min, examType: e.exam_type, setMode: e.set_mode,
    classOptions: JSON.parse(e.class_options || '[]'), questionsPerSet: e.questions_per_set,
    oePerSet: e.oe_per_set, randomize: !!e.randomize,
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
    'INSERT INTO exams (id, title, subtitle, active, is_default, duration_min, exam_type, set_mode, class_options, ' +
    'questions_per_set, oe_per_set, randomize, grade_boundaries, set_cards, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, f.title || id, f.subtitle || '', f.active || 0, 0, f.duration_min || 60,
          f.exam_type || 'igcse', f.set_mode || 'single', f.class_options || '[]',
          f.questions_per_set || 0, f.oe_per_set || 0, f.randomize || 0,
          f.grade_boundaries || '{}', f.set_cards || '{}', now, now).run();
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
  await requireExam(env, c.params.id);
  const f = examFields(body);
  const isDefault = f.is_default;
  delete f.is_default;  // handled separately to keep it exclusive
  const cols = Object.keys(f);
  if (cols.length) {
    const sql = 'UPDATE exams SET ' + cols.map((k) => k + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?';
    await env.DB.prepare(sql).bind(...cols.map((k) => f[k]), deps.now(), c.params.id).run();
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
                options: null, correct_index: null, rubric: '', accepted_answers: null, image_hash: null };

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
    imageHash: r.image_hash,
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
      'rubric, accepted_answers, image_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(examId, r.set_id, r.qid, position, r.section, r.type, r.points, r.text, r.options, r.correct_index,
            r.rubric, r.accepted_answers, r.image_hash).run();
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
    'correct_index = ?, rubric = ?, accepted_answers = ?, image_hash = ? WHERE id = ?')
    .bind(r.position, r.section, r.type, r.points, r.text, r.options, r.correct_index, r.rubric,
          r.accepted_answers, r.image_hash, existing.id).run();
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
    'grading_error, faults, warnings, away_ms, paste_events, paste_chars FROM attempts WHERE exam_id = ? ORDER BY started_at DESC').bind(examId).all();
  return { body: { success: true, attempts: results.map((a) => ({
    id: a.id, examId: a.exam_id, set: a.set_id, email: a.email, firstName: a.first_name, lastName: a.last_name,
    class: a.class, timestamp: new Date(a.started_at).toISOString(), submittedAt: a.submitted_at,
    deadlineAt: a.deadline_at, status: a.status, tabSwitches: a.tab_switches, penalty: a.penalty,
    mcScore: a.mc_score, openScore: a.open_score, totalScore: a.total_score, maxScore: a.max_score,
    percentage: a.percentage, finalGrade: a.final_grade, emailStatus: a.email_status, gradingError: a.grading_error,
    // Integrity summary (details in the attempt view)
    faults: a.faults, warnings: a.warnings, awayMs: a.away_ms, pasteEvents: a.paste_events, pasteChars: a.paste_chars,
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
  const byQid = new Map(results.map((q) => [q.qid, q]));
  const paper = JSON.parse(attempt.paper);
  return { exam, paper, paperQuestions: paper.qids.map((id) => byQid.get(id)).filter(Boolean) };
}

/** Writes recalculated totals/grade (and optionally results/overrides) back to an attempt. */
async function writeTotals(env, attempt, exam, paperQuestions, results, overrides) {
  const totals = computeTotals(paperQuestions, results, overrides, attempt.penalty);
  const grade = calculateGrade(totals.percentage, attempt.set_id, boundariesOf(exam));
  await env.DB.prepare(
    'UPDATE attempts SET results = ?, overrides = ?, mc_score = ?, open_score = ?, max_score = ?, total_score = ?, ' +
    'percentage = ?, final_grade = ? WHERE id = ?')
    .bind(JSON.stringify(results), JSON.stringify(overrides), totals.mcScore, totals.openScore, totals.maxScore,
          totals.totalScore, totals.percentage, grade, attempt.id).run();
  return { ...totals, finalGrade: grade };
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

/** Deletes an attempt. The student can then start the exam again (this is also "reset"). */
export async function deleteAttempt(c) {
  await c.env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(c.params.id).run();
  return { body: { success: true } };
}

// ---------- bulk maintenance (always scoped to ONE exam) ----------

/**
 * Walks graded attempts of an exam in chunks. `perAttempt(attempt, ctx)` returns
 * true when it changed the row. The admin page repeats the call with the
 * returned `nextAfterId` until it is null.
 */
async function bulkWalk(c, perAttempt) {
  await requireExam(c.env, c.params.id);
  const after = String(c.body.afterId || '');
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM attempts WHERE exam_id = ? AND status = 'graded' AND id > ? ORDER BY id LIMIT ?")
    .bind(c.params.id, after, MAX_UPDATES_PER_CALL).all();
  let changed = 0;
  for (const a of results) {
    if (await perAttempt(a)) { changed++; }
  }
  const last = results.length === MAX_UPDATES_PER_CALL ? results[results.length - 1].id : null;
  return { body: { success: true, changed, nextAfterId: last } };
}

/** Recomputes totals and grades (after boundaries or overrides changed). */
export async function recalculate(c) {
  return bulkWalk(c, async (a) => {
    const { exam, paperQuestions } = await paperContext(c.env, a);
    await writeTotals(c.env, a, exam, paperQuestions, JSON.parse(a.results || '{}'), JSON.parse(a.overrides || '{}'));
    return true;
  });
}

/**
 * Re-marks every MC answer against the CURRENT answer key (after a wrong key was
 * corrected). Stored answers are re-used; no model call is made.
 */
export async function regradeMc(c) {
  const noModel = async () => { throw new Error('MC regrade must not call the model'); };
  return bulkWalk(c, async (a) => {
    const { exam, paperQuestions } = await paperContext(c.env, a);
    const answers = JSON.parse(a.answers || '{}');
    const results = JSON.parse(a.results || '{}');
    for (const q of paperQuestions) {
      if (q.type === 'mc') { results[q.qid] = await gradeQuestion(q, answers[q.qid], noModel); }
    }
    await writeTotals(c.env, a, exam, paperQuestions, results, JSON.parse(a.overrides || '{}'));
    return true;
  });
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
