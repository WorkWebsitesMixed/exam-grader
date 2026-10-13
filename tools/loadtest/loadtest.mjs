#!/usr/bin/env node
/**
 * loadtest.mjs -- fires waves of simultaneous requests at the test Worker.
 *
 * Role in the project: Check 1 of the migration plan. It answers "do 60
 * students starting at the same instant get a fast, correct answer?" by
 * sending N requests at once and reporting latency percentiles and failures.
 * Uses only Node 18+ built-ins (global fetch); no npm install needed.
 *
 * Usage:
 *   node loadtest.mjs --url https://examgrader-loadtest.<you>.workers.dev
 *   node loadtest.mjs --url <worker> --waves 25,60,120 --gap 20 --endpoint both
 *   node loadtest.mjs --url <worker> --baseline <apps-script-exec-url>
 *
 * Options:
 *   --url        base URL of the test Worker (required)
 *   --waves      comma list of simultaneous request counts   (default 25,60,120)
 *   --gap        seconds to rest between waves               (default 20)
 *   --endpoint   exam | start | both | bench                  (default both)
 *                bench = POST /bench with a ~30 KB body: models the CPU of
 *                token verification + a submit-sized JSON (see worker/src/index.js)
 *   --baseline   OPTIONAL Apps Script /exec URL. Sends the same waves of
 *                GET ?action=questions to it for comparison. It is read-only
 *                but occupies Apps Script execution slots, so run it only
 *                when no class is sitting an exam. Off unless you pass it.
 *
 * Honest limitation: every request leaves from THIS computer and one IP, so
 * this measures the server side under burst, not the school network. The
 * lab-check page covers the network side.
 */

// ---------- argument parsing ----------
// Minimal "--key value" parser; avoids a dependency for a 10-line job.
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
if (!args.url) {
  console.error('Missing --url <worker base url>. See the header comment for usage.');
  process.exit(1);
}
const BASE = args.url.replace(/\/$/, '');
const WAVES = (args.waves || '25,60,120').split(',').map(Number);
const GAP_S = Number(args.gap || 20);
const ENDPOINT = args.endpoint || 'both';
const BASELINE = args.baseline || '';

// Unique per run so repeated runs never collide on the UNIQUE(email) guard
// (a collision would return resumed=true and hide the insert cost).
const RUN_ID = Date.now().toString(36);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** p-th percentile (0-100) of a numeric array, nearest-rank method. */
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Sends `n` requests that all start together. We build the request thunks
 * first and then release them in the same tick so the burst is as
 * simultaneous as one Node process can make it. Latency is measured from
 * release until the whole body is read (what a browser would wait for).
 */
async function runWave(label, n, makeRequest) {
  const jobs = [];
  for (let i = 0; i < n; i++) jobs.push(() => makeRequest(i));

  const t0 = performance.now();
  const results = await Promise.all(jobs.map(async (job) => {
    const start = performance.now();
    try {
      const { status, bytes, extra } = await job();
      return { ok: status >= 200 && status < 300, status, bytes, extra, ms: performance.now() - start };
    } catch (err) {
      // Network-level failure (DNS, reset, timeout): no HTTP status exists.
      return { ok: false, status: 'ERR:' + (err.cause?.code || err.name), bytes: 0, ms: performance.now() - start };
    }
  }));
  const wall = performance.now() - t0;

  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const statuses = {};
  results.forEach((r) => { statuses[r.status] = (statuses[r.status] || 0) + 1; });
  const resumed = results.filter((r) => r.extra && r.extra.resumed).length;
  const rowsWritten = results.map((r) => r.extra && r.extra.rowsWritten).filter((x) => x != null);

  console.log(
    `${label.padEnd(18)} n=${String(n).padStart(3)}  ok=${results.filter((r) => r.ok).length}` +
    `  p50=${percentile(lat, 50).toFixed(0)}ms  p95=${percentile(lat, 95).toFixed(0)}ms` +
    `  max=${lat[lat.length - 1].toFixed(0)}ms  wall=${wall.toFixed(0)}ms` +
    `  status=${JSON.stringify(statuses)}` +
    (resumed ? `  UNEXPECTED resumed=${resumed}` : '') +
    (rowsWritten.length ? `  rowsWritten(first)=${rowsWritten[0]}` : '')
  );
}

// ---------- the request types ----------

/** GET /exam on the test Worker: the "load the exam page" hot path. */
function examRequest() {
  return async () => {
    const r = await fetch(BASE + '/exam');
    const body = await r.arrayBuffer();
    return { status: r.status, bytes: body.byteLength };
  };
}

/** POST /start on the test Worker: 60 distinct students each creating an attempt. */
function startRequest(waveTag) {
  return async (i) => {
    // text/plain on purpose: matches how the real frontend avoids preflight.
    const r = await fetch(BASE + '/start', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ examId: 'loadtest', set: 'A', email: `s${i}-${waveTag}-${RUN_ID}@test.invalid` }),
    });
    const text = await r.text();
    let extra = null;
    try { extra = JSON.parse(text); } catch (e) { /* non-JSON error page: status tells the story */ }
    return { status: r.status, bytes: text.length, extra };
  };
}

/** POST /bench: a ~30 KB JSON body, like a submit with many long answers. */
const BENCH_BODY = JSON.stringify({ answers: Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => ['Q' + i, 'A long written answer. '.repeat(30)])) });
function benchRequest() {
  return async () => {
    const r = await fetch(BASE + '/bench', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: BENCH_BODY });
    const text = await r.text();
    return { status: r.status, bytes: text.length };
  };
}

/** Baseline: the current Apps Script questions endpoint, for comparison only. */
function baselineRequest() {
  return async () => {
    const r = await fetch(BASELINE + (BASELINE.includes('?') ? '&' : '?') + 'action=questions');
    const body = await r.text();
    return { status: r.status, bytes: body.length };
  };
}

// ---------- main ----------
console.log(`Run ${RUN_ID}  target=${BASE}  waves=${WAVES.join(',')}  gap=${GAP_S}s  endpoint=${ENDPOINT}`);
if (BASELINE) {
  console.log('BASELINE enabled: Apps Script will receive the same bursts. Starting in 5 s (Ctrl+C to cancel).');
  await sleep(5000);
}

for (let w = 0; w < WAVES.length; w++) {
  const n = WAVES[w];
  if (ENDPOINT === 'exam' || ENDPOINT === 'both') await runWave('worker GET /exam', n, examRequest());
  if (ENDPOINT === 'start' || ENDPOINT === 'both') await runWave('worker POST /start', n, startRequest('w' + w));
  if (ENDPOINT === 'bench') await runWave('worker POST /bench', n, benchRequest());
  if (BASELINE) await runWave('appsscript GET', n, baselineRequest());
  if (w < WAVES.length - 1) { console.log(`  ...resting ${GAP_S}s`); await sleep(GAP_S * 1000); }
}

console.log('\nDone. Now open the Cloudflare dashboard (Workers & Pages > examgrader-loadtest > Metrics)');
console.log('and read the CPU time p50/p99: the free plan allows 10 ms per request.');
