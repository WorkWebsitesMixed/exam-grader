/**
 * mail.test.js -- results email: when it is sent, what it contains, what
 * happens when the relay fails, and the admin "resend" action.
 *
 * The relay (Apps Script) is faked in helpers.js; `w.mails` holds what it
 * received and `w.relay.mode` switches it to failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';

const MIN = 60 * 1000;
const TEACHER = 'andres.forero@marymount.edu.co';

/** World with the relay enabled and one graded attempt (unless `submit` is false). */
async function setup({ relay = true, firstName = 'Ana', klass = '10A', email = 'ana.perez@marymount.edu.co' } = {}) {
  const w = await makeWorld();
  if (relay) { w.env.MAIL_RELAY_URL = 'https://relay.test/exec'; }
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const s = await w.call('POST', '/api/start', { body: {
    idToken: await w.google.token({ email }), exam: 'EX1', set: 'A', firstName, lastName: 'Perez', class: klass } });
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId,
    answers: { Q1: 0, Q2: 'Paris', Q3: 'Rigid <b>triangles</b> & more.' } } });
  await w.drainQueue();
  return { w, attemptId: s.json.attemptId };
}
const row = (w) => w.env.DB.db.prepare('SELECT * FROM attempts').get();

async function adminAuth(w) {
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  return { Authorization: 'Bearer ' + login.json.session };
}

test('the email waits for the deadline, then goes to the verified address exactly once', async () => {
  const { w } = await setup();
  assert.equal(row(w).email_status, 'pending');

  await w.app.scheduled({}, w.env);
  assert.equal(w.mails.length, 0, 'nothing is sent while the student could still be working');

  w.clock.t += 61 * MIN;
  await w.app.scheduled({}, w.env);
  assert.equal(w.mails.length, 1);
  assert.equal(w.mails[0].to, 'ana.perez@marymount.edu.co');
  assert.equal(row(w).email_status, 'sent');

  await w.app.scheduled({}, w.env);
  await w.app.scheduled({}, w.env);
  assert.equal(w.mails.length, 1, 'later sweeps do not send it again');
});

test('content: grade, points, correct answer of a wrong MC, teacher override and escaped student text', async () => {
  const { w, attemptId } = await setup({ firstName: '<i>Ana</i>' });
  const auth = await adminAuth(w);
  // Q1 was answered 0 ("a") and the key is 1 ("b"): wrong. Override the open answer to 4.
  const ov = await w.call('PUT', `/api/admin/attempts/${attemptId}/overrides`, { headers: auth, body: { overrides: { Q3: 4 } } });
  assert.equal(ov.json.success, true);

  w.clock.t += 61 * MIN;
  await w.app.scheduled({}, w.env);
  const mail = w.mails[0];
  assert.match(mail.subject, /Test Exam .* Your Results/);
  assert.match(mail.html, /Correct answer: <strong>b<\/strong>/);
  assert.match(mail.html, /Open-Ended &mdash; 4\/6 pts/);          // the override, not the AI score
  assert.ok(!mail.html.includes('<i>Ana</i>'), 'name is escaped');
  assert.ok(mail.html.includes('&lt;i&gt;Ana&lt;/i&gt;'));
  assert.ok(!mail.html.includes('<b>triangles</b>'), 'answer is escaped');
  assert.ok(mail.html.includes('Rigid &lt;b&gt;triangles&lt;/b&gt; &amp; more.'));
});

test('a failing relay marks the attempt failed; resend queues it and the next sweep delivers', async () => {
  const { w } = await setup();
  w.relay.mode = 'error';
  w.clock.t += 61 * MIN;
  await w.app.scheduled({}, w.env);
  assert.equal(row(w).email_status, 'failed');
  assert.equal(w.mails.length, 0);

  w.relay.mode = 'ok';
  const auth = await adminAuth(w);
  const r = await w.call('POST', '/api/admin/exams/EX1/resend-emails', { headers: auth, body: {} });
  assert.equal(r.json.queued, 1);
  assert.equal(row(w).email_status, 'pending');
  await w.app.scheduled({}, w.env);
  assert.equal(w.mails.length, 1);
  assert.equal(row(w).email_status, 'sent');
});

test('an unreachable relay does not break the sweep or the exam', async () => {
  const { w } = await setup();
  w.relay.mode = 'down';
  w.clock.t += 61 * MIN;
  await w.app.scheduled({}, w.env);
  assert.equal(row(w).email_status, 'failed');
  assert.equal(row(w).status, 'graded');
});

test('without a relay configured nothing is attempted and resend says so', async () => {
  const { w } = await setup({ relay: false });
  assert.equal(row(w).email_status, 'none');
  w.clock.t += 61 * MIN;
  await w.app.scheduled({}, w.env);
  assert.equal(w.mails.length, 0);
  const auth = await adminAuth(w);
  const r = await w.call('POST', '/api/admin/exams/EX1/resend-emails', { headers: auth, body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'email_disabled');
});

test('resend can be limited to one class or set', async () => {
  const { w } = await setup({ klass: '10A' });
  const other = await w.call('POST', '/api/start', { body: {
    idToken: await w.google.token({ email: 'bea.ruiz@marymount.edu.co' }), exam: 'EX1', set: 'A',
    firstName: 'Bea', lastName: 'Ruiz', class: '10B' } });
  await w.call('POST', '/api/submit', { body: { attemptId: other.json.attemptId, answers: {} } });
  await w.drainQueue();
  w.clock.t += 61 * MIN;
  await w.app.scheduled({}, w.env);
  assert.equal(w.mails.length, 2);

  const auth = await adminAuth(w);
  const r = await w.call('POST', '/api/admin/exams/EX1/resend-emails', { headers: auth, body: { class: '10B' } });
  assert.equal(r.json.queued, 1);
  await w.app.scheduled({}, w.env);
  assert.equal(w.mails.length, 3);
  assert.equal(w.mails[2].to, 'bea.ruiz@marymount.edu.co');
});

test('resend needs a teacher session', async () => {
  const { w } = await setup();
  const r = await w.call('POST', '/api/admin/exams/EX1/resend-emails', { body: {} });
  assert.equal(r.status, 401);
});
