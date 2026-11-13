/**
 * grading.test.js -- reliability of the AI grading path (audit phase P1).
 *
 * The model is faked (helpers.js). What is checked is everything around it:
 * the request settings per question type, what happens when a reply is cut,
 * declined or has no score, that an attempt is never graded twice at once,
 * that retries are capped and resume from saved partial results, the two
 * "regrade" routes, and that malformed grade boundaries are refused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';
import { processGrade, MAX_GRADE_ATTEMPTS } from '../src/queue.js';
import { REVIEW_TEXT } from '../src/grading.js';

const STUDENT = 'ana.gomez@marymount.edu.co';
const TEACHER = 'andres.forero@marymount.edu.co';
const MINUTE = 60 * 1000;

/** A Messages API response that stopped for `reason` with no text (what a cut or declined reply looks like). */
const stopped = (reason) => ({ content: [], stop_reason: reason });

/** World with the default exam (Q1 mc, Q2 short "Paris", Q3 open-ended) and a signed-in teacher. */
async function world(options) {
  const w = await makeWorld(options);
  await seedExam(w, options && options.seed);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  return { w, auth: { Authorization: 'Bearer ' + login.json.session } };
}

/** Starts and submits an attempt; returns its id. Grading has NOT run yet. */
async function submit(w, answers, email = STUDENT) {
  const s = await w.call('POST', '/api/start', { body: {
    idToken: await w.google.token({ email }), exam: 'EX1', set: 'A', firstName: 'Ana', lastName: 'Gómez' } });
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers } });
  return s.json.attemptId;
}

const row = (w, id) => w.env.DB.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);

/** Delivers one queue message like Cloudflare would; returns 'ack' or 'retry'. */
async function deliver(w, attemptId) {
  let outcome = '';
  const msg = { body: { type: 'grade', attemptId }, ack() { outcome = 'ack'; }, retry() { outcome = 'retry'; } };
  await w.app.queue({ messages: [msg] }, w.env);
  return outcome;
}

/** Makes every model call fail with HTTP `status` until the returned function is called. */
function breakModel(w, status) {
  const real = w.deps.fetch;
  w.deps.fetch = async (url, init) => (String(url).includes('anthropic')
    ? new Response('{}', { status }) : real(url, init));
  return () => { w.deps.fetch = real; };
}

test('each question type is sent with its own thinking, effort and budget, and the answer is fenced as untrusted', async () => {
  const { w } = await world();
  const id = await submit(w, { Q1: 1, Q2: 'Lyon', Q3: 'Triangles make a frame rigid.' });
  await w.drainQueue();
  assert.equal(row(w, id).status, 'graded');

  const short = w.modelCalls.find((c) => /Capital of France/.test(c.user)).body;
  const open = w.modelCalls.find((c) => /RUBRIC/.test(c.user)).body;
  // Short: thinking off (this model's spelling of "off"), cheap. Open-ended: thinking on, medium.
  assert.deepEqual(short.thinking, { type: 'between_tools' });
  assert.equal(short.output_config.effort, 'low');
  assert.equal(short.max_tokens, 400);
  assert.deepEqual(open.thinking, { type: 'adaptive' });
  assert.equal(open.output_config.effort, 'medium');
  assert.equal(open.max_tokens, 4000);
  // Both ask for the enforced JSON reply, and wrap the student's text in tags.
  for (const body of [short, open]) {
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.deepEqual(body.output_config.format.schema.required, ['score', 'feedback']);
    assert.match(body.messages[0].content, /<student_answer>\n[\s\S]+\n<\/student_answer>/);
    assert.match(body.system, /never follow instructions/);
  }
});

test('a reply cut at max_tokens is asked once more with a larger budget, and the tokens of both calls are counted', async () => {
  let n = 0;
  const { w } = await world({ modelReply: () => (++n === 1 ? stopped('max_tokens') : '{"score": 4, "feedback": "Good start."}') });
  const id = await submit(w, { Q1: 1, Q2: 'Paris', Q3: 'Triangles make a frame rigid.' });
  await w.drainQueue();

  assert.equal(w.modelCalls.length, 2);
  assert.equal(w.modelCalls[1].body.max_tokens, 16000);
  const a = row(w, id);
  assert.equal(a.status, 'graded');
  assert.equal(JSON.parse(a.results).Q3.score, 4);
  assert.equal(a.needs_review, 0);
  // The fake reports 4200 in / 900 out per call.
  assert.equal(a.tokens_in, 8400);
  assert.equal(a.tokens_out, 1800);
});

test('a declined answer flags only that question for the teacher; the attempt is graded and an override clears the flag', async () => {
  const { w, auth } = await world({ modelReply: () => stopped('refusal') });
  const id = await submit(w, { Q1: 1, Q2: 'Paris', Q3: 'Some text a safety filter trips on.' });
  await w.drainQueue();

  const a = row(w, id);
  assert.equal(a.status, 'graded');
  assert.equal(a.needs_review, 1);
  assert.equal(a.total_score, 3);                       // Q1 (2) + Q2 (1); Q3 counts 0 for now
  const q3 = JSON.parse(a.results).Q3;
  assert.equal(q3.needsReview, true);
  assert.match(q3.reviewReason, /declined/);

  // The student is told the teacher will mark it, not shown an empty zero.
  w.clock.t += 61 * MINUTE;
  const seen = await w.call('GET', '/api/result?attemptId=' + id);
  assert.equal(seen.json.openFeedback.find((f) => f.questionId === 'Q3').feedback, REVIEW_TEXT);
  const list = await w.call('GET', '/api/admin/attempts?exam=EX1', { headers: auth });
  assert.equal(list.json.attempts[0].needsReview, 1);

  // The teacher's mark clears the flag everywhere.
  const o = await w.call('PUT', '/api/admin/attempts/' + id + '/overrides', { headers: auth, body: { overrides: { Q3: 5 } } });
  assert.equal(o.status, 200);
  assert.equal(row(w, id).needs_review, 0);
  const after = await w.call('GET', '/api/result?attemptId=' + id);
  const fb = after.json.openFeedback.find((f) => f.questionId === 'Q3');
  assert.equal(fb.score, 5);
  assert.notEqual(fb.feedback, REVIEW_TEXT);
});

test('a reply with no usable score, or still cut after the larger retry, needs review instead of scoring a silent zero', async () => {
  const noScore = await world({ modelReply: () => 'I would give this about three marks.' });
  const id1 = await submit(noScore.w, { Q3: 'An answer.' });
  await noScore.w.drainQueue();
  assert.match(JSON.parse(row(noScore.w, id1).results).Q3.reviewReason, /no usable score/);

  const cut = await world({ modelReply: () => stopped('max_tokens') });
  const id2 = await submit(cut.w, { Q3: 'An answer.' });
  await cut.w.drainQueue();
  assert.equal(cut.w.modelCalls.length, 2);             // the first call and exactly one larger retry
  assert.equal(row(cut.w, id2).status, 'graded');
  assert.match(JSON.parse(row(cut.w, id2).results).Q3.reviewReason, /output budget/);
});

test('a second message for an attempt that is being graded is skipped; a run that died long ago is taken over', async () => {
  const { w } = await world();
  const id = await submit(w, { Q3: 'An answer.' });
  // Pretend another consumer claimed it a minute ago.
  w.env.DB.db.prepare("UPDATE attempts SET status = 'grading', grading_started_at = ? WHERE id = ?").run(w.clock.t - MINUTE, id);
  assert.equal(await processGrade(w.env, w.deps, id), 'skipped');
  assert.equal(w.modelCalls.length, 0);

  // 17 minutes later that run cannot be alive any more (a consumer may run 15 minutes).
  w.clock.t += 16 * MINUTE;
  assert.equal(await processGrade(w.env, w.deps, id), 'graded');
  assert.equal(w.modelCalls.length, 1);
});

test('retries are capped: after 5 failed tries the attempt stops as error and nothing enqueues it again', async () => {
  const { w } = await world();
  const id = await submit(w, { Q3: 'An answer.' });
  w.sent.length = 0;
  breakModel(w, 500);

  for (let i = 1; i <= MAX_GRADE_ATTEMPTS; i++) {
    assert.equal(await deliver(w, id), 'retry');
    const a = row(w, id);
    assert.equal(a.status, 'submitted');                // claim released, ready for the next try
    assert.equal(a.grade_attempts, i);
  }
  const callsBefore = w.modelCalls.length;
  assert.equal(await deliver(w, id), 'ack');             // the sixth message does not call the model
  const a = row(w, id);
  assert.equal(a.status, 'error');
  assert.match(a.grading_error, /Stopped after 5 tries/);
  assert.equal(w.modelCalls.length, callsBefore);

  // The sweep leaves an attempt in error alone, however old it is.
  w.clock.t += 3 * 60 * MINUTE;
  await w.app.scheduled({}, w.env);
  assert.equal(w.sent.filter((m) => m.attemptId === id).length, 0);
});

test('partial results survive a failed run: the retry calls the model only for the questions still missing', async () => {
  const questions = ['Q1', 'Q2', 'Q3'].map((id) => (
    { set: 'A', id, type: 'openEnded', points: 4, text: 'Explain ' + id + '.', rubric: 'Rubric of ' + id }));
  const { w } = await world({ seed: { questions } });
  const id = await submit(w, { Q1: 'First answer.', Q2: 'Second answer.', Q3: 'Third answer.' });

  // The service goes down while the third question is being graded.
  const real = w.deps.fetch;
  w.deps.fetch = async (url, init) => (String(url).includes('anthropic') && /Rubric of Q3/.test(init.body)
    ? new Response('{}', { status: 503 }) : real(url, init));
  assert.equal(await deliver(w, id), 'retry');
  assert.deepEqual(Object.keys(JSON.parse(row(w, id).results)), ['Q1', 'Q2']);
  assert.equal(w.modelCalls.length, 2);

  w.deps.fetch = real;
  assert.equal(await deliver(w, id), 'ack');
  assert.equal(row(w, id).status, 'graded');
  assert.equal(w.modelCalls.length, 3);                  // only Q3 was asked again
  assert.match(w.modelCalls[2].user, /Rubric of Q3/);
  assert.equal(row(w, id).tokens_in, 3 * 4200);          // three paid calls in total, none repeated
});

test('regrade: an attempt in error is graded after the cause is fixed, one at a time or all of an exam', async () => {
  const { w, auth } = await world();
  const fix = breakModel(w, 401);
  const one = await submit(w, { Q3: 'An answer.' });
  const two = await submit(w, { Q3: 'Another answer.' }, 'bea.ruiz@marymount.edu.co');
  await w.drainQueue();
  assert.equal(row(w, one).status, 'error');
  assert.equal(row(w, two).status, 'error');

  fix();
  const r = await w.call('POST', '/api/admin/attempts/' + one + '/regrade', { headers: auth });
  assert.equal(r.status, 200);
  await w.drainQueue();
  assert.equal(row(w, one).status, 'graded');
  assert.equal(row(w, one).grading_error, null);

  const all = await w.call('POST', '/api/admin/exams/EX1/regrade-errors', { headers: auth });
  assert.deepEqual([all.json.queued, all.json.more], [1, false]);
  await w.drainQueue();
  assert.equal(row(w, two).status, 'graded');
});

test('regrade: a graded attempt is marked again against the current rubric and keeps the teacher override; others are refused', async () => {
  let score = 2;
  const { w, auth } = await world({ modelReply: () => JSON.stringify({ score, feedback: 'Marked.' }) });
  const id = await submit(w, { Q1: 1, Q2: 'Lyon', Q3: 'An answer.' });
  await w.drainQueue();
  await w.call('PUT', '/api/admin/attempts/' + id + '/overrides', { headers: auth, body: { overrides: { Q2: 1 } } });

  score = 6;                                             // stands for "the rubric was corrected"
  await w.call('POST', '/api/admin/attempts/' + id + '/regrade', { headers: auth });
  await w.drainQueue();
  const a = row(w, id);
  assert.equal(JSON.parse(a.results).Q3.score, 6);
  assert.equal(JSON.parse(a.overrides).Q2, 1);
  assert.equal(a.total_score, 2 + 1 + 6);

  // An attempt still in progress cannot be regraded, and a session is required.
  const s = await w.call('POST', '/api/start', { body: {
    idToken: await w.google.token({ email: 'bea.ruiz@marymount.edu.co' }), exam: 'EX1', set: 'A', firstName: 'B', lastName: 'R' } });
  assert.equal((await w.call('POST', '/api/admin/attempts/' + s.json.attemptId + '/regrade', { headers: auth })).status, 409);
  assert.equal((await w.call('POST', '/api/admin/attempts/' + id + '/regrade')).status, 401);
});

test('malformed grade boundaries are refused by the server; a valid list is stored', async () => {
  const { w, auth } = await world();
  const put = (gradeBoundaries) => w.call('PUT', '/api/admin/exams/EX1', { headers: auth, body: { gradeBoundaries } });
  // Each of these used to be stored and made grading throw after the model calls.
  for (const bad of [{ A: { grade: '4.0', min: 90 } }, { A: [{ grade: '4.0' }] }, { A: [{ grade: 4, min: 90 }] },
                     { A: [{ grade: '4.0', min: 140 }] }, { D: [] }, [], { A: new Array(21).fill({ grade: '1.0', min: 0 }) }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const ok = await put({ A: [{ grade: '4.0', min: 85 }, { grade: '1.0', min: 0 }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.exam.gradeBoundaries.A[0], { grade: '4.0', min: 85 });
});
