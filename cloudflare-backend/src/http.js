/**
 * http.js -- small HTTP helpers shared by every handler.
 *
 * Role: one place that decides how a request body is read, how an error becomes
 * a JSON response, and how CORS headers are produced. Keeping this in one file
 * means no handler can forget CORS or leak a stack trace.
 */

/**
 * An error that carries an HTTP status and a stable machine-readable `code`.
 * Handlers `throw new HttpError(...)`; the router turns it into
 * `{success:false, error, code}` with that status. Anything else thrown is a
 * bug and becomes a generic 500 (the message is NOT sent to the client).
 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/** Parses the comma-separated ALLOWED_ORIGINS variable into an array. */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * CORS headers for one request. The caller's Origin is echoed back ONLY when it
 * is on the allowlist (never "*"): the admin API takes a bearer token, and a
 * wildcard would let any web page script it from a logged-in teacher's browser.
 */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Filename',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/** Builds a JSON response with UTF-8 and CORS. Accents survive natively (no \uXXXX escaping needed). */
export function jsonResponse(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

/**
 * Reads and parses a JSON request body with a size cap.
 * Student POSTs arrive as text/plain (to avoid a CORS preflight), so we always
 * read the raw text and parse it ourselves instead of trusting Content-Type.
 */
export async function readJsonBody(request, maxBytes = 200000) {
  const text = await request.text();
  if (text.length > maxBytes) { throw new HttpError(413, 'too_large', 'Request body too large'); }
  if (!text) { return {}; }
  try { return JSON.parse(text); }
  catch (e) { throw new HttpError(400, 'bad_json', 'Request body is not valid JSON'); }
}

/** Clamps a client-supplied number into [min, max]; NaN becomes `min`. */
export function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (Number.isNaN(n)) { return min; }
  return Math.max(min, Math.min(max, n));
}
