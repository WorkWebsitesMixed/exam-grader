/**
 * similarity.test.js -- the similarity report: what it flags, what it must not,
 * and that it runs as a queue job without any model call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOpen, buildSimilarityReport, normalizeText } from '../src/similarity.js';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';

const LONG = 'A triangulated frame is rigid because a triangle cannot change shape without one of its sides ' +
  'changing length so the load is shared between the members and the structure does not collapse under force';

test('near-identical long answers score high; different answers score low', () => {
  const copy = compareOpen(LONG, LONG.replace('rigid', 'stiff').replace('collapse', 'fail'));
  assert.ok(copy.score > 0.6, 'score ' + copy.score);
  const other = compareOpen(LONG,
    'Plywood is made of thin layers of wood glued with the grain at right angles which makes it strong in ' +
    'both directions and less likely to split than solid timber which is why it is used for furniture panels');
  assert.ok(other.score < 0.1);
});

test('short answers are not compared, and phrases from the question are ignored', () => {
  assert.equal(compareOpen('Triangles are rigid.', 'Triangles are rigid.'), null);
  const ignore = new Set(LONG.toLowerCase().split(' ').map((_, i, w) => w.slice(i, i + 3).join(' ')).filter((p) => p.split(' ').length === 3));
  assert.equal(compareOpen(LONG, LONG, ignore), null);   // nothing left after removing the question's own phrases
});

test('normalizeText removes accents and punctuation', () => {
  assert.equal(normalizeText('  Triangulación, RÍGIDA! '), 'triangulacion rigida');
});

const mkAttempt = (id, name, set, answers, qids) => ({
  id, email: id + '@marymount.edu.co', first_name: name, last_name: 'X', class: '10A', set_id: set,
  answers, paper: { qids },
});
const QUESTIONS = [
  { set_id: 'A', qid: 'M1', type: 'mc', text: 'm1', correct_index: 0 },
  { set_id: 'A', qid: 'M2', type: 'mc', text: 'm2', correct_index: 0 },
  { set_id: 'A', qid: 'M3', type: 'mc', text: 'm3', correct_index: 0 },
  { set_id: 'A', qid: 'M4', type: 'mc', text: 'm4', correct_index: 0 },
  { set_id: 'A', qid: 'O1', type: 'openEnded', text: 'Explain why a triangle is rigid.' },
  { set_id: 'B', qid: 'O1', type: 'openEnded', text: 'Explain.' },
];
const QIDS = ['M1', 'M2', 'M3', 'M4', 'O1'];

test('flags a copied open answer and a pattern of shared wrong multiple-choice answers', () => {
  const report = buildSimilarityReport([
    mkAttempt('ana', 'Ana', 'A', { M1: 2, M2: 3, M3: 1, M4: 0, O1: LONG }, QIDS),
    mkAttempt('bea', 'Bea', 'A', { M1: 2, M2: 3, M3: 1, M4: 0, O1: LONG.replace('rigid', 'stiff') }, QIDS),
    mkAttempt('caro', 'Caro', 'A', { M1: 0, M2: 1, M3: 0, M4: 0, O1: 'Plywood is layered wood glued with the grain at right angles which gives it strength in both directions and resists splitting far better than solid timber used for large furniture panels and cupboards' }, QIDS),
  ], QUESTIONS);
  assert.equal(report.pairsFlagged, 1);
  const p = report.pairs[0];
  assert.deepEqual([p.a.name.includes('Ana'), p.b.name.includes('Bea')], [true, true]);
  assert.equal(p.open.length, 1);
  assert.equal(p.mc.sharedWrong, 3);
  assert.equal(p.mc.flagged, true);
  assert.ok(p.open[0].phrases.length > 0);
});

test('students on different sets are never compared', () => {
  const report = buildSimilarityReport([
    mkAttempt('ana', 'Ana', 'A', { O1: LONG }, ['O1']),
    mkAttempt('bea', 'Bea', 'B', { O1: LONG }, ['O1']),
  ], QUESTIONS);
  assert.equal(report.pairsFlagged, 0);
});

test('sharing RIGHT answers is not a signal', () => {
  const same = { M1: 0, M2: 0, M3: 0, M4: 0 };
  const report = buildSimilarityReport([mkAttempt('ana', 'Ana', 'A', same, QIDS), mkAttempt('bea', 'Bea', 'A', same, QIDS)], QUESTIONS);
  assert.equal(report.pairsFlagged, 0);
});

test('queue job: admin requests the report, the consumer computes it, no model is called', async () => {
  const w = await makeWorld();
  await seedExam(w, { questions: [
    { set: 'A', id: 'Q1', type: 'mc', points: 2, text: 'Pick B', options: ['a', 'b', 'c', 'd'], correctIndex: 1 },
    { set: 'A', id: 'Q3', type: 'openEnded', points: 6, text: 'Explain triangulation.', rubric: 'Mention rigidity.' },
  ] });
  seedTeacher(w, 'andres.forero@marymount.edu.co');
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: 'andres.forero@marymount.edu.co' }) } });
  const auth = { Authorization: 'Bearer ' + login.json.session };

  const ins = w.env.DB.db.prepare(
    "INSERT INTO attempts (id, exam_id, set_id, email, first_name, last_name, class, started_at, deadline_at, paper, answers, status) " +
    "VALUES (?, 'EX1', 'A', ?, ?, 'X', '10A', 0, 1, ?, ?, 'graded')");
  const paper = JSON.stringify({ qids: ['Q1', 'Q3'], optionOrder: {} });
  ins.run('a1', 'a1@marymount.edu.co', 'Ana', paper, JSON.stringify({ Q1: 2, Q3: LONG }));
  ins.run('a2', 'a2@marymount.edu.co', 'Bea', paper, JSON.stringify({ Q1: 2, Q3: LONG + ' thanks' }));

  const req = await w.call('POST', '/api/admin/exams/EX1/similarity', { headers: auth, body: {} });
  assert.equal(req.json.status, 'queued');
  await w.drainQueue();
  const got = await w.call('GET', '/api/admin/exams/EX1/similarity', { headers: auth });
  assert.equal(got.json.status, 'done');
  assert.equal(got.json.report.pairsFlagged, 1);
  assert.equal(w.modelCalls.length, 0);
});
