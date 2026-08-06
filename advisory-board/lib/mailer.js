// Delivering the board's decision to whoever asked for it.
//
// The console already sends sign-in links through Brevo (lib/auth.js); this is
// the same transport with attachment support, kept separate so a mail failure
// can never touch the auth path. Delivery is best-effort by design: a run that
// completed is saved and visible in the console no matter what the mail server
// does, so an email failure is reported, never fatal.

const https = require('node:https');
const { envSecret } = require('./config');
const { markdownToPdf } = require('./pdf');

const DOC_TITLE = 'Decisions of the Advisory Board Meeting';

function config() {
  return {
    apiKey: envSecret('BREVO_API_KEY'),
    sender: envSecret('BOARD_MAGIC_FROM') || envSecret('BREVO_SENDER_EMAIL'),
  };
}

function isEnabled() {
  const c = config();
  return !!(c.apiKey && c.sender);
}

function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function postBrevo(payload) {
  const { apiKey } = config();
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const rq = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (rs) => {
        let d = '';
        rs.setEncoding('utf8');
        rs.on('data', (c) => (d += c));
        rs.on('end', () => {
          if (rs.statusCode >= 200 && rs.statusCode < 300) return resolve(JSON.parse(d || '{}'));
          reject(new Error(`Brevo HTTP ${rs.statusCode}: ${d.slice(0, 200)}`));
        });
      }
    );
    rq.setTimeout(60000, () => rq.destroy(new Error('Brevo request timed out')));
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(iso) {
  const d = new Date(iso || Date.now());
  if (isNaN(d)) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${d.getUTCFullYear()}`;
}

function fileSlug(s) {
  return String(s || 'meeting').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'meeting';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds the PDF and mails it. Returns { to, messageId, bytes }.
async function sendDecisionsPdf({ to, run, reportMarkdown }) {
  if (!isEnabled()) throw new Error('Email delivery is not configured (BREVO_API_KEY / sender).');
  if (!looksLikeEmail(to)) throw new Error(`Not an email address: ${to}`);

  const when = longDate(run.finishedAt);
  const members = (run.members || []).map((m) => m.seatName || m.model);
  const subtitle = [
    `Convened ${when}`,
    `${members.length}-member ${run.tier} board`,
    run.chairman ? `chaired by ${run.chairman.model}` : null,
  ].filter(Boolean).join('  ·  ');

  const pdf = markdownToPdf(reportMarkdown, {
    title: DOC_TITLE,
    subtitle,
    footer: DOC_TITLE,
  });

  const question = String(run.question || '').trim();
  const shortQ = question.length > 240 ? question.slice(0, 240) + '…' : question;
  const summaryBits = [
    `Board: ${members.join(', ')}`,
    run.chairman ? `Chairman: ${run.chairman.model}` : null,
    (run.failedMembers || []).length ? `Ran short-handed: ${run.failedMembers.map((m) => m.seatName || m.model).join(', ')} did not answer.` : null,
    run.context ? `Context attached to the question: ${run.context.name}` : null,
  ].filter(Boolean);

  const text = `${DOC_TITLE}
${when}

Your question:
${shortQ}

The full decision - the board's answer, where the members agreed, where they split, and what would resolve the disagreement - is attached as a PDF.

${summaryBits.join('\n')}

This is advisory only: the board argues a position, it does not decide for you.`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1D1D1F;line-height:1.6;max-width:640px">
  <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#1E824C"><strong>Advisory Board</strong></p>
  <h1 style="font-size:22px;margin:0 0 6px">${esc(DOC_TITLE)}</h1>
  <p style="margin:0 0 20px;color:#6E6E73">${esc(when)}</p>
  <p style="margin:0 0 6px;color:#6E6E73">Your question</p>
  <blockquote style="margin:0 0 20px;padding:12px 16px;background:#F5F5F7;border-radius:12px;border-left:3px solid #1E824C">${esc(shortQ)}</blockquote>
  <p>The full decision — the board's answer, where the members agreed, where they split, and what would resolve the disagreement — is attached as a PDF.</p>
  <ul style="color:#6E6E73;padding-left:18px">${summaryBits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
  <p style="color:#6E6E73;font-size:13px;margin-top:22px">This is advisory only: the board argues a position, it does not decide for you.</p>
</div>`;

  const filename = `${DOC_TITLE} - ${fileSlug(run.title)}.pdf`;
  const resp = await postBrevo({
    sender: { email: config().sender, name: 'Advisory Board' },
    to: [{ email: to.trim() }],
    subject: `${DOC_TITLE} — ${run.title || 'your question'}`,
    textContent: text,
    htmlContent: html,
    attachment: [{ content: pdf.toString('base64'), name: filename }],
  });
  return { to: to.trim(), messageId: resp.messageId || null, bytes: pdf.length, filename };
}

module.exports = { sendDecisionsPdf, isEnabled, looksLikeEmail, DOC_TITLE };
