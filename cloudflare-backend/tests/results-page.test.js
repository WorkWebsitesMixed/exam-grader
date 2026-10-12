/**
 * results-page.test.js -- the real results.html in jsdom against the real Worker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeWorld, seedExam } from './helpers.js';

const HTML = readFileSync(new URL('../../results.html', import.meta.url), 'utf8');
const BASE = 'https://examgrader-api.test.workers.dev';
const STUDENT = 'ana.perez@marymount.edu.co';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) { return; } await sleep(40); }
  throw new Error('timed out waiting for: ' + what);
}

function openPage(w, search) {
  const requests = [];
  const dom = new JSDOM(HTML, {
    url: 'https://workwebsitesmixed.github.io/exam-grader/results.html' + search,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.__gsi = {};
      window.google = { accounts: { id: { initialize(cfg) { window.__gsi.cb = cfg.callback; }, renderButton() {} } } };
      window.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), method: init.method || 'GET', body: init.body });
        if (!String(url).startsWith(BASE)) { return new Response('{"success":false}', { status: 502 }); }
        return w.app.fetch(new Request(String(url), { ...init, headers: { Origin: 'https://workwebsitesmixed.github.io' } }), w.env);
      };
    },
  });
  return { win: dom.window, doc: dom.window.document, requests };
}

async function gradedAttempt(w) {
  await seedExam(w, { exam: { exam_type: 'standard', duration_min: 45 } });
  const s = await w.call('POST', '/api/start', { body: { idToken: await w.google.token({ email: STUDENT }), exam: 'EX1', set: 'A', firstName: 'Ana', lastName: 'Pérez', class: '10A' } });
  await w.call('POST', '/api/submit', { body: { attemptId: s.json.attemptId, answers: { Q1: 1, Q2: 'paris', Q3: 'Triangles are rigid.' } } });
  await w.drainQueue();
}

test('graded exam appears with grade, scores and per-question detail once the deadline has passed', async () => {
  const w = await makeWorld();
  await gradedAttempt(w);
  w.clock.t += 46 * 60 * 1000;
  const page = openPage(w, `?src=${BASE}`);
  await until(() => page.win.__gsi.cb, 'sign-in init');
  page.win.__gsi.cb({ credential: await w.google.token({ email: STUDENT, given_name: 'Ana', family_name: 'Pérez' }) });
  await until(() => page.doc.getElementById('resultsScreen').style.display === 'block', 'results screen');

  assert.equal(page.requests[0].url, `${BASE}/api/myresults`);
  assert.match(page.doc.getElementById('studentName').textContent, /Pérez, Ana/);
  assert.equal(page.doc.querySelectorAll('.submission-card').length, 1);
  assert.equal(page.doc.querySelectorAll('.question-block').length, 3);
  assert.match(page.doc.querySelector('.score-strip').textContent, /9 \/ 9 pts/);
  page.win.close();
});

test('before the deadline nothing is shown and the page explains when results appear', async () => {
  const w = await makeWorld();
  await gradedAttempt(w);          // clock still inside the 45 minutes
  const page = openPage(w, `?src=${BASE}`);
  await until(() => page.win.__gsi.cb, 'sign-in init');
  page.win.__gsi.cb({ credential: await w.google.token({ email: STUDENT, given_name: 'Ana', family_name: 'Pérez' }) });
  await until(() => page.doc.getElementById('emptyScreen').style.display === 'block', 'empty screen');
  assert.match(page.doc.getElementById('emptyMsg').textContent, /exam time has ended/);
  page.win.close();
});

test('the OLD Apps Script link still posts the old action to the exec URL', async () => {
  const w = await makeWorld();
  const page = openPage(w, '?src=https://script.google.com/macros/s/AKfycbyOLD/exec');
  await until(() => page.win.__gsi.cb, 'sign-in init');
  page.win.__gsi.cb({ credential: await w.google.token({ email: STUDENT, given_name: 'Ana', family_name: 'Pérez' }) });
  await until(() => page.requests.length > 0, 'request');
  assert.equal(page.requests[0].url, 'https://script.google.com/macros/s/AKfycbyOLD/exec');
  assert.equal(JSON.parse(page.requests[0].body).action, 'myresults');
  page.win.close();
});
