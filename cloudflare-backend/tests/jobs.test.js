/**
 * jobs.test.js -- PDF tools: question extraction and marking-scheme reading.
 * The model is faked (modelReply); what is checked is the plumbing around it:
 * what is sent, what is stored, what is refused and what the teacher gets back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher, ORIGIN } from './helpers.js';
import { processJob, cleanExtracted, cleanRubrics } from '../src/jobs.js';

const TEACHER = 'andres.forero@marymount.edu.co';
const PDF = new TextEncoder().encode('%PDF-1.4\n% fake pdf body for tests\n%%EOF');

async function world(modelReply) {
  const w = await makeWorld({ modelReply });
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  w.auth = { Authorization: 'Bearer ' + login.json.session };
  return w;
}

/** Raw PDF upload, like the admin page. */
async function upload(w, kind, bytes = PDF, auth = w.auth) {
  const resp = await w.app.fetch(new Request('https://api.test/api/admin/jobs?kind=' + kind, {
    method: 'POST', body: bytes, headers: { Origin: ORIGIN, ...auth } }), w.env);
  return { status: resp.status, json: await resp.json() };
}

const EXTRACTED = JSON.stringify([
  { label: '3(a)', text: 'Fig. 3.1 shows a clock.\n\nState the type of motion.', type: 'short', points: 1, options: [], figure: 'Fig. 3.1' },
  { label: '9', text: 'Pick one', type: 'mc', points: 2, options: ['a', 'b', 'c', 'd'], figure: '' },
  { label: '10', text: 'Explain', type: 'essay', points: '4', options: 'nope', figure: '' },   // unknown type, bad options
  { label: '11', text: '   ', type: 'mc' },                                                    // empty text: dropped
]);

test('extraction: the PDF goes to the model as a document block; the review list is sanitised; temp files are removed', async () => {
  const w = await world(() => '```json\n' + EXTRACTED + '\n```');
  const up = await upload(w, 'extractQuestions');
  assert.equal(up.status, 200);
  assert.ok(w.env.FILES.objects.has('tmp/' + up.json.jobId + '.pdf'));
  assert.equal(w.modelCalls.length, 0, 'nothing is sent to the model before /run');

  const run = await w.call('POST', `/api/admin/jobs/${up.json.jobId}/run`, { headers: w.auth, body: {} });
  assert.equal(run.json.status, 'queued');
  await w.drainQueue();

  const job = await w.call('GET', `/api/admin/jobs/${up.json.jobId}`, { headers: w.auth });
  assert.equal(job.json.status, 'done');
  const qs = job.json.output.questions;
  assert.equal(qs.length, 3);
  assert.deepEqual(qs[0], { label: '3(a)', text: 'Fig. 3.1 shows a clock.\n\nState the type of motion.',
                            type: 'short', points: 1, options: [], figure: 'Fig. 3.1' });
  assert.equal(qs[2].type, 'openEnded');           // unknown type falls back
  assert.equal(qs[2].points, 4);                   // numeric string coerced
  assert.deepEqual(qs[2].options, []);
  assert.deepEqual(job.json.output.usage, { input_tokens: 4200, output_tokens: 900 });

  const sent = w.modelCalls[0].user;
  assert.equal(sent[0].type, 'document');
  assert.equal(sent[0].source.media_type, 'application/pdf');
  assert.equal(Buffer.from(sent[0].source.data, 'base64').toString().startsWith('%PDF-1.4'), true);
  assert.ok(!w.env.FILES.objects.has('tmp/' + up.json.jobId + '.pdf'), 'PDF removed after the job');
});

test('marking scheme: letters become 0-based indexes, only asked ids are kept, junk is dropped', async () => {
  const reply = { Q1: { correct: 'C' }, Q2: { accepted: ['Paris', ' paris ', ''] }, Q3: { rubric: 'Mention rigidity (2).' },
                  Q4: { correct: 'E' }, NOPE: { rubric: 'not asked' } };
  const w = await world((system, user) => JSON.stringify(reply));
  const up = await upload(w, 'generateRubrics');
  const items = [
    { id: 'Q1', type: 'mc', points: 2, text: 'Pick', options: ['a', 'b', 'c', 'd'] },
    { id: 'Q2', type: 'short', points: 1, text: 'Capital?' },
    { id: 'Q3', type: 'openEnded', points: 3, text: 'Explain' },
    { id: 'Q4', type: 'mc', points: 2, text: 'Pick', options: ['a', 'b', 'c', 'd'] },
  ];
  await w.call('POST', `/api/admin/jobs/${up.json.jobId}/run`, { headers: w.auth, body: { items } });
  await w.drainQueue();
  const job = await w.call('GET', `/api/admin/jobs/${up.json.jobId}`, { headers: w.auth });
  assert.equal(job.json.status, 'done');
  assert.deepEqual(job.json.output.rubrics, {
    Q1: { correctIndex: 2 },
    Q2: { accepted: ['Paris', 'paris'] },
    Q3: { rubric: 'Mention rigidity (2).' },
  });
  // The questions the scheme must be matched to travelled in the prompt.
  assert.match(w.modelCalls[0].user[1].text, /"id":"Q1"/);
});

test('refusals: not a PDF, too large, no session, started twice, rubrics without items', async () => {
  const w = await world(() => '[]');
  assert.equal((await upload(w, 'extractQuestions', new TextEncoder().encode('<html>no</html>'))).status, 415);
  assert.equal((await upload(w, 'nonsense')).status, 400);
  const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(PDF);
  assert.equal((await upload(w, 'extractQuestions', big)).status, 413);
  assert.equal((await upload(w, 'extractQuestions', PDF, {})).status, 401);

  const up = await upload(w, 'generateRubrics');
  const noItems = await w.call('POST', `/api/admin/jobs/${up.json.jobId}/run`, { headers: w.auth, body: {} });
  assert.equal(noItems.status, 400);
  const ok = await w.call('POST', `/api/admin/jobs/${up.json.jobId}/run`, { headers: w.auth,
    body: { items: [{ id: 'Q1', type: 'openEnded', text: 'x' }] } });
  assert.equal(ok.json.success, true);
  await w.drainQueue();
  const again = await w.call('POST', `/api/admin/jobs/${up.json.jobId}/run`, { headers: w.auth, body: { items: [{ id: 'Q1', text: 'x' }] } });
  assert.equal(again.status, 409);
});

test('a reply with no readable questions is reported to the teacher, not saved as an empty exam', async () => {
  const w = await world(() => 'Sorry, I cannot read this document.');
  const up = await upload(w, 'extractQuestions');
  await w.call('POST', `/api/admin/jobs/${up.json.jobId}/run`, { headers: w.auth, body: {} });
  await w.drainQueue();
  const job = await w.call('GET', `/api/admin/jobs/${up.json.jobId}`, { headers: w.auth });
  assert.equal(job.json.status, 'error');
  assert.match(job.json.error, /No questions could be read/);
});

test('a bad API key is a permanent error on the job; a service outage is retried by the queue', async () => {
  const w = await world();
  const up = await upload(w, 'extractQuestions');
  await w.call('POST', `/api/admin/jobs/${up.json.jobId}/run`, { headers: w.auth, body: {} });
  const sleep = async () => {};

  const denied = { ...w.deps, sleep, fetch: async () => new Response('{}', { status: 401 }) };
  assert.equal(await processJob(w.env, denied, up.json.jobId), 'error');
  const job = await w.call('GET', `/api/admin/jobs/${up.json.jobId}`, { headers: w.auth });
  assert.match(job.json.error, /API key/);

  const up2 = await upload(w, 'extractQuestions');
  await w.call('POST', `/api/admin/jobs/${up2.json.jobId}/run`, { headers: w.auth, body: {} });
  const down = { ...w.deps, sleep, fetch: async () => new Response('', { status: 503 }) };
  await assert.rejects(() => processJob(w.env, down, up2.json.jobId));
  const still = await w.call('GET', `/api/admin/jobs/${up2.json.jobId}`, { headers: w.auth });
  assert.equal(still.json.status, 'running');

  // Retries exhausted: the sweep stops the admin page waiting forever.
  w.clock.t += 21 * 60 * 1000;
  await w.app.scheduled({}, w.env);
  const stale = await w.call('GET', `/api/admin/jobs/${up2.json.jobId}`, { headers: w.auth });
  assert.equal(stale.json.status, 'error');
});

test('cleanExtracted and cleanRubrics tolerate junk input', () => {
  assert.deepEqual(cleanExtracted(null), []);
  assert.deepEqual(cleanExtracted([null, 5, { text: 'ok' }])[0].type, 'openEnded');
  assert.deepEqual(cleanRubrics(null, []), {});
  assert.deepEqual(cleanRubrics({ A: 'string' }, [{ id: 'A', type: 'openEnded', options: [] }]), {});
});

test('image list shows how many questions use each figure', async () => {
  const w = await world();
  const hash = 'ef'.repeat(32);
  w.env.DB.db.prepare("INSERT INTO images (hash, mime, size_bytes, original_name, uploaded_by, created_at) VALUES (?, 'image/png', 9, 'G10_M2_Q3_clock.png', 't', 5)").run(hash);
  w.env.DB.db.prepare("UPDATE questions SET image_hash = ? WHERE qid IN ('Q1','Q2')").run(hash);
  const r = await w.call('GET', '/api/admin/images', { headers: w.auth });
  assert.deepEqual(r.json.images, [{ hash, mime: 'image/png', size: 9, name: 'G10_M2_Q3_clock.png', createdAt: 5, used: 2 }]);
});
