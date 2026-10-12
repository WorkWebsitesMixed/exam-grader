/**
 * claude.js -- the one place that talks to the Anthropic Messages API.
 *
 * Role: grading calls its `askModel(system, user)` and gets plain text back.
 * Retry policy is the same as callClaudeAPI in Code.gs (waits of 2, 4, 8 s on
 * 429/5xx) but it runs inside the queue consumer, so waiting never blocks a
 * student. Differences from the old code, on purpose:
 *   - a bad API key or an empty reply THROWS (non-retryable) instead of
 *     returning "SCORE: 0". The old behaviour silently gave students zeros and
 *     the teacher only noticed afterwards. Now the attempt is marked `error`
 *     and can be regraded once the key is fixed.
 */

import { GradingError } from './grading.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const RETRY_DELAYS_MS = [2000, 4000, 8000];

/**
 * Sends one Messages API request with the retry policy above and returns
 * {text, usage}. Shared by grading (plain text prompt) and the PDF tools
 * (a document block + instructions). Throws GradingError: `retryable` says
 * whether trying again later can help.
 */
export async function callMessages(env, deps, { system, content, maxTokens, model }) {
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || env.GRADING_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
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
      const block = (json.content || []).find((b) => b.type === 'text' && b.text);
      if (block) { return { text: block.text, usage: json.usage || null }; }
      throw new GradingError('Grading service returned no text', false);
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

/** Returns an async function (system, user) => text, bound to env + deps. */
export function makeAskModel(env, deps) {
  return async function askModel(system, user) {
    const out = await callMessages(env, deps, { system, content: user, maxTokens: 1024 });
    return out.text;
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
  return callMessages(env, deps, { system, content, maxTokens: maxTokens || 8000,
                                   model: env.EXTRACTION_MODEL || env.GRADING_MODEL });
}
