/**
 * helpers.js -- test harness: a D1-compatible adapter over SQLite, a fake
 * Google that signs real RS256 tokens, and a way to call the Worker in-process.
 *
 * Role: lets the whole exam flow (start -> save -> submit -> grade -> result)
 * run against real SQL and real signature verification with no network and no
 * Cloudflare account. The adapter implements only the parts of the D1 API the
 * code uses (prepare/bind/first/all/run/batch).
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/index.js';
import { bytesToB64url, resetAuthCaches } from '../src/auth.js';
import { resetStudentCaches } from '../src/student.js';

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const ORIGIN = 'https://workwebsitesmixed.github.io';

/** Minimal R2Bucket lookalike: put/get over a Map. */
export class FakeR2 {
  constructor() { this.objects = new Map(); }
  async put(key, value, options = {}) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, httpMetadata: options.httpMetadata || {} });
  }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) { return null; }
    const bytes = o.bytes;
    return {
      body: new Blob([bytes]).stream(), httpMetadata: o.httpMetadata,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
    };
  }
  async delete(key) { this.objects.delete(key); }
}

/** Minimal D1Database lookalike backed by node:sqlite. */
export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    this.queryCount = 0;
  }
  prepare(sql) {
    const self = this;
    return {
      sql, params: [],
      bind(...p) { this.params = p.map((v) => (v === undefined ? null : v)); return this; },
      async first() { self.queryCount++; return self.db.prepare(sql).get(...this.params) || null; },
      async all() { self.queryCount++; return { results: self.db.prepare(sql).all(...this.params) }; },
      async run() {
        self.queryCount++;
        const r = self.db.prepare(sql).run(...this.params);
        return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
  }
  async batch(stmts) { const out = []; for (const s of stmts) { out.push(await s.run()); } return out; }
}

/** Generates an RSA key pair and a function that signs Google-style ID tokens. */
export async function makeGoogle(nowMs = () => Date.now()) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'test-key-1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const enc = new TextEncoder();
  const b64 = (obj) => bytesToB64url(enc.encode(JSON.stringify(obj)));

  async function token(claims, { kid = 'test-key-1', key = pair.privateKey } = {}) {
    const header = b64({ alg: 'RS256', typ: 'JWT', kid });
    const payload = b64({
      iss: 'https://accounts.google.com', aud: CLIENT_ID,
      exp: Math.floor(nowMs() / 1000) + 3600,
      email_verified: true, hd: 'marymount.edu.co', sub: 'sub-' + claims.email, ...claims });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(header + '.' + payload));
    return header + '.' + payload + '.' + bytesToB64url(new Uint8Array(sig));
  }
  return { jwk, token, privateKey: pair.privateKey };
}

/**
 * Builds a fresh app + env. `modelReply(system, user)` stands in for Claude and
 * returns the text of its answer (default: full marks).
 */
export async function makeWorld({ modelReply } = {}) {
  resetAuthCaches(); resetStudentCaches();
  const clock = { t: Date.UTC(2026, 9, 12, 14, 0, 0) };
  // Tokens are minted relative to the simulated clock so expiry tests are exact.
  const google = await makeGoogle(() => clock.t);
  const sent = [];       // queue messages
  const modelCalls = [];
  const mails = [];      // messages delivered to the fake mail relay
  const relay = { mode: 'ok' };   // 'ok' | 'error' | 'down'

  const env = {
    DB: new FakeD1(),
    FILES: new FakeR2(),
    GRADE_QUEUE: { send: async (m) => { sent.push(m); } },
    GRADING_MODEL: 'claude-sonnet-5-5', GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_EMAIL_DOMAIN: 'marymount.edu.co',
    ALLOWED_ORIGINS: ORIGIN, SESSION_SECRET: 'test-session-secret', ANTHROPIC_API_KEY: 'test-key', MAIL_RELAY_URL: '', MAIL_RELAY_KEY: 'relay-secret',
  };

  const deps = {
    now: () => clock.t,
    random: () => 0.5,
    sleep: async () => {},
    fetch: async (url, init) => {
      if (String(url).startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
        return new Response(JSON.stringify({ keys: [google.jwk] }),
          { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
      }
      if (String(url).startsWith('https://api.anthropic.com/')) {
        const body = JSON.parse(init.body);
        const user = body.messages[0].content;
        modelCalls.push({ system: body.system, user });
        const text = modelReply ? modelReply(body.system, user) : 'SCORE: 99\nFEEDBACK: Well done, a thorough answer.';
        return new Response(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 4200, output_tokens: 900 } }), { status: 200 });
      }
      if (String(url).startsWith('https://relay.test/')) {
        if (relay.mode === 'down') { throw new Error('relay unreachable'); }
        const body = JSON.parse(init.body);
        if (body.key !== 'relay-secret') { return new Response(JSON.stringify({ success: false, error: 'bad key' })); }
        if (relay.mode === 'error') { return new Response(JSON.stringify({ success: false, error: 'quota' })); }
        mails.push(body);
        return new Response(JSON.stringify({ success: true }));
      }
      throw new Error('unexpected fetch ' + url);
    },
  };

  const app = createApp(deps);

  /** Calls the Worker like a browser would. Returns {status, json, headers}. */
  async function call(method, path, { body, headers = {} } = {}) {
    const init = { method, headers: { Origin: ORIGIN, ...headers } };
    if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); }
    const resp = await app.fetch(new Request('https://api.test' + path, init), env);
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
    return { status: resp.status, json, headers: resp.headers, text };
  }

  /** Runs the queue consumer over everything sent so far, like Cloudflare would. */
  async function drainQueue() {
    const pending = sent.splice(0, sent.length);
    for (const body of pending) {
      const msg = { body, ack() {}, retry() { throw new Error('unexpected retry'); } };
      await app.queue({ messages: [msg] }, env);
    }
    return pending.length;
  }

  return { env, deps, app, google, clock, sent, modelCalls, mails, relay, call, drainQueue };
}

/** Seeds one exam with the given questions (rows use admin-API field names). */
export async function seedExam(world, { exam = {}, questions } = {}) {
  const db = world.env.DB;
  const e = { id: 'EX1', title: 'Test Exam', duration_min: 60, exam_type: 'igcse', active: 1, is_default: 1, ...exam };
  db.db.prepare(
    'INSERT INTO exams (id, title, active, is_default, duration_min, exam_type, set_mode, created_at, updated_at) ' +
    "VALUES (?, ?, ?, ?, ?, ?, 'single', 0, 0)").run(e.id, e.title, e.active, e.is_default, e.duration_min, e.exam_type);
  const qs = questions || [
    { set: 'A', id: 'Q1', type: 'mc', points: 2, text: 'Pick B', options: ['a', 'b', 'c', 'd'], correctIndex: 1 },
    { set: 'A', id: 'Q2', type: 'short', points: 1, text: 'Capital of France?', accepted: ['Paris'] },
    { set: 'A', id: 'Q3', type: 'openEnded', points: 6, text: 'Explain triangulation.', rubric: 'Mention rigidity.' },
  ];
  qs.forEach((q, i) => {
    db.db.prepare(
      'INSERT INTO questions (exam_id, set_id, qid, position, section, type, points, text, options, correct_index, rubric, accepted_answers) ' +
      "VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)").run(
      e.id, q.set, q.id, i + 1, q.type, q.points, q.text, q.options ? JSON.stringify(q.options) : null,
      q.correctIndex ?? null, q.rubric || '', q.accepted ? JSON.stringify(q.accepted) : null);
  });
  return e;
}

/** Inserts a teacher row. */
export function seedTeacher(world, email, { role = 'admin', retake = 0 } = {}) {
  world.env.DB.db.prepare('INSERT INTO teachers (email, name, role, retake_exempt, added_at) VALUES (?, ?, ?, ?, 0)')
    .run(email, '', role, retake);
}
