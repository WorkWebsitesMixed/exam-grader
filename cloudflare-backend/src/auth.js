/**
 * auth.js -- identity: Google ID-token verification and admin sessions.
 *
 * Role: this is where the two security gaps of the old Code.gs are closed.
 *   1. The old backend asked Google's tokeninfo endpoint (documented as
 *      debugging-only), checked only `aud`, never checked the school domain
 *      and fell back to a client-supplied email when no token was sent.
 *      Here the RS256 signature is verified locally against Google's
 *      published keys, and `iss`, `aud`, `exp`, `email_verified`, `hd` and the
 *      email suffix are all required. There is no fallback.
 *   2. Admin access is a signed session issued only to emails in `teachers`.
 *
 * Everything uses the WebCrypto API that Workers provide (no dependencies).
 * Network and clock are injected through `deps` so tests can run offline.
 */

import { HttpError } from './http.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const CLOCK_SKEW_SECONDS = 60;

// Module-scope caches: a Worker isolate serves many requests, so the keys are
// fetched and imported once per isolate instead of once per request. This also
// keeps CPU time per request low (importing an RSA key is the costly step).
let jwksCache = { keys: null, expiresAt: 0 };
const cryptoKeyCache = new Map();  // kid -> CryptoKey

/** Test hook: forget cached Google keys. */
export function resetAuthCaches() {
  jwksCache = { keys: null, expiresAt: 0 };
  cryptoKeyCache.clear();
}

// ---------- base64url helpers ----------

export function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// ---------- Google ID token ----------

/** Downloads (or reuses) Google's public signing keys, honouring Cache-Control max-age. */
async function getJwks(deps, forceRefresh) {
  const nowMs = deps.now();
  if (!forceRefresh && jwksCache.keys && nowMs < jwksCache.expiresAt) { return jwksCache.keys; }
  const resp = await deps.fetch(GOOGLE_JWKS_URL);
  if (!resp.ok) { throw new HttpError(503, 'auth_unavailable', 'Could not fetch Google signing keys'); }
  const body = await resp.json();
  const match = /max-age=(\d+)/.exec(resp.headers.get('Cache-Control') || '');
  const ttlSeconds = match ? Number(match[1]) : 3600;
  jwksCache = { keys: body.keys || [], expiresAt: nowMs + ttlSeconds * 1000 };
  return jwksCache.keys;
}

/** Returns the CryptoKey for a key id, refreshing the key set once if the id is unknown (key rotation). */
async function getVerifyKey(kid, deps) {
  if (cryptoKeyCache.has(kid)) { return cryptoKeyCache.get(kid); }
  let jwk = (await getJwks(deps, false)).find((k) => k.kid === kid);
  if (!jwk) { jwk = (await getJwks(deps, true)).find((k) => k.kid === kid); }
  if (!jwk) { throw new HttpError(401, 'invalid_token', 'Unknown signing key'); }
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  cryptoKeyCache.set(kid, key);
  return key;
}

/**
 * Verifies a Google ID token and returns {email, name, sub}.
 * @param {string} idToken  the `credential` from Google Sign-In
 * @param {object} env      needs GOOGLE_CLIENT_ID and ALLOWED_EMAIL_DOMAIN
 * @param {object} deps     {fetch, now}
 * @param {object} options  requireSchoolDomain (default true). Admin login passes
 *                          false because teacher access is decided by the
 *                          `teachers` table, not by the email domain.
 * Throws HttpError 401 (invalid / expired token) or 403 (wrong domain).
 */
export async function verifyGoogleIdToken(idToken, env, deps, options = {}) {
  const requireSchoolDomain = options.requireSchoolDomain !== false;
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) { throw new HttpError(401, 'invalid_token', 'Missing or malformed sign-in token'); }

  let header; let payload;
  try {
    header = JSON.parse(utf8Decode.decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(utf8Decode.decode(b64urlToBytes(parts[1])));
  } catch (e) { throw new HttpError(401, 'invalid_token', 'Malformed sign-in token'); }

  if (header.alg !== 'RS256' || !header.kid) { throw new HttpError(401, 'invalid_token', 'Unsupported token algorithm'); }

  // Signature first: nothing in the payload is trusted before this passes.
  const key = await getVerifyKey(header.kid, deps);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), utf8.encode(parts[0] + '.' + parts[1]));
  if (!valid) { throw new HttpError(401, 'invalid_token', 'Bad token signature'); }

  if (!ALLOWED_ISSUERS.includes(payload.iss)) { throw new HttpError(401, 'invalid_token', 'Wrong token issuer'); }
  if (payload.aud !== env.GOOGLE_CLIENT_ID) { throw new HttpError(401, 'invalid_token', 'Token was issued for another app'); }
  const nowSeconds = Math.floor(deps.now() / 1000);
  // 'token_expired' is a distinct code so the page can ask the student to sign in again.
  if (!payload.exp || nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) {
    throw new HttpError(401, 'token_expired', 'Sign-in expired, please sign in again');
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new HttpError(401, 'invalid_token', 'Email not verified by Google');
  }

  const email = String(payload.email || '').toLowerCase().trim();
  if (!email) { throw new HttpError(401, 'invalid_token', 'Token has no email'); }

  if (requireSchoolDomain) {
    const domain = String(env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
    // Google's guidance: `hd` proves Workspace membership; the email suffix alone does not.
    if (!domain || payload.hd !== domain || !email.endsWith('@' + domain)) {
      throw new HttpError(403, 'wrong_domain', 'Use your school Google account');
    }
  }
  return { email, name: String(payload.name || ''), sub: String(payload.sub || '') };
}

// ---------- admin sessions (HMAC-signed, stateless) ----------

async function hmacKey(secret) {
  if (!secret) { throw new HttpError(500, 'server_misconfigured', 'SESSION_SECRET is not set'); }
  return crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Issues a session token: `v1.<payload>.<signature>`. The payload holds the
 * email, role and expiry; the signature stops anyone editing it. Stateless on
 * purpose: no table to write on login, nothing to clean up.
 */
export async function signSession(payload, secret) {
  const body = bytesToB64url(utf8.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8.encode('v1.' + body));
  return 'v1.' + body + '.' + bytesToB64url(new Uint8Array(sig));
}

/** Returns the payload of a valid, unexpired session token, or throws 401. */
export async function verifySession(token, secret, nowMs) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') { throw new HttpError(401, 'unauthorized', 'Not signed in'); }
  const ok = await crypto.subtle.verify(
    'HMAC', await hmacKey(secret), b64urlToBytes(parts[2]), utf8.encode('v1.' + parts[1]));
  if (!ok) { throw new HttpError(401, 'unauthorized', 'Not signed in'); }
  let payload;
  try { payload = JSON.parse(utf8Decode.decode(b64urlToBytes(parts[1]))); }
  catch (e) { throw new HttpError(401, 'unauthorized', 'Not signed in'); }
  if (!payload.exp || nowMs > payload.exp) { throw new HttpError(401, 'session_expired', 'Session expired, sign in again'); }
  return payload;
}
