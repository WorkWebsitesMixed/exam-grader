/**
 * analysis.js -- compact per-question results of an exam, for the Analysis tab.
 *
 * Role: the Analysis tab of admin3.html computes its statistics in the browser
 * (a request has 10 ms of CPU on the free plan and every graded attempt carries a
 * JSON `results` column that must be parsed, so one request cannot analyse a whole
 * class). This route hands the browser the raw numbers in pages of 25 attempts,
 * the same page size the Sheets export uses:
 *   GET /api/admin/exams/:id/results?after=<attempt id>
 *
 * Only GRADED attempts are returned, and attempts of teacher accounts (test runs)
 * are left out, so statistics describe real students. Behind the admin session.
 * Scores already include the teacher's overrides but NOT the integrity penalty,
 * which is reported separately.
 */

import { HttpError } from './http.js';
import { levelForGrade } from './grading.js';

const PAGE_SIZE = 25;
const ANSWER_MAX = 200;   // chars of a student answer kept (enough to group wrong answers)

export async function examResults(c) {
  const examId = c.params.id;
  const after = c.url.searchParams.get('after') || '';
  const exam = await c.env.DB.prepare('SELECT id, title FROM exams WHERE id = ?').bind(examId).first();
  if (!exam) { throw new HttpError(404, 'exam_not_found', 'Exam not found'); }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM attempts WHERE exam_id = ? AND status = 'graded' AND id > ? " +
    'AND email NOT IN (SELECT email FROM teachers) ORDER BY id LIMIT ?').bind(examId, after, PAGE_SIZE).all();

  const attempts = results.map((a) => {
    const paper = JSON.parse(a.paper);
    const graded = JSON.parse(a.results || '{}');
    const overrides = JSON.parse(a.overrides || '{}');
    const items = [];
    for (const qid of paper.qids || []) {
      const r = graded[qid];
      if (!r) { continue; }
      const has = overrides[qid] !== undefined && overrides[qid] !== null;
      const isMc = r.type === 'mc';
      const score = !isMc && has ? Number(overrides[qid]) : Number(r.score) || 0;
      const answer = isMc ? r.selected : (r.type === 'short' ? r.answer : '');
      items.push({ qid, type: r.type, score, max: r.max, overridden: has && !isMc,
                   answer: String(answer || '').slice(0, ANSWER_MAX) });
    }
    return {
      id: a.id, set: a.set_id, class: a.class, email: a.email, firstName: a.first_name, lastName: a.last_name,
      startedAt: a.started_at, submittedAt: a.submitted_at, totalScore: a.total_score, maxScore: a.max_score,
      percentage: a.percentage, finalGrade: a.final_grade, level: levelForGrade(a.final_grade),
      penalty: a.penalty, faults: a.faults, items,
    };
  });
  const last = results.length === PAGE_SIZE ? results[results.length - 1].id : null;
  return { body: { success: true, exam: { id: exam.id, title: exam.title }, attempts, nextAfterId: last } };
}
