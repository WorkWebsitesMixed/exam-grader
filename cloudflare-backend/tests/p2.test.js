/**
 * p2.test.js -- exam-day correctness within platform limits (audit phase P2).
 *
 * Covers: the query/subrequest budget of the sweep and the bulk tools (R5, R6),
 * per-student deadlines and the Settings save that must not undo them (R7),
 * the sweep grace versus a late final submit (R8), the browser cache of
 * /api/exam at a window edge (R10), the /api/myresults cap (R11), the PDF job
 * claim (R14), class validation (S9) and the last-admin guard (S13).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher, ORIGIN } from './helpers.js';

const TEACHER = 'andres.forero@marymount.edu.co';
const MIN = 60 * 1000;

async function ready() {
  const w = await makeWorld();
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  w.auth = { Authorization: 'Bearer ' + login.json.session };
  return w;
}

const start = async (w, email, extra = {}) =>
  w.call('POST', '/api/start', { body: { idToken: await w.google.token({ email }), exam: 'EX1', set: 'A',
                                         firstName: 'Ana', lastName: 'Perez', class: '10A', ...extra } });

/** Inserts an attempt row directly, in any state, for the budget tests. */
function insertAttempt(w, n, fields) {
  const f = { status: 'started', saved: null, submitted: null, gradingStarted: null, email: 'pending', deadline: w.clock.t - 10 * MIN, ...fields };
  w.env.DB.db.prepare(
    "INSERT INTO attempts (id, exam_id, set_id, email, first_name, last_name, class, started_at, deadline_at, paper, status, " +
    "answers_saved_at, submitted_at, grading_started_at, email_status, results) VALUES (?, 'EX1', 'A', ?, 'A', 'B', '10A', ?, ?, ?, ?, ?, ?, ?, ?, '{}')")
    .run('att' + n, 'u' + n + '@marymount.edu.co', f.deadline - 60 * MIN, f.deadline, JSON.stringify({ qids: ['Q1', 'Q2', 'Q3'] }),
         f.status, f.saved, f.submitted, f.gradingStarted, f.email);
}

// ---- R5: the sweep fits in 50 subrequests ----

test('R5: a worst-case sweep stays under 40 subrequests (queries + queue calls + relay calls)', async () => {
  const w = await ready();
  w.env.MAIL_RELAY_URL = 'https://relay.test/m';
  let queueCalls = 0, relayCalls = 0;
  const send = w.env.GRADE_QUEUE.sendBatch;
  w.env.GRADE_QUEUE.sendBatch = async (l) => { queueCalls++; return send(l); };
  w.env.GRADE_QUEUE.send = async () => { queueCalls++; };
  const fetch = w.deps.fetch;
  w.deps.fetch = async (u, i) => { if (String(u).startsWith('https://relay.test/')) { relayCalls += 2; } return fetch(u, i); };  // 2 = the redirect Apps Script adds

  let n = 0;
  for (let i = 0; i < 10; i++) { insertAttempt(w, n++, { status: 'started', saved: w.clock.t - 20 * MIN }); }                           // expired
  for (let i = 0; i < 10; i++) { insertAttempt(w, n++, { status: 'grading', gradingStarted: w.clock.t - 30 * MIN }); }                // stale grading
  for (let i = 0; i < 10; i++) { insertAttempt(w, n++, { status: 'submitted', submitted: w.clock.t - 45 * MIN }); }                   // stale submitted
  for (let i = 0; i < 12; i++) { insertAttempt(w, n++, { status: 'graded', email: 'pending' }); }                                      // emails waiting

  w.env.DB.queryCount = 0;
  await w.app.scheduled({}, w.env);
  const total = w.env.DB.queryCount + queueCalls + relayCalls;
  assert.ok(total <= 40, 'subrequests: ' + total + ' (queries ' + w.env.DB.queryCount + ', queue ' + queueCalls + ', relay ' + relayCalls + ')');
  assert.equal(w.sent.length, 30, 'all three categories were enqueued, in one call');
  assert.equal(w.mails.length, 5, 'emails are capped per sweep');
});

test('R5: when the sweep cannot enqueue, the attempts it just submitted go back to started and are retried next minute', async () => {
  const w = await ready();
  insertAttempt(w, 1, { status: 'started', saved: w.clock.t - 20 * MIN });
  const original = w.env.GRADE_QUEUE.sendBatch;
  w.env.GRADE_QUEUE.sendBatch = async () => { throw new Error('queue down'); };
  await w.app.scheduled({}, w.env);
  assert.equal(w.env.DB.db.prepare("SELECT status FROM attempts WHERE id = 'att1'").get().status, 'started');
  w.env.GRADE_QUEUE.sendBatch = original;
  await w.app.scheduled({}, w.env);
  assert.equal(w.env.DB.db.prepare("SELECT status FROM attempts WHERE id = 'att1'").get().status, 'submitted');
  assert.equal(w.sent.length, 1);
});

// ---- R6: bulk tools cost a fixed number of queries ----

test('R6: recalculate and regrade-mc over 40 graded attempts use about 4 queries, not 120', async () => {
  const w = await ready();
  for (let i = 0; i < 40; i++) {
    const s = await start(w, 's' + i + '@marymount.edu.co');
    await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q1: i % 2, Q2: 'Paris', Q3: 'Rigid triangles.' } } });
  }
  await w.drainQueue();
  assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM attempts WHERE status = 'graded'").get().n, 40);

  // Change the key so the tools have something to do: Q1's right answer was index 1.
  w.env.DB.db.prepare("UPDATE questions SET correct_index = 0 WHERE qid = 'Q1'").run();
  for (const path of ['regrade-mc', 'recalculate']) {
    w.env.DB.queryCount = 0;
    const r = await w.call('POST', '/api/admin/exams/EX1/' + path, { headers: w.auth, body: {} });
    assert.equal(r.json.success, true);
    assert.equal(r.json.changed, 40);
    // + 1 for the session check of the router
    assert.ok(w.env.DB.queryCount <= 8, path + ' queries: ' + w.env.DB.queryCount);
  }
  // And the result is right: students who answered 0 now have Q1 correct (2 marks).
  const even = w.env.DB.db.prepare("SELECT mc_score FROM attempts WHERE email = 's0@marymount.edu.co'").get();
  assert.equal(even.mc_score, 2);
  const odd = w.env.DB.db.prepare("SELECT mc_score FROM attempts WHERE email = 's1@marymount.edu.co'").get();
  assert.equal(odd.mc_score, 0);
});

// ---- R7: per-student deadline, and Settings saves that leave it alone ----

test('R7: extra minutes extend one student, survive a Settings save with the same closing time, and reach the page on the next autosave', async () => {
  const w = await ready();
  const closes = w.clock.t + 30 * MIN;
  await w.call('PUT', '/api/admin/exams/EX1', { headers: w.auth, body: { closesAt: closes } });
  const s = await start(w, 'ana@marymount.edu.co');
  assert.equal(s.json.deadlineAt, closes);

  const ext = await w.call('PUT', '/api/admin/attempts/' + s.json.attemptId + '/deadline', { headers: w.auth, body: { extraMinutes: 15 } });
  assert.equal(ext.json.deadlineAt, closes + 15 * MIN);

  // The admin page sends closesAt with every save; the same value must not undo the extension.
  await w.call('PUT', '/api/admin/exams/EX1', { headers: w.auth, body: { closesAt: closes, title: 'Renamed' } });
  const save = await w.call('POST', '/api/save', { body: { attemptId: s.json.attemptId, answers: { Q1: 1 } } });
  assert.equal(save.json.deadlineAt, closes + 15 * MIN);
});

test('R7: moving the closing time earlier shortens normal attempts but not manually extended ones', async () => {
  const w = await ready();
  const closes = w.clock.t + 50 * MIN;
  await w.call('PUT', '/api/admin/exams/EX1', { headers: w.auth, body: { closesAt: closes } });
  const a = await start(w, 'a@marymount.edu.co');
  const b = await start(w, 'b@marymount.edu.co');
  await w.call('PUT', '/api/admin/attempts/' + b.json.attemptId + '/deadline', { headers: w.auth, body: { extraMinutes: 10 } });

  const earlier = w.clock.t + 20 * MIN;
  await w.call('PUT', '/api/admin/exams/EX1', { headers: w.auth, body: { closesAt: earlier } });
  const row = (id) => w.env.DB.db.prepare('SELECT deadline_at FROM attempts WHERE id = ?').get(id).deadline_at;
  assert.equal(row(a.json.attemptId), earlier);
  assert.equal(row(b.json.attemptId), closes + 10 * MIN);
});

test('R7: the deadline route validates its input and only touches attempts in progress', async () => {
  const w = await ready();
  const s = await start(w, 'ana@marymount.edu.co');
  const put = (body) => w.call('PUT', '/api/admin/attempts/' + s.json.attemptId + '/deadline', { headers: w.auth, body });
  assert.equal((await put({ extraMinutes: 0 })).status, 400);
  assert.equal((await put({ extraMinutes: 181 })).status, 400);
  assert.equal((await put({ extraMinutes: 'ten' })).status, 400);
  assert.equal((await w.call('PUT', '/api/admin/attempts/' + s.json.attemptId + '/deadline', { body: { extraMinutes: 5 } })).status, 401);
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: {} } });
  assert.equal((await put({ extraMinutes: 5 })).status, 409);
});

test('R7: extending an attempt that just ran out counts the minutes from now', async () => {
  const w = await ready();
  const s = await start(w, 'ana@marymount.edu.co');
  w.clock.t += 61 * MIN;                         // 1 minute past a 60-minute deadline, sweep has not run yet
  const ext = await w.call('PUT', '/api/admin/attempts/' + s.json.attemptId + '/deadline', { headers: w.auth, body: { extraMinutes: 10 } });
  assert.equal(ext.json.deadlineAt, w.clock.t + 10 * MIN);
});

// ---- R8: a final submit that arrives after the deadline is not pre-empted by the sweep ----

test('R8: a submit 90 s after the deadline stores its answers, and the sweep does not close the attempt before that grace ends', async () => {
  const w = await ready();
  const s = await start(w, 'ana@marymount.edu.co');
  await w.call('POST', '/api/save', { body: { attemptId: s.json.attemptId, answers: { Q1: 0 } } });

  w.clock.t += 60 * MIN + 90 * 1000;             // 90 s after the 60-minute deadline
  await w.app.scheduled({}, w.env);
  assert.equal(w.env.DB.db.prepare('SELECT status FROM attempts').get().status, 'started', 'sweep waits out the submit grace');

  const sub = await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q1: 1, Q2: 'Paris' } } });
  assert.equal(sub.json.success, true);
  assert.deepEqual(JSON.parse(w.env.DB.db.prepare('SELECT answers FROM attempts').get().answers), { Q1: 1, Q2: 'Paris' });
});

test('R8: the attempts list tells an expired attempt with nothing saved from one that saved', async () => {
  const w = await ready();
  await start(w, 'never@marymount.edu.co');
  const s = await start(w, 'saved@marymount.edu.co');
  await w.call('POST', '/api/save', { body: { attemptId: s.json.attemptId, answers: { Q1: 1 } } });
  const list = await w.call('GET', '/api/admin/attempts?exam=EX1', { headers: w.auth });
  const by = Object.fromEntries(list.json.attempts.map((a) => [a.email, a]));
  assert.equal(by['never@marymount.edu.co'].savedAt, null);
  assert.ok(by['saved@marymount.edu.co'].savedAt > 0);
});

// ---- R10: browser cache never outlives a window edge ----

test('R10: /api/exam is cached for 30 s normally and for less when an opening or closing time is near', async () => {
  const w = await ready();
  const maxAge = (r) => (/max-age=(\d+)/.exec(r.headers.get('Cache-Control')) || [])[1];
  assert.equal(maxAge(await w.call('GET', '/api/exam')), '30');

  const w2 = await ready();
  w2.env.DB.db.prepare('UPDATE exams SET opens_at = ?').run(w2.clock.t + 10 * 1000);
  assert.equal(maxAge(await w2.call('GET', '/api/exam')), '10');
  w2.clock.t += 7500;                            // served from the server cache, 2.5 s to go
  assert.equal(maxAge(await w2.call('GET', '/api/exam')), '2');
  w2.clock.t += 2000;                            // 0.5 s to go: must not be cached at all
  const last = await w2.call('GET', '/api/exam');
  assert.equal(last.headers.get('Cache-Control'), 'no-store');
});

// ---- R11 ----

test('R11: /api/myresults returns only the latest 20 attempts', async () => {
  const w = await ready();
  const s = await start(w, 'ana@marymount.edu.co');
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q1: 1 } } });
  await w.drainQueue();
  for (let i = 1; i <= 22; i++) {
    w.env.DB.db.prepare("INSERT INTO exams (id, title, active, is_default, duration_min, exam_type, set_mode, created_at, updated_at) VALUES (?, 'X', 0, 0, 60, 'igcse', 'single', 0, 0)").run('X' + i);
    w.env.DB.db.prepare(
      "INSERT INTO attempts (id, exam_id, set_id, email, first_name, last_name, class, started_at, deadline_at, paper, status, results, total_score, max_score, percentage, final_grade) " +
      "SELECT 'old' || ?, 'X' || ?, set_id, email, first_name, last_name, class, started_at - ? * 1000, deadline_at - ? * 1000, paper, status, results, total_score, max_score, percentage, final_grade FROM attempts WHERE id = ?")
      .run(String(i), String(i), i, i, s.json.attemptId);  // strings: a JS number binds as REAL and would make 'X1.0'
  }
  w.clock.t += 2 * 60 * MIN;
  const r = await w.call('POST', '/api/myresults', { body: { idToken: await w.google.token({ email: 'ana@marymount.edu.co' }) } });
  assert.equal(r.json.submissions.length, 20);
  assert.equal(r.json.submissions[0].examId, 'EX1', 'newest first');
});

// ---- R14 ----

test('R14: pressing Run twice on a PDF job queues it once', async () => {
  const w = await ready();
  const up = await w.app.fetch(new Request('https://api.test/api/admin/jobs?kind=extractQuestions', {
    method: 'POST', body: new TextEncoder().encode('%PDF-1.4\n%%EOF'), headers: { Origin: ORIGIN, ...w.auth } }), w.env);
  const jobId = (await up.json()).jobId;
  const first = await w.call('POST', `/api/admin/jobs/${jobId}/run`, { headers: w.auth, body: {} });
  const second = await w.call('POST', `/api/admin/jobs/${jobId}/run`, { headers: w.auth, body: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(w.sent.filter((m) => m.type === 'job').length, 1);
});

// ---- S9 ----

test('S9: a class outside the exam list is refused; a listed one and an empty list are accepted', async () => {
  const w = await ready();
  const ok = await start(w, 'a@marymount.edu.co', { class: 'whatever' });          // no list yet: anything goes
  assert.equal(ok.json.success, true);

  await w.call('PUT', '/api/admin/exams/EX1', { headers: w.auth, body: { classOptions: ['10A', '10B'] } });
  const bad = await start(w, 'b@marymount.edu.co', { class: '11A' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'invalid_class');
  const empty = await start(w, 'c@marymount.edu.co', { class: '' });
  assert.equal(empty.json.code, 'invalid_class');
  const good = await start(w, 'd@marymount.edu.co', { class: '10B' });
  assert.equal(good.json.success, true);
});

// ---- S13 ----

test('S13: the last admin cannot be demoted, but can once another admin exists', async () => {
  const w = await ready();
  const demote = () => w.call('POST', '/api/admin/teachers', { headers: w.auth, body: { email: TEACHER, role: 'teacher' } });
  const refused = await demote();
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'last_admin');
  assert.equal(w.env.DB.db.prepare('SELECT role FROM teachers WHERE email = ?').get(TEACHER).role, 'admin');

  await w.call('POST', '/api/admin/teachers', { headers: w.auth, body: { email: 'second@marymount.edu.co', role: 'admin' } });
  assert.equal((await demote()).status, 200);
});
