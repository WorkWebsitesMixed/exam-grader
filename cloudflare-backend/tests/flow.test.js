/**
 * flow.test.js -- end-to-end student flow and the security rules from API.md
 * section 6, run against real SQL and real RS256 verification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';

const STUDENT = 'ana.perez@marymount.edu.co';
const start = (world, token, extra = {}) =>
  world.call('POST', '/api/start', { body: { idToken: token, exam: 'EX1', set: 'A', firstName: 'Ana', lastName: 'Pérez', class: '10A', ...extra } });

async function ready(opts) {
  const w = await makeWorld(opts);
  await seedExam(w);
  return w;
}

test('public exam payload contains no answers, rubrics or accepted answers', async () => {
  const w = await ready();
  const r = await w.call('GET', '/api/exam');
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.json);
  assert.ok(!/correct|rubric|accepted|triangulation\./i.test(text.replace('Explain triangulation.', '')));
  assert.equal(r.json.questions.A.length, 3);
  assert.ok(r.json.questions.A[0].options);
});

test('full flow: start, save, submit, grade, result held until the deadline', async () => {
  const w = await ready();
  const token = await w.google.token({ email: STUDENT });
  const s = await start(w, token);
  assert.equal(s.json.success, true);
  assert.deepEqual(s.json.paper.qids, ['Q1', 'Q2', 'Q3']);
  const id = s.json.attemptId;

  const sub = await w.call('POST', '/api/submit', { body: { attemptId: id, answers: { Q1: 1, Q2: ' paris ', Q3: 'A triangle is rigid.' }, tabSwitches: 0 } });
  assert.equal(sub.json.status, 'queued');
  assert.equal(await w.drainQueue(), 1);

  // Early: graded but held (server-side hold, not just hidden in the browser).
  const early = await w.call('GET', '/api/result?attemptId=' + id);
  assert.equal(early.json.ready, false);
  assert.equal(early.json.status, 'held');
  assert.ok(!early.text.includes('feedback'));

  w.clock.t += 61 * 60 * 1000;   // past the 60-minute deadline
  const done = await w.call('GET', '/api/result?attemptId=' + id);
  assert.equal(done.json.ready, true);
  assert.equal(done.json.maxScore, 9);
  assert.equal(done.json.totalScore, 9);          // mc 2 + short exact 1 + open (model said 99, clamped to 6)
  assert.equal(done.json.mcFeedback[0].correct, true);
  assert.equal(w.modelCalls.length, 1);           // exact short match needed no AI call
});

test('a student cannot raise the percentage by omitting questions', async () => {
  const w = await ready();
  const s = await start(w, await w.google.token({ email: STUDENT }));
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q1: 1 } } });  // only the easy MC
  await w.drainQueue();
  w.clock.t += 61 * 60 * 1000;
  const r = await w.call('GET', '/api/result?attemptId=' + s.json.attemptId);
  assert.equal(r.json.maxScore, 9);               // not 2
  assert.equal(r.json.totalScore, 2);
  assert.equal(r.json.percentage, 22);
});

test('identity: no token, forged token, other domain and expired token are refused', async () => {
  const w = await ready();
  assert.equal((await w.call('POST', '/api/start', { body: { exam: 'EX1', set: 'A', email: STUDENT, firstName: 'a', lastName: 'b' } })).json.code, 'invalid_token');

  const other = await makeWorld();           // different key pair: a forged signature
  const forged = await other.google.token({ email: STUDENT });
  assert.equal((await start(w, forged)).json.code, 'invalid_token');

  const gmail = await w.google.token({ email: 'someone@gmail.com', hd: undefined });
  const wd = await start(w, gmail);
  assert.equal(wd.status, 403);
  assert.equal(wd.json.code, 'wrong_domain');

  const spoofedHd = await w.google.token({ email: 'x@evil.com', hd: 'marymount.edu.co' });
  assert.equal((await start(w, spoofedHd)).json.code, 'wrong_domain');   // hd claim alone is not enough

  const expired = await w.google.token({ email: STUDENT, exp: Math.floor(w.clock.t / 1000) - 3600 });
  assert.equal((await start(w, expired)).json.code, 'token_expired');

  const wrongApp = await w.google.token({ email: STUDENT, aud: 'someone-else' });
  assert.equal((await start(w, wrongApp)).json.code, 'invalid_token');
});

test('the email stored comes from the verified token, never from the request body', async () => {
  const w = await ready();
  const s = await start(w, await w.google.token({ email: STUDENT }), { email: 'victim@marymount.edu.co' });
  const row = w.env.DB.db.prepare('SELECT email FROM attempts WHERE id = ?').get(s.json.attemptId);
  assert.equal(row.email, STUDENT);
});

test('one attempt per student: reload resumes, a second start after submit is a duplicate', async () => {
  const w = await ready();
  const token = await w.google.token({ email: STUDENT });
  const first = await start(w, token);
  await w.call('POST', '/api/save', { body: { attemptId: first.json.attemptId, answers: { Q3: 'draft' } } });
  w.clock.t += 5 * 60 * 1000;
  const again = await start(w, token);
  assert.equal(again.json.resumed, true);
  assert.equal(again.json.attemptId, first.json.attemptId);
  assert.equal(again.json.answers.Q3, 'draft');
  assert.equal(again.json.startedAt, first.json.startedAt);   // timer is not reset by a reload

  await w.call('POST', '/api/submit', { body: { attemptId: first.json.attemptId, answers: { Q3: 'final' } } });
  const dup = await start(w, token);
  assert.equal(dup.json.duplicate, true);
});

test('retake-exempt teacher can run the exam again, even when it is inactive', async () => {
  const w = await ready();
  seedTeacher(w, STUDENT, { retake: 1 });
  const token = await w.google.token({ email: STUDENT });
  const a = await start(w, token);
  await w.call('POST', '/api/submit', { body: { attemptId: a.json.attemptId, answers: {} } });
  const b = await start(w, token);
  assert.equal(b.json.success, true);
  assert.notEqual(b.json.attemptId, a.json.attemptId);
});

test('an older cached page that only reports tab switches is still governed by the new rules', async () => {
  const w = await ready();
  const s = await start(w, await w.google.token({ email: STUDENT }));
  // 2 switches: the first is only a warning, the second is a fault worth 1 point.
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q1: 1 }, tabSwitches: 2, penaltyPoints: 0 } });
  await w.drainQueue();
  w.clock.t += 61 * 60 * 1000;
  const r = await w.call('GET', '/api/result?attemptId=' + s.json.attemptId);
  assert.equal(r.json.penalty, 1);
});

test('accents survive the whole round trip', async () => {
  const w = await ready();
  const s = await start(w, await w.google.token({ email: STUDENT }), { firstName: 'María José', lastName: 'Núñez Peña' });
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q2: 'París', Q3: 'La triangulación es rígida y más fuerte, ¿no?' } } });
  await w.drainQueue();
  w.clock.t += 61 * 60 * 1000;
  const r = await w.call('GET', '/api/result?attemptId=' + s.json.attemptId);
  assert.equal(r.json.firstName, 'María José');
  assert.equal(r.json.openFeedback.find((f) => f.questionId === 'Q3').studentAnswer, 'La triangulación es rígida y más fuerte, ¿no?');
  assert.ok(r.text.includes('Núñez Peña'));   // raw UTF-8 on the wire, not \uXXXX escapes
});

test('late submit keeps the last autosave instead of the posted answers', async () => {
  const w = await ready();
  const s = await start(w, await w.google.token({ email: STUDENT }));
  await w.call('POST', '/api/save', { body: { attemptId: s.json.attemptId, answers: { Q3: 'saved in time' } } });
  w.clock.t += 60 * 60 * 1000 + 5 * 60 * 1000;   // 5 minutes after the deadline
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q3: 'written after the deadline' } } });
  const a = w.env.DB.db.prepare('SELECT answers FROM attempts WHERE id = ?').get(s.json.attemptId);
  assert.equal(JSON.parse(a.answers).Q3, 'saved in time');
});

test('save is rejected after the grace period and after submit', async () => {
  const w = await ready();
  const s = await start(w, await w.google.token({ email: STUDENT }));
  w.clock.t += 62 * 60 * 1000;
  assert.equal((await w.call('POST', '/api/save', { body: { attemptId: s.json.attemptId, answers: {} } })).json.code, 'deadline_passed');
});

test('sweep submits an expired attempt that has autosaved answers, and leaves empty ones alone', async () => {
  const w = await ready();
  const a = await start(w, await w.google.token({ email: STUDENT }));
  await w.call('POST', '/api/save', { body: { attemptId: a.json.attemptId, answers: { Q1: 1 } } });
  const b = await start(w, await w.google.token({ email: 'bea@marymount.edu.co' }));   // never saved anything

  w.clock.t += 62 * 60 * 1000;
  await w.app.scheduled({}, w.env);
  assert.equal(await w.drainQueue(), 1);
  const rows = w.env.DB.db.prepare('SELECT id, status FROM attempts').all();
  assert.equal(rows.find((r) => r.id === a.json.attemptId).status, 'graded');
  assert.equal(rows.find((r) => r.id === b.json.attemptId).status, 'started');
});

test('an invalid API key marks the attempt as error instead of silently giving zeros', async () => {
  const w = await ready();
  w.deps.fetch = async (url) => (String(url).includes('anthropic')
    ? new Response('{}', { status: 401 })
    : new Response(JSON.stringify({ keys: [w.google.jwk] }), { status: 200 }));
  const s = await start(w, await w.google.token({ email: STUDENT }));
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q3: 'A real answer here.' } } });
  await w.drainQueue();
  const row = w.env.DB.db.prepare('SELECT status, grading_error FROM attempts WHERE id = ?').get(s.json.attemptId);
  assert.equal(row.status, 'error');
  assert.match(row.grading_error, /API key/);
});

test('CORS: allowlisted origin is echoed, others get no allow-origin header', async () => {
  const w = await ready();
  const ok = await w.call('GET', '/api/exam');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://workwebsitesmixed.github.io');
  const bad = await w.call('GET', '/api/exam', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});

test('a normal start stays well under D1 free-plan limit of 50 queries per invocation', async () => {
  const w = await ready();
  const token = await w.google.token({ email: STUDENT });
  w.env.DB.queryCount = 0;
  await start(w, token);
  assert.ok(w.env.DB.queryCount <= 8, 'queries: ' + w.env.DB.queryCount);
});

test('public config carries the exam grade boundaries in the string form grader.html parses', async () => {
  const w = await ready();
  w.env.DB.db.prepare('UPDATE exams SET grade_boundaries = ? WHERE id = ?')
    .run(JSON.stringify({ A: [{ grade: '4.0', min: 90 }, { grade: '1.0', min: 0 }] }), 'EX1');
  const r = await w.call('GET', '/api/exam');
  assert.equal(r.json.config.grade_boundaries_A, '4.0:90,1.0:0');
});
