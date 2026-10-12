/**
 * grader-page.test.js -- the real grader.html, running in jsdom, talking to the
 * real Worker code (in-process, real SQL). This is the closest thing to a
 * classroom test that can run without a browser or a network: it exercises the
 * page's adapter for the new backend end to end.
 *
 * What is faked: Google Sign-In (the page's callback is invoked with a token
 * signed by the test's own RSA key) and the clock (page and server share one
 * simulated clock so the 45-minute deadline can be crossed instantly).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeWorld, seedExam } from './helpers.js';

const HTML = readFileSync(new URL('../../grader.html', import.meta.url), 'utf8');
const BASE = 'https://examgrader-api.test.workers.dev';
const STUDENT = 'ana.perez@marymount.edu.co';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) { return; } await sleep(40); }
  throw new Error('timed out waiting for: ' + what);
}

/** World with a standard (shuffled) exam: 2 mc + 1 open-ended, one question with an image. */
async function setup() {
  const w = await makeWorld();
  await seedExam(w, { exam: { exam_type: 'standard', duration_min: 45 }, questions: [
    { set: 'A', id: 'Q1', type: 'mc', points: 2, text: 'Pick B', options: ['a', 'b', 'c', 'd'], correctIndex: 1 },
    { set: 'A', id: 'Q2', type: 'mc', points: 2, text: 'Pick D', options: ['w', 'x', 'y', 'z'], correctIndex: 3 },
    { set: 'A', id: 'Q3', type: 'openEnded', points: 6, text: 'Explain triangulation.', rubric: 'Mention rigidity.' },
  ] });
  w.env.DB.db.prepare("UPDATE exams SET class_options = '[\"10A\"]' WHERE id = 'EX1'").run();
  const hash = 'ab'.repeat(32);
  w.env.DB.db.prepare("INSERT INTO images (hash, mime, size_bytes, uploaded_by, created_at) VALUES (?, 'image/png', 1, 't', 0)").run(hash);
  w.env.DB.db.prepare("UPDATE questions SET image_hash = ? WHERE qid = 'Q1'").run(hash);
  return w;
}

/** Opens grader.html as a student would: from a link with ?src= (and optionally &exam=). */
function openPage(w, search) {
  const requests = [];
  const alerts = [];
  const dom = new JSDOM(HTML, {
    url: 'https://workwebsitesmixed.github.io/exam-grader/grader.html' + search,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.alert = (m) => alerts.push(String(m));
      window.Date.now = () => w.clock.t;
      window.__gsi = {};
      window.google = { accounts: { id: { initialize(cfg) { window.__gsi.cb = cfg.callback; }, renderButton() {} } } };
      // The page's fetch goes straight into the Worker, like the network would.
      window.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), method: init.method || 'GET' });
        const u = new URL(String(url));
        if (u.origin !== BASE) { return new Response('{"success":false}', { status: 502 }); }
        return w.app.fetch(new Request(String(url), { ...init, headers: { Origin: 'https://workwebsitesmixed.github.io' } }), w.env);
      };
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, requests, alerts };
}

async function signIn(w, page, email = STUDENT) {
  await until(() => page.win.__gsi.cb, 'google sign-in to initialise');
  const token = await w.google.token({ email, given_name: 'Ana', family_name: 'Pérez' });
  page.win.__gsi.cb({ credential: token });
  await until(() => page.doc.getElementById('studentInfoScreen').classList.contains('active'), 'student info screen');
}

async function startExam(page) {
  page.doc.getElementById('studentClass').value = '10A';
  page.win.startExam();
  await until(() => page.doc.getElementById('examContainer').classList.contains('active'), 'exam screen');
}

/** Tick the radio of a question that shows the given option TEXT. */
function chooseByText(page, qid, text) {
  const radios = [...page.doc.querySelectorAll(`input[name="${qid}"]`)];
  const radio = radios.find((r) => r.parentElement.textContent.includes('. ' + text));
  assert.ok(radio, `option "${text}" not found for ${qid}`);
  radio.click();
  return radio.value;
}

test('page loads the exam from the Worker, shows images from /img, and applies the grade scale', async () => {
  const w = await setup();
  w.env.DB.db.prepare('UPDATE exams SET grade_boundaries = ? WHERE id = ?')
    .run(JSON.stringify({ A: [{ grade: '4.0', min: 90 }, { grade: '1.0', min: 0 }] }), 'EX1');
  const page = openPage(w, `?src=${BASE}&exam=EX1`);
  await signIn(w, page);
  assert.equal(page.requests[0].url, `${BASE}/api/exam?exam=EX1`);
  assert.match(page.doc.getElementById('gradingScaleTable').textContent, /4\.0.*90%/s);
  page.win.close();
});

test('full exam on the new backend: shuffled options are graded by index, autosave stores them, result after deadline', async () => {
  const w = await setup();
  const page = openPage(w, `?src=${BASE}&exam=EX1`);
  await signIn(w, page);
  await startExam(page);

  // Three cards; Q1 carries the image, served from the Worker, not Drive.
  assert.equal(page.doc.querySelectorAll('.question-card').length, 3);
  assert.equal(page.doc.querySelector('.question-image img').src, `${BASE}/img/${'ab'.repeat(32)}`);

  // Option order is shuffled (rng 0.5 -> a, d, b, c) and the page must still send printed indexes.
  const q1Texts = [...page.doc.querySelectorAll('input[name="Q1"]')].map((r) => r.parentElement.textContent.split('. ')[1]);
  assert.deepEqual(q1Texts, ['a', 'd', 'b', 'c']);

  chooseByText(page, 'Q1', 'b');                 // correct (printed index 1)
  chooseByText(page, 'Q2', 'x');                 // wrong (correct is z)
  const ta = page.doc.querySelector('textarea[data-qid="Q3"]');
  ta.value = 'Triangles are rigid, so they resist deformation.';
  ta.dispatchEvent(new page.win.Event('input'));

  // Autosave: the server must hold printed-order indexes, not letters.
  page.win.autosaveNow(false);
  await until(() => {
    const row = w.env.DB.db.prepare('SELECT answers FROM attempts').get();
    return row && JSON.parse(row.answers).Q1 !== undefined;
  }, 'autosave');
  const saved = JSON.parse(w.env.DB.db.prepare('SELECT answers FROM attempts').get().answers);
  assert.equal(saved.Q1, 1);
  assert.equal(saved.Q2, 1);
  assert.equal(saved.Q3, 'Triangles are rigid, so they resist deformation.');

  // Submit before the deadline: the page must say results come later.
  page.win.confirmSubmit();
  await until(() => /Results will appear when time is up/.test(page.doc.getElementById('waitingMsg').textContent), 'submitted message');
  assert.equal(await w.drainQueue(), 1);

  // Cross the deadline: the page's own timer notices and polls until the result is ready.
  w.clock.t += 46 * 60 * 1000;
  await until(() => page.doc.getElementById('resultsScreen').classList.contains('active'), 'results screen', 15000);
  assert.equal(page.doc.getElementById('totalScoreDisplay').textContent, '8/10');   // 2 + 0 + 6
  assert.match(page.doc.getElementById('resultsName').textContent, /Ana Pérez/);
  assert.equal(page.alerts.length, 0);
  page.win.close();
});

test('reload resumes the same attempt on another browser, with answers and the original deadline', async () => {
  const w = await setup();
  const first = openPage(w, `?src=${BASE}&exam=EX1`);
  await signIn(w, first);
  await startExam(first);
  chooseByText(first, 'Q2', 'z');
  const ta = first.doc.querySelector('textarea[data-qid="Q3"]');
  ta.value = 'half written answer';
  ta.dispatchEvent(new first.win.Event('input'));
  first.win.autosaveNow(false);
  await until(() => w.env.DB.db.prepare('SELECT answers FROM attempts').get().answers !== '{}', 'autosave');
  first.win.close();

  w.clock.t += 10 * 60 * 1000;   // ten minutes later, on another computer (fresh sessionStorage)
  const second = openPage(w, `?src=${BASE}&exam=EX1`);
  await signIn(w, second);
  await startExam(second);
  assert.equal(w.env.DB.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1);
  assert.equal(second.doc.querySelector('textarea[data-qid="Q3"]').value, 'half written answer');
  const picked = [...second.doc.querySelectorAll('input[name="Q2"]')].find((r) => r.checked);
  assert.ok(picked && picked.parentElement.textContent.includes('. z'));
  // Timer shows the REMAINING time (35 minutes), not a fresh 45.
  assert.match(second.doc.getElementById('timer').textContent, /^3[45]:/);
  second.win.close();
});

test('a second attempt after submit shows the "already submitted" screen', async () => {
  const w = await setup();
  const a = openPage(w, `?src=${BASE}&exam=EX1`);
  await signIn(w, a); await startExam(a);
  a.win.confirmSubmit();
  await until(() => /Results will appear/.test(a.doc.getElementById('waitingMsg').textContent), 'submitted');
  a.win.close();

  const b = openPage(w, `?src=${BASE}&exam=EX1`);
  await signIn(w, b);
  b.doc.getElementById('studentClass').value = '10A';
  b.win.startExam();
  await until(() => b.doc.getElementById('duplicateScreen').style.display === 'block', 'duplicate screen');
  b.win.close();
});

test('the OLD Apps Script link still uses the old request shape (no /api calls)', async () => {
  const w = await setup();
  const page = openPage(w, '?src=https://script.google.com/macros/s/AKfycbyOLD/exec');
  await until(() => page.requests.length > 0, 'first request');
  assert.equal(page.requests[0].url, 'https://script.google.com/macros/s/AKfycbyOLD/exec?action=questions');
  assert.ok(!page.requests.some((r) => r.url.includes('/api/')));
  page.win.close();
});

test('an unknown exam id shows a clear message instead of retrying forever', async () => {
  const w = await setup();
  const page = openPage(w, `?src=${BASE}&exam=NOPE`);
  await until(() => /not found/i.test(page.doc.getElementById('loadingScreen').textContent), 'not found message');
  assert.equal(page.requests.length, 1);
  page.win.close();
});
