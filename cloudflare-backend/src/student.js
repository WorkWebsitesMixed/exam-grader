/**
 * student.js -- the endpoints a student's browser calls during an exam.
 *
 * Role: replaces doGet (questions), handleCheckDuplicate, handleSubmission and
 * getMyResultsResponse of Code.gs. The flow is:
 *
 *   GET  /api/exam      public paper (no answers/rubrics), cacheable
 *   POST /api/start     verify Google token, create-or-resume the attempt
 *   POST /api/save      autosave answers (every ~30 s, only when changed)
 *   POST /api/submit    final answers; queues grading; returns immediately
 *   GET  /api/result    graded result, released only after the exam deadline
 *   POST /api/myresults all graded attempts of the signed-in student
 *
 * Handlers receive one context object `c`: {request, env, deps, url, params, body}.
 */

import { HttpError, clampInt } from './http.js';
import { verifyGoogleIdToken } from './auth.js';
import { buildPaper, publicQuestion } from './paper.js';
import { sanitizeEvents, mergeEvents, withLegacySwitches, assessEvents, parseEvents, MAX_FAULTS, FAULT_POINTS } from './integrity.js';

// Seconds of grace after the deadline during which autosave is still accepted
// (clock drift, a slow network at the last second).
const SAVE_GRACE_MS = 60 * 1000;
// A final submit this late after the deadline still replaces the saved answers.
const SUBMIT_GRACE_MS = 120 * 1000;
// Public exam payload is cached per isolate for this long (admin edits to an
// ACTIVE exam can take up to this long to reach students, same as the old 30 s cache).
const EXAM_CACHE_MS = 30 * 1000;

const examCache = new Map();  // key -> {expiresAt, payload}

/** Test hook. */
export function resetStudentCaches() { examCache.clear(); }

// ---------- shared lookups ----------

/** Finds the exam named by `examId`, or the default exam when none is given. */
async function findExam(env, examId) {
  if (examId) { return env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first(); }
  return env.DB.prepare('SELECT * FROM exams WHERE is_default = 1 LIMIT 1').first();
}

async function loadAttempt(env, attemptId) {
  if (!attemptId || typeof attemptId !== 'string') { throw new HttpError(400, 'bad_request', 'attemptId is required'); }
  const row = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(attemptId).first();
  if (!row) { throw new HttpError(404, 'attempt_not_found', 'Attempt not found'); }
  return row;
}

async function isRetakeExempt(env, email) {
  const row = await env.DB.prepare('SELECT retake_exempt FROM teachers WHERE email = ?').bind(email).first();
  return !!(row && row.retake_exempt);
}

/** The config keys grader.html already understands (same names as the old Config sheet). */
function publicConfig(exam) {
  const cfg = {
    exam_id: exam.id,
    exam_title: exam.title,
    exam_subtitle: exam.subtitle,
    class_options: JSON.parse(exam.class_options || '[]').join(','),
    exam_duration_minutes: String(exam.duration_min),
    exam_active: exam.active ? 'true' : 'false',
    exam_type: exam.exam_type,
    set_mode: exam.set_mode,
  };
  // Grade boundaries in the old "4.0:90,3.7:80" string form, which grader.html
  // already parses to show the grading scale before the exam starts.
  const bounds = JSON.parse(exam.grade_boundaries || '{}');
  ['A', 'B', 'C'].forEach((s) => {
    if (Array.isArray(bounds[s]) && bounds[s].length) {
      cfg['grade_boundaries_' + s] = bounds[s].map((b) => b.grade + ':' + b.min).join(',');
    }
  });
  const cards = JSON.parse(exam.set_cards || '{}');
  ['A', 'B', 'C'].forEach((s) => {
    const card = cards[s];
    if (!card) { return; }
    const k = s.toLowerCase();
    cfg['set_' + k + '_label'] = card.label || '';
    cfg['set_' + k + '_max_grade'] = card.max_grade || '';
    cfg['set_' + k + '_description'] = card.description || '';
  });
  return cfg;
}

/** Keeps only known question ids and sane values; protects the database from junk. */
function sanitizeAnswers(raw, qids) {
  const out = {};
  if (!raw || typeof raw !== 'object') { return out; }
  for (const qid of qids) {
    const v = raw[qid];
    if (Number.isInteger(v) && v >= 0 && v <= 3) { out[qid] = v; }
    else if (typeof v === 'string') { out[qid] = v.slice(0, 20000); }
  }
  return out;
}

/**
 * Folds the integrity events of a request into the attempt's stored log and
 * returns the server's verdict. Three input shapes are accepted:
 *   - `events` (current page): appended, duplicates ignored;
 *   - only `tabSwitches` (an older cached page): converted to 'away' events;
 *   - nothing: the stored log stands.
 * The penalty, fault count and auto-submit decision always come from the
 * verdict, never from a number the browser sends.
 */
function integrityFrom(attempt, body, nowMs) {
  let events = parseEvents(attempt.events);
  if (Array.isArray(body.events)) { events = mergeEvents(events, sanitizeEvents(body.events)); }
  else if (body.tabSwitches !== undefined) { events = withLegacySwitches(events, body.tabSwitches, nowMs); }
  if (!events.length && attempt.tab_switches > 0) { events = withLegacySwitches(events, attempt.tab_switches, nowMs); }
  return { events, verdict: assessEvents(events) };
}

/** The numbers stored next to the log so lists never have to parse it. */
function integrityColumns(attempt, events, verdict) {
  return [JSON.stringify(events), verdict.faults, verdict.warnings, verdict.awayMs, verdict.pasteEvents,
          verdict.pasteChars, Math.max(attempt.tab_switches, verdict.awayEvents), verdict.penalty];
}

// ---------- GET /api/exam ----------

export async function getExam(c) {
  const examId = c.url.searchParams.get('exam') || '';
  const key = examId || '__default__';
  const now = c.deps.now();
  const cached = examCache.get(key);
  if (cached && cached.expiresAt > now) { return { body: cached.payload, cacheSeconds: 30 }; }

  const exam = await findExam(c.env, examId);
  if (!exam) { throw new HttpError(404, 'exam_not_found', 'Exam not found'); }

  const payload = { success: true, config: publicConfig(exam), questions: { A: [], B: [], C: [] } };
  // An inactive exam exposes only its config so the page can say "closed".
  if (exam.active) {
    const { results } = await c.env.DB
      .prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY set_id, position')
      .bind(exam.id).all();
    for (const q of results) { payload.questions[q.set_id].push(publicQuestion(q)); }
  }
  examCache.set(key, { expiresAt: now + EXAM_CACHE_MS, payload });
  return { body: payload, cacheSeconds: 30 };
}

// ---------- POST /api/start ----------

export async function startAttempt(c) {
  const { env, deps, body } = c;
  // 1. Identity. Mandatory, verified locally; the body's email is never read.
  const who = await verifyGoogleIdToken(body.idToken, env, deps);

  const exam = await findExam(env, String(body.exam || ''));
  if (!exam) { throw new HttpError(404, 'exam_not_found', 'Exam not found'); }
  const exempt = await isRetakeExempt(env, who.email);
  if (!exam.active && !exempt) { throw new HttpError(403, 'exam_closed', 'This exam is not open'); }

  const setId = String(body.set || '');
  const firstName = String(body.firstName || '').trim().slice(0, 80);
  const lastName = String(body.lastName || '').trim().slice(0, 80);
  const studentClass = String(body.class || '').trim().slice(0, 20);
  if (!['A', 'B', 'C'].includes(setId)) { throw new HttpError(400, 'invalid_set', 'Invalid set'); }
  if (!firstName || !lastName) { throw new HttpError(400, 'name_required', 'First and last name are required'); }

  // 2. Existing attempt: resume it, or refuse a repeat.
  let attempt = await env.DB
    .prepare('SELECT * FROM attempts WHERE exam_id = ? AND email = ? AND set_id = ?')
    .bind(exam.id, who.email, setId).first();

  if (attempt && attempt.status !== 'started') {
    if (!exempt) { return { body: { success: true, duplicate: true } }; }
    // Teacher test account: wipe the old attempt so it can run the exam again.
    await env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(attempt.id).run();
    attempt = null;
  }

  let resumed = !!attempt;
  if (!attempt) {
    const { results: qs } = await env.DB
      .prepare('SELECT * FROM questions WHERE exam_id = ? AND set_id = ? ORDER BY position')
      .bind(exam.id, setId).all();
    if (!qs.length) { throw new HttpError(400, 'invalid_set', 'That set has no questions'); }

    const paper = buildPaper(exam, qs, deps.random);
    const now = deps.now();
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO attempts (id, exam_id, set_id, email, first_name, last_name, class, started_at, deadline_at, paper) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, exam.id, setId, who.email, firstName, lastName, studentClass,
              now, now + exam.duration_min * 60 * 1000, JSON.stringify(paper)).run();
    } catch (e) {
      // Two starts raced: the UNIQUE constraint rejected the second. Resume the winner.
      if (!/UNIQUE/i.test(String(e.message))) { throw e; }
      resumed = true;
    }
    attempt = await env.DB
      .prepare('SELECT * FROM attempts WHERE exam_id = ? AND email = ? AND set_id = ?')
      .bind(exam.id, who.email, setId).first();
  }

  return { body: {
    success: true,
    attemptId: attempt.id,
    resumed,
    startedAt: attempt.started_at,
    deadlineAt: attempt.deadline_at,
    serverNow: deps.now(),
    paper: JSON.parse(attempt.paper),
    answers: JSON.parse(attempt.answers || '{}'),
    tabSwitches: attempt.tab_switches,
    // Where the integrity log stands, so a resumed page continues the same
    // strikes (and the same first-warning flags) instead of starting over.
    integrity: integritySnapshot(attempt),
  } };
}

/** The integrity state the page needs to continue after a reload. */
function integritySnapshot(attempt) {
  const events = parseEvents(attempt.events);
  const v = assessEvents(events);
  return {
    faults: v.faults, warnings: v.warnings, seen: v.seen, penalty: v.penalty, autoSubmit: v.autoSubmit,
    eventsCount: events.length ? events[events.length - 1].seq + 1 : 0,
    maxFaults: MAX_FAULTS, faultPoints: FAULT_POINTS,
  };
}

// ---------- POST /api/save ----------

export async function saveAnswers(c) {
  const { env, deps, body } = c;
  const attempt = await loadAttempt(env, body.attemptId);
  if (attempt.status !== 'started') { throw new HttpError(409, 'already_submitted', 'Attempt already submitted'); }
  const now = deps.now();
  if (now > attempt.deadline_at + SAVE_GRACE_MS) { throw new HttpError(409, 'deadline_passed', 'Time is up'); }

  const paper = JSON.parse(attempt.paper);
  const answers = sanitizeAnswers(body.answers, paper.qids);
  const { events, verdict } = integrityFrom(attempt, body, now);
  const cols = integrityColumns(attempt, events, verdict);

  // Third fault: the SERVER submits the exam, so a page that ignores the
  // instruction cannot keep working. The answers in this request are kept.
  const forced = verdict.autoSubmit;
  await env.DB.prepare(
    'UPDATE attempts SET answers = ?, answers_saved_at = ?, events = ?, faults = ?, warnings = ?, away_ms = ?, ' +
    "paste_events = ?, paste_chars = ?, tab_switches = ?, penalty = ?, status = ?, submitted_at = ? " +
    "WHERE id = ? AND status = 'started'")
    .bind(JSON.stringify(answers), now, ...cols, forced ? 'submitted' : 'started', forced ? now : null, attempt.id).run();
  if (forced) {
    try { await env.GRADE_QUEUE.send({ type: 'grade', attemptId: attempt.id }); }
    catch (e) { console.error('enqueue failed, the sweep will retry', e && e.message); }
  }
  return { body: { success: true, savedAt: now, autoSubmitted: forced, faults: verdict.faults,
                   warnings: verdict.warnings, penalty: verdict.penalty } };
}

// ---------- POST /api/submit ----------

export async function submitAttempt(c) {
  const { env, deps, body } = c;
  const attempt = await loadAttempt(env, body.attemptId);

  // Idempotent: a retried submit just reports the current state.
  if (attempt.status !== 'started') {
    return { body: { success: true, status: attempt.status, deadlineAt: attempt.deadline_at } };
  }

  const now = deps.now();
  const paper = JSON.parse(attempt.paper);
  // Within the grace window the posted answers are final. Later than that, the
  // posted answers are ignored and the last autosave stands (a late submit must
  // not be a way to keep working past the deadline).
  const accept = now <= attempt.deadline_at + SUBMIT_GRACE_MS;
  const answers = accept ? sanitizeAnswers(body.answers, paper.qids) : JSON.parse(attempt.answers || '{}');
  // Integrity events are evidence, so they are accepted even from a late submit.
  const { events, verdict } = integrityFrom(attempt, body, now);
  const cols = integrityColumns(attempt, events, verdict);

  await env.DB.prepare(
    "UPDATE attempts SET status = 'submitted', submitted_at = ?, answers = ?, answers_saved_at = ?, " +
    'events = ?, faults = ?, warnings = ?, away_ms = ?, paste_events = ?, paste_chars = ?, tab_switches = ?, ' +
    'penalty = ? WHERE id = ? AND status = ?')
    .bind(now, JSON.stringify(answers), now, ...cols, attempt.id, 'started').run();

  try { await env.GRADE_QUEUE.send({ type: 'grade', attemptId: attempt.id }); }
  catch (e) { console.error('enqueue failed, the sweep will retry', e && e.message); }

  return { body: { success: true, status: 'queued', deadlineAt: attempt.deadline_at } };
}

// ---------- result formatting ----------

/** Effective score of one stored result (a teacher override wins for non-MC). */
function effectiveScore(r, override) {
  return r.type !== 'mc' && override !== undefined && override !== null ? Number(override) : Number(r.score) || 0;
}

/** The shape grader.html already renders (openFeedback / mcFeedback). */
function formatResult(attempt) {
  const results = JSON.parse(attempt.results || '{}');
  const overrides = JSON.parse(attempt.overrides || '{}');
  const paper = JSON.parse(attempt.paper);
  const openFeedback = [];
  const mcFeedback = [];
  for (const qid of paper.qids) {
    const r = results[qid];
    if (!r) { continue; }
    const score = effectiveScore(r, overrides[qid]);
    if (r.type === 'mc') {
      mcFeedback.push({ questionId: qid, questionText: r.text, correct: r.correct, selectedText: r.selected,
                        correctText: r.correctText, earned: score, points: r.max });
    } else {
      openFeedback.push({ questionId: qid, questionText: r.text, studentAnswer: r.answer || '', score,
                          maxScore: r.max, feedback: r.feedback || '', type: r.type, accepted: r.accepted || '' });
    }
  }
  return {
    success: true,
    status: 'graded',
    ready: true,
    firstName: attempt.first_name,
    lastName: attempt.last_name,
    set: attempt.set_id,
    totalScore: attempt.total_score,
    maxScore: attempt.max_score,
    percentage: attempt.percentage,
    finalGrade: attempt.final_grade,
    penalty: attempt.penalty,
    openFeedback,
    mcFeedback,
  };
}

// ---------- GET /api/result ----------

/**
 * Results are held SERVER-SIDE until the exam deadline, even when the student
 * submitted early (the old page only hid them in the browser; the data had
 * already been delivered).
 */
export async function getResult(c) {
  const attempt = await loadAttempt(c.env, c.url.searchParams.get('attemptId'));
  const now = c.deps.now();
  if (attempt.status !== 'graded') {
    return { body: { success: true, ready: false, status: attempt.status, releaseAt: attempt.deadline_at } };
  }
  if (now < attempt.deadline_at) {
    return { body: { success: true, ready: false, status: 'held', releaseAt: attempt.deadline_at } };
  }
  return { body: formatResult(attempt) };
}

// ---------- POST /api/myresults ----------

export async function myResults(c) {
  const { env, deps, body } = c;
  const who = await verifyGoogleIdToken(body.idToken, env, deps);
  const { results: rows } = await env.DB
    .prepare("SELECT * FROM attempts WHERE email = ? AND status = 'graded' AND deadline_at <= ? ORDER BY started_at DESC")
    .bind(who.email, deps.now()).all();

  const submissions = rows.map((a) => {
    const stored = JSON.parse(a.results || '{}');
    const overrides = JSON.parse(a.overrides || '{}');
    const paper = JSON.parse(a.paper);
    const details = paper.qids.filter((q) => stored[q]).map((qid) => {
      const r = stored[qid];
      const score = effectiveScore(r, overrides[qid]);
      const isMc = r.type === 'mc';
      return {
        questionId: qid, type: r.type, questionText: r.text,
        studentAnswer: isMc ? r.selected : (r.answer || ''),
        correctAnswer: isMc ? r.correctText : (r.accepted || ''),
        isCorrect: isMc ? (r.correct ? 'TRUE' : 'FALSE') : '',
        aiScore: score, maxScore: r.max,
        aiFeedback: isMc ? (r.correct ? 'Correct' : 'Incorrect. Correct answer: ' + r.correctText) : (r.feedback || ''),
      };
    });
    return {
      timestamp: new Date(a.started_at).toISOString(), firstName: a.first_name, lastName: a.last_name,
      class: a.class, set: a.set_id, examId: a.exam_id, mcScore: a.mc_score, openScore: a.open_score,
      penalty: a.penalty, totalScore: a.total_score, maxScore: a.max_score, percentage: a.percentage,
      finalGrade: a.final_grade, details,
    };
  });
  return { body: { success: true, submissions } };
}
