/**
 * integrity.test.js -- the integrity rules as pure functions, and the server
 * side of enforcement (forced submit, replay safety, tampering).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvents, sanitizeEvents, mergeEvents, withLegacySwitches, FAULT_POINTS } from '../src/integrity.js';
import { makeWorld, seedExam } from './helpers.js';

const ev = (seq, type, extra = {}) => ({ seq, t: 1000 + seq, type, ...extra });

test('first tab leave is a warning, the second is a fault worth one point', () => {
  const a = assessEvents([ev(0, 'away'), ev(1, 'back', { ms: 5000, of: 'away' }), ev(2, 'away')]);
  assert.equal(a.warnings, 1);
  assert.equal(a.faults, 1);
  assert.equal(a.penalty, FAULT_POINTS);
  assert.equal(a.awayMs, 5000);
});

test('copy, cut, paste and drop are faults at once, with no warning', () => {
  const a = assessEvents([ev(0, 'paste', { len: 40 }), ev(1, 'copy'), ev(2, 'drop', { len: 10 })]);
  assert.equal(a.warnings, 0);
  assert.equal(a.faults, 3);
  assert.equal(a.autoSubmit, true);
  assert.equal(a.pasteEvents, 2);
  assert.equal(a.pasteChars, 50);
});

test('each warning category has its own first warning; unfocus and resize share one', () => {
  const a = assessEvents([ev(0, 'away'), ev(1, 'contextmenu'), ev(2, 'unfocus'), ev(3, 'resize')]);
  assert.equal(a.warnings, 3);          // tab, menu, window
  assert.equal(a.faults, 1);            // the resize is the second "window" event
});

test('warnings never count towards the limit of three faults', () => {
  const warnings = assessEvents([ev(0, 'away'), ev(1, 'contextmenu'), ev(2, 'unfocus')]);
  assert.equal(warnings.faults, 0);
  assert.equal(warnings.autoSubmit, false);
  const third = assessEvents([...warnings.events, ev(3, 'away'), ev(4, 'contextmenu'), ev(5, 'unfocus')]);
  assert.equal(third.faults, 3);
  assert.equal(third.autoSubmit, true);
  assert.equal(third.penalty, 3 * FAULT_POINTS);
});

test('penalty is capped at the faults needed to submit, even if more events arrive', () => {
  const a = assessEvents(Array.from({ length: 10 }, (_, i) => ev(i, 'paste', { len: 1 })));
  assert.equal(a.faults, 10);
  assert.equal(a.penalty, 3 * FAULT_POINTS);
});

test('sanitizeEvents drops unknown types and clamps numbers', () => {
  const clean = sanitizeEvents([
    { seq: 0, t: 5, type: 'paste', len: 999999999 },
    { seq: 1, t: 6, type: 'evil' },
    { seq: -1, t: 7, type: 'away' },
    { seq: 2, t: 8, type: 'back', ms: -50, of: 'away' },
    'junk', null,
  ]);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].len, 100000);
  assert.equal(clean[1].ms, 0);
  assert.deepEqual(sanitizeEvents('not an array'), []);
});

test('mergeEvents ignores events it already has, so a retry cannot double count', () => {
  const stored = [ev(0, 'away'), ev(1, 'paste', { len: 5 })];
  const merged = mergeEvents(stored, [ev(1, 'paste', { len: 5 }), ev(2, 'copy')]);
  assert.deepEqual(merged.map((e) => e.seq), [0, 1, 2]);
  assert.equal(mergeEvents(merged, [ev(0, 'away'), ev(2, 'copy')]).length, 3);
});

test('legacy switch counts become away events without duplicating existing ones', () => {
  const out = withLegacySwitches([ev(0, 'away')], 3, 99);
  assert.equal(out.filter((e) => e.type === 'away').length, 3);
});

// ---- server enforcement ------------------------------------------------------

const STUDENT = 'ana.perez@marymount.edu.co';
async function started() {
  const w = await makeWorld();
  await seedExam(w);
  const s = await w.call('POST', '/api/start', { body: { idToken: await w.google.token({ email: STUDENT }), exam: 'EX1', set: 'A', firstName: 'Ana', lastName: 'P' } });
  return { w, id: s.json.attemptId, s };
}
const row = (w) => w.env.DB.db.prepare('SELECT * FROM attempts').get();

test('three faults reported in one save: the SERVER submits the exam and grades it with the penalty', async () => {
  const { w, id } = await started();
  const r = await w.call('POST', '/api/save', { body: { attemptId: id, answers: { Q1: 1 },
    events: [ev(0, 'paste', { len: 30 }), ev(1, 'paste', { len: 30 }), ev(2, 'copy')] } });
  assert.equal(r.json.autoSubmitted, true);
  assert.equal(row(w).status, 'submitted');
  assert.equal(w.sent.length, 1);

  // The page, still open, cannot keep working.
  const again = await w.call('POST', '/api/save', { body: { attemptId: id, answers: { Q1: 0 } } });
  assert.equal(again.json.code, 'already_submitted');

  await w.drainQueue();
  assert.equal(row(w).penalty, 3 * FAULT_POINTS);
  assert.equal(row(w).faults, 3);
  assert.equal(row(w).paste_events, 2);
  assert.equal(row(w).paste_chars, 60);
});

test('events are evidence: a later request that omits them cannot erase them', async () => {
  const { w, id } = await started();
  await w.call('POST', '/api/save', { body: { attemptId: id, answers: {}, events: [ev(0, 'away'), ev(1, 'paste', { len: 9 })] } });
  await w.call('POST', '/api/save', { body: { attemptId: id, answers: {}, events: [] } });
  await w.call('POST', '/api/submit', { body: { attemptId: id, answers: {} } });
  assert.equal(row(w).faults, 1);
  assert.equal(row(w).warnings, 1);
  assert.equal(JSON.parse(row(w).events).length, 2);
});

test('re-sending the same batch does not double count', async () => {
  const { w, id } = await started();
  const batch = [ev(0, 'paste', { len: 4 })];
  await w.call('POST', '/api/save', { body: { attemptId: id, answers: {}, events: batch } });
  await w.call('POST', '/api/save', { body: { attemptId: id, answers: {}, events: batch } });
  assert.equal(row(w).faults, 1);
});

test('resume returns the integrity state so the page continues the same strikes', async () => {
  const { w, id } = await started();
  await w.call('POST', '/api/save', { body: { attemptId: id, answers: {}, events: [ev(0, 'away'), ev(1, 'paste', { len: 3 })] } });
  const again = await w.call('POST', '/api/start', { body: { idToken: await w.google.token({ email: STUDENT }), exam: 'EX1', set: 'A', firstName: 'Ana', lastName: 'P' } });
  assert.equal(again.json.integrity.faults, 1);
  assert.equal(again.json.integrity.warnings, 1);
  assert.equal(again.json.integrity.seen.tab, true);
  assert.equal(again.json.integrity.eventsCount, 2);
});
