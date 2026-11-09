/**
 * analysis.test.js -- the Analysis tab (admin3.html) and its /results route.
 *
 * A class of 12 graded students is inserted directly into the database with scores
 * designed so every statistic has a known answer:
 *   Q1 (mc, 2 marks):   only the 4 best students get it right -> facility 33%, strong discrimination
 *   Q2 (short, 1 mark): everybody gets it right                 -> facility 100%, "Very easy"
 *   Q3 (open, 6 marks): scores 6,6,4,4,4,2,2,2,0,0,6,6 (spread shown); one of them is a teacher override
 * Plus one teacher-account attempt that must NOT be counted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeWorld, seedExam, seedTeacher } from './helpers.js';

const HTML = readFileSync(new URL('../../admin3.html', import.meta.url), 'utf8');
const BASE = 'https://examgrader-api.marymount-exams.workers.dev';
const TEACHER = 'andres.forero@marymount.edu.co';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) { return; } await sleep(30); }
  throw new Error('timed out waiting for: ' + what);
}

const Q3_SCORES = [6, 6, 4, 4, 4, 2, 2, 2, 0, 0, 6, 6];

async function world() {
  const w = await makeWorld();
  await seedExam(w);
  seedTeacher(w, TEACHER, { role: 'admin' });
  seedTeacher(w, 'felipe@marymount.edu.co', { role: 'teacher' });
  const db = w.env.DB.db;
  db.prepare("UPDATE questions SET topic = 'Mechanisms' WHERE qid IN ('Q1','Q2')").run();
  db.prepare("UPDATE questions SET topic = 'Design' WHERE qid = 'Q3'").run();
  const insert = db.prepare(
    'INSERT INTO attempts (id, exam_id, set_id, email, first_name, last_name, class, started_at, deadline_at, paper, status, ' +
    "submitted_at, results, overrides, penalty, total_score, max_score, percentage, final_grade, graded_at) " +
    "VALUES (?, 'EX1', 'A', ?, ?, ?, ?, 0, 1, ?, 'graded', 1, ?, ?, ?, ?, 9, ?, ?, 1)");
  const rows = [];
  Q3_SCORES.forEach((q3, i) => {
    const q1right = i < 4;                               // students 0-3 are the best
    const q1 = q1right ? 2 : 0;
    const total = q1 + 1 + q3;
    const pct = Math.round((total / 9) * 100);
    const grade = pct >= 90 ? '4.0' : pct >= 80 ? '3.7' : pct >= 70 ? '3.3' : pct >= 60 ? '3.0' : pct >= 50 ? '2.7' : pct >= 40 ? '2.3' : pct >= 30 ? '2.0' : '1.0';
    const results = {
      Q1: { type: 'mc', score: q1, max: 2, correct: q1right, selected: q1right ? 'b' : 'a', correctText: 'b' },
      Q2: { type: 'short', score: 1, max: 1, answer: 'Paris', accepted: 'Paris' },
      Q3: { type: 'openEnded', score: q3 === 6 && i === 11 ? 3 : q3, max: 6, feedback: 'x' },
    };
    // Student 11's open answer was marked 3 by the model and raised to 6 by the teacher.
    const overrides = i === 11 ? { Q3: 6 } : {};
    insert.run('att-' + String(i).padStart(2, '0'), `s${i}@marymount.edu.co`, 'Stu' + i, 'Dent' + i, i % 2 ? '10B' : '10A',
               JSON.stringify({ qids: ['Q1', 'Q2', 'Q3'] }), JSON.stringify(results), JSON.stringify(overrides),
               0, total, pct, grade);
    rows.push(total);
  });
  // A teacher's own test attempt: must be ignored.
  insert.run('att-teacher', 'felipe@marymount.edu.co', 'Felipe', 'Test', '10A', JSON.stringify({ qids: ['Q1', 'Q2', 'Q3'] }),
             JSON.stringify({ Q1: { type: 'mc', score: 0, max: 2, selected: 'c' }, Q2: { type: 'short', score: 0, max: 1, answer: 'x' },
                             Q3: { type: 'openEnded', score: 0, max: 6 } }), '{}', 0, 0, 0, '1.0');
  return w;
}

function openPage(w) {
  const requests = [];
  const dom = new JSDOM(HTML, {
    url: 'https://workwebsitesmixed.github.io/exam-grader/admin3.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.confirm = () => true;
      window.Date.now = () => w.clock.t;
      window.__gsi = {};
      window.google = { accounts: { id: { initialize(cfg) { window.__gsi.cb = cfg.callback; }, renderButton() {}, disableAutoSelect() {} } } };
      window.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), method: init.method || 'GET' });
        return w.app.fetch(new Request(String(url), { ...init, headers: { ...(init.headers || {}), Origin: 'https://workwebsitesmixed.github.io' } }), w.env);
      };
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, requests };
}
async function signedIn(w) {
  const page = openPage(w);
  await until(() => page.win.__gsi.cb, 'sign-in');
  page.win.__gsi.cb({ credential: await w.google.token({ email: TEACHER }) });
  await until(() => page.doc.getElementById('examSelect'), 'exam bar');
  return page;
}
const $ = (page, sel) => page.doc.querySelector(sel);

test('/results returns graded student attempts only, 25 per page, behind the admin session', async () => {
  const w = await world();
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  const auth = { Authorization: 'Bearer ' + login.json.session };
  assert.equal((await w.call('GET', '/api/admin/exams/EX1/results')).status, 401);
  const r = await w.call('GET', '/api/admin/exams/EX1/results', { headers: auth });
  assert.equal(r.json.attempts.length, 12);                        // the teacher's attempt is left out
  assert.equal(r.json.nextAfterId, null);
  const a = r.json.attempts[11];
  assert.equal(a.items.find((i) => i.qid === 'Q3').score, 6);      // the override is applied
  assert.equal(a.items.find((i) => i.qid === 'Q3').overridden, true);
  assert.equal(a.level, ['', 'Approaching', 'Meeting', 'Exceeding', 'Excelling'][Math.floor(Number(a.finalGrade))]);
  assert.equal((await w.call('GET', '/api/admin/exams/NOPE/results', { headers: auth })).status, 404);
});

test('Analysis tab: summary, facility, discrimination, flags, topics, wrong answers and CSV', async () => {
  const w = await world();
  const page = await signedIn(w);
  $(page, '.tab[data-tab="analysis"]').click();
  await until(() => $(page, '#anQuestions'), 'analysis tables');

  assert.equal($(page, '#anN').textContent, '12');
  const rowOf = (qid) => [...$(page, '#anQuestions').querySelectorAll('tbody tr')].find((r) => r.dataset.qid === qid);
  const cells = (qid) => [...rowOf(qid).children].map((c) => c.textContent);

  // Q1: 4 of 12 right = 8/24 marks = 33%; the top 3 all right, the bottom 3 all wrong -> discrimination 1.00.
  const q1 = cells('Q1');
  assert.equal(q1[6], '33%');
  assert.equal(q1[7], '1.00');
  // Q2: everybody right -> 100%, discrimination 0, flagged very easy and weak.
  const q2 = cells('Q2');
  assert.equal(q2[6], '100%');
  assert.match(q2[9], /Very easy/);
  assert.match(q2[9], /Weak discrimination/);
  // Q3: marks 6,6,4,4,4,2,2,2,0,0,6,6 -> 42/72 = 58%; one teacher override counted.
  const q3 = cells('Q3');
  assert.equal(q3[6], '58%');
  assert.match(q3[8], /1 \(8%\)/);

  // Topics: Mechanisms = Q1+Q2 = (8+12)/(24+12) = 56%; Design = Q3 = 58%.
  const topics = [...$(page, '#anTopics').querySelectorAll('tbody tr')].map((r) => r.textContent);
  assert.ok(topics.some((t) => /Mechanisms.*56%/.test(t)), topics.join(' | '));
  assert.ok(topics.some((t) => /Design.*58%/.test(t)), topics.join(' | '));

  // Wrong answers: 8 students chose option 'a' on Q1; open-ended shows its spread.
  const detail = $(page, '.qcard[data-qid="Q1"]').textContent;
  assert.match(detail, /8×.*a/);
  assert.match($(page, '.qcard[data-qid="Q3"]').textContent, /0 marks: 2.*6 marks: 4/);

  // Classes: 10A and 10B both listed, 6 students each.
  const classes = [...$(page, '#anClasses').querySelectorAll('tbody tr')].map((r) => r.textContent);
  assert.ok(classes.some((c) => /^10A6/.test(c)) && classes.some((c) => /^10B6/.test(c)), classes.join(' | '));
  page.win.close();
});

test('Analysis tab: a topic edited in the question form is saved and survives an edit that omits it', async () => {
  const w = await world();
  const login = await w.call('POST', '/api/admin/login', { body: { idToken: await w.google.token({ email: TEACHER }) } });
  const auth = { Authorization: 'Bearer ' + login.json.session };
  // An older client that does not send `topic` must not wipe it.
  const q = { set: 'A', id: 'Q2', type: 'short', points: 1, text: 'Capital of France?', accepted: ['Paris'], position: 2 };
  assert.equal((await w.call('PUT', '/api/admin/exams/EX1/questions/A/Q2', { headers: auth, body: q })).json.success, true);
  assert.equal(w.env.DB.db.prepare("SELECT topic FROM questions WHERE qid = 'Q2'").get().topic, 'Mechanisms');
  await w.call('PUT', '/api/admin/exams/EX1/questions/A/Q2', { headers: auth, body: { ...q, topic: 'Geography' } });
  assert.equal(w.env.DB.db.prepare("SELECT topic FROM questions WHERE qid = 'Q2'").get().topic, 'Geography');
});

test('CSV neutralises formulas in student answers', async () => {
  const w = await world();
  w.env.DB.db.prepare("UPDATE attempts SET results = replace(results, '\"selected\":\"a\"', '\"selected\":\"=HYPERLINK(1)\"') WHERE id = 'att-11'").run();
  const page = await signedIn(w);
  let csv = '';
  page.win.URL.createObjectURL = (blob) => { blob.text().then((t) => { csv = t; }); return 'blob:x'; };
  page.win.URL.revokeObjectURL = () => {};
  $(page, '.tab[data-tab="analysis"]').click();
  await until(() => $(page, '#anCsv'), 'csv button');
  $(page, '#anCsv').click();
  await until(() => csv, 'csv');
  assert.match(csv, /^attempt,class,email/);
  assert.ok(csv.includes("'=HYPERLINK(1)"), 'formula text must be prefixed');
  assert.ok(!/,=HYPERLINK/.test(csv));
  assert.equal(csv.split('\n').length, 1 + 12 * 3);
  page.win.close();
});

test('Analysis tab: the class filter defaults to all classes and recomputes every table, the CSV included', async () => {
  const w = await world();
  const page = await signedIn(w);
  $(page, '.tab[data-tab="analysis"]').click();
  await until(() => $(page, '#anClassFilter'), 'filter');
  const sel = $(page, '#anClassFilter');
  assert.equal(sel.value, '');                                              // default: every class
  assert.equal($(page, '#anN').textContent, '12');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['All classes (12)', '10A (6)', '10B (6)']);

  sel.value = '10A';
  sel.dispatchEvent(new page.win.Event('change'));
  await until(() => $(page, '#anN').textContent === '6', 'filtered to 10A');
  const cells = (qid) => [...[...$(page, '#anQuestions').querySelectorAll('tbody tr')].find((r) => r.dataset.qid === qid).children].map((c) => c.textContent);
  // 10A = students 0,2,4,6,8,10: Q1 right for 0 and 2 -> 4/12 = 33%; Q3 = 6+4+4+2+0+6 = 22/36 = 61%.
  assert.equal(cells('Q1')[5], '6');
  assert.equal(cells('Q1')[6], '33%');
  assert.equal(cells('Q3')[6], '61%');
  assert.doesNotMatch(cells('Q2')[9], /Very easy/);                         // 6 attempts: below the minimum for flags
  const classes = [...$(page, '#anClasses').querySelectorAll('tbody tr')].map((r) => r.textContent);
  assert.equal(classes.length, 1);

  // The filter survives a re-render and goes into the CSV.
  let csv = '';
  page.win.URL.createObjectURL = (blob) => { blob.text().then((t) => { csv = t; }); return 'blob:x'; };
  page.win.URL.revokeObjectURL = () => {};
  $(page, '#anCsv').click();
  await until(() => csv, 'csv');
  assert.equal(csv.split('\n').length, 1 + 6 * 3);
  assert.ok(!/,10B,/.test(csv));

  sel.value = '';
  sel.dispatchEvent(new page.win.Event('change'));
  await until(() => $(page, '#anN').textContent === '12', 'back to all classes');
  page.win.close();
});
