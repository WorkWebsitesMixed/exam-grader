/**
 * export.js -- read-only export of results for the Sheets archive (and, if
 * wanted, a nightly backup pulled by another machine such as the Raspberry Pi).
 *
 * Role: D1 is the live store; teachers also want their grades in a spreadsheet
 * and a copy outside Cloudflare. A small Apps Script project on a time trigger
 * (tools/sheet-archive/) calls these two routes:
 *   GET /api/export/index              exams that have attempts + a digest each
 *   GET /api/export/exams/:id          the attempts of one exam, 25 per page
 *
 * Authentication is a key of its own (EXPORT_KEY, a Worker secret), NOT an admin
 * session: the caller is a script with no Google sign-in. The key can only read
 * this data, never change anything. When the secret is not set the routes
 * answer 404 as if they did not exist.
 *
 * The digest lets the caller skip exams that did not change since its last
 * run: it covers attempt count, latest start and grading times and the sums of
 * totals and penalties, so a new attempt, a regrade, an override or a delete
 * all change it.
 *
 * Pages are small on purpose: a request has 10 ms of CPU on the free plan and
 * every graded attempt carries a JSON `results` column that must be parsed.
 */

import { HttpError, clampInt } from './http.js';

const PAGE_SIZE = 25;

/** SHA-256 of a string as bytes; used to compare secrets in constant time. */
async function digestOf(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Checks `Authorization: Bearer <EXPORT_KEY>`. Both sides are hashed first so
 * the comparison below always sees equal-length inputs and never stops early.
 */
async function requireExportKey(c) {
  const expected = c.env.EXPORT_KEY;
  if (!expected) { throw new HttpError(404, 'not_found', 'Not found'); }
  const header = c.request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = await digestOf(given);
  const b = await digestOf(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) { diff |= a[i] ^ b[i]; }
  if (diff !== 0) { throw new HttpError(401, 'unauthorized', 'Invalid export key'); }
}

/** GET /api/export/index */
export async function exportIndex(c) {
  await requireExportKey(c);
  const { results } = await c.env.DB.prepare(
    'SELECT a.exam_id AS id, e.title AS title, COUNT(*) AS attempts, MAX(a.started_at) AS last_started, ' +
    'MAX(a.graded_at) AS last_graded, SUM(COALESCE(a.total_score, 0)) AS sum_total, SUM(a.penalty) AS sum_penalty ' +
    'FROM attempts a LEFT JOIN exams e ON e.id = a.exam_id GROUP BY a.exam_id ORDER BY a.exam_id').all();
  return { body: { success: true, exams: results.map((r) => ({
    id: r.id, title: r.title || r.id, attempts: r.attempts,
    digest: [r.attempts, r.last_started, r.last_graded, r.sum_total, r.sum_penalty].join(':'),
  })) } };
}

/** One answer line for the archive, from the per-question result snapshot. */
function answerRow(qid, r, overrides) {
  if (!r) { return null; }
  const has = overrides[qid] !== undefined && overrides[qid] !== null;
  const score = r.type !== 'mc' && has ? Number(overrides[qid]) : r.score;
  if (r.type === 'mc') {
    return { qid, type: 'mc', question: r.text, answer: r.selected, correct: r.correctText,
             score, max: r.max, feedback: '' };
  }
  return { qid, type: r.type, question: r.text, answer: r.answer || '',
           correct: r.type === 'short' ? (r.accepted || '') : '', score, max: r.max,
           feedback: r.feedback || '', overridden: has };
}

/** GET /api/export/exams/:id?after=<attempt id>&limit=25 */
export async function exportExam(c) {
  await requireExportKey(c);
  const examId = c.params.id;
  const after = c.url.searchParams.get('after') || '';
  const limit = clampInt(c.url.searchParams.get('limit') || PAGE_SIZE, 1, PAGE_SIZE);

  const exam = await c.env.DB.prepare('SELECT id, title FROM exams WHERE id = ?').bind(examId).first();
  if (!exam) { throw new HttpError(404, 'exam_not_found', 'Exam not found'); }

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM attempts WHERE exam_id = ? AND id > ? ORDER BY id LIMIT ?').bind(examId, after, limit).all();

  const attempts = results.map((a) => {
    const paper = JSON.parse(a.paper);
    const overrides = JSON.parse(a.overrides || '{}');
    const graded = a.results ? JSON.parse(a.results) : null;
    const rawAnswers = JSON.parse(a.answers || '{}');
    const answers = [];
    for (const qid of paper.qids || []) {
      const row = graded ? answerRow(qid, graded[qid], overrides) : null;
      // Not graded (yet): keep what the student had saved, as plain text.
      answers.push(row || { qid, type: '', question: '',
        answer: rawAnswers[qid] === undefined || rawAnswers[qid] === null ? '' : String(rawAnswers[qid]),
        correct: '', score: null, max: null, feedback: '' });
    }
    return {
      id: a.id, examId: a.exam_id, set: a.set_id, email: a.email, firstName: a.first_name, lastName: a.last_name,
      class: a.class, status: a.status, startedAt: a.started_at, submittedAt: a.submitted_at, gradedAt: a.graded_at,
      mcScore: a.mc_score, openScore: a.open_score, penalty: a.penalty, totalScore: a.total_score,
      maxScore: a.max_score, percentage: a.percentage, finalGrade: a.final_grade,
      faults: a.faults, warnings: a.warnings, awayMs: a.away_ms, pasteEvents: a.paste_events,
      pasteChars: a.paste_chars, emailStatus: a.email_status, answers,
    };
  });
  const last = results.length === limit ? results[results.length - 1].id : null;
  return { body: { success: true, exam: { id: exam.id, title: exam.title }, attempts, nextAfterId: last } };
}
