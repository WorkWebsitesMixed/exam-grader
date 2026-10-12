/**
 * jobs.js -- PDF tools: extract questions from a question-paper PDF, and read
 * a marking-scheme PDF to get answer keys and rubrics.
 *
 * Role: port of handleExtractQuestions / handleGenerateRubrics from Code.gs.
 * Both need one model call that can take a minute, far more than a request may
 * use, so they run as a job:
 *   1. POST /api/admin/jobs?kind=...      body = the raw PDF -> {jobId}
 *      (stored in R2 under tmp/<jobId>.pdf; nothing is sent to the model yet)
 *   2. POST /api/admin/jobs/:id/run       JSON {items?} -> queued
 *      (items = the questions the marking scheme must be matched to)
 *   3. the queue consumer calls the model and stores the result in the job row
 *   4. GET  /api/admin/jobs/:id           the admin page polls until done
 *
 * Nothing the model returns is saved as an exam question by this module: the
 * admin page shows it for review and the teacher imports it explicitly. The
 * output is still sanitised here (type whitelist, clamped numbers, bounded
 * strings) because the PDF is untrusted input to the model.
 */

import { HttpError } from './http.js';
import { askModelWithPdf } from './claude.js';
import { GradingError } from './grading.js';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const KINDS = ['extractQuestions', 'generateRubrics'];
const MAX_ITEMS = 80;

const pdfKey = (id) => 'tmp/' + id + '.pdf';
const itemsKey = (id) => 'tmp/' + id + '.items.json';

// ---------------------------------------------------------------------------
// Prompts (the extraction prompt is the old one plus `label` and `figure`)
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM =
  'You extract exam questions from a question-paper PDF for a teacher. ' +
  'Transcribe text EXACTLY as printed (verbatim) — never paraphrase, summarise, or invent content. ' +
  'Ignore page headers/footers, barcodes, cover/instruction pages, and blank pages.';

const EXTRACT_INSTRUCTIONS =
  'Extract every question and sub-question from this exam paper, in the order they appear. ' +
  'Return ONLY a JSON array — no prose, no markdown code fences. Each element:\n' +
  '{"label": "<question number exactly as printed, with any part letters, e.g. \\"3\\", \\"3(a)\\", \\"11(b)(i)\\">", ' +
  '"text": "<verbatim question text. When a sub-part belongs to a question that has a shared introduction ' +
  '(for example \\"Fig. 3.1 shows a clock.\\"), begin the text with that introduction, then a blank line, then the sub-part>", ' +
  '"type": "mc" | "short" | "openEnded", ' +
  '"points": <integer marks shown in brackets, default 1>, ' +
  '"options": [<printed multiple-choice options as strings, else empty array>], ' +
  '"figure": "<the printed figure label this question needs, e.g. \\"Fig. 3.1\\", or an empty string>"}\n' +
  'Use "mc" only when multiple-choice options are printed. Use "short" for one-line factual ' +
  'answers (e.g. "Name a..." typically worth 1 mark). Otherwise use "openEnded". ' +
  'Do NOT include answers or mark schemes.';

const RUBRIC_SYSTEM =
  'You write concise grading aids for a teacher, derived strictly from an official exam marking scheme. ' +
  'Base everything only on the marking scheme — what earns each mark. Do not invent criteria.';

function rubricInstructions(items) {
  return 'Below is a JSON list of exam questions (each with a "type"). Using the attached marking-scheme PDF, ' +
    'produce an answer aid for each, matched to its scheme section by content:\n' +
    '- type "mc": the correct option as a single letter A, B, C or D, where A is the first option listed.\n' +
    '- type "short": a JSON array of ALL acceptable answers from the scheme (include the ' +
    'synonyms / alternatives the scheme allows).\n' +
    '- type "openEnded": a concise grading rubric describing exactly what earns the marks ' +
    '(mark-by-mark where the scheme specifies).\n\n' +
    'QUESTIONS:\n' + JSON.stringify(items) + '\n\n' +
    'Return ONLY a JSON object mapping each question "id" to an object: ' +
    '{"correct": "B"} for mc, {"accepted": ["..."]} for short, {"rubric": "..."} for openEnded — ' +
    'no prose, no code fences. If a question has no matching scheme content, map it to {}.';
}

// ---------------------------------------------------------------------------
// Parsing and sanitising the model's reply
// ---------------------------------------------------------------------------

/** First JSON value delimited by open/close in the text (tolerates fences and stray prose). */
function extractJson(text, open, close) {
  const s = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const start = s.indexOf(open); const end = s.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) { return null; }
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);

/** Questions as the review screen needs them; unknown types fall back to openEnded. */
export function cleanExtracted(arr) {
  const out = [];
  for (const q of (Array.isArray(arr) ? arr : []).slice(0, 200)) {
    if (!q || typeof q !== 'object') { continue; }
    const text = clip(q.text, 4000);
    if (!text) { continue; }
    let type = String(q.type || 'openEnded');
    if (!['mc', 'short', 'openEnded'].includes(type)) { type = 'openEnded'; }
    const options = Array.isArray(q.options) ? q.options.slice(0, 8).map((o) => clip(o, 500)) : [];
    const points = Math.max(1, Math.min(100, parseInt(q.points, 10) || 1));
    out.push({ label: clip(q.label, 30), text, type, points, options, figure: clip(q.figure, 30) });
  }
  return out;
}

/** {id: {correct|accepted|rubric}} limited to the ids that were asked for. */
export function cleanRubrics(map, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = {};
  if (!map || typeof map !== 'object') { return out; }
  for (const id of Object.keys(map)) {
    const item = byId.get(id);
    const v = map[id];
    if (!item || !v || typeof v !== 'object') { continue; }
    if (item.type === 'mc') {
      const letter = String(v.correct || '').trim().toUpperCase();
      const idx = 'ABCD'.indexOf(letter);
      if (letter.length === 1 && idx >= 0 && item.options.length === 4) { out[id] = { correctIndex: idx }; }
    } else if (item.type === 'short') {
      const list = (Array.isArray(v.accepted) ? v.accepted : []).map((a) => clip(a, 200)).filter(Boolean).slice(0, 30);
      if (list.length) { out[id] = { accepted: list }; }
    } else {
      const rubric = clip(v.rubric, 4000);
      if (rubric) { out[id] = { rubric }; }
    }
  }
  return out;
}

/** Validates the items the teacher sends with /run (what to match to the scheme). */
function cleanItems(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ITEMS) {
    throw new HttpError(400, 'bad_request', 'items must be a list of 1 to ' + MAX_ITEMS + ' questions');
  }
  const seen = new Set();
  return raw.map((q) => {
    const id = clip(q && q.id, 40);
    if (!id || seen.has(id)) { throw new HttpError(400, 'bad_request', 'each item needs a unique id'); }
    seen.add(id);
    const type = ['mc', 'short', 'openEnded'].includes(q.type) ? q.type : 'openEnded';
    return { id, type, points: Math.max(1, Math.min(100, parseInt(q.points, 10) || 1)),
             text: clip(q.text, 4000),
             options: type === 'mc' && Array.isArray(q.options) ? q.options.slice(0, 4).map((o) => clip(o, 500)) : [] };
  });
}

// ---------------------------------------------------------------------------
// HTTP handlers (admin only; routed in index.js)
// ---------------------------------------------------------------------------

/** POST /api/admin/jobs?kind=extractQuestions|generateRubrics -- the body is the PDF. */
export async function createJob(c) {
  const { env, deps, request, url } = c;
  const kind = url.searchParams.get('kind') || '';
  if (!KINDS.includes(kind)) { throw new HttpError(400, 'bad_request', 'kind must be extractQuestions or generateRubrics'); }

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_PDF_BYTES) { throw new HttpError(413, 'too_large', 'PDF is larger than 10 MB'); }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) { throw new HttpError(413, 'too_large', 'PDF is larger than 10 MB'); }
  const head = new Uint8Array(buffer.slice(0, 5));
  if (String.fromCharCode(...head) !== '%PDF-') { throw new HttpError(415, 'bad_type', 'That file is not a PDF'); }

  const id = crypto.randomUUID();
  await env.FILES.put(pdfKey(id), buffer, { httpMetadata: { contentType: 'application/pdf' } });
  const now = deps.now();
  await env.DB.prepare(
    "INSERT INTO jobs (id, kind, exam_id, status, input_key, created_by, created_at, updated_at) " +
    "VALUES (?, ?, NULL, 'queued', ?, ?, ?, ?)").bind(id, kind, pdfKey(id), c.teacher.email, now, now).run();
  return { body: { success: true, jobId: id, bytes: buffer.byteLength } };
}

/** POST /api/admin/jobs/:id/run -- JSON {items?}; hands the job to the queue. */
export async function runJob(c) {
  const { env, params, body } = c;
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(params.id).first();
  if (!job) { throw new HttpError(404, 'job_not_found', 'Job not found'); }
  if (job.status !== 'queued') { throw new HttpError(409, 'job_started', 'This job was already started'); }
  if (job.kind === 'generateRubrics') {
    const items = cleanItems(body.items);
    await env.FILES.put(itemsKey(job.id), JSON.stringify(items), { httpMetadata: { contentType: 'application/json' } });
  }
  await env.GRADE_QUEUE.send({ type: 'job', jobId: job.id });
  return { body: { success: true, status: 'queued' } };
}

/** GET /api/admin/jobs/:id */
export async function getJob(c) {
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(c.params.id).first();
  if (!job) { throw new HttpError(404, 'job_not_found', 'Job not found'); }
  return { body: { success: true, kind: job.kind, status: job.status, error: job.error,
                   output: job.output ? JSON.parse(job.output) : null } };
}

// ---------------------------------------------------------------------------
// Queue consumer side
// ---------------------------------------------------------------------------

/**
 * Runs one job. Returns 'done', 'error' or 'skipped'. A RETRYABLE failure
 * (rate limit, service down) is re-thrown so the queue tries again later; a
 * permanent one is stored on the job so the teacher sees the reason.
 */
export async function processJob(env, deps, jobId) {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job || !['queued', 'running'].includes(job.status)) { return 'skipped'; }
  await env.DB.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").bind(deps.now(), jobId).run();

  const fail = async (message) => {
    await env.DB.prepare("UPDATE jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ?")
      .bind(String(message).slice(0, 500), deps.now(), jobId).run();
    await cleanup(env, jobId);
    return 'error';
  };

  try {
    const pdf = await env.FILES.get(pdfKey(jobId));
    if (!pdf) { return await fail('The uploaded PDF is no longer available. Upload it again.'); }
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());

    let output;
    if (job.kind === 'extractQuestions') {
      const reply = await askModelWithPdf(env, deps, { system: EXTRACT_SYSTEM, instructions: EXTRACT_INSTRUCTIONS, pdfBytes });
      const questions = cleanExtracted(extractJson(reply.text, '[', ']'));
      if (!questions.length) {
        return await fail('No questions could be read from the model reply. Start of the reply: ' + String(reply.text).slice(0, 200));
      }
      output = { questions, usage: reply.usage };
    } else {
      const itemsObj = await env.FILES.get(itemsKey(jobId));
      if (!itemsObj) { return await fail('The question list for this job is missing.'); }
      const items = JSON.parse(await itemsObj.text());
      const reply = await askModelWithPdf(env, deps, { system: RUBRIC_SYSTEM, instructions: rubricInstructions(items), pdfBytes });
      const parsed = extractJson(reply.text, '{', '}');
      if (!parsed) { return await fail('The model reply could not be read. Start of the reply: ' + String(reply.text).slice(0, 200)); }
      output = { rubrics: cleanRubrics(parsed, items), asked: items.length, usage: reply.usage };
    }

    await env.DB.prepare("UPDATE jobs SET status = 'done', output = ?, error = NULL, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(output), deps.now(), jobId).run();
    await cleanup(env, jobId);
    return 'done';
  } catch (e) {
    if (e instanceof GradingError && !e.retryable) { return fail(e.message); }
    throw e;   // retryable: the queue will call again
  }
}

/** The PDF and item list are only needed while the job runs. */
async function cleanup(env, jobId) {
  try { await env.FILES.delete(pdfKey(jobId)); await env.FILES.delete(itemsKey(jobId)); } catch (e) { /* best effort */ }
}
