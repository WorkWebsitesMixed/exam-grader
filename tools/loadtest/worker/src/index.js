/**
 * index.js -- throwaway Cloudflare Worker for the exam-grader load test.
 *
 * Role in the project: this is NOT the future backend. It exists only to
 * measure two things from outside, before any rewrite:
 *   - GET  /exam   : serves a synthetic, realistically sized questions JSON
 *                    (the "60 students load the exam page" hot path).
 *   - POST /start  : does what the real /start will do at the database level:
 *                    look up an attempt, create it if missing (UNIQUE guard),
 *                    and return it. No authentication here on purpose; the
 *                    point is to time D1 under 60 simultaneous writes.
 *   - GET  /ping   : trivial reply, gives the latency floor of the network.
 *   - POST /report : receives one lab PC's labcheck.html result (see handleReport).
 *   - GET  /reports?run=<tag> : aggregates all reports of one burst (handleReports).
 *
 * Nothing here reads or writes real exam data. Test emails should end in
 * @test.invalid so they can never be mistaken for real students.
 */

// Origins allowed to call this Worker from a browser. The lab-check page runs
// on GitHub Pages; localhost:8000 is the usual local preview port. Node-based
// load tests send no Origin header, so they are unaffected by this list.
import { BENCH_JWK, BENCH_TOKEN } from './bench-data.js';

const ALLOWED_ORIGINS = [
  'https://workwebsitesmixed.github.io',
  'http://localhost:8000',
];

/**
 * Builds the CORS headers for a request. We echo the caller's origin only if
 * it is on the allowlist (never "*"), which mirrors what the real backend
 * must do. Content-Type is allowed so a later JSON POST would also pass.
 */
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/** JSON response helper that always attaches the CORS headers. */
function json(request, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request),
      ...extra,
    },
  });
}

/**
 * Builds the synthetic exam once per isolate (module scope), not per request,
 * so the cost we measure is serving, not generating.
 *
 * Shape and size are chosen to resemble a real IGCSE paper as served to
 * students: 40 questions, mixed types, MC with four options, an image URL in
 * the same format Code.gs produces (driveImageUrl_). With the filler text the
 * payload comes out around 40 KB. Like the real one, it contains no
 * correctIndex and no rubric.
 */
const FILLER =
  'A designer is developing a product for a client and must justify each ' +
  'decision using the specification, the materials available and the ' +
  'manufacturing process chosen. Explain your reasoning with reference to the ' +
  'figure shown and give two reasons for your answer.';

function buildExam() {
  const questions = [];
  for (let i = 1; i <= 40; i++) {
    const type = i % 4 === 0 ? 'openEnded' : i % 4 === 1 ? 'short' : 'mc';
    const q = {
      id: 'T_' + i,
      section: 'Section ' + (i <= 20 ? 'A' : 'B'),
      type: type,
      points: type === 'openEnded' ? 6 : type === 'short' ? 1 : 2,
      text: i + '. ' + FILLER + ' ' + FILLER,
      imageUrl: 'https://drive.google.com/thumbnail?id=TESTFILE' + i + '&sz=w1600',
    };
    if (type === 'mc') {
      q.options = ['Option A ' + FILLER.slice(0, 60), 'Option B ' + FILLER.slice(0, 60),
                   'Option C ' + FILLER.slice(0, 60), 'Option D ' + FILLER.slice(0, 60)];
      q.shuffled = [0, 1, 2, 3];
    }
    questions.push(q);
  }
  return {
    success: true,
    questions: { A: questions, B: [], C: [] },
    config: { exam_title: 'LOAD TEST', exam_active: 'true', exam_type: 'igcse', set_mode: 'single' },
  };
}
const EXAM_BODY = JSON.stringify(buildExam());

/**
 * POST /start -- the database half of the future start endpoint.
 * Body: {"examId": "...", "email": "...", "set": "A"} (sent as text/plain or
 * JSON; we parse the text ourselves so no CORS preflight is ever triggered).
 *
 * Two queries only (INSERT OR IGNORE, then SELECT), well under D1's limit of
 * 50 queries per invocation on the free plan. Calling it twice with the same
 * email returns the SAME attempt id with resumed=true, which is exactly the
 * "reload mid-exam resumes instead of locking out" behaviour we want.
 */
async function handleStart(request, env) {
  let body;
  try { body = JSON.parse(await request.text()); }
  catch (e) { return json(request, { success: false, error: 'bad json' }, 400); }

  const examId = String(body.examId || 'loadtest');
  const email = String(body.email || '').toLowerCase().trim();
  const set = String(body.set || 'A');
  if (!email) { return json(request, { success: false, error: 'email required' }, 400); }

  const newId = crypto.randomUUID();
  const insert = await env.DB
    .prepare('INSERT OR IGNORE INTO attempts (id, exam_id, email, set_id, started_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId, examId, email, set, Date.now())
    .run();

  // If the row already existed, INSERT OR IGNORE changed nothing and the
  // SELECT below returns the earlier attempt's id instead of newId.
  const row = await env.DB
    .prepare('SELECT id, started_at FROM attempts WHERE exam_id = ? AND email = ? AND set_id = ?')
    .bind(examId, email, set)
    .first();

  return json(request, {
    success: true,
    attemptId: row.id,
    startedAt: row.started_at,
    resumed: row.id !== newId,
    // Lets us confirm the pricing-page claim that the index doubles the writes.
    rowsWritten: insert.meta ? insert.meta.rows_written : null,
  });
}

/**
 * POST /report -- receives one lab PC's labcheck.html result.
 * Body (text/plain JSON): {run, userAgent, results:[{name, verdict, cors:[], noCors:[]}]}.
 * Stored as-is (size-capped) so a burst of 26 PCs can be summarized afterwards.
 * Deliberately stores no IP address or student data.
 */
async function handleReport(request, env) {
  const raw = await request.text();
  if (raw.length > 20000) { return json(request, { success: false, error: 'too large' }, 413); }
  let body;
  try { body = JSON.parse(raw); }
  catch (e) { return json(request, { success: false, error: 'bad json' }, 400); }

  await env.DB
    .prepare('INSERT INTO lab_reports (run, received_at, user_agent, results) VALUES (?, ?, ?, ?)')
    .bind(String(body.run || 'default').slice(0, 40), Date.now(),
          String(body.userAgent || '').slice(0, 300), JSON.stringify(body.results || []))
    .run();
  return json(request, { success: true });
}

/** Nearest-rank percentile of an ascending numeric array (NaN-safe: returns null if empty). */
function pct(sorted, p) {
  if (!sorted.length) { return null; }
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * GET /reports?run=<tag> -- aggregates every report of one run into a
 * per-probe summary: how many PCs got each verdict, and latency percentiles
 * and failed-try counts over all tries of all PCs. This is what answers
 * "did the whole lab fail at once, and on which address?".
 */
async function handleReports(request, env, url) {
  const run = url.searchParams.get('run') || 'default';
  const { results: rows } = await env.DB
    .prepare('SELECT received_at, user_agent, results FROM lab_reports WHERE run = ? ORDER BY received_at')
    .bind(run)
    .all();

  const probes = {};  // name -> {verdicts:{}, ok:[ms], failed:int, errors:{}}
  for (const row of rows) {
    let list = [];
    try { list = JSON.parse(row.results); } catch (e) { continue; }
    for (const r of list) {
      const p = probes[r.name] || (probes[r.name] = { verdicts: {}, okMs: [], failedTries: 0, errors: {} });
      p.verdicts[r.verdict] = (p.verdicts[r.verdict] || 0) + 1;
      // Latency of the normal fetch when it applies, else of the no-cors fetch.
      const tries = (r.cors && r.cors.length) ? r.cors : (r.noCors || []);
      for (const t of tries) {
        if (t.ok) { p.okMs.push(t.ms); }
        else { p.failedTries++; p.errors[t.error] = (p.errors[t.error] || 0) + 1; }
      }
    }
  }

  const summary = {};
  for (const name of Object.keys(probes)) {
    const p = probes[name];
    const ms = p.okMs.sort((a, b) => a - b);
    summary[name] = { verdicts: p.verdicts, okTries: ms.length, failedTries: p.failedTries,
                      p50ms: pct(ms, 50), p95ms: pct(ms, 95), maxMs: ms.length ? ms[ms.length - 1] : null,
                      errors: p.errors };
  }
  return json(request, {
    run,
    reports: rows.length,
    spreadMs: rows.length ? rows[rows.length - 1].received_at - rows[0].received_at : 0,
    userAgents: [...new Set(rows.map((r) => r.user_agent))],
    summary,
  });
}

// CPU benchmark state: the imported key is cached per isolate, exactly like auth.js does.
let benchKey = null;

/**
 * POST /bench -- models the CPU cost of one real student request: verify an
 * RS256 token (importing the key only when the isolate has not done it yet) and
 * parse + re-serialize a ~30 KB JSON body, as a submit/autosave would. The
 * Cloudflare dashboard then shows CPU time per invocation for a burst of these.
 */
async function handleBench(request) {
  const body = await request.text();
  const parsed = JSON.parse(body);
  const cold = benchKey === null;
  if (cold) {
    benchKey = await crypto.subtle.importKey('jwk', BENCH_JWK, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  const [h, p, s] = BENCH_TOKEN.split('.');
  const b64 = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', benchKey, b64(s), new TextEncoder().encode(h + '.' + p));
  const out = JSON.stringify(parsed);
  return new Response(JSON.stringify({ ok, cold, bytesIn: body.length, bytesOut: out.length }),
    { headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Answer the browser's CORS preflight without touching any logic.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/bench' && request.method === 'POST') { return handleBench(request); }

    if (url.pathname === '/ping') { return json(request, { ok: true, t: Date.now() }); }

    if (url.pathname === '/exam' && request.method === 'GET') {
      // max-age lets browsers and Cloudflare's edge reuse the body briefly.
      // We do not depend on it: the test must also pass with no caching.
      return new Response(EXAM_BODY, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=30',
          ...corsHeaders(request),
        },
      });
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      return handleStart(request, env);
    }

    if (url.pathname === '/report' && request.method === 'POST') { return handleReport(request, env); }
    if (url.pathname === '/reports' && request.method === 'GET') { return handleReports(request, env, url); }

    return json(request, { success: false, error: 'not found' }, 404);
  },
};
