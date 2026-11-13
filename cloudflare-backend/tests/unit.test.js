/**
 * unit.test.js -- pure-logic tests: boundaries, totals, penalty, paper building.
 * Expected values for calculateGrade are taken from the boundary tables in the
 * original Code.gs so a behaviour change would be caught.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGrade, parseBoundaryString, computeTotals, normalizeShort,
         verdictToGrade, DEFAULT_BOUNDARIES, levelForGrade, minMarksFor } from '../src/grading.js';
import { buildPaper, publicQuestion } from '../src/paper.js';

test('every set uses the school scale by default', () => {
  for (const set of ['A', 'B', 'C']) {
    assert.equal(calculateGrade(90, set, null), '4.0');
    assert.equal(calculateGrade(89, set, null), '3.7');
    assert.equal(calculateGrade(82, set, null), '3.7');   // 9/11 = 81.8% -> 82%
    assert.equal(calculateGrade(30, set, null), '2.0');
    assert.equal(calculateGrade(0, set, null), '1.0');
  }
});

test('levels follow the integer part of the grade', () => {
  assert.deepEqual(['1.0', '1.7', '2.0', '2.7', '3.0', '3.7', '4.0'].map(levelForGrade),
    ['Approaching', 'Approaching', 'Meeting', 'Meeting', 'Exceeding', 'Exceeding', 'Excelling']);
});

test('minMarksFor agrees with the rounded percentage the grader uses', () => {
  for (const total of [11, 20, 45, 57]) {
    for (const { min } of DEFAULT_BOUNDARIES.A) {
      const m = minMarksFor(total, min);
      assert.ok(Math.round((m / total) * 100) >= min, `${m}/${total} should reach ${min}%`);
      if (m > 0) { assert.ok(Math.round(((m - 1) / total) * 100) < min, `${m - 1}/${total} should not reach ${min}%`); }
    }
  }
  assert.equal(minMarksFor(20, 90), 18);
  assert.equal(minMarksFor(11, 90), 10);
});

test('calculateGrade does not depend on how the list is ordered', () => {
  const shuffled = { A: DEFAULT_BOUNDARIES.A.slice().reverse() };
  assert.equal(calculateGrade(72, 'A', shuffled), '3.3');
});

test('parseBoundaryString reads the old Config sheet format', () => {
  assert.deepEqual(parseBoundaryString('2.3:85, 2.0:70,1.0:0'),
    [{ grade: '2.3', min: 85 }, { grade: '2.0', min: 70 }, { grade: '1.0', min: 0 }]);
  assert.equal(parseBoundaryString('nonsense'), null);
});

test('max score comes from the paper, so omitting a question cannot raise the percentage', () => {
  const paper = [{ qid: 'Q1', type: 'mc', points: 2 }, { qid: 'Q2', type: 'openEnded', points: 8 }];
  const t = computeTotals(paper, { Q1: { score: 2 } }, {}, 0);   // Q2 never answered
  assert.equal(t.maxScore, 10);
  assert.equal(t.percentage, 20);
});

test('overrides replace non-MC scores only, and penalty cannot push below zero', () => {
  const paper = [{ qid: 'Q1', type: 'mc', points: 2 }, { qid: 'Q2', type: 'openEnded', points: 8 }];
  const t = computeTotals(paper, { Q1: { score: 2 }, Q2: { score: 3 } }, { Q1: 0, Q2: 7 }, 4);
  assert.equal(t.openScore, 7);
  assert.equal(t.mcScore, 2);
  assert.equal(t.totalScore, 5);
  assert.equal(computeTotals(paper, {}, {}, 4).totalScore, 0);
});

test('normalizeShort and verdictToGrade', () => {
  assert.equal(normalizeShort('  Paris   FRANCE '), 'paris france');
  // The score is clamped to the question's marks; empty feedback gets the fallback.
  assert.deepEqual(verdictToGrade({ score: 7, feedback: 'Good.' }, 6, 'x'), { score: 6, feedback: 'Good.' });
  assert.deepEqual(verdictToGrade({ score: -2, feedback: '' }, 6, 'fallback'), { score: 0, feedback: 'fallback' });
  // A reply the model layer could not use is never a silent zero: it is flagged.
  assert.deepEqual(verdictToGrade({ review: 'no score' }, 6, 'x'),
    { score: 0, feedback: '', needsReview: true, reviewReason: 'no score' });
});

const mkQ = (qid, type, extra = {}) => ({ qid, type, set_id: 'A', position: 0, section: '', points: 1, text: qid,
  options: type === 'mc' ? JSON.stringify(['a', 'b', 'c', 'd']) : null, image_hash: null, ...extra });

test('igcse paper: every question, fixed order, identity option order, sampling ignored', () => {
  const exam = { exam_type: 'igcse', questions_per_set: 2, oe_per_set: 1, randomize: 1 };
  const qs = [mkQ('Q1', 'mc'), mkQ('Q2', 'openEnded'), mkQ('Q3', 'mc'), mkQ('Q4', 'short')];
  const paper = buildPaper(exam, qs, () => 0.1);
  assert.deepEqual(paper.qids, ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.deepEqual(paper.optionOrder.Q1, [0, 1, 2, 3]);
});

test('standard paper: questions_per_set works without randomize (independent options)', () => {
  const exam = { exam_type: 'standard', questions_per_set: 2, oe_per_set: 0, randomize: 0 };
  const qs = [mkQ('Q1', 'mc'), mkQ('Q2', 'mc'), mkQ('Q3', 'mc')];
  assert.deepEqual(buildPaper(exam, qs, () => 0.9).qids, ['Q1', 'Q2']);
});

test('standard paper: oe_per_set guarantees open-ended questions', () => {
  const exam = { exam_type: 'standard', questions_per_set: 3, oe_per_set: 2, randomize: 0 };
  const qs = [mkQ('M1', 'mc'), mkQ('M2', 'mc'), mkQ('M3', 'mc'), mkQ('O1', 'openEnded'), mkQ('O2', 'openEnded')];
  const paper = buildPaper(exam, qs, () => 0.5);
  assert.equal(paper.qids.filter((q) => q.startsWith('O')).length, 2);
  assert.equal(paper.qids.length, 3);
});

test('publicQuestion never exposes secrets', () => {
  const q = mkQ('Q1', 'mc', { correct_index: 2, rubric: 'SECRET RUBRIC', accepted_answers: '["x"]', image_hash: 'ab'.repeat(32) });
  const out = publicQuestion(q);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('SECRET'));
  assert.ok(!('correct_index' in out) && !('correctIndex' in out) && !('rubric' in out) && !('accepted_answers' in out));
  assert.equal(out.imageUrl, '/img/' + 'ab'.repeat(32));
});
