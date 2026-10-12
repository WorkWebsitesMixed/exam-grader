/**
 * index.js -- Worker entry point: routing, admin gate, queue and cron hooks.
 *
 * Role: this file wires the pieces together and nothing else.
 *   fetch()     -> routes an HTTP request to a handler in student.js / admin.js
 *   queue()     -> grading consumer (queue.js)
 *   scheduled() -> the once-a-minute sweep (queue.js)
 *
 * `createApp(deps)` takes the clock, network, random source and sleep as
 * parameters. Production passes the real ones (bottom of the file); the tests
 * pass fakes, which is how the whole exam flow is tested without a network.
 */

import { HttpError, corsHeaders, jsonResponse, readJsonBody } from './http.js';
import { verifySession } from './auth.js';
import * as student from './student.js';
import * as admin from './admin.js';
import { uploadImage, serveImage, listImages } from './images.js';
import { createJob, runJob, getJob } from './jobs.js';
import { handleQueueBatch, runSweep } from './queue.js';

/**
 * Route table. `admin: true` requires a valid teacher session.
 * `body: true` means the handler needs the parsed JSON body.
 * Path parameters come from named groups in the pattern.
 */
const ROUTES = [
  // --- students ---
  { method: 'GET',  path: '/api/exam',      handler: student.getExam },
  { method: 'POST', path: '/api/start',     handler: student.startAttempt, body: true },
  { method: 'POST', path: '/api/save',      handler: student.saveAnswers, body: true },
  { method: 'POST', path: '/api/submit',    handler: student.submitAttempt, body: true },
  { method: 'GET',  path: '/api/result',    handler: student.getResult },
  { method: 'POST', path: '/api/myresults', handler: student.myResults, body: true },

  // --- admin: session ---
  { method: 'POST', path: '/api/admin/login', handler: admin.login, body: true },
  { method: 'GET',  path: '/api/admin/me',    handler: admin.me, admin: true },

  // --- admin: exams and questions ---
  { method: 'GET',  path: '/api/admin/exams',             handler: admin.listExams, admin: true },
  { method: 'POST', path: '/api/admin/exams',             handler: admin.createExam, admin: true, body: true },
  { method: 'GET',  path: '/api/admin/exams/:id',         handler: admin.getExamAdmin, admin: true },
  { method: 'PUT',  path: '/api/admin/exams/:id',         handler: admin.updateExam, admin: true, body: true },
  { method: 'GET',  path: '/api/admin/exams/:id/questions',      handler: admin.listQuestions, admin: true },
  { method: 'POST', path: '/api/admin/exams/:id/questions',      handler: admin.addQuestion, admin: true, body: true },
  { method: 'POST', path: '/api/admin/exams/:id/questions/bulk', handler: admin.addQuestionsBulk, admin: true, body: true },
  { method: 'PUT',  path: '/api/admin/exams/:id/questions/:set/:qid', handler: admin.updateQuestion, admin: true, body: true },
  { method: 'DELETE', path: '/api/admin/exams/:id/questions/:set/:qid', handler: admin.deleteQuestion, admin: true },

  // --- admin: attempts and maintenance ---
  { method: 'GET',  path: '/api/admin/attempts',               handler: admin.listAttempts, admin: true },
  { method: 'GET',  path: '/api/admin/attempts/:id',           handler: admin.getAttempt, admin: true },
  { method: 'PUT',  path: '/api/admin/attempts/:id/overrides', handler: admin.setOverrides, admin: true, body: true },
  { method: 'DELETE', path: '/api/admin/attempts/:id',         handler: admin.deleteAttempt, admin: true },
  { method: 'POST', path: '/api/admin/attempts/:id/reset',     handler: admin.deleteAttempt, admin: true },
  { method: 'POST', path: '/api/admin/exams/:id/recalculate',  handler: admin.recalculate, admin: true, body: true },
  { method: 'POST', path: '/api/admin/exams/:id/regrade-mc',   handler: admin.regradeMc, admin: true, body: true },
  { method: 'POST', path: '/api/admin/exams/:id/resend-emails', handler: admin.resendEmails, admin: true, body: true },
  { method: 'POST', path: '/api/admin/exams/:id/similarity',   handler: admin.requestSimilarity, admin: true, body: true },
  { method: 'GET',  path: '/api/admin/exams/:id/similarity',   handler: admin.getSimilarity, admin: true },

  // --- admin: images (the request body is the raw file, so no `body: true`) ---
  { method: 'POST', path: '/api/admin/images', handler: uploadImage, admin: true },
  { method: 'GET',  path: '/api/admin/images', handler: listImages, admin: true },

  // --- admin: PDF jobs (create takes the raw PDF as the body) ---
  { method: 'POST', path: '/api/admin/jobs', handler: createJob, admin: true },
  { method: 'POST', path: '/api/admin/jobs/:id/run', handler: runJob, admin: true, body: true },
  { method: 'GET',  path: '/api/admin/jobs/:id', handler: getJob, admin: true },

  // --- admin: teachers ---
  { method: 'GET',  path: '/api/admin/teachers',        handler: admin.listTeachers, admin: true },
  { method: 'POST', path: '/api/admin/teachers',        handler: admin.addTeacher, admin: true, body: true },
  { method: 'DELETE', path: '/api/admin/teachers/:email', handler: admin.removeTeacher, admin: true },
];

/** Turns "/api/admin/exams/:id" into a RegExp with named groups. */
function compile(path) {
  const pattern = path.replace(/:([a-z]+)/g, '(?<$1>[^/]+)');
  return new RegExp('^' + pattern + '$');
}
const COMPILED = ROUTES.map((r) => ({ ...r, regex: compile(r.path) }));

/** Resolves the signed-in teacher from the Authorization header, or throws 401. */
async function authenticateTeacher(request, env, deps) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = await verifySession(token, env.SESSION_SECRET, deps.now());
  // Re-check on every request so removing a teacher takes effect immediately.
  const teacher = await env.DB.prepare('SELECT * FROM teachers WHERE email = ?').bind(session.email).first();
  if (!teacher) { throw new HttpError(401, 'unauthorized', 'Not signed in'); }
  return teacher;
}

/** Builds the app. Returns {fetch, queue, scheduled} ready to export. */
export function createApp(deps) {
  async function handle(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    const url = new URL(request.url);

    try {
      for (const route of COMPILED) {
        if (route.method !== request.method) { continue; }
        const match = route.regex.exec(url.pathname);
        if (!match) { continue; }

        const c = { request, env, deps, url, params: match.groups || {}, body: {}, teacher: null };
        if (route.admin) { c.teacher = await authenticateTeacher(request, env, deps); }
        if (route.body) { c.body = await readJsonBody(request); }

        const out = await route.handler(c);
        const extra = out.cacheSeconds ? { 'Cache-Control': 'public, max-age=' + out.cacheSeconds } : { 'Cache-Control': 'no-store' };
        return jsonResponse(request, env, out.body, out.status || 200, extra);
      }

      // Figures are the one non-JSON, public route: GET /img/<sha256>.
      const image = await serveImage(request, env, url.pathname);
      if (image) { return image; }

      throw new HttpError(404, 'not_found', 'Not found');
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse(request, env, { success: false, error: err.message, code: err.code }, err.status,
                            { 'Cache-Control': 'no-store' });
      }
      // A bug: log details server-side, tell the client nothing about internals.
      console.error('unhandled error', err && err.stack ? err.stack : err);
      return jsonResponse(request, env, { success: false, error: 'Internal error', code: 'internal' }, 500,
                          { 'Cache-Control': 'no-store' });
    }
  }

  return {
    fetch: handle,
    queue: (batch, env) => handleQueueBatch(batch, env, deps),
    scheduled: (event, env) => runSweep(env, deps),
  };
}

// Production wiring: real clock, real network, real randomness.
const app = createApp({
  now: () => Date.now(),
  fetch: (...args) => fetch(...args),
  random: () => Math.random(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  queue: (batch, env, ctx) => app.queue(batch, env, ctx),
  scheduled: (event, env, ctx) => ctx.waitUntil(app.scheduled(event, env)),
};
