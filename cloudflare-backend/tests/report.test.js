/** report.test.js -- the text report printed by tools/integrity-report.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReport } from '../tools/integrity-report.mjs';

const attempt = (over) => ({ id: 'x', email: 'x@m.co', first_name: 'Ana', last_name: 'Perez', class: '11A', set_id: 'B',
  status: 'graded', total_score: 50, max_score: 57, events: '[]', answers: '{}', paper: '{"qids":[]}', ...over });

test('report lists every student and the timeline of those with events', () => {
  const events = JSON.stringify([
    { seq: 0, t: Date.UTC(2026, 9, 12, 15, 0, 0), type: 'away' },
    { seq: 1, t: Date.UTC(2026, 9, 12, 15, 0, 40), type: 'back', ms: 40000, of: 'away' },
    { seq: 2, t: Date.UTC(2026, 9, 12, 15, 5, 0), type: 'paste', len: 300 },
  ]);
  const text = formatReport('EX1', [attempt({ events }), attempt({ id: 'y', first_name: 'Bea', last_name: 'Gomez' })], []);
  assert.match(text, /Perez, Ana\s+11A\s+B\s+graded\s+50\/57\s+1\s+1\s+1\s+0:40\s+1 \(300\)/);
  assert.match(text, /warning\s+left the tab/);
  assert.match(text, /FAULT\s+paste \(300 chars\)/);
  assert.match(text, /Gomez, Bea/);
  assert.match(text, /\(no pairs flagged\)/);
});

test('an exam with no events says so', () => {
  assert.match(formatReport('EX1', [attempt({})], []), /TIMELINES[\s\S]*\(none\)/);
});
