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

/** Returns an async function (system, user) => text, bound to env + deps. */
export function makeAskModel(env, deps) {
  return async function askModel(system, user) {
    const body = JSON.stringify({
      model: env.GRADING_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body,
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
        if (block) { return block.text; }
        throw new GradingError('Grading service returned no text', false);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new GradingError('Grading unavailable: API key missing or invalid', false);
      }
      if ((resp.status === 429 || resp.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
        await deps.sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      // Retryable class but out of local retries: let the queue try again later.
      throw new GradingError('Grading service error ' + resp.status, resp.status === 429 || resp.status >= 500);
    }
    throw new GradingError('Grading service unavailable', true);
  };
}
