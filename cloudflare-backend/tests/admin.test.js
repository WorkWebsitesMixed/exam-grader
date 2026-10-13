/**
 * admin.test.js -- admin login, access control and the maintenance operations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';

const TEACHER = 'andres.forero@marymount.edu.co';

async function adminWorld() {
  const w = await makeWorld();
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  const auth = { Authorization: 'Bearer ' + login.json.session };
  return { w, auth, login };
}

async function gradedAttempt(w, email, answers) {
  const s = await w.call('POST', '/api/start', { body: { idToken: await w.google.token({ email }), exam: 'EX1', set: 'A', firstName: 'A', lastName: 'B' } });
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers } });
  await w.drainQueue();
  return s.json.attemptId;
}

test('login: only emails in the teachers table get a session', async () => {
  const { login } = await adminWorld();
  assert.equal(login.json.success, true);
  assert.equal(login.json.role, 'admin');

  const w = await makeWorld();
  const r = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: 'student@marymount.edu.co' }) } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'not_a_teacher');
});

test('every admin route rejects a missing, forged or revoked session', async () => {
  const { w, auth } = await adminWorld();
  assert.equal((await w.call('GET', '/api/admin/exams')).status, 401);
  assert.equal((await w.call('GET', '/api/admin/exams', { headers: { Authorization: 'Bearer v1.AAAA.BBBB' } })).status, 401);
  assert.equal((await w.call('GET', '/api/admin/exams', { headers: auth })).status, 200);
  w.env.DB.db.prepare('DELETE FROM teachers WHERE email = ?').run(TEACHER);
  assert.equal((await w.call('GET', '/api/admin/exams', { headers: auth })).status, 401);   // revoked at once
});

test('session expires after 8 hours', async () => {
  const { w, auth } = await adminWorld();
  w.clock.t += 9 * 60 * 60 * 1000;
  const r = await w.call('GET', '/api/admin/exams', { headers: auth });
  assert.equal(r.json.code, 'session_expired');
});

test('question CRUD: validates, rejects a 1-based index of 4, converts legacy 1-based', async () => {
  const { w, auth } = await adminWorld();
  const base = { set: 'A', id: 'Q9', type: 'mc', points: 2, text: 'Pick', options: ['a', 'b', 'c', 'd'] };
  const bad = await w.call('POST', '/api/admin/exams/EX1/questions', { headers: auth, body: { ...base, correctIndex: 4 } });
  assert.equal(bad.status, 400);

  const legacy = await w.call('POST', '/api/admin/exams/EX1/questions', { headers: auth, body: { ...base, legacyCorrectIndex: 4 } });
  assert.equal(legacy.json.success, true);
  const row = w.env.DB.db.prepare("SELECT correct_index, position FROM questions WHERE qid = 'Q9'").get();
  assert.equal(row.correct_index, 3);
  assert.equal(row.position, 4);

  const dup = await w.call('POST', '/api/admin/exams/EX1/questions', { headers: auth, body: { ...base, correctIndex: 0 } });
  assert.equal(dup.status, 409);

  const del = await w.call('DELETE', '/api/admin/exams/EX1/questions/A/Q9', { headers: auth });
  assert.equal(del.json.success, true);
});

test('admin question list includes secrets; the public one does not', async () => {
  const { w, auth } = await adminWorld();
  const adminList = await w.call('GET', '/api/admin/exams/EX1/questions', { headers: auth });
  assert.equal(adminList.json.questions[0].correctIndex, 1);
  assert.equal(adminList.json.questions[2].rubric, 'Mention rigidity.');
});

test('override recomputes totals and grade; MC cannot be overridden', async () => {
  const { w, auth } = await adminWorld();
  const id = await gradedAttempt(w, 'ana@marymount.edu.co', { Q1: 0, Q2: 'rome', Q3: 'Triangles are rigid.' });
  // Model stub gives full marks: MC wrong -> 0, short (AI fallback) -> 1, open -> 6, so 7 in total
  const before = w.env.DB.db.prepare('SELECT total_score FROM attempts WHERE id = ?').get(id).total_score;

  const mc = await w.call('PUT', '/api/admin/attempts/' + id + '/overrides', { headers: auth, body: { overrides: { Q1: 2 } } });
  assert.equal(mc.status, 400);
  const tooHigh = await w.call('PUT', '/api/admin/attempts/' + id + '/overrides', { headers: auth, body: { overrides: { Q3: 7 } } });
  assert.equal(tooHigh.status, 400);

  const ok = await w.call('PUT', '/api/admin/attempts/' + id + '/overrides', { headers: auth, body: { overrides: { Q3: 1 } } });
  assert.equal(ok.json.success, true);
  const after = w.env.DB.db.prepare('SELECT total_score, final_grade FROM attempts WHERE id = ?').get(id);
  assert.equal(after.total_score, before - 5);
});

test('regrade-mc fixes a wrong answer key without any model call', async () => {
  const { w, auth } = await adminWorld();
  const id = await gradedAttempt(w, 'ana@marymount.edu.co', { Q1: 2, Q2: 'paris', Q3: 'x' });   // picked option C
  assert.equal(w.env.DB.db.prepare('SELECT mc_score FROM attempts WHERE id = ?').get(id).mc_score, 0);

  w.env.DB.db.prepare("UPDATE questions SET correct_index = 2 WHERE qid = 'Q1'").run();          // key was wrong
  const calls = w.modelCalls.length;
  const r = await w.call('POST', '/api/admin/exams/EX1/regrade-mc', { headers: auth, body: {} });
  assert.equal(r.json.changed, 1);
  assert.equal(w.env.DB.db.prepare('SELECT mc_score FROM attempts WHERE id = ?').get(id).mc_score, 2);
  assert.equal(w.modelCalls.length, calls);
});

test('recalculate uses the exam boundaries and is paged', async () => {
  const { w, auth } = await adminWorld();
  const id = await gradedAttempt(w, 'ana@marymount.edu.co', { Q1: 1, Q2: 'paris', Q3: 'Triangles are rigid.' });   // 100%
  await w.call('PUT', '/api/admin/exams/EX1', { headers: auth, body: { gradeBoundaries: { A: [{ grade: '4.0', min: 90 }, { grade: '1.0', min: 0 }] } } });
  const r = await w.call('POST', '/api/admin/exams/EX1/recalculate', { headers: auth, body: {} });
  assert.equal(r.json.changed, 1);
  assert.equal(r.json.nextAfterId, null);
  assert.equal(w.env.DB.db.prepare('SELECT final_grade FROM attempts WHERE id = ?').get(id).final_grade, '4.0');
});

test('delete lets the student start again; teachers management needs the admin role', async () => {
  const { w, auth } = await adminWorld();
  const id = await gradedAttempt(w, 'ana@marymount.edu.co', { Q1: 1 });
  await w.call('DELETE', '/api/admin/attempts/' + id, { headers: auth });
  const again = await w.call('POST', '/api/start', { body: { idToken: await w.google.token({ email: 'ana@marymount.edu.co' }), exam: 'EX1', set: 'A', firstName: 'A', lastName: 'B' } });
  assert.equal(again.json.success, true);
  assert.notEqual(again.json.duplicate, true);

  seedTeacher(w, 'felipe.velasquez@marymount.edu.co', { role: 'teacher' });
  const l = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: 'felipe.velasquez@marymount.edu.co' }) } });
  const r = await w.call('GET', '/api/admin/teachers', { headers: { Authorization: 'Bearer ' + l.json.session } });
  assert.equal(r.status, 403);
});

test('only one exam can be the default', async () => {
  const { w, auth } = await adminWorld();
  await w.call('POST', '/api/admin/exams', { headers: auth, body: { id: 'EX2', title: 'Second', isDefault: true } });
  const rows = w.env.DB.db.prepare('SELECT id, is_default FROM exams ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.is_default), [0, 1]);
});

test('penalty can be removed for a false positive: totals and grade follow, evidence stays, recalculate keeps it', async () => {
  const { w, auth } = await adminWorld();
  const id = await gradedAttempt(w, 'ana@marymount.edu.co', { Q1: 1, Q2: 'Paris', Q3: 'Rigid triangles.' });
  // A paste fault was recorded and cost one point.
  const events = [{ seq: 0, t: w.clock.t, type: 'paste', len: 50 }];
  w.env.DB.db.prepare('UPDATE attempts SET events = ?, faults = 1, penalty = 1').run(JSON.stringify(events));
  await w.call('POST', '/api/admin/exams/EX1/recalculate', { headers: auth, body: {} });
  assert.equal(w.env.DB.db.prepare('SELECT total_score AS t FROM attempts').get().t, 8);   // 9 - 1

  const r = await w.call('PUT', `/api/admin/attempts/${id}/penalty`, { headers: auth, body: { penalty: 0 } });
  assert.equal(r.json.totalScore, 9);
  assert.equal(r.json.percentage, 100);
  const row = w.env.DB.db.prepare('SELECT * FROM attempts').get();
  assert.equal(row.total_score, 9);
  assert.equal(JSON.parse(row.events).length, 1);            // evidence kept

  await w.call('POST', '/api/admin/exams/EX1/recalculate', { headers: auth, body: {} });
  assert.equal(w.env.DB.db.prepare('SELECT total_score AS t FROM attempts').get().t, 9);

  const bad = await w.call('PUT', `/api/admin/attempts/${id}/penalty`, { headers: auth, body: { penalty: 7 } });
  assert.equal(bad.status, 400);
  const noSession = await w.call('PUT', `/api/admin/attempts/${id}/penalty`, { body: { penalty: 0 } });
  assert.equal(noSession.status, 401);
});
