/**
 * images.test.js -- figure upload and serving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';
import { ORIGIN } from './helpers.js';

const TEACHER = 'andres.forero@marymount.edu.co';
// 1x1 transparent PNG
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

async function adminWorld() {
  const w = await makeWorld();
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  return { w, auth: { Authorization: 'Bearer ' + login.json.session } };
}

/** Raw upload like the admin page does it. */
async function upload(w, auth, bytes, headers = {}) {
  const resp = await w.app.fetch(new Request('https://api.test/api/admin/images', {
    method: 'POST', body: bytes, headers: { Origin: ORIGIN, ...auth, ...headers } }), w.env);
  return { status: resp.status, json: await resp.json() };
}

test('upload stores the file under its content hash and serves it publicly with a long cache', async () => {
  const { w, auth } = await adminWorld();
  const r = await upload(w, auth, PNG, { 'X-Filename': encodeURIComponent('diagrama é.png') });
  assert.equal(r.status, 200);
  assert.match(r.json.hash, /^[a-f0-9]{64}$/);
  assert.equal(r.json.url, '/img/' + r.json.hash);
  assert.equal(w.env.DB.db.prepare('SELECT original_name, mime FROM images').get().original_name, 'diagrama é.png');

  // No session needed to read it: students see the figure.
  const got = await w.app.fetch(new Request('https://api.test' + r.json.url), w.env);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Content-Type'), 'image/png');
  assert.match(got.headers.get('Cache-Control'), /immutable/);
  assert.equal(got.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PNG);
});

test('the same file twice is stored once', async () => {
  const { w, auth } = await adminWorld();
  const a = await upload(w, auth, PNG);
  const b = await upload(w, auth, PNG);
  assert.equal(a.json.hash, b.json.hash);
  assert.equal(b.json.existed, true);
  assert.equal(w.env.DB.db.prepare('SELECT COUNT(*) AS n FROM images').get().n, 1);
});

test('refuses SVG and HTML even when the client claims an image type; refuses oversize and anonymous uploads', async () => {
  const { w, auth } = await adminWorld();
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const r1 = await upload(w, auth, svg, { 'Content-Type': 'image/png' });
  assert.equal(r1.status, 415);

  const big = new Uint8Array(2 * 1024 * 1024 + 1); big.set(PNG.slice(0, 8));
  const r2 = await upload(w, auth, big);
  assert.equal(r2.status, 413);

  const r3 = await upload(w, {}, PNG);
  assert.equal(r3.status, 401);
  assert.equal(w.env.DB.db.prepare('SELECT COUNT(*) AS n FROM images').get().n, 0);
});

test('an unknown or malformed image path is a 404, and a question may reference an uploaded hash', async () => {
  const { w, auth } = await adminWorld();
  const miss = await w.app.fetch(new Request('https://api.test/img/' + 'ab'.repeat(32)), w.env);
  assert.equal(miss.status, 404);
  const junk = await w.app.fetch(new Request('https://api.test/img/../../etc'), w.env);
  assert.equal(junk.status, 404);

  const up = await upload(w, auth, PNG);
  const q = await w.call('POST', '/api/admin/exams/EX1/questions', { headers: auth, body: {
    set: 'A', id: 'QIMG', type: 'openEnded', points: 2, text: 'Look at the figure', rubric: 'x', imageHash: up.json.hash } });
  assert.equal(q.json.success, true);
  const exam = await w.call('GET', '/api/exam?exam=EX1');
  const served = exam.json.questions.A.find((x) => x.id === 'QIMG');
  assert.equal(served.imageUrl.endsWith('/img/' + up.json.hash), true);
});
