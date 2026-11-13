/**
 * claude.js -- the one place that talks to the Anthropic Messages API.
 *
 * Role: grading calls `askModel(kind, system, user)` and gets back either a
 * verdict {score, feedback} or {review: reason}. Retry policy is the same as
 * callClaudeAPI in Code.gs (waits of 2, 4, 8 s on 429/5xx) but it runs inside
 * the queue consumer, so waiting never blocks a student.
 *
 * Two kinds of failure are kept apart on purpose:
 *   - The SERVICE fails (bad API key, no credit, outage). Every question is
 *     affected, so this THROWS a GradingError; the attempt ends as `error` (or
 *     is retried) and the teacher presses "Regrade" once the cause is fixed.
 *   - ONE reply is unusable (it ran out of output budget, the model declined
 *     the text, or there is no score in it). Only that question is affected,
 *     so nothing is thrown: the question is flagged "needs teacher review" and
 *     the rest of the attempt is graded normally.
 */

import { GradingError } from './grading.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const RETRY_DELAYS_MS = [2000, 4000, 8000];

/**
 * Request settings per question type (audit decision D5; a starting point to
 * be checked against the teacher's own marking).
 *
 * Why they are explicit: on claude-sonnet-5-5 a request WITHOUT `thinking`
 * runs adaptive thinking at effort `high`, and thinking tokens are counted
 * inside `max_tokens`. With the old fixed 1024 a long answer could use the
 * whole budget on thinking and come back with no text at all.
 *   - openEnded: judging against a rubric benefits from some thinking, so it
 *     stays on at `medium`, with room for thinking plus one paragraph.
 *   - short: "does this mean the same as the accepted answer" is a one-line
 *     decision, so thinking is off and the budget is small. On this model
 *     `{type: "disabled"}` is rejected; `{type: "between_tools"}` is how
 *     thinking is turned off (allowed at effort `high` or below).
 */
export const GRADING_PARAMS = {
  openEnded: { thinking: { type: 'adaptive' }, effort: 'medium', maxTokens: 4000 },
  short: { thinking: { type: 'between_tools' }, effort: 'low', maxTokens: 400 },
};
// When a reply stops at max_tokens it is asked ONCE more with this many times the budget.
const BUDGET_RETRY_FACTOR = 4;

/**
 * The reply format the API enforces for grading (structured output). The
 * model can only answer with this JSON object, so there is no "SCORE: n" text
 * to parse and a reply cannot silently lose its score. Number ranges cannot be
 * expressed in the schema, so the score is clamped in grading.js.
 */
const VERDICT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: { score: { type: 'integer' }, feedback: { type: 'string' } },
    required: ['score', 'feedback'],
    additionalProperties: false,
  },
};

/**
 * Sends one Messages API request with the retry policy above and returns
 * {text, usage, stopReason}. `text` is '' when the reply has no text block
 * (the caller decides what that means). Shared by grading and the PDF tools
 * (a document block + instructions). `thinking`, `effort` and `format` are
 * optional and are sent only when given. Throws GradingError for SERVICE
 * failures: `retryable` says whether trying again later can help.
 */
export async function callMessages(env, deps, { system, content, maxTokens, model, thinking, effort, format }) {
  const payload = {
    model: model || env.GRADING_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
  };
  if (thinking) { payload.thinking = thinking; }
  // effort and the reply format both live inside output_config.
  if (effort || format) {
    payload.output_config = {};
    if (effort) { payload.output_config.effort = effort; }
    if (format) { payload.output_config.format = format; }
  }
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  };

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let resp;
    try { resp = await deps.fetch(API_URL, init); }
    catch (e) {
      // Network failure: worth retrying like a 5xx.
      if (attempt < RETRY_DELAYS_MS.length) { await deps.sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new GradingError('Could not reach the grading service', true);
    }

    if (resp.status === 200) {
      const json = await resp.json();
      // Read blocks by TYPE: with thinking on, the first block is a thinking block.
      const block = (json.content || []).find((b) => b.type === 'text' && b.text);
      return { text: block ? block.text : '', usage: json.usage || null, stopReason: json.stop_reason || '' };
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new GradingError('Grading unavailable: API key missing or invalid', false);
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
      await deps.sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    // A 4xx other than auth/rate limit (for example a PDF over the page limit)
    // will not get better by retrying; include the service's own explanation.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      const detail = await resp.text().catch(() => '');
      throw new GradingError('Grading service error ' + resp.status + ': ' + detail.slice(0, 300), false);
    }
    // Retryable class but out of local retries: let the queue try again later.
    throw new GradingError('Grading service error ' + resp.status, resp.status === 429 || resp.status >= 500);
  }
  throw new GradingError('Grading service unavailable', true);
}

/**
 * Returns the function grading.js uses to ask for one verdict:
 *   askModel(kind, system, user) -> {score, feedback}  or  {review: reason}
 * `kind` is 'openEnded' or 'short' and picks the settings in GRADING_PARAMS.
 * `onUsage(usage)` is called after every model call (including the retry) so
 * the caller can add up the tokens an attempt cost.
 *
 * `stop_reason` is checked before the text is trusted:
 *   max_tokens -> the reply was cut; ask once more with a larger budget
 *   refusal    -> a safety filter declined the student's text (HTTP 200, no text)
 * Whatever still has no usable score becomes {review}, never a silent 0.
 */
export function makeAskModel(env, deps, onUsage) {
  return async function askModel(kind, system, user) {
    const p = GRADING_PARAMS[kind];
    const ask = async (maxTokens) => {
      const out = await callMessages(env, deps, { system, content: user, maxTokens,
                                                  thinking: p.thinking, effort: p.effort, format: VERDICT_FORMAT });
      if (onUsage && out.usage) { onUsage(out.usage); }
      return out;
    };

    let out = await ask(p.maxTokens);
    if (out.stopReason === 'max_tokens') { out = await ask(p.maxTokens * BUDGET_RETRY_FACTOR); }
    if (out.stopReason === 'max_tokens') { return { review: 'The reply ran out of output budget' }; }
    if (out.stopReason === 'refusal') { return { review: 'The model declined to grade this answer' }; }

    let verdict = null;
    try { verdict = JSON.parse(out.text); } catch (e) { verdict = null; }
    if (!verdict || !Number.isFinite(verdict.score)) { return { review: 'The reply had no usable score' }; }
    return { score: verdict.score, feedback: String(verdict.feedback || '').trim() };
  };
}

/** Bytes -> base64 without building one giant string argument (safe for MB-sized PDFs). */
export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Asks the model about a PDF. Returns {text, usage}.
 * The document block shape is the one documented for the Messages API
 * (type 'document', base64 source, media type application/pdf).
 */
export async function askModelWithPdf(env, deps, { system, instructions, pdfBytes, maxTokens }) {
  const content = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(pdfBytes) } },
    { type: 'text', text: instructions },
  ];
  const out = await callMessages(env, deps, { system, content, maxTokens: maxTokens || 8000,
                                              model: env.EXTRACTION_MODEL || env.GRADING_MODEL });
  // A PDF job is one call, so an empty reply is a failed job (the teacher sees the reason and retries).
  if (!out.text) { throw new GradingError('Grading service returned no text', false); }
  return out;
}
