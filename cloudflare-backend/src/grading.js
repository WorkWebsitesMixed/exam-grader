/**
 * grading.js -- scoring rules: boundaries, totals and the per-question grader.
 *
 * Role: a faithful port of the grading rules of Code.gs (calculateGrade,
 * recalcRow, gradeOpenEnded, gradeShortAnswer, prompts) with the server-side
 * fixes decided in API.md:
 *   - max score is the sum over the paper the SERVER served, not over what the
 *     client sent, and a question with no answer scores 0;
 *   - MC is compared by option index, not by text;
 *   - an AI failure raises an error instead of silently scoring 0.
 *
 * Pure functions: the model call is injected (`askModel`) so everything here is
 * testable without a network.
 */

// Fallback boundaries, copied from GRADE_BOUNDARIES in Code.gs. An exam's own
// `grade_boundaries` JSON overrides these per set.
export const DEFAULT_BOUNDARIES = {
  A: [
    { grade: '2.3', min: 85 }, { grade: '2.0', min: 70 },
    { grade: '1.7', min: 50 }, { grade: '1.3', min: 35 }, { grade: '1.0', min: 0 },
  ],
  B: [
    { grade: '3.3', min: 85 }, { grade: '3.0', min: 75 }, { grade: '2.7', min: 65 },
    { grade: '2.3', min: 55 }, { grade: '2.0', min: 45 }, { grade: '1.7', min: 35 },
    { grade: '1.3', min: 20 }, { grade: '1.0', min: 0 },
  ],
  C: [
    { grade: '4.0', min: 90 }, { grade: '3.7', min: 80 }, { grade: '3.3', min: 70 },
    { grade: '3.0', min: 60 }, { grade: '2.7', min: 50 }, { grade: '2.3', min: 40 },
    { grade: '2.0', min: 30 }, { grade: '1.7', min: 20 }, { grade: '1.3', min: 10 }, { grade: '1.0', min: 0 },
  ],
};

/**
 * Parses the old Config-sheet format "2.3:85,2.0:70,1.0:0" into
 * [{grade, min}, ...]. Returns null when nothing valid is found. Used by the
 * one-off import of an existing exam's configuration.
 */
export function parseBoundaryString(str) {
  const result = [];
  String(str || '').split(',').forEach((pair) => {
    const parts = pair.trim().split(':');
    if (parts.length === 2) {
      const grade = parts[0].trim();
      const min = parseInt(parts[1].trim(), 10);
      if (grade && !Number.isNaN(min)) { result.push({ grade, min }); }
    }
  });
  return result.length ? result : null;
}

/**
 * Same semantics as calculateGrade in Code.gs: the first boundary (highest
 * `min` first) whose min is <= percentage wins; below every boundary is '1.0'.
 * Sorting here makes the result independent of how the list was typed.
 */
export function calculateGrade(percentage, setId, boundaries) {
  const list = (boundaries && boundaries[setId]) || DEFAULT_BOUNDARIES[setId] || DEFAULT_BOUNDARIES.A;
  const sorted = list.slice().sort((a, b) => b.min - a.min);
  for (const b of sorted) {
    if (percentage >= b.min) { return b.grade; }
  }
  return '1.0';
}

/** Lower-cases, trims and collapses spaces: the short-answer comparison form. */
export function normalizeShort(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Totals for one attempt.
 * @param {Array}  paperQuestions  question rows named in attempt.paper.qids
 * @param {object} results         {qid: {score, ...}} from grading (may be partial)
 * @param {object} overrides       {qid: number} teacher overrides (non-MC only)
 * @param {number} penalty         anti-cheating points, already clamped 0..4
 * Max score comes from `paperQuestions`, so omitting a question cannot raise
 * the percentage.
 */
export function computeTotals(paperQuestions, results, overrides, penalty) {
  let mcScore = 0; let openScore = 0; let maxScore = 0;
  for (const q of paperQuestions) {
    const r = results[q.qid];
    let score = r ? Number(r.score) || 0 : 0;
    const hasOverride = overrides && overrides[q.qid] !== undefined && overrides[q.qid] !== null;
    if (q.type !== 'mc' && hasOverride) { score = Number(overrides[q.qid]) || 0; }
    if (q.type === 'mc') { mcScore += score; } else { openScore += score; }
    maxScore += q.points;
  }
  const totalScore = Math.max(0, mcScore + openScore - (penalty || 0));
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  return { mcScore, openScore, maxScore, totalScore, percentage };
}

/** An error from the model layer. `retryable` tells the queue whether trying again can help. */
export class GradingError extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

/** Extracts "SCORE: n" and "FEEDBACK: ..." from a model reply, clamped to [0, max]. */
export function parseScoreFeedback(text, maxPoints, fallbackFeedback) {
  const scoreMatch = /SCORE:\s*(\d+)/i.exec(text);
  const feedbackMatch = /FEEDBACK:?\s+([\s\S]+)/i.exec(text);
  const score = scoreMatch ? Math.min(maxPoints, Math.max(0, parseInt(scoreMatch[1], 10))) : 0;
  let feedback = feedbackMatch ? feedbackMatch[1].trim() : '';
  if (!feedback) { feedback = text.replace(/SCORE:\s*\d+/i, '').replace(/FEEDBACK:?/i, '').trim(); }
  return { score, feedback: feedback || fallbackFeedback };
}

/** Open-ended answer: one model call against the rubric. Prompt copied from Code.gs. */
async function gradeOpenEnded(answer, rubric, maxPoints, askModel) {
  if (!answer || answer.trim().length < 2) { return { score: 0, feedback: 'No answer provided.' }; }
  const system =
    'You are an experienced, fair examiner grading a high-school Design & Technology ' +
    'exam answer against a marking rubric. Award partial marks wherever the rubric allows. ' +
    'Judge only what the student actually wrote.';
  const user =
    'RUBRIC:\n' + rubric + '\n\n' +
    'STUDENT ANSWER:\n' + answer + '\n\n' +
    'MAXIMUM MARKS: ' + maxPoints + '\n\n' +
    'Grade the answer, then respond in EXACTLY this format and nothing else:\n' +
    'SCORE: <integer from 0 to ' + maxPoints + '>\n' +
    'FEEDBACK: <one detailed paragraph written directly to the student. Say what they got ' +
    'right, what was missing or incorrect, and specifically what topics or concepts they ' +
    'should review to improve. Be precise and encouraging, and refer to what they actually wrote.>';
  return parseScoreFeedback(await askModel(system, user), maxPoints, 'Grading complete.');
}

/** Short answer: exact normalized match first; otherwise one cheap model call. */
async function gradeShort(answer, accepted, maxPoints, questionText, askModel) {
  const ans = normalizeShort(answer);
  if (!ans) { return { score: 0, feedback: 'No answer provided.' }; }
  if (accepted.some((a) => normalizeShort(a) === ans)) { return { score: maxPoints, feedback: 'Correct.' }; }
  const system =
    'You are marking a short-answer exam question against the list of accepted answers from the ' +
    'official marking scheme. Accept answers that mean the same thing — synonyms, abbreviations, ' +
    'and minor spelling differences all count. Do not accept answers that are actually wrong.';
  const user =
    'QUESTION: ' + (questionText || '') + '\n' +
    'ACCEPTED ANSWERS (from marking scheme): ' + accepted.join(', ') + '\n' +
    'STUDENT ANSWER: ' + answer + '\n' +
    'MAXIMUM MARKS: ' + maxPoints + '\n\n' +
    'Decide whether the student answer is acceptable. Respond in EXACTLY this format, nothing else:\n' +
    'SCORE: <0 or ' + maxPoints + '>\n' +
    'FEEDBACK: <one short sentence>';
  return parseScoreFeedback(await askModel(system, user), maxPoints, 'Marked.');
}

/** Parses the JSON columns of a question row once. */
export function questionOptions(q) {
  try { return q.options ? JSON.parse(q.options) : []; } catch (e) { return []; }
}
export function questionAccepted(q) {
  try { return q.accepted_answers ? JSON.parse(q.accepted_answers) : []; } catch (e) { return []; }
}

/**
 * Grades one question from the student's stored answer and returns the
 * per-question result object stored in attempts.results. A text snapshot is
 * kept so history still reads correctly if the question is edited later.
 */
export async function gradeQuestion(q, answer, askModel) {
  const base = { type: q.type, max: q.points, text: q.text };
  if (q.type === 'mc') {
    const options = questionOptions(q);
    const picked = Number.isInteger(answer) && answer >= 0 && answer < options.length ? answer : null;
    const correct = picked !== null && picked === q.correct_index;
    return {
      ...base,
      score: correct ? q.points : 0,
      correct,
      selected: picked === null ? 'No answer' : options[picked],
      correctText: options[q.correct_index] || '',
    };
  }
  const text = typeof answer === 'string' ? answer : '';
  const graded = q.type === 'short'
    ? await gradeShort(text, questionAccepted(q), q.points, q.text, askModel)
    : await gradeOpenEnded(text, q.rubric, q.points, askModel);
  return { ...base, score: graded.score, feedback: graded.feedback, answer: text,
           accepted: q.type === 'short' ? questionAccepted(q).join(', ') : undefined };
}
