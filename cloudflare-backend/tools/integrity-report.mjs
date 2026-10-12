#!/usr/bin/env node
/**
 * integrity-report.mjs -- prints the integrity and similarity report of an exam.
 *
 * Role: until the new admin panel exists, this is how a teacher reads what the
 * anti-cheating system recorded. It asks the live D1 database (through your
 * logged-in wrangler, so no password or token is needed), then prints:
 *   1. one line per student: score, warnings, penalties, time away, pastes;
 *   2. the timeline of events of every student who triggered anything;
 *   3. pairs of students with suspiciously similar answers.
 * It only READS; it changes nothing. The similarity step uses no AI model, so
 * running it costs no tokens.
 *
 * Usage (from cloudflare-backend/):
 *   node tools/integrity-report.mjs --exam G11_T1_W1-5
 *   node tools/integrity-report.mjs --exam G11_T1_W1-5 --local   # local test database
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessEvents, parseEvents } from '../src/integrity.js';
import { buildSimilarityReport } from '../src/similarity.js';

const EVENT_LABEL = {
  away: 'left the tab', unfocus: 'window lost focus (split screen / second screen)', resize: 'window shrunk',
  contextmenu: 'right-click', copy: 'copy', cut: 'cut', paste: 'paste', drop: 'drag-drop text',
  back: 'came back', bulk_input: 'large jump in an answer (not a paste)',
};

const clock = (t) => new Date(t).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour12: false });
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

/** Pure formatting, separated from I/O so it can be tested. */
export function formatReport(examId, attempts, questions) {
  const out = [];
  out.push(`INTEGRITY REPORT -- exam ${examId} -- ${attempts.length} attempt(s)`);
  out.push('');
  out.push('name'.padEnd(30) + 'class'.padEnd(7) + 'set'.padEnd(5) + 'status'.padEnd(11) + 'score'.padEnd(10) +
           'warn'.padEnd(6) + 'fault'.padEnd(7) + 'pen'.padEnd(5) + 'away'.padEnd(8) + 'pastes (chars)');
  out.push('-'.repeat(100));

  const flagged = [];
  for (const a of attempts) {
    const v = assessEvents(parseEvents(a.events));
    const name = `${a.last_name}, ${a.first_name}`.slice(0, 28);
    const score = a.max_score ? `${a.total_score}/${a.max_score}` : '-';
    out.push(name.padEnd(30) + String(a.class || '').padEnd(7) + String(a.set_id).padEnd(5) + String(a.status).padEnd(11) +
             score.padEnd(10) + String(v.warnings).padEnd(6) + String(v.faults).padEnd(7) + String(v.penalty).padEnd(5) +
             mmss(v.awayMs).padEnd(8) + `${v.pasteEvents} (${v.pasteChars})`);
    if (v.events.length) { flagged.push({ a, v }); }
  }

  out.push('');
  out.push('TIMELINES (students with any recorded event)');
  out.push('-'.repeat(100));
  if (!flagged.length) { out.push('(none)'); }
  for (const { a, v } of flagged) {
    out.push(`${a.last_name}, ${a.first_name} (${a.class}, set ${a.set_id}) -- faults ${v.faults}, warnings ${v.warnings}, penalty -${v.penalty}`);
    for (const e of v.events) {
      const detail = [e.ms !== undefined ? `${mmss(e.ms)} min` : '', e.len !== undefined ? `${e.len} chars` : ''].filter(Boolean).join(', ');
      const tag = e.outcome === 'fault' ? 'FAULT  ' : e.outcome === 'warning' ? 'warning' : 'info   ';
      out.push(`   ${clock(e.t)}  ${tag}  ${EVENT_LABEL[e.type] || e.type}${detail ? ' (' + detail + ')' : ''}`);
    }
  }

  const graded = attempts.filter((a) => a.status === 'graded');
  const sim = buildSimilarityReport(graded, questions);
  out.push('');
  out.push(`SIMILARITY -- ${sim.attemptsCompared} graded attempts compared, ${sim.pairsFlagged} pair(s) flagged`);
  out.push('A flagged pair is a reason to read both papers, not proof of copying.');
  out.push('-'.repeat(100));
  if (!sim.pairs.length) { out.push('(no pairs flagged)'); }
  for (const p of sim.pairs) {
    out.push(`${p.a.name} (${p.a.class})  <->  ${p.b.name} (${p.b.class})   set ${p.set}`);
    for (const o of p.open) {
      out.push(`   ${o.qid}: ${Math.round(o.score * 100)}% overlap, ${o.common} shared phrases, e.g. "${o.phrases.slice(0, 2).join('", "')}"`);
    }
    if (p.mc.flagged) { out.push(`   multiple choice: ${p.mc.sharedWrong} identical WRONG answers (they got ${p.mc.wrongA} and ${p.mc.wrongB} wrong)`); }
  }
  return out.join('\n');
}

function queryD1(sql, local) {
  const args = ['wrangler', 'd1', 'execute', 'examgrader', local ? '--local' : '--remote', '--json', '--command', sql];
  const raw = execFileSync('npx', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(raw)[0].results;
}

function cli() {
  const argv = process.argv.slice(2);
  const examId = argv[argv.indexOf('--exam') + 1];
  // Interpolated into SQL below, so it is restricted to the id alphabet.
  if (!examId || !/^[A-Za-z0-9_-]{1,40}$/.test(examId)) {
    console.error('Usage: node tools/integrity-report.mjs --exam <exam id> [--local]');
    process.exit(1);
  }
  const local = argv.includes('--local');
  const attempts = queryD1(
    'SELECT id, email, first_name, last_name, class, set_id, status, total_score, max_score, events, answers, paper ' +
    `FROM attempts WHERE exam_id = '${examId}' ORDER BY last_name, first_name`, local);
  const questions = queryD1(
    `SELECT set_id, qid, type, text, correct_index FROM questions WHERE exam_id = '${examId}'`, local);
  console.log(formatReport(examId, attempts, questions));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { cli(); }
