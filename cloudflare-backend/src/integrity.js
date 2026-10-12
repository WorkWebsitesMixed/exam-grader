/**
 * integrity.js -- the anti-cheating rules, evaluated on the SERVER.
 *
 * Role: the browser reports what it saw as a list of EVENTS (left the tab,
 * lost focus, right-click, copy, paste...). This module decides, from that list
 * alone, which events were warnings, which were faults, how many points they
 * cost and whether the exam must be submitted. Nothing the browser says about
 * penalties is trusted; it can only lie by omission, and every event it does
 * send is kept as evidence for the teacher.
 *
 * Rules (decided with the teacher, 2026-10-12):
 *   - Copy, cut, paste, drag-drop of text: always a FAULT (no warning).
 *   - Leaving the tab / minimising:       first time a WARNING, then faults.
 *   - Window split, overlay or second
 *     screen (focus lost, window shrunk): first time a WARNING, then faults.
 *   - Right click:                        first time a WARNING, then faults.
 *   - Each warning category has its own first warning.
 *   - Warnings never count. The 3rd fault submits the exam automatically.
 *   - Every fault costs FAULT_POINTS points.
 *
 * The same rules are mirrored in grader.html so the student sees the warning
 * at once; the numbers stored and graded always come from here.
 */

export const FAULT_POINTS = 1;     // points taken per fault
export const MAX_FAULTS = 3;       // the 3rd fault auto-submits
export const MAX_EVENTS = 300;     // evidence kept per attempt (bounds storage)

// Which warning category each event type belongs to. 'clip' has no warning.
const CATEGORY = {
  away: 'tab',
  unfocus: 'window',
  resize: 'window',
  contextmenu: 'menu',
  copy: 'clip',
  cut: 'clip',
  paste: 'clip',
  drop: 'clip',
};
// Events that are evidence only (never a warning or a fault).
const INFO_TYPES = ['back', 'bulk_input'];

/**
 * Validates events coming from the browser: unknown types are dropped, numbers
 * are clamped. Returns a clean array; never throws.
 */
export function sanitizeEvents(raw) {
  if (!Array.isArray(raw)) { return []; }
  const out = [];
  for (const e of raw.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object') { continue; }
    if (!(e.type in CATEGORY) && !INFO_TYPES.includes(e.type)) { continue; }
    const seq = Number(e.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq > 1e6) { continue; }
    const clean = { seq, t: Math.trunc(Number(e.t)) || 0, type: e.type };
    if (e.ms !== undefined) { clean.ms = Math.max(0, Math.min(6 * 3600 * 1000, Math.trunc(Number(e.ms)) || 0)); }
    if (e.len !== undefined) { clean.len = Math.max(0, Math.min(100000, Math.trunc(Number(e.len)) || 0)); }
    if (e.of === 'away' || e.of === 'unfocus') { clean.of = e.of; }
    out.push(clean);
  }
  return out;
}

/**
 * Appends incoming events to the stored ones. An event whose seq is not above
 * the last stored one is a retry of something already saved and is skipped, so
 * a re-sent batch can never double count.
 */
export function mergeEvents(stored, incoming) {
  const merged = stored.slice();
  let next = merged.length ? merged[merged.length - 1].seq + 1 : 0;
  for (const e of incoming.slice().sort((a, b) => a.seq - b.seq)) {
    if (e.seq < next) { continue; }
    if (merged.length >= MAX_EVENTS) { break; }
    merged.push(e);
    next = e.seq + 1;
  }
  return merged;
}

/**
 * Old page versions (cached in a browser) report only a count of tab
 * switches. Turn the difference into 'away' events so the same rules apply.
 */
export function withLegacySwitches(events, tabSwitches, nowMs) {
  const have = events.filter((e) => e.type === 'away').length;
  const missing = Math.max(0, Math.min(Number(tabSwitches) || 0, 10) - have);
  const out = events.slice();
  let seq = out.length ? out[out.length - 1].seq + 1 : 0;
  for (let i = 0; i < missing; i++) { out.push({ seq: seq++, t: nowMs, type: 'away' }); }
  return out;
}

/**
 * The verdict for a list of events.
 * @returns {{faults, warnings, penalty, autoSubmit, seen, awayMs, pasteEvents,
 *            pasteChars, bulkInputs, awayEvents, events}}  `events` carries the
 *            same list with an `outcome` of 'warning', 'fault' or 'info'.
 */
export function assessEvents(events) {
  const seen = {};
  let faults = 0; let warnings = 0; let awayMs = 0; let pasteEvents = 0; let pasteChars = 0;
  let bulkInputs = 0; let awayEvents = 0;
  const annotated = [];

  for (const e of events) {
    const category = CATEGORY[e.type];
    let outcome = 'info';
    if (category) {
      if (category === 'clip') { outcome = 'fault'; }
      else if (!seen[category]) { seen[category] = true; outcome = 'warning'; }
      else { outcome = 'fault'; }
      if (outcome === 'fault') { faults++; } else { warnings++; }
      if (e.type === 'away') { awayEvents++; }
      if (e.type === 'paste' || e.type === 'drop') { pasteEvents++; pasteChars += e.len || 0; }
    } else if (e.type === 'back') { awayMs += e.ms || 0; }
    else if (e.type === 'bulk_input') { bulkInputs++; }
    annotated.push({ ...e, outcome });
  }

  return {
    faults, warnings,
    penalty: Math.min(faults, MAX_FAULTS) * FAULT_POINTS,
    autoSubmit: faults >= MAX_FAULTS,
    seen, awayMs, pasteEvents, pasteChars, bulkInputs, awayEvents,
    events: annotated,
  };
}

/** Parses the stored JSON column. */
export function parseEvents(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
