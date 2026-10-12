/**
 * admin-page.test.js -- the real admin3.html, running in jsdom, talking to the
 * real Worker code (in-process, real SQL).
 *
 * Same technique as grader-page.test.js: Google Sign-In is faked (the page's
 * callback receives a token signed by the test's own RSA key) and the clock is
 * shared with the server. What these tests prove is that the page's buttons
 * call the right routes with the right bodies, that the numbers it shows come
 * from the server, and that student-written text can never become markup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';

const HTML = readFileSync(new URL('../../admin3.html', import.meta.url), 'utf8');
const BASE = 'https://examgrader-api.marymount-exams.workers.dev';   // fixed in the page
const TEACHER = 'andres.forero@marymount.edu.co';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) { return; } await sleep(30); }
  throw new Error('timed out waiting for: ' + what);
}

/** World with one exam (mc + short + openEnded), a teacher and one graded student. */
async function setup({ firstName = 'Ana' } = {}) {
  const w = await makeWorld();
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const start = await w.call('POST', '/api/start', { body: {
    idToken: await w.google.token({ email: 'ana.perez@marymount.edu.co' }), exam: 'EX1', set: 'A',
    firstName, lastName: 'Perez', class: '10A' } });
  await w.call('POST', '/api/submit', { body: { attemptId: start.json.attemptId, answers: { Q1: 1, Q2: 'Paris', Q3: 'Rigid triangles.' } } });
  await w.drainQueue();
  w.attemptId = start.json.attemptId;
  return w;
}

/** Opens admin3.html like a teacher would, with fetch wired into the Worker. */
function openPage(w) {
  const requests = [];
  const dom = new JSDOM(HTML, {
    url: 'https://workwebsitesmixed.github.io/exam-grader/admin3.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.confirm = () => true;
      window.Date.now = () => w.clock.t;
      window.__gsi = {};
      window.google = { accounts: { id: {
        initialize(cfg) { window.__gsi.cb = cfg.callback; }, renderButton() {}, disableAutoSelect() {} } } };
      window.fetch = async (url, init = {}) => {
        const u = new URL(String(url));
        // jsdom's Blob is not Node's: read it into bytes before handing it to the Worker.
        if (init.body && typeof init.body === 'object' && typeof init.body.size === 'number') {
          init = { ...init, body: await new Promise((res) => {
            const fr = new window.FileReader();
            fr.onload = () => res(new Uint8Array(fr.result));
            fr.readAsArrayBuffer(init.body);
          }) };
        }
        requests.push({ url: String(url), method: init.method || 'GET', body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
        if (u.origin !== BASE) { return new Response('{"success":false}', { status: 502 }); }
        return w.app.fetch(new Request(String(url), { ...init, headers: { ...(init.headers || {}), Origin: 'https://workwebsitesmixed.github.io' } }), w.env);
      };
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, requests };
}

async function signIn(w, page, email = TEACHER) {
  await until(() => page.win.__gsi.cb, 'google sign-in to initialise');
  page.win.__gsi.cb({ credential: await w.google.token({ email }) });
}
async function signedIn(w) {
  const page = openPage(w);
  await signIn(w, page);
  await until(() => page.doc.getElementById('examSelect'), 'exam bar');
  return page;
}

const $ = (page, sel) => page.doc.querySelector(sel);
const text = (page, sel) => ($(page, sel) ? $(page, sel).textContent : '');
const tab = (page, name) => $(page, `.tab[data-tab="${name}"]`).click();
const db = (w) => w.env.DB.db;

test('a student account is refused with a clear message; a teacher gets the panel', async () => {
  const w = await setup();
  const bad = openPage(w);
  await signIn(w, bad, 'ana.perez@marymount.edu.co');
  await until(() => !bad.doc.getElementById('signinError').classList.contains('hidden'), 'error message');
  assert.match(text(bad, '#signinError'), /not on the teachers list/);
  assert.ok(bad.doc.getElementById('app').classList.contains('hidden'));
  bad.win.close();

  const page = await signedIn(w);
  assert.equal(text(page, '#whoEmail'), TEACHER);
  assert.match(text(page, '#examSelect'), /Test Exam \(EX1\)/);
  assert.equal(text(page, '#activePill'), 'Open to students');
  page.win.close();
});

test('attempts list shows score, grade and integrity summary; detail shows the timeline', async () => {
  const w = await setup();
  // Integrity evidence as the browser would have reported it: a tab leave
  // (first time: warning), the return, and a paste (fault at once).
  const events = [
    { seq: 0, t: w.clock.t - 600000, type: 'away' },
    { seq: 1, t: w.clock.t - 480000, type: 'back', ms: 125000, of: 'away' },
    { seq: 2, t: w.clock.t - 300000, type: 'paste', len: 340 },
  ];
  db(w).prepare('UPDATE attempts SET events = ?, faults = 1, warnings = 1, away_ms = 125000, paste_events = 1, ' +
                'paste_chars = 340, penalty = 1').run(JSON.stringify(events));

  const page = await signedIn(w);
  await until(() => $(page, '#attemptsTable tbody tr[data-id]'), 'attempts row');
  const row = text(page, '#attemptsTable tbody tr');
  assert.match(row, /Perez, Ana/);
  assert.match(row, /1 fault/);
  assert.match(row, /1 warning/);
  assert.match(row, /away 2:05/);
  assert.match(row, /paste x1/);

  $(page, '#attemptsTable tbody tr[data-id]').click();
  await until(() => $(page, '#backToList'), 'detail view');
  const detail = text(page, '#view');
  assert.match(detail, /Left the tab/);
  assert.match(detail, /Paste/);
  assert.match(detail, /340 chars/);
  assert.match(detail, /Rigid triangles\./);       // the student's own text
  page.win.close();
});

test('student text is shown as text, never as markup', async () => {
  const w = await setup({ firstName: '<img src=x onerror="window.__pwned=1">' });
  db(w).prepare('UPDATE attempts SET answers = ?, results = ?').run(
    JSON.stringify({ Q3: '<script>window.__pwned=1</script>' }),
    JSON.stringify({ Q3: { type: 'openEnded', score: 1, max: 6, text: 'Explain', answer: '<b>bold</b><img src=x onerror="window.__pwned=1">', feedback: '' } }));
  const page = await signedIn(w);
  await until(() => $(page, '#attemptsTable tbody tr[data-id]'), 'row');
  assert.equal($(page, '#attemptsTable img'), null);
  $(page, '#attemptsTable tbody tr[data-id]').click();
  await until(() => $(page, '#backToList'), 'detail');
  assert.equal($(page, '#view img'), null);
  assert.equal($(page, '#view b'), null);
  assert.match(text(page, '#view'), /<b>bold<\/b>/);       // visible as characters
  assert.equal(page.win.__pwned, undefined);
  page.win.close();
});

test('override: the score is saved, totals and grade are recomputed by the server', async () => {
  const w = await setup();
  db(w).prepare('UPDATE attempts SET penalty = 1').run();
  const page = await signedIn(w);
  await until(() => $(page, '#attemptsTable tbody tr[data-id]'), 'row');
  $(page, '#attemptsTable tbody tr[data-id]').click();
  await until(() => $(page, 'input.ovr'), 'override input');

  const input = $(page, 'input.ovr[data-qid="Q3"]');
  input.value = '3';
  input.parentElement.querySelector('button').click();
  await until(() => db(w).prepare('SELECT overrides FROM attempts').get().overrides !== '{}', 'override stored');

  const a = db(w).prepare('SELECT * FROM attempts').get();
  assert.deepEqual(JSON.parse(a.overrides), { Q3: 3 });
  assert.equal(a.open_score, 4);                        // short answer (1) + overridden open-ended (3)
  assert.equal(a.total_score, 2 + 1 + 3 - 1);          // mc + short + override - penalty
  await until(() => /overridden/.test(text(page, '#view')), 'detail reloaded');
  page.win.close();
});

test('deleting an attempt asks first and lets the student start again', async () => {
  const w = await setup();
  const page = await signedIn(w);
  await until(() => $(page, '#attemptsTable tbody tr[data-id]'), 'row');
  $(page, '#attemptsTable tbody tr[data-id]').click();
  await until(() => $(page, '#deleteAttempt'), 'delete button');
  $(page, '#deleteAttempt').click();
  await until(() => db(w).prepare('SELECT COUNT(*) AS n FROM attempts').get().n === 0, 'attempt deleted');
  page.win.close();
});

test('settings: saves boundaries and set cards; a malformed boundary is refused before any request', async () => {
  const w = await setup();
  const page = await signedIn(w);
  tab(page, 'settings');
  await until(() => $(page, '#sSave'), 'settings form');

  $(page, '#sTitle').value = 'Renamed exam';
  $(page, '#sDuration').value = '50';
  $(page, '.sBounds[data-set="A"]').value = '4.0:90, 3.0:60, 1.0:0';
  page.requests.length = 0;
  $(page, '#sSave').click();
  await until(() => db(w).prepare('SELECT title FROM exams').get().title === 'Renamed exam', 'settings saved');
  const e = db(w).prepare('SELECT * FROM exams').get();
  assert.equal(e.duration_min, 50);
  assert.deepEqual(JSON.parse(e.grade_boundaries).A, [
    { grade: '4.0', min: 90 }, { grade: '3.0', min: 60 }, { grade: '1.0', min: 0 }]);

  // Malformed: error on the page, no PUT sent.
  await until(() => $(page, '#sSave'), 'form re-rendered');
  $(page, '.sBounds[data-set="A"]').value = 'four:ninety';
  page.requests.length = 0;
  $(page, '#sSave').click();
  await sleep(100);
  assert.match(text(page, '#banner'), /not grade:minimum/);
  assert.equal(page.requests.filter((r) => r.method === 'PUT').length, 0);
  page.win.close();
});

test('settings: IGCSE switches sampling off, standard switches it on (independent options)', async () => {
  const w = await setup();
  const page = await signedIn(w);
  tab(page, 'settings');
  await until(() => $(page, '#sType'), 'settings');
  const type = $(page, '#sType');
  type.value = 'standard'; type.dispatchEvent(new page.win.Event('change'));
  assert.equal($(page, '#sQps').disabled, false);
  assert.equal($(page, '#sRandom').disabled, false);
  type.value = 'igcse'; type.dispatchEvent(new page.win.Event('change'));
  assert.equal($(page, '#sQps').disabled, true);
  page.win.close();
});

test('close and reopen the exam from the header', async () => {
  const w = await setup();
  const page = await signedIn(w);
  $(page, '#toggleActive').click();
  await until(() => db(w).prepare('SELECT active FROM exams').get().active === 0, 'closed');
  await until(() => text(page, '#activePill') === 'Closed', 'pill updated');
  $(page, '#toggleActive').click();
  await until(() => db(w).prepare('SELECT active FROM exams').get().active === 1, 'opened');
  page.win.close();
});

test('questions: edit keeps the attached image, add a short answer, delete it', async () => {
  const w = await setup();
  const hash = 'cd'.repeat(32);
  db(w).prepare("INSERT INTO images (hash, mime, size_bytes, uploaded_by, created_at) VALUES (?, 'image/png', 1, 't', 0)").run(hash);
  db(w).prepare("UPDATE questions SET image_hash = ? WHERE qid = 'Q1'").run(hash);

  const page = await signedIn(w);
  tab(page, 'questions');
  await until(() => $(page, '#questionsTable tbody tr[data-qid="Q1"]'), 'question list');

  // Edit Q1: change the text and the correct option (C).
  $(page, 'tr[data-qid="Q1"] button.edit').click();
  await until(() => $(page, '#qfSave'), 'form');
  assert.equal($(page, '#qfId').disabled, true);
  $(page, '#qfText').value = 'Pick C instead';
  page.doc.querySelectorAll('input[name="qfCorrect"]')[2].checked = true;
  $(page, '#qfSave').click();
  await until(() => db(w).prepare("SELECT text FROM questions WHERE qid = 'Q1'").get().text === 'Pick C instead', 'saved');
  const q1 = db(w).prepare("SELECT * FROM questions WHERE qid = 'Q1'").get();
  assert.equal(q1.correct_index, 2);
  assert.equal(q1.image_hash, hash);                    // not detached by the edit

  // Add a short-answer question.
  await until(() => $(page, '#addQuestion'), 'list again');
  $(page, '#addQuestion').click();
  await until(() => $(page, '#qfSave'), 'add form');
  $(page, '#qfId').value = 'Q9';
  const type = $(page, '#qfType'); type.value = 'short'; type.dispatchEvent(new page.win.Event('change'));
  $(page, '#qfText').value = 'Largest planet?';
  $(page, '#qfAccepted').value = 'Jupiter\n jupiter ';
  $(page, '#qfSave').click();
  await until(() => db(w).prepare("SELECT COUNT(*) AS n FROM questions WHERE qid = 'Q9'").get().n === 1, 'added');
  const q9 = db(w).prepare("SELECT * FROM questions WHERE qid = 'Q9'").get();
  assert.equal(q9.type, 'short');
  assert.deepEqual(JSON.parse(q9.accepted_answers), ['Jupiter', 'jupiter']);

  // Delete it.
  await until(() => $(page, 'tr[data-qid="Q9"] button.edit'), 'new row listed');
  $(page, 'tr[data-qid="Q9"] button.edit').click();
  await until(() => $(page, '#qfDelete'), 'delete button');
  $(page, '#qfDelete').click();
  await until(() => db(w).prepare("SELECT COUNT(*) AS n FROM questions WHERE qid = 'Q9'").get().n === 0, 'deleted');
  page.win.close();
});

test('a question the server rejects shows the server message and stays on the form', async () => {
  const w = await setup();
  const page = await signedIn(w);
  tab(page, 'questions');
  await until(() => $(page, '#addQuestion'), 'list');
  $(page, '#addQuestion').click();
  await until(() => $(page, '#qfSave'), 'form');
  $(page, '#qfId').value = 'Q8';
  $(page, '#qfText').value = 'No options given';           // multiple choice with empty options
  $(page, '#qfSave').click();
  await until(() => /4 non-empty options/.test(text(page, '#banner')), 'server message shown');
  assert.ok($(page, '#qfSave'));
  page.win.close();
});

test('tools: recalculate and regrade run to the end; the similarity report is computed by the queue', async () => {
  const w = await setup();
  const page = await signedIn(w);
  tab(page, 'tools');
  await until(() => $(page, '#recalc'), 'tools');

  $(page, '#recalc').click();
  await until(() => /Done\. 1 attempt/.test(text(page, '#recalcStatus')), 'recalculate done');
  $(page, '#regradeMc').click();
  await until(() => /Done\. 1 attempt/.test(text(page, '#regradeMcStatus')), 'regrade done');

  $(page, '#simRun').click();
  await until(() => w.sent.some((m) => m.type === 'similarity'), 'similarity job queued');
  await w.drainQueue();
  await until(() => /graded attempts compared/.test(text(page, '#simBox')), 'report rendered', 8000);
  assert.match(text(page, '#simBox'), /No pairs flagged/);
  page.win.close();
});

test('teachers: add and remove; a plain teacher does not see the tab', async () => {
  const w = await setup();
  const page = await signedIn(w);
  tab(page, 'teachers');
  await until(() => $(page, '#tAdd'), 'teachers view');
  $(page, '#tEmail').value = 'felipe.velasquez@marymount.edu.co';
  $(page, '#tAdd').click();
  await until(() => db(w).prepare('SELECT COUNT(*) AS n FROM teachers').get().n === 2, 'teacher added');
  await until(() => /felipe\.velasquez/.test(text(page, '#teachersTable')), 'list updated');
  page.win.close();

  seedTeacher(w, 'plain@marymount.edu.co', { role: 'teacher' });
  const plain = openPage(w);
  await signIn(w, plain, 'plain@marymount.edu.co');
  await until(() => plain.doc.getElementById('examSelect'), 'exam bar');
  assert.equal($(plain, '.tab[data-tab="teachers"]'), null);
  plain.win.close();
});

test('creating an exam: it is created closed and selected', async () => {
  const w = await setup();
  const page = await signedIn(w);
  $(page, '#newExamBtn').click();
  await until(() => $(page, '#neCreate'), 'new exam form');
  $(page, '#neId').value = 'G10_T2';
  $(page, '#neTitle').value = 'Grade 10 Term 2';
  $(page, '#neCreate').click();
  await until(() => db(w).prepare("SELECT COUNT(*) AS n FROM exams WHERE id = 'G10_T2'").get().n === 1, 'created');
  assert.equal(db(w).prepare("SELECT active FROM exams WHERE id = 'G10_T2'").get().active, 0);
  await until(() => text(page, '#activePill') === 'Closed', 'new exam selected and shown closed');
  page.win.close();
});

test('an ended session (revoked teacher) returns to the sign-in screen', async () => {
  const w = await setup();
  const page = await signedIn(w);
  db(w).prepare('DELETE FROM teachers').run();
  tab(page, 'tools');                                      // any admin call now gets 401
  tab(page, 'questions');
  await until(() => !page.doc.getElementById('signinCard').classList.contains('hidden'), 'back to sign-in');
  assert.match(text(page, '#signinError'), /session ended/i);
  page.win.close();
});

test('tools: resend emails says so when the relay is not configured, and queues them when it is', async () => {
  const w = await setup();
  const page = await signedIn(w);
  tab(page, 'tools');
  await until(() => $(page, '#mailResend'), 'tools');
  $(page, '#mailResend').click();
  await until(() => /not configured/.test(text(page, '#mailStatus')), 'not configured message');

  w.env.MAIL_RELAY_URL = 'https://relay.test/exec';
  $(page, '#mailResend').click();
  await until(() => /1 email\(s\) queued/.test(text(page, '#mailStatus')), 'queued message');
  assert.equal(db(w).prepare('SELECT email_status FROM attempts').get().email_status, 'pending');
  page.win.close();
});

test('questions: a figure is uploaded from the form, stored by hash, saved with the question and can be removed', async () => {
  const w = await setup();
  const page = await signedIn(w);
  tab(page, 'questions');
  await until(() => $(page, 'tr[data-qid="Q1"] button.edit'), 'list');
  $(page, 'tr[data-qid="Q1"] button.edit').click();
  await until(() => $(page, '#qfImageFile'), 'form');

  const png = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const input = $(page, '#qfImageFile');
  Object.defineProperty(input, 'files', { value: [new page.win.File([png], 'fig 1.png', { type: 'image/png' })] });
  input.dispatchEvent(new page.win.Event('change'));
  await until(() => /Image uploaded/.test(text(page, '#qfImageNote')), 'upload finished');
  const img = db(w).prepare('SELECT * FROM images').get();
  assert.equal(img.original_name, 'fig 1.png');
  assert.ok(w.env.FILES.objects.has('img/' + img.hash));

  $(page, '#qfSave').click();
  await until(() => db(w).prepare("SELECT image_hash FROM questions WHERE qid = 'Q1'").get().image_hash === img.hash, 'saved with image');

  // Reopen and remove it.
  await until(() => $(page, 'tr[data-qid="Q1"] button.edit'), 'list again');
  $(page, 'tr[data-qid="Q1"] button.edit').click();
  await until(() => $(page, '#qfImageRemove') && !$(page, '#qfImageRemove').classList.contains('hidden'), 'remove shown');
  $(page, '#qfImageRemove').click();
  $(page, '#qfSave').click();
  await until(() => db(w).prepare("SELECT image_hash FROM questions WHERE qid = 'Q1'").get().image_hash === null, 'image detached');
  page.win.close();
});

// ---------------------------------------------------------------------------
// Import from PDF
// ---------------------------------------------------------------------------

const FAKE_PDF = new TextEncoder().encode('%PDF-1.4\n% test\n%%EOF');
const pngVariant = (n) => {
  const base = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const out = new Uint8Array(base.length + 1); out.set(base); out[base.length] = n;   // different bytes, different hash
  return out;
};

/** jsdom has no way to choose files; define `files` on the input like a browser would expose it. */
function setFiles(page, input, files) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
}

test('import from PDF: read the paper, upload figures, read the scheme, review, import', async () => {
  const extracted = [
    { label: '3(a)', text: 'Fig. 3.1 shows a clock.\n\nState the type of motion of the pendulum.', type: 'short', points: 1, options: [], figure: 'Fig. 3.1' },
    { label: '9', text: 'Which unit is used for resistance?', type: 'mc', points: 1, options: ['volt', 'amp', 'ohm', 'watt'], figure: '' },
    { label: '11(a)', text: 'Fig. 11.1 shows a component.\n\nName it.', type: 'short', points: 1, options: [], figure: 'Fig. 11.1' },
    { label: '12', text: 'Describe how the transistor switches on a motor.', type: 'openEnded', points: 3, options: [], figure: '' },
  ];
  const w = await makeWorldFor(extracted);
  const page = await signedIn(w);
  tab(page, 'questions');
  await until(() => $(page, '#importPdf'), 'questions tab');
  $(page, '#importPdf').click();
  await until(() => $(page, '#impRead'), 'import screen');

  // 1. Figures first: three files, two of them for question 11.
  const win = page.win;
  setFiles(page, $(page, '#impFigures'), [
    new win.File([pngVariant(1)], 'G10_M2_Q3_clock.png', { type: 'image/png' }),
    new win.File([pngVariant(2)], 'G10_M2_Q11_thermistor.png', { type: 'image/png' }),
    new win.File([pngVariant(3)], 'G10_M2_Q11_potential_divider.png', { type: 'image/png' }),
  ]);
  $(page, '#impFigures').dispatchEvent(new win.Event('change'));
  await until(() => /Uploaded 3 of 3/.test(text(page, '#impFigStatus')), 'figures uploaded');
  assert.equal(db(w).prepare('SELECT COUNT(*) AS n FROM images').get().n, 3);

  // 2. Question paper.
  setFiles(page, $(page, '#impPaper'), [new win.File([FAKE_PDF], 'paper.pdf', { type: 'application/pdf' })]);
  $(page, '#impRead').click();
  await until(() => w.sent.some((m) => m.type === 'job'), 'extraction job queued');
  await w.drainQueue();
  await until(() => page.doc.querySelectorAll('#impReview .qcard').length === 4, 'review cards', 10000);
  assert.match(text(page, '#impStatus'), /Read 4 questions .* 4200 input, 900 output tokens/);

  const cards = [...page.doc.querySelectorAll('#impReview .qcard')];
  assert.equal(cards[0].querySelector('.rvId').value, 'Q3a');
  // Q3 has exactly one figure matching its number: suggested automatically.
  const clockHash = db(w).prepare("SELECT hash FROM images WHERE original_name = 'G10_M2_Q3_clock.png'").get().hash;
  assert.equal(cards[0].querySelector('.rvImage').value, clockHash);
  // Q11 has two: nothing is guessed, and the page says so.
  assert.equal(cards[2].querySelector('.rvImage').value, '');
  assert.match(cards[2].textContent, /2 figures match this question number/);
  // The paper alone cannot know the answer key: import is blocked until it is chosen.
  assert.match(text(page, '#impReview'), /1 multiple-choice question\(s\) have no correct answer/);

  // Choose the thermistor for Q11(a) by hand (the select re-renders the cards).
  const thermistor = db(w).prepare("SELECT hash FROM images WHERE original_name = 'G10_M2_Q11_thermistor.png'").get().hash;
  const sel = page.doc.querySelectorAll('#impReview .qcard')[2].querySelector('.rvImage');
  sel.value = thermistor; sel.dispatchEvent(new win.Event('change'));

  // 3. Marking scheme fills key, accepted answers and rubric.
  setFiles(page, $(page, '#impScheme'), [new win.File([FAKE_PDF], 'ms.pdf', { type: 'application/pdf' })]);
  $(page, '#impReadScheme').click();
  await until(() => w.sent.some((m) => m.type === 'job'), 'scheme job queued');
  await w.drainQueue();
  await until(() => /Filled 4 of 4/.test(text(page, '#impSchemeStatus')), 'scheme read', 10000);

  // 4. Import.
  $(page, '#impSave').click();
  await until(() => db(w).prepare("SELECT COUNT(*) AS n FROM questions WHERE qid LIKE 'Q%a' OR qid IN ('Q9','Q12')").get().n >= 4, 'questions saved');
  const rows = db(w).prepare("SELECT * FROM questions WHERE qid IN ('Q3a','Q9','Q11a','Q12') ORDER BY position").all();
  assert.deepEqual(rows.map((r) => r.qid), ['Q3a', 'Q9', 'Q11a', 'Q12']);          // paper order kept
  assert.equal(rows[0].image_hash, clockHash);
  assert.deepEqual(JSON.parse(rows[0].accepted_answers), ['pendulum swings', 'oscillation']);
  assert.equal(rows[1].correct_index, 2);                                           // "C" from the scheme -> index 2
  assert.equal(rows[2].image_hash, thermistor);
  assert.equal(rows[3].rubric, '1 mark base current, 1 mark switches transistor, 1 mark motor runs.');
  assert.equal(rows[0].section, 'Q3');
  page.win.close();
});

/** World whose fake model answers the two PDF tools. */
async function makeWorldFor(extracted) {
  const w = await makeWorld({ modelReply: (system) => {
    if (/extract exam questions/.test(system)) { return JSON.stringify(extracted); }
    return JSON.stringify({
      Q3a: { accepted: ['pendulum swings', 'oscillation'] },
      Q9: { correct: 'C' },
      Q11a: { accepted: ['thermistor'] },
      Q12: { rubric: '1 mark base current, 1 mark switches transistor, 1 mark motor runs.' },
    });
  } });
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  return w;
}

test('import from PDF: a PDF that cannot be read shows the reason and saves nothing', async () => {
  const w = await makeWorld({ modelReply: () => 'I could not read this.' });
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  const before = db(w).prepare('SELECT COUNT(*) AS n FROM questions').get().n;
  const page = await signedIn(w);
  tab(page, 'questions');
  await until(() => $(page, '#importPdf'), 'tab');
  $(page, '#importPdf').click();
  await until(() => $(page, '#impRead'), 'import screen');
  setFiles(page, $(page, '#impPaper'), [new page.win.File([FAKE_PDF], 'p.pdf', { type: 'application/pdf' })]);
  $(page, '#impRead').click();
  await until(() => w.sent.some((m) => m.type === 'job'), 'queued');
  await w.drainQueue();
  await until(() => /Failed: No questions could be read/.test(text(page, '#impStatus')), 'failure shown', 10000);
  assert.equal(db(w).prepare('SELECT COUNT(*) AS n FROM questions').get().n, before);
  page.win.close();
});

test('import review: picking a figure re-renders the cards but keeps the scroll position', async () => {
  const extracted = [
    { label: '11(a)', text: 'Fig. 11.1 shows a component.', type: 'short', points: 1, options: [], figure: 'Fig. 11.1' },
    { label: '12', text: 'Describe.', type: 'openEnded', points: 3, options: [], figure: '' },
  ];
  const w = await makeWorldFor(extracted);
  const page = await signedIn(w);
  tab(page, 'questions');
  await until(() => $(page, '#importPdf'), 'tab');
  $(page, '#importPdf').click();
  await until(() => $(page, '#impRead'), 'import screen');
  setFiles(page, $(page, '#impPaper'), [new page.win.File([FAKE_PDF], 'p.pdf', { type: 'application/pdf' })]);
  $(page, '#impRead').click();
  await until(() => w.sent.some((m) => m.type === 'job'), 'queued');
  await w.drainQueue();
  await until(() => page.doc.querySelectorAll('#impReview .qcard').length === 2, 'cards', 10000);

  page.doc.documentElement.scrollTop = 640;                  // the teacher has scrolled down
  const sel = $(page, '#impReview .qcard .rvImage');
  const first = [...sel.options].find((o) => o.value);
  if (first) { sel.value = first.value; } else { sel.value = ''; }
  sel.dispatchEvent(new page.win.Event('change'));
  assert.equal(page.doc.documentElement.scrollTop, 640);
  page.win.close();
});
