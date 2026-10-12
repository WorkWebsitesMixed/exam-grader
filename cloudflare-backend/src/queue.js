/**
 * queue.js -- background work: grading, and the once-a-minute sweep.
 *
 * Role: this is what lets the exam page answer instantly. /api/submit only
 * stores the answers and drops a message here; the consumer does the slow
 * model calls. Grading speed does not matter, access does.
 *
 * Reliability design (the free plan keeps queue messages only 24 h, and a
 * message can be lost or processed twice):
 *   - The attempt row in D1 is the source of truth: `status` says what is
 *     left to do. A message is just a nudge.
 *   - Grading is idempotent: an attempt that is already `graded` is skipped.
 *   - The sweep re-enqueues anything stuck, so a lost message heals itself.
 * D1's free plan allows 50 queries per invocation, hence the small LIMITs.
 */

import { makeAskModel } from './claude.js';
import { GradingError, DEFAULT_BOUNDARIES, calculateGrade, computeTotals, gradeQuestion } from './grading.js';
import { assessEvents, parseEvents, withLegacySwitches } from './integrity.js';
import { buildSimilarityReport } from './similarity.js';
import { sendAttemptEmail } from './mail.js';
import { processJob } from './jobs.js';

const SWEEP_LIMIT = 10;                 // rows per category per run (query budget)
const SUBMIT_GRACE_MS = 60 * 1000;      // after the deadline before auto-submitting
const STUCK_GRADING_MS = 10 * 60 * 1000;
const STUCK_SUBMITTED_MS = 2 * 60 * 1000;
const STUCK_JOB_MS = 20 * 60 * 1000;
const EMAIL_PER_SWEEP = 8;             // results emails sent per run (sent in parallel)

/** Parses an exam's boundaries JSON, falling back per set to the defaults. */
export function boundariesOf(exam) {
  let own = {};
  try { own = JSON.parse(exam.grade_boundaries || '{}'); } catch (e) { own = {}; }
  return { A: own.A || DEFAULT_BOUNDARIES.A, B: own.B || DEFAULT_BOUNDARIES.B, C: own.C || DEFAULT_BOUNDARIES.C };
}

/**
 * Grades one attempt and writes the result. Returns 'graded', 'skipped' or
 * 'error'. Throws only for RETRYABLE failures, so the queue can retry later.
 */
export async function processGrade(env, deps, attemptId) {
  const attempt = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(attemptId).first();
  if (!attempt || !['submitted', 'grading', 'error'].includes(attempt.status)) { return 'skipped'; }

  await env.DB.prepare("UPDATE attempts SET status = 'grading' WHERE id = ? AND status IN ('submitted','grading','error')")
    .bind(attemptId).run();

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(attempt.exam_id).first();
  const paper = JSON.parse(attempt.paper);
  const answers = JSON.parse(attempt.answers || '{}');
  const { results: rows } = await env.DB
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND set_id = ?').bind(attempt.exam_id, attempt.set_id).all();
  const byQid = new Map(rows.map((q) => [q.qid, q]));
  const paperQuestions = paper.qids.map((qid) => byQid.get(qid)).filter(Boolean);

  const askModel = makeAskModel(env, deps);
  const results = {};
  try {
    // Sequential on purpose: keeps us well under the model's per-minute limits.
    for (const q of paperQuestions) { results[q.qid] = await gradeQuestion(q, answers[q.qid], askModel); }
  } catch (e) {
    if (e instanceof GradingError && !e.retryable) {
      await env.DB.prepare("UPDATE attempts SET status = 'error', grading_error = ? WHERE id = ?")
        .bind(e.message, attemptId).run();
      return 'error';
    }
    throw e;  // retryable: the consumer asks the queue to try again
  }

  const overrides = JSON.parse(attempt.overrides || '{}');
  // Penalty comes from the integrity log (also covers sweep-submitted attempts).
  // An attempt recorded before the log existed only has a switch count.
  let events = parseEvents(attempt.events);
  if (!events.length && attempt.tab_switches > 0) { events = withLegacySwitches(events, attempt.tab_switches, deps.now()); }
  const penalty = assessEvents(events).penalty;
  const totals = computeTotals(paperQuestions, results, overrides, penalty);
  const finalGrade = calculateGrade(totals.percentage, attempt.set_id, boundariesOf(exam));
  const emailStatus = env.MAIL_RELAY_URL ? 'pending' : 'none';

  await env.DB.prepare(
    "UPDATE attempts SET status = 'graded', results = ?, mc_score = ?, open_score = ?, max_score = ?, " +
    'total_score = ?, percentage = ?, final_grade = ?, penalty = ?, graded_at = ?, grading_error = NULL, ' +
    'email_status = ? WHERE id = ?')
    .bind(JSON.stringify(results), totals.mcScore, totals.openScore, totals.maxScore, totals.totalScore,
          totals.percentage, finalGrade, penalty, deps.now(), emailStatus, attemptId).run();
  return 'graded';
}

/**
 * Computes the similarity report of one exam and stores it. Runs in the queue
 * consumer (30 s CPU) because comparing every pair of students is far more than
 * the 10 ms a normal request may use. At most 150 graded attempts are compared.
 */
export async function processSimilarity(env, deps, examId) {
  try {
    const { results: attempts } = await env.DB.prepare(
      "SELECT id, email, first_name, last_name, class, set_id, answers, paper FROM attempts " +
      "WHERE exam_id = ? AND status = 'graded' ORDER BY started_at LIMIT 150").bind(examId).all();
    const { results: questions } = await env.DB.prepare(
      'SELECT set_id, qid, type, text, correct_index FROM questions WHERE exam_id = ?').bind(examId).all();
    const report = buildSimilarityReport(attempts, questions);
    await env.DB.prepare(
      "UPDATE similarity_reports SET status = 'done', computed_at = ?, output = ?, error = NULL WHERE exam_id = ?")
      .bind(deps.now(), JSON.stringify(report), examId).run();
  } catch (e) {
    await env.DB.prepare("UPDATE similarity_reports SET status = 'error', error = ? WHERE exam_id = ?")
      .bind(String(e && e.message).slice(0, 300), examId).run();
  }
}

/** Queue entry point: one message per invocation (see wrangler.toml). */
export async function handleQueueBatch(batch, env, deps) {
  for (const message of batch.messages) {
    const body = message.body || {};
    try {
      if (body.type === 'grade') { await processGrade(env, deps, body.attemptId); }
      if (body.type === 'similarity') { await processSimilarity(env, deps, body.examId); }
      if (body.type === 'job') { await processJob(env, deps, body.jobId); }
      message.ack();
    } catch (e) {
      console.error('queue job failed', body, e && e.message);
      // Back off a minute; after max_retries the sweep takes over.
      message.retry({ delaySeconds: 60 });
    }
  }
}

/**
 * Cron entry point. Three rescues, each bounded by SWEEP_LIMIT, plus the email stage:
 *  (a) a student's time ran out without a submit -> submit the autosaved answers
 *  (b) grading started but never finished (worker killed) -> enqueue again
 *  (c) submitted but the enqueue was lost -> enqueue again
 * An expired attempt with NO saved answers is deliberately left alone: the
 * teacher sees it as "started" and decides, instead of the system inventing a 0.
 *
 * Email stage: graded attempts whose email_status is 'pending' and whose
 * deadline has passed are sent here, a few per minute, straight from the cron
 * invocation. Doing it here (not through the queue) means one sender, so a
 * message can never be delivered twice by two overlapping jobs, and "Resend"
 * is just setting email_status back to 'pending'.
 */
export async function runSweep(env, deps) {
  const now = deps.now();
  const enqueued = { expired: 0, stuckGrading: 0, stuckSubmitted: 0, emailed: 0 };

  const expired = await env.DB.prepare(
    "SELECT id FROM attempts WHERE status = 'started' AND answers_saved_at IS NOT NULL AND deadline_at < ? LIMIT ?")
    .bind(now - SUBMIT_GRACE_MS, SWEEP_LIMIT).all();
  for (const row of expired.results) {
    await env.DB.prepare("UPDATE attempts SET status = 'submitted', submitted_at = ? WHERE id = ? AND status = 'started'")
      .bind(now, row.id).run();
    await env.GRADE_QUEUE.send({ type: 'grade', attemptId: row.id });
    enqueued.expired++;
  }

  const grading = await env.DB.prepare(
    "SELECT id FROM attempts WHERE status = 'grading' AND submitted_at < ? LIMIT ?")
    .bind(now - STUCK_GRADING_MS, SWEEP_LIMIT).all();
  for (const row of grading.results) {
    await env.GRADE_QUEUE.send({ type: 'grade', attemptId: row.id });
    enqueued.stuckGrading++;
  }

  const submitted = await env.DB.prepare(
    "SELECT id FROM attempts WHERE status = 'submitted' AND submitted_at < ? LIMIT ?")
    .bind(now - STUCK_SUBMITTED_MS, SWEEP_LIMIT).all();
  for (const row of submitted.results) {
    await env.GRADE_QUEUE.send({ type: 'grade', attemptId: row.id });
    enqueued.stuckSubmitted++;
  }

  // A PDF job whose retries ran out stays 'running'; say so instead of leaving the admin page waiting.
  await env.DB.prepare("UPDATE jobs SET status = 'error', error = 'Timed out. Please try again.', updated_at = ? " +
    "WHERE status = 'running' AND updated_at < ?").bind(now, now - STUCK_JOB_MS).run();

  if (env.MAIL_RELAY_URL) {
    const mail = await env.DB.prepare(
      "SELECT id FROM attempts WHERE status = 'graded' AND email_status = 'pending' AND deadline_at < ? " +
      'ORDER BY deadline_at LIMIT ?').bind(now, EMAIL_PER_SWEEP).all();
    const outcomes = await Promise.all(mail.results.map((row) => sendAttemptEmail(env, deps, row.id)));
    enqueued.emailed = outcomes.filter((o) => o === 'sent').length;
  }
  return enqueued;
}
