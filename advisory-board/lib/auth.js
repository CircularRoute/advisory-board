// Magic-link email authorization for the console (hosted mode).
//
// Flow: the user enters their email on the console -> if it is on the
// BOARD_ALLOWED_EMAILS allowlist, a single-use sign-in link (15 min TTL) is
// emailed via Brevo's HTTP API. The console then POLLS with a request id;
// when the link is clicked ANYWHERE (mail app, Safari), the polling console
// receives its own session cookie. This matters for the installed PWA on
// iOS, whose cookie jar is separate from Safari's - the emailed link could
// never set the PWA's cookie directly.
//
// Sessions (90 days) and pending tokens persist next to the runs dir, so a
// hosted redeploy does not sign everyone out. Only SHA-256 hashes of secrets
// are stored; raw tokens/cookies exist only in the email link and browsers.
//
// Zero dependencies, same as the rest of the tool.

const crypto = require('node:crypto');
const https = require('node:https');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { envSecret } = require('./config');
const { RUNS_DIR } = require('./store');

const SESSIONS_FILE =
  process.env.BOARD_SESSIONS_FILE || path.join(path.dirname(RUNS_DIR), 'board-sessions.json');
const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const COOKIE_NAME = 'board_session';
const HEX64 = /^[a-f0-9]{64}$/;

// ---- configuration ----

function allowedEmails() {
  return (envSecret('BOARD_ALLOWED_EMAILS') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function brevoConfig() {
  return {
    apiKey: envSecret('BREVO_API_KEY'),
    sender: envSecret('BOARD_MAGIC_FROM') || envSecret('BREVO_SENDER_EMAIL'),
  };
}

// Magic-link auth is enabled only when fully configured; a partial config is
// reported loudly at startup rather than silently half-working.
function isEnabled() {
  const { apiKey, sender } = brevoConfig();
  return allowedEmails().length > 0 && !!apiKey && !!sender;
}

// The admin (BOARD_ADMIN_EMAIL, set in the Render environment) additionally
// sees the history of all questions: who asked, the final response, the cost.
function isAdminEmail(email) {
  const admin = (envSecret('BOARD_ADMIN_EMAIL') || '').trim().toLowerCase();
  return !!admin && !!email && admin === String(email).trim().toLowerCase();
}

function configProblems() {
  const problems = [];
  if (allowedEmails().length > 0) {
    const { apiKey, sender } = brevoConfig();
    if (!apiKey) problems.push('BOARD_ALLOWED_EMAILS is set but BREVO_API_KEY is missing');
    if (!sender) problems.push('BOARD_ALLOWED_EMAILS is set but no sender (BOARD_MAGIC_FROM / BREVO_SENDER_EMAIL)');
  }
  return problems;
}

// ---- persistence ----

function loadState() {
  try {
    const s = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    return { sessions: s.sessions || {}, tokens: s.tokens || {}, pending: s.pending || {} };
  } catch {
    return { sessions: {}, tokens: {}, pending: {} };
  }
}

function saveState(state) {
  const now = Date.now();
  for (const bucket of ['tokens', 'sessions', 'pending']) {
    for (const [k, v] of Object.entries(state[bucket])) if (v.expiresAt < now) delete state[bucket][k];
  }
  mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(state, null, 2));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- rate limiting (in-memory; resets on restart, which is fine) ----

// Asking again is normal (the first mail went to spam, the link expired, the
// phone was elsewhere), so re-sends are allowed freely - throttled only enough
// to stop someone mail-bombing an authorized address. Two limits:
//   - a short cooldown between links, so a double-tap does not send twice;
//   - a ceiling per window, well above ordinary retrying.
// Checked BEFORE the allowlist, so an unauthorized address is throttled the
// same way and the responses still reveal nothing about who is authorized.
const RESEND_COOLDOWN_MS = 20 * 1000;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 8;

const recentRequests = new Map(); // email -> [timestamps]
// Returns null when the request may proceed, else { waitSec, message }.
function rateLimitCheck(email) {
  const now = Date.now();
  const list = (recentRequests.get(email) || []).filter((t) => now - t < REQUEST_WINDOW_MS);
  const last = list[list.length - 1];
  if (last && now - last < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000);
    return { waitSec, message: `A sign-in link was just sent - check your inbox and spam folder. You can ask for another in ${waitSec} seconds.` };
  }
  if (list.length >= MAX_PER_WINDOW) {
    const waitSec = Math.ceil((REQUEST_WINDOW_MS - (now - list[0])) / 1000);
    return { waitSec, message: `That is a lot of sign-in requests for one address. Try again in ${Math.ceil(waitSec / 60)} minute(s).` };
  }
  list.push(now);
  recentRequests.set(email, list);
  return null;
}

// ---- Brevo transactional email (raw https, no SDK) ----

function sendEmail(to, subject, textContent, htmlContent) {
  const { apiKey, sender } = brevoConfig();
  const body = JSON.stringify({
    sender: { email: sender, name: 'Advisory Board' },
    to: [{ email: to }],
    subject,
    textContent,
    htmlContent,
  });
  return new Promise((resolve, reject) => {
    const rq = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (rs) => {
        let d = '';
        rs.setEncoding('utf8');
        rs.on('data', (c) => (d += c));
        rs.on('end', () => {
          if (rs.statusCode >= 200 && rs.statusCode < 300) resolve();
          else reject(new Error(`Brevo HTTP ${rs.statusCode}: ${d.slice(0, 200)}`));
        });
      }
    );
    rq.setTimeout(30000, () => rq.destroy(new Error('Brevo request timed out')));
    rq.on('error', reject);
    rq.write(body);
    rq.end();
  });
}

// ---- the flow ----

// Step 1: request a link. Always returns the same generic message and a
// request id to poll - for unauthorized addresses the id never approves, so
// nothing about the allowlist leaks. Sending failures for AUTHORIZED
// addresses are thrown loudly, not swallowed.
async function requestLink(rawEmail, baseUrl) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const requestId = crypto.randomBytes(32).toString('hex');
  const generic = 'If that address is authorized, a sign-in link is on its way (valid 15 minutes). Leave this page open - it signs itself in when you tap the link.';
  const ok = { message: generic, requestId };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ok;
  // A throttled request says so plainly instead of claiming a link is on its
  // way: silently dropping it is what made a second attempt look broken.
  const limited = rateLimitCheck(email);
  // No requestId on a throttled reply: the caller must keep polling the id it
  // already has, because the link from the previous request is still live and
  // tapping it must still sign this page in.
  if (limited) return { message: limited.message, retryAfterSec: limited.waitSec, throttled: true };
  if (!allowedEmails().includes(email)) return ok;

  const token = crypto.randomBytes(32).toString('hex');
  const state = loadState();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  // Newest link wins: retire this address's earlier links and the pages
  // waiting on them. Otherwise a second request leaves two live links, and
  // tapping the older one signs in that tab while the page that asked for the
  // newer one polls forever - looking, again, like nothing was sent.
  for (const [k, v] of Object.entries(state.tokens)) if (v.email === email) delete state.tokens[k];
  for (const [k, v] of Object.entries(state.pending)) if (v.email === email && !v.approved) delete state.pending[k];
  state.tokens[sha(token)] = { email, rid: sha(requestId), expiresAt };
  state.pending[sha(requestId)] = { email, approved: false, expiresAt };
  saveState(state);

  const link = `${baseUrl}/auth/verify?token=${token}`;
  await sendEmail(
    email,
    'Your Advisory Board sign-in link',
    `Sign in to the Advisory Board console:\n\n${link}\n\nThe link is valid for 15 minutes and works once. The console page or app you requested it from will sign itself in when you open the link. If you did not request it, ignore this email.`,
    `<p>Sign in to the <strong>Advisory Board</strong> console:</p>
     <p style="margin:18px 0"><a href="${link}" style="background:#1E824C;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open the Board Console</a></p>
     <p style="color:#666;font-size:13px">The link is valid for 15 minutes and works once. The console page or app you requested it from signs itself in when you open the link. If you did not request it, ignore this email.</p>`
  );
  return ok;
}

// Step 2a: the emailed link is clicked. Marks the pending request approved
// (so the polling console gets its own cookie) AND returns a cookie for the
// browser that opened the link. Null if invalid/expired; tokens are single
// use and are spent even when expired.
function verifyToken(token) {
  if (!token || !HEX64.test(token)) return null;
  const state = loadState();
  const key = sha(token);
  const entry = state.tokens[key];
  delete state.tokens[key];
  if (!entry || entry.expiresAt < Date.now()) {
    saveState(state);
    return null;
  }
  if (state.pending[entry.rid]) state.pending[entry.rid].approved = true;
  const cookieValue = newSession(state, entry.email);
  saveState(state);
  return cookieValue;
}

// Step 2b: the console polls its request id. Approved -> it gets its own
// session cookie (critical for the installed PWA, whose cookies are separate
// from the browser that opened the email link).
function pollRequest(rid) {
  if (!rid || !HEX64.test(rid)) return { status: 'pending' };
  const state = loadState();
  const key = sha(rid);
  const entry = state.pending[key];
  if (!entry || !entry.approved) return { status: 'pending' };
  delete state.pending[key];
  const cookieValue = newSession(state, entry.email);
  saveState(state);
  return { status: 'approved', cookieValue, email: entry.email };
}

function newSession(state, email) {
  const cookieValue = crypto.randomBytes(32).toString('hex');
  state.sessions[sha(cookieValue)] = {
    email,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  return cookieValue;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Returns the signed-in email for a request's Cookie header, or null.
function sessionEmail(cookieHeader) {
  const value = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!value || !HEX64.test(value)) return null;
  const entry = loadState().sessions[sha(value)];
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.email;
}

function destroySession(cookieHeader) {
  const value = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!value) return;
  const state = loadState();
  delete state.sessions[sha(value)];
  saveState(state);
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  isEnabled,
  isAdminEmail,
  configProblems,
  allowedEmails,
  requestLink,
  verifyToken,
  pollRequest,
  sessionEmail,
  destroySession,
};
