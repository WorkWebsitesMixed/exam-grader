/**
 * unit.test.js -- pure-logic tests: boundaries, totals, penalty, paper building.
 * Expected values for calculateGrade are taken from the boundary tables in the
 * original Code.gs so a behaviour change would be caught.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGrade, parseBoundaryString, computeTotals, normalizeShort,
         parseScoreFeedback, DEFAULT_BOUNDARIES } from '../src/grading.js';
import { buildPaper, publicQuestion } from '../src/paper.js';

test('calculateGrade matches the Code.gs tables', () => {
  assert.equal(calculateGrade(85, 'A', null), '2.3');
  assert.equal(calculateGrade(84, 'A', null), '2.0');
  assert.equal(calculateGrade(0, 'A', null), '1.0');
  assert.equal(calculateGrade(90, 'C', null), '4.0');
  assert.equal(calculateGrade(89, 'C', null), '3.7');
  assert.equal(calculateGrade(35, 'B', null), '1.7');
});

test('calculateGrade does not depend on how the list is ordered', () => {
  const shuffled = { A: DEFAULT_BOUNDARIES.A.slice().reverse() };
  assert.equal(calculateGrade(72, 'A', shuffled), '2.0');
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

test('normalizeShort and parseScoreFeedback', () => {
  assert.equal(normalizeShort('  Paris   FRANCE '), 'paris france');
  assert.deepEqual(parseScoreFeedback('SCORE: 7\nFEEDBACK: Good.\nMore.', 6, 'x'), { score: 6, feedback: 'Good.\nMore.' });
  assert.deepEqual(parseScoreFeedback('no format', 6, 'fallback'), { score: 0, feedback: 'no format' });
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
