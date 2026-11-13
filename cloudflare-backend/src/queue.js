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
 *   - Grading is idempotent: an attempt that is already `graded` is skipped,
 *     and a second message for one being graded right now is skipped too.
 *   - The sweep re-enqueues anything stuck, so a lost message heals itself.
 *   - Tries are counted (MAX_GRADE_ATTEMPTS) and partial results are kept, so
 *     a failing attempt cannot spend tokens without limit.
 * D1's free plan allows 50 queries per invocation, hence the small LIMITs.
 */

import { makeAskModel } from './claude.js';
import { GradingError, DEFAULT_BOUNDARIES, calculateGrade, computeTotals, countNeedsReview, gradeQuestion } from './grading.js';
import { assessEvents, parseEvents, withLegacySwitches } from './integrity.js';
import { buildSimilarityReport } from './similarity.js';
import { sendAttemptEmail } from './mail.js';
import { processJob } from './jobs.js';

const SWEEP_LIMIT = 10;                 // rows per category per run (query budget)
const SUBMIT_GRACE_MS = 60 * 1000;      // after the deadline before auto-submitting
// A grading run is "stale" only after longer than a queue consumer may run
// (15 min wall time), so a run that is still alive is never taken over.
const STUCK_GRADING_MS = 16 * 60 * 1000;
// Well above the normal queue wait when a whole class submits at the hard stop
// (about 70 attempts, 5 at a time). A shorter value re-enqueued attempts that
// were simply waiting their turn, one duplicate message a minute.
const STUCK_SUBMITTED_MS = 30 * 60 * 1000;
// Grading tries per attempt before it stops as `error`. Without a cap, one
// attempt that always fails would call the model again every few minutes forever.
export const MAX_GRADE_ATTEMPTS = 5;
// Partial results are saved after this many model-graded questions, so a retry
// continues where the last run stopped instead of paying for every call again.
// Not after every question: each save is a D1 query, and an invocation is
// limited to 50 subrequests (model calls + queries).
const CHECKPOINT_EVERY = 5;
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
 *
 * Life of an attempt here (status column):
 *   submitted --claim--> grading --all questions done--> graded
 *                           |--service failure that may pass--> submitted (try again later)
 *                           |--permanent failure, or 5 tries used--> error (teacher presses Regrade)
 *
 * The claim is one compare-and-set UPDATE. Queue messages can arrive twice
 * (and the sweep sends duplicates), so two consumers may reach the same
 * attempt; only the one whose UPDATE changes the row goes on, which is what
 * stops an attempt from being graded, and paid for, twice at once.
 */
export async function processGrade(env, deps, attemptId) {
  const now = deps.now();
  const attempt = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(attemptId).first();
  if (!attempt || !['submitted', 'grading'].includes(attempt.status)) { return 'skipped'; }

  // Retry cap: stop here, keeping the last recorded problem as the explanation.
  if (attempt.grade_attempts >= MAX_GRADE_ATTEMPTS) {
    await env.DB.prepare("UPDATE attempts SET status = 'error', grading_error = ? WHERE id = ? AND status IN ('submitted','grading')")
      .bind(('Stopped after ' + MAX_GRADE_ATTEMPTS + ' tries. Last problem: ' + (attempt.grading_error || 'unknown')).slice(0, 500),
            attemptId).run();
    return 'error';
  }

  // Claim: from `submitted`, or from a `grading` run that started so long ago it must be dead.
  const claim = await env.DB.prepare(
    "UPDATE attempts SET status = 'grading', grading_started_at = ?, grade_attempts = grade_attempts + 1 " +
    "WHERE id = ? AND (status = 'submitted' OR (status = 'grading' AND (grading_started_at IS NULL OR grading_started_at < ?)))")
    .bind(now, attemptId, now - STUCK_GRADING_MS).run();
  if (!claim.meta.changes) { return 'skipped'; }   // another consumer is grading it right now

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(attempt.exam_id).first();
  const paper = JSON.parse(attempt.paper);
  const answers = JSON.parse(attempt.answers || '{}');
  const { results: rows } = await env.DB
    .prepare('SELECT * FROM questions WHERE exam_id = ? AND set_id = ?').bind(attempt.exam_id, attempt.set_id).all();
  const byQid = new Map(rows.map((q) => [q.qid, q]));
  const paperQuestions = paper.qids.map((qid) => byQid.get(qid)).filter(Boolean);

  // Tokens used by THIS run and not yet written to the row.
  const spent = { in: 0, out: 0 };
  const askModel = makeAskModel(env, deps, (u) => { spent.in += u.input_tokens || 0; spent.out += u.output_tokens || 0; });
  // Start from what an earlier, interrupted run already graded (NULL on a first run and after "Regrade").
  const results = JSON.parse(attempt.results || '{}');

  /** Saves the partial results and adds the tokens spent since the last save. */
  const checkpoint = async (extraSql, extraBinds) => {
    await env.DB.prepare('UPDATE attempts SET results = ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?' +
                         (extraSql || '') + " WHERE id = ? AND status = 'grading'")
      .bind(JSON.stringify(results), spent.in, spent.out, ...(extraBinds || []), attemptId).run();
    spent.in = 0; spent.out = 0;
  };

  try {
    // Sequential on purpose: keeps us well under the model's per-minute limits.
    let sinceSave = 0;
    for (const q of paperQuestions) {
      // Multiple choice costs nothing, so it is always re-marked; a written
      // answer that already has a result from an earlier run is not paid for again.
      if (q.type !== 'mc' && results[q.qid]) { continue; }
      results[q.qid] = await gradeQuestion(q, answers[q.qid], askModel);
      if (q.type !== 'mc' && ++sinceSave >= CHECKPOINT_EVERY) { await checkpoint(); sinceSave = 0; }
    }
  } catch (e) {
    const permanent = e instanceof GradingError && !e.retryable;
    const message = String((e && e.message) || e).slice(0, 500);
    try {
      // Keep what was graded, and release the claim so the next try does not
      // have to wait for the run to look stale. Permanent failures (bad key,
      // no credit) stop as `error`; anything else goes back to `submitted`.
      await checkpoint(', status = ?, grading_error = ?', [permanent ? 'error' : 'submitted', message]);
    } catch (saveError) {
      // The save itself failed (for example the subrequest limit was reached).
      // The row stays `grading` and the sweep takes it over once it is stale.
      console.error('could not record a grading failure', attemptId, saveError && saveError.message);
    }
    if (permanent) { return 'error'; }
    throw e;  // the consumer asks the queue to try again
  }

  const overrides = JSON.parse(attempt.overrides || '{}');
  // Penalty comes from the integrity log (also covers sweep-submitted attempts).
  // An attempt recorded before the log existed only has a switch count.
  let events = parseEvents(attempt.events);
  if (!events.length && attempt.tab_switches > 0) { events = withLegacySwitches(events, attempt.tab_switches, deps.now()); }
  const penalty = assessEvents(events).penalty;
  const totals = computeTotals(paperQuestions, results, overrides, penalty);
  const finalGrade = calculateGrade(totals.percentage, attempt.set_id, boundariesOf(exam));
  // A regraded attempt whose email already went out is not emailed again by
  // itself; the teacher decides with "Resend emails".
  const emailStatus = !env.MAIL_RELAY_URL ? 'none' : attempt.email_status === 'sent' ? 'sent' : 'pending';

  await env.DB.prepare(
    "UPDATE attempts SET status = 'graded', results = ?, mc_score = ?, open_score = ?, max_score = ?, " +
    'total_score = ?, percentage = ?, final_grade = ?, penalty = ?, graded_at = ?, grading_error = NULL, ' +
    'email_status = ?, needs_review = ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ? ' +
    "WHERE id = ? AND status = 'grading'")
    .bind(JSON.stringify(results), totals.mcScore, totals.openScore, totals.maxScore, totals.totalScore,
          totals.percentage, finalGrade, penalty, deps.now(), emailStatus,
          countNeedsReview(paperQuestions, results, overrides), spent.in, spent.out, attemptId).run();
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
    // Measured from when grading STARTED (not from the submit), so an attempt
    // that waited long in the queue is not mistaken for a dead run.
    "SELECT id FROM attempts WHERE status = 'grading' AND (grading_started_at IS NULL OR grading_started_at < ?) LIMIT ?")
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
