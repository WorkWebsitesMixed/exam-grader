/**
 * Code.gs -- results-email relay for the Cloudflare exam backend.
 *
 * What it is: a tiny, SEPARATE Apps Script web app. The Cloudflare Worker
 * (cloudflare-backend/src/mail.js) POSTs {key, to, subject, html} here and this
 * script sends the message with MailApp. It exists only because Cloudflare's
 * free plan cannot send email and Apps Script can, from the school account.
 *
 * Why a separate project and not an action in the exam Code.gs: the production
 * script keeps running untouched during the migration, and this one can be
 * redeployed or deleted without any risk to it.
 *
 * Safety rules enforced here (the Worker is not trusted blindly either):
 *   - the shared key must match the MAIL_RELAY_KEY Script Property;
 *   - recipients must be on the school domain, so a leaked key cannot turn
 *     this into an open spam relay;
 *   - subject and body sizes are bounded;
 *   - nothing is logged that contains the body or the key.
 *
 * Setup: see README.md in this folder.
 */

var ALLOWED_DOMAIN = 'marymount.edu.co';   // recipients must end with @<this>
var MAX_SUBJECT = 200;                      // characters
var MAX_HTML = 100000;                      // characters (a long exam is ~20 KB)
var SENDER_NAME = 'Marymount Exams';

/** JSON reply helper. */
function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Comparison that does not stop at the first differing character. */
function sameKey(a, b) {
  if (a.length !== b.length) { return false; }
  var diff = 0;
  for (var i = 0; i < a.length; i++) { diff |= a.charCodeAt(i) ^ b.charCodeAt(i); }
  return diff === 0;
}

/** Health check: open the /exec URL in a browser; it never sends anything. */
function doGet() {
  return reply({ success: true, service: 'exam mail relay', remaining: MailApp.getRemainingDailyQuota() });
}

/** The Worker's request. Always answers JSON {success, error?, remaining?}. */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var expected = PropertiesService.getScriptProperties().getProperty('MAIL_RELAY_KEY') || '';
    if (!expected || !sameKey(String(data.key || ''), expected)) {
      return reply({ success: false, error: 'unauthorized' });
    }

    var to = String(data.to || '').trim().toLowerCase();
    var domainOk = to.length > ALLOWED_DOMAIN.length + 2 &&
      to.slice(-(ALLOWED_DOMAIN.length + 1)) === '@' + ALLOWED_DOMAIN && to.indexOf(' ') < 0 && to.split('@').length === 2;
    if (!domainOk) { return reply({ success: false, error: 'recipient not allowed' }); }

    var subject = String(data.subject || '').replace(/[\r\n]+/g, ' ').slice(0, MAX_SUBJECT);
    var html = String(data.html || '');
    if (!subject || !html || html.length > MAX_HTML) { return reply({ success: false, error: 'bad message' }); }

    if (MailApp.getRemainingDailyQuota() < 1) { return reply({ success: false, error: 'quota' }); }

    MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: SENDER_NAME });
    return reply({ success: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ success: false, error: String(err && err.message ? err.message : err).slice(0, 200) });
  }
}
