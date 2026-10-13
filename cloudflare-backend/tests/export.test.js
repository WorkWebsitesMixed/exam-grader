/**
 * export.test.js -- the read-only export used by the Sheets archive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';

const TEACHER = 'andres.forero@marymount.edu.co';
const KEY = 'export-secret-for-tests';

/** Several graded students so pagination has something to page. */
async function setup(n = 3, { key = KEY } = {}) {
  const w = await makeWorld();
  if (key) { w.env.EXPORT_KEY = key; }
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  w.ids = [];
  for (let i = 0; i < n; i++) {
    const email = `student${i}@marymount.edu.co`;
    const s = await w.call('POST', '/api/start', { body: {
      idToken: await w.google.token({ email }), exam: 'EX1', set: 'A', firstName: 'Ana' + i, lastName: 'Pérez', class: '10A' } });
    await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId,
      answers: { Q1: 1, Q2: 'Paris', Q3: '=HYPERLINK("http://evil","x") é á ó' } } });
    w.ids.push(s.json.attemptId);
  }
  await w.drainQueue();
  return w;
}
const bearer = (k = KEY) => ({ Authorization: 'Bearer ' + k });

test('the export needs its own key; without a configured key the routes do not exist', async () => {
  const w = await setup(1);
  assert.equal((await w.call('GET', '/api/export/index')).status, 401);
  assert.equal((await w.call('GET', '/api/export/index', { headers: bearer('wrong') })).status, 401);
  assert.equal((await w.call('GET', '/api/export/exams/EX1', { headers: bearer('wrong') })).status, 401);
  assert.equal((await w.call('GET', '/api/export/index', { headers: bearer() })).status, 200);

  // An admin session is NOT an export key.
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  const asAdmin = await w.call('GET', '/api/export/index', { headers: { Authorization: 'Bearer ' + login.json.session } });
  assert.equal(asAdmin.status, 401);

  const off = await setup(1, { key: '' });
  assert.equal((await off.call('GET', '/api/export/index', { headers: bearer() })).status, 404);
});

test('export carries scores, integrity summary and per-question answers; accents survive; override is applied', async () => {
  const w = await setup(1);
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  await w.call('PUT', `/api/admin/attempts/${w.ids[0]}/overrides`, {
    headers: { Authorization: 'Bearer ' + login.json.session }, body: { overrides: { Q3: 2 } } });

  const r = await w.call('GET', '/api/export/exams/EX1', { headers: bearer() });
  assert.equal(r.json.exam.id, 'EX1');
  assert.equal(r.json.nextAfterId, null);
  const a = r.json.attempts[0];
  assert.equal(a.email, 'student0@marymount.edu.co');
  assert.equal(a.lastName, 'Pérez');
  assert.equal(a.status, 'graded');
  assert.equal(a.maxScore, 9);
  assert.equal(a.totalScore, 2 + 1 + 2);                       // mc 2 + short 1 + override 2
  const q3 = a.answers.find((x) => x.qid === 'Q3');
  assert.equal(q3.score, 2);
  assert.equal(q3.overridden, true);
  assert.equal(q3.answer, '=HYPERLINK("http://evil","x") é á ó');   // raw: the consumer must neutralise formulas
  assert.deepEqual(a.answers.map((x) => x.qid), ['Q1', 'Q2', 'Q3']);
  assert.equal(a.answers[0].correct, 'b');
});

test('pages of at most 25 are linked by nextAfterId and together cover every attempt once', async () => {
  const w = await setup(5);
  const seen = [];
  let after = '';
  let pages = 0;
  do {
    const r = await w.call('GET', `/api/export/exams/EX1?limit=2&after=${after}`, { headers: bearer() });
    assert.ok(r.json.attempts.length <= 2);
    seen.push(...r.json.attempts.map((x) => x.id));
    after = r.json.nextAfterId || '';
    pages++;
  } while (after && pages < 10);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.deepEqual([...seen].sort(), [...w.ids].sort());
  // limit cannot exceed the page size
  const big = await w.call('GET', '/api/export/exams/EX1?limit=500', { headers: bearer() });
  assert.ok(big.json.attempts.length <= 25);
});

test('the digest changes when an override, a regrade or a delete changes the data, and not otherwise', async () => {
  const w = await setup(2);
  const digest = async () => (await w.call('GET', '/api/export/index', { headers: bearer() })).json.exams[0].digest;
  const d1 = await digest();
  assert.equal(await digest(), d1);

  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  const auth = { Authorization: 'Bearer ' + login.json.session };
  await w.call('PUT', `/api/admin/attempts/${w.ids[0]}/overrides`, { headers: auth, body: { overrides: { Q3: 1 } } });
  const d2 = await digest();
  assert.notEqual(d2, d1);

  await w.call('DELETE', `/api/admin/attempts/${w.ids[1]}`, { headers: auth });
  assert.notEqual(await digest(), d2);
});

test('an unknown exam is a 404 and an attempt that is not graded yet still exports what was saved', async () => {
  const w = await setup(0);
  assert.equal((await w.call('GET', '/api/export/exams/NOPE', { headers: bearer() })).status, 404);

  const s = await w.call('POST', '/api/start', { body: {
    idToken: await w.google.token({ email: 'late@marymount.edu.co' }), exam: 'EX1', set: 'A', firstName: 'L', lastName: 'M' } });
  await w.call('POST', '/api/save', { body: { attemptId: s.json.attemptId, answers: { Q2: 'Par' } } });
  const r = await w.call('GET', '/api/export/exams/EX1', { headers: bearer() });
  const a = r.json.attempts[0];
  assert.equal(a.status, 'started');
  assert.equal(a.totalScore, null);
  assert.equal(a.answers.find((x) => x.qid === 'Q2').answer, 'Par');
});
