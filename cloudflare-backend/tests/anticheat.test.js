/**
 * anticheat.test.js -- the integrity rules exercised through the REAL
 * grader.html: the student sees the right warning or penalty at the right
 * moment, blocked actions are blocked, the server ends up with the same
 * numbers, and the third penalty closes the exam.
 *
 * Browser events are simulated the way the browser raises them
 * (visibilitychange, blur, resize, contextmenu, copy, paste).
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

async function setup() {
  const w = await makeWorld();
  await seedExam(w, { exam: { exam_type: 'standard', duration_min: 45 }, questions: [
    { set: 'A', id: 'Q1', type: 'mc', points: 10, text: 'Pick B', options: ['a', 'b', 'c', 'd'], correctIndex: 1 },
    { set: 'A', id: 'Q2', type: 'openEnded', points: 5, text: 'Explain.', rubric: 'r' },
  ] });
  w.env.DB.db.prepare("UPDATE exams SET class_options = '[\"10A\"]' WHERE id = 'EX1'").run();
  return w;
}

function openPage(w) {
  const dom = new JSDOM(HTML, {
    url: `https://workwebsitesmixed.github.io/exam-grader/grader.html?src=${BASE}&exam=EX1`,
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.alert = () => {};
      window.Date.now = () => w.clock.t;
      window.__gsi = {};
      window.google = { accounts: { id: { initialize(cfg) { window.__gsi.cb = cfg.callback; }, renderButton() {} } } };
      window.fetch = async (url, init = {}) => w.app.fetch(
        new Request(String(url), { ...init, headers: { Origin: 'https://workwebsitesmixed.github.io' } }), w.env);
    },
  });
  return { win: dom.window, doc: dom.window.document };
}

async function begin(w) {
  const page = openPage(w);
  await until(() => page.win.__gsi.cb, 'sign-in init');
  page.win.__gsi.cb({ credential: await w.google.token({ email: STUDENT, given_name: 'Ana', family_name: 'Pérez' }) });
  await until(() => page.doc.getElementById('studentInfoScreen').classList.contains('active'), 'info screen');
  page.doc.getElementById('studentClass').value = '10A';
  page.win.startExam();
  await until(() => page.doc.getElementById('examContainer').classList.contains('active'), 'exam');
  return page;
}

const row = (w) => w.env.DB.db.prepare('SELECT * FROM attempts').get();
const modalText = (p) => p.doc.getElementById('warningText').textContent;
const closeModal = (p) => p.doc.getElementById('warningModal').classList.remove('active');

function leaveTab(page) {
  Object.defineProperty(page.doc, 'hidden', { value: true, configurable: true });
  page.doc.dispatchEvent(new page.win.Event('visibilitychange'));
  Object.defineProperty(page.doc, 'hidden', { value: false, configurable: true });
  page.doc.dispatchEvent(new page.win.Event('visibilitychange'));
}
function rightClick(page) {
  const e = new page.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  page.doc.querySelector('.question-card').dispatchEvent(e);
  return e;
}
function clip(page, type, text = '') {
  const e = new page.win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, type === 'drop' ? 'dataTransfer' : 'clipboardData', { value: { getData: () => text } });
  (page.doc.querySelector('textarea') || page.doc.body).dispatchEvent(e);
  return e;
}

test('leaving the tab: first time only a warning, no points', async () => {
  const w = await setup();
  const page = await begin(w);
  leaveTab(page);
  assert.match(modalText(page), /Warning.*no penalty/s);
  assert.match(page.doc.getElementById('integrityBadge').textContent, /Warnings: 1 .* Penalties: 0\/3/);
  await until(() => row(w).warnings === 1, 'warning stored');
  assert.equal(row(w).faults, 0);
  assert.equal(row(w).penalty, 0);
  page.win.close();
});

test('leaving the tab again: a penalty of one point', async () => {
  const w = await setup();
  const page = await begin(w);
  page.doc.querySelector('input[name="Q1"]');
  [...page.doc.querySelectorAll('input[name="Q1"]')].find((r) => r.parentElement.textContent.includes('. b')).click();
  leaveTab(page); closeModal(page);
  leaveTab(page);
  assert.match(modalText(page), /Penalty: -1 point.*1 of 3/s);
  await until(() => row(w).faults === 1, 'fault stored');
  page.win.confirmSubmit();
  await until(() => row(w).status === 'submitted', 'submitted');
  await w.drainQueue();
  assert.equal(row(w).penalty, 1);
  assert.equal(row(w).total_score, 9);   // 10 for the right MC answer - 1
  page.win.close();
});

test('paste is blocked and is a penalty at once, with the pasted size recorded', async () => {
  const w = await setup();
  const page = await begin(w);
  const e = clip(page, 'paste', 'x'.repeat(120));
  assert.equal(e.defaultPrevented, true);
  assert.match(modalText(page), /Penalty: -1 point.*Pasting text/s);
  await until(() => row(w).paste_events === 1, 'paste stored');
  assert.equal(row(w).paste_chars, 120);
  assert.equal(row(w).faults, 1);
  page.win.close();
});

test('copy, cut and drag-drop are blocked and penalised too', async () => {
  const w = await setup();
  const page = await begin(w);
  assert.equal(clip(page, 'copy').defaultPrevented, true);
  closeModal(page);
  assert.equal(clip(page, 'cut').defaultPrevented, true);
  await until(() => row(w).faults === 2, 'two faults stored');
  page.win.close();
});

test('right-click: first a warning, then a penalty; the menu is blocked both times', async () => {
  const w = await setup();
  const page = await begin(w);
  assert.equal(rightClick(page).defaultPrevented, true);
  assert.match(modalText(page), /Warning.*Right-click/s);
  closeModal(page);
  assert.equal(rightClick(page).defaultPrevented, true);
  assert.match(modalText(page), /Penalty/);
  await until(() => row(w).faults === 1 && row(w).warnings === 1, 'stored');
  page.win.close();
});

test('warnings do not count: two warnings and two penalties leave the exam open, the third penalty submits it', async () => {
  const w = await setup();
  const page = await begin(w);
  leaveTab(page); closeModal(page);          // warning (tab)
  rightClick(page); closeModal(page);        // warning (menu)
  clip(page, 'paste', 'a'); closeModal(page);   // fault 1
  clip(page, 'paste', 'b'); closeModal(page);   // fault 2
  assert.ok(page.doc.getElementById('examContainer').classList.contains('active'), 'still open after 2 faults');
  clip(page, 'paste', 'c');                  // fault 3
  await until(() => page.doc.getElementById('waitingScreen').classList.contains('active'), 'waiting screen');
  await until(() => row(w).status === 'submitted', 'server marked submitted');
  assert.equal(row(w).faults, 3);
  await w.drainQueue();
  assert.equal(row(w).penalty, 3);
  page.win.close();
});

test('losing focus to another window, or thinking for minutes without typing, is NOT an event', async () => {
  const w = await setup();
  const page = await begin(w);
  page.doc.hasFocus = () => false;
  page.win.dispatchEvent(new page.win.Event('blur'));
  await sleep(2500);                       // longer than the old 2-second rule
  assert.equal(page.doc.getElementById('warningModal').classList.contains('active'), false);
  w.clock.t += 5 * 60 * 1000;              // five quiet minutes
  page.win.autosaveNow(true);
  await sleep(300);
  assert.equal(row(w).faults, 0);
  assert.equal(row(w).warnings, 0);
  page.win.close();
});

test('shrinking the window below 75% of the screen width counts as a split screen', async () => {
  const w = await setup();
  const page = await begin(w);
  Object.defineProperty(page.win.screen, 'availWidth', { value: 1920, configurable: true });
  Object.defineProperty(page.win, 'outerWidth', { value: 960, configurable: true });
  page.win.dispatchEvent(new page.win.Event('resize'));
  assert.match(modalText(page), /Warning.*shrunk/s);
  page.win.close();
});

test('reloading keeps the strikes AND the first-warning flags', async () => {
  const w = await setup();
  const first = await begin(w);
  leaveTab(first);                                   // warning
  await until(() => row(w).warnings === 1, 'stored');
  first.win.close();

  const second = await begin(w);
  assert.match(second.doc.getElementById('integrityBadge').textContent, /Warnings: 1/);
  leaveTab(second);                                  // would be a new warning in the old system; now a fault
  assert.match(modalText(second), /Penalty/);
  await until(() => row(w).faults === 1, 'fault stored');
  second.win.close();
});

test('a typed answer is not an event, and a large non-paste jump is only evidence', async () => {
  const w = await setup();
  const page = await begin(w);
  const ta = page.doc.querySelector('textarea');
  ta.dispatchEvent(new page.win.Event('focusin', { bubbles: true }));
  ta.value = 'normal typing';
  ta.dispatchEvent(new page.win.Event('input', { bubbles: true }));
  ta.value = 'z'.repeat(300);
  ta.dispatchEvent(new page.win.Event('input', { bubbles: true }));
  await until(() => JSON.parse(row(w).events).some((e) => e.type === 'bulk_input'), 'evidence stored');
  assert.equal(row(w).faults, 0);
  assert.equal(row(w).penalty, 0);
  page.win.close();
});
