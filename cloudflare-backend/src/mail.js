/**
 * mail.js -- results email: the message body and the call to the relay.
 *
 * Role: Cloudflare Email Sending is not available on the free plan, so the
 * Worker hands the finished message to a small Apps Script web app (the
 * "relay", tools/mail-relay/Code.gs) which sends it with MailApp. The relay is
 * authenticated with a shared key (MAIL_RELAY_KEY, a Worker secret) and only
 * delivers to the school domain, so it cannot be used as an open mail relay.
 *
 * Email is best effort. The exam never waits for it: a failure only marks the
 * attempt's email_status 'failed' and the teacher can press "Resend" later.
 *
 * The body is a port of sendResultsEmail() in Code.gs (same look), with one
 * change: every piece of text that came from a student or a question is
 * HTML-escaped here, because this is the one place where student text becomes
 * HTML.
 */

const RELAY_TIMEOUT_MS = 20000;   // Apps Script cold starts take a few seconds

/** Escapes text for use inside HTML element content or a double-quoted attribute. */
export function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Builds {subject, html} for one graded attempt.
 * @param {object} attempt  attempts row (graded)
 * @param {string} examTitle
 * @param {Array}  qids     question ids in the order the student saw them
 */
export function buildResultEmail(attempt, examTitle, qids) {
  const results = JSON.parse(attempt.results || '{}');
  const overrides = JSON.parse(attempt.overrides || '{}');
  const penalty = attempt.penalty || 0;
  const subject = String(examTitle || 'Exam').replace(/[\r\n]+/g, ' ') + ' — Your Results';

  // Multiple choice first, then written answers, like the original email.
  const mc = []; const open = [];
  for (const qid of qids) {
    const r = results[qid];
    if (!r) { continue; }
    if (r.type === 'mc') { mc.push(r); continue; }
    const has = overrides[qid] !== undefined && overrides[qid] !== null;
    open.push({ ...r, score: has ? Number(overrides[qid]) : r.score });
  }

  let html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0F172A;">' +
    '<div style="background:#1F4E78;color:white;padding:28px 24px;border-radius:8px 8px 0 0;">' +
      '<h1 style="margin:0;font-size:22px;">' + escapeHtml(examTitle) + '</h1>' +
      '<p style="margin:6px 0 0;opacity:0.85;font-size:14px;">Results for ' +
        escapeHtml(attempt.first_name) + ' ' + escapeHtml(attempt.last_name) +
        ' &mdash; Set ' + escapeHtml(attempt.set_id) + '</p>' +
    '</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F7FF;border:1px solid #BFDBFE;border-top:none;"><tr>' +
      '<td align="center" style="padding:20px;">' +
        '<div style="font-size:48px;font-weight:bold;color:#27AE60;line-height:1;">' + escapeHtml(attempt.final_grade) + '</div>' +
        '<div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px;">Final Grade</div></td>' +
      '<td align="center" style="padding:20px;border-left:1px solid #BFDBFE;">' +
        '<div style="font-size:36px;font-weight:bold;color:#1F4E78;">' + escapeHtml(attempt.percentage) + '%</div>' +
        '<div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px;">Score</div></td>' +
      '<td align="center" style="padding:20px;border-left:1px solid #BFDBFE;">' +
        '<div style="font-size:28px;font-weight:bold;color:#1F4E78;">' + escapeHtml(attempt.total_score) + '/' +
          escapeHtml(attempt.max_score) + '</div>' +
        '<div style="font-size:11px;color:#64748B;text-transform:uppercase;margin-top:4px;">Points</div></td>' +
    '</tr></table>';

  if (penalty > 0) {
    html += '<div style="background:#FEF2F2;border:1px solid #FCA5A5;border-top:none;padding:10px 20px;font-size:13px;color:#DC2626;">' +
      '&#9888; &minus;' + penalty + ' point' + (penalty === 1 ? '' : 's') + ' anti-cheating penalty applied</div>';
  }

  html += '<div style="border:1px solid #E2E8F0;border-top:none;border-radius:0 0 8px 8px;">';

  for (const r of mc) {
    const bg = r.correct ? '#F0FDF4' : '#FEF2F2';
    html += '<div style="border-top:1px solid #E2E8F0;padding:14px 20px;background:' + bg + ';">' +
      '<div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">' +
        'Multiple Choice &mdash; ' + r.score + '/' + r.max + ' pts</div>' +
      '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">' + escapeHtml(r.text) + '</div>' +
      '<div style="font-size:13px;color:' + (r.correct ? '#16A34A' : '#DC2626') + ';font-weight:600;">' +
        (r.correct ? '&#10003;' : '&#10007;') + ' Your answer: ' + escapeHtml(r.selected) + '</div>';
    if (!r.correct && r.correctText) {
      html += '<div style="font-size:13px;color:#16A34A;margin-top:4px;">&#10003; Correct answer: <strong>' +
        escapeHtml(r.correctText) + '</strong></div>';
    }
    html += '</div>';
  }

  for (const r of open) {
    html += '<div style="border-top:1px solid #E2E8F0;padding:14px 20px;">' +
      '<div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;">' +
        (r.type === 'short' ? 'Short Answer' : 'Open-Ended') + ' &mdash; ' + r.score + '/' + r.max + ' pts</div>' +
      '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">' + escapeHtml(r.text) + '</div>';
    if (r.answer) {
      html += '<div style="background:#F8FAFC;border-left:3px solid #94A3B8;padding:8px 12px;font-size:13px;' +
        'color:#475569;margin-bottom:8px;white-space:pre-wrap;">' + escapeHtml(r.answer) + '</div>';
    }
    if (r.feedback) {
      html += '<div style="font-size:13px;color:#1F4E78;font-style:italic;">&#128172; ' + escapeHtml(r.feedback) + '</div>';
    }
    html += '</div>';
  }

  html += '</div><p style="font-size:12px;color:#94A3B8;text-align:center;margin-top:16px;">' +
    'You can view your results at any time on the Results page.</p></div>';

  return { subject, html };
}

/**
 * POSTs one message to the relay. Returns {ok, error}. Never throws: network
 * errors, timeouts and relay refusals all come back as {ok:false, error}.
 * Apps Script answers a POST with a redirect to the response body; fetch
 * follows it automatically.
 */
export async function sendViaRelay(env, deps, { to, subject, html }) {
  try {
    const res = await deps.fetch(env.MAIL_RELAY_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight in browsers and Apps Script reads the raw body anyway.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: env.MAIL_RELAY_KEY, to, subject, html }),
      redirect: 'follow',
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (data && data.success) { return { ok: true }; }
    return { ok: false, error: (data && data.error) || 'relay answered ' + res.status };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/**
 * Sends the results email of one graded attempt whose deadline has passed and
 * records the outcome in email_status. Returns 'sent', 'failed' or 'skipped'.
 * The deadline rule is the same as GET /api/result: an early finisher must not
 * receive the correct answers while classmates are still working.
 */
export async function sendAttemptEmail(env, deps, attemptId) {
  const a = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(attemptId).first();
  if (!a || a.status !== 'graded' || a.email_status !== 'pending' || deps.now() < a.deadline_at) { return 'skipped'; }

  const exam = await env.DB.prepare('SELECT title FROM exams WHERE id = ?').bind(a.exam_id).first();
  const qids = (JSON.parse(a.paper).qids) || [];
  const msg = buildResultEmail(a, exam ? exam.title : 'Exam', qids);
  const out = await sendViaRelay(env, deps, { to: a.email, subject: msg.subject, html: msg.html });

  await env.DB.prepare('UPDATE attempts SET email_status = ? WHERE id = ?')
    .bind(out.ok ? 'sent' : 'failed', attemptId).run();
  if (!out.ok) { console.error('email failed for attempt', attemptId, out.error); }
  return out.ok ? 'sent' : 'failed';
}
