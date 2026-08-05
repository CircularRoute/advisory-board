#!/usr/bin/env node
// Web console for the Advisory Board - the cockpit on top of the CLI.
//
// Two modes, decided by whether any auth is configured:
//   - Local (no auth configured): binds 127.0.0.1 ONLY, no auth. Same as always.
//       node console.js          ->  http://127.0.0.1:4821
//   - Hosted (BOARD_ACCESS_KEY and/or magic-link email auth configured):
//       binds 0.0.0.0 and EVERY /api/* endpoint requires either a signed-in
//       session cookie (magic link, see lib/auth.js) or the access key
//       (Authorization: Bearer / ?key=). Runs spend API credit, so a public
//       bind without auth is impossible by construction.
//
// Advisory only, same as the CLI: convenes boards, persists records, never
// writes to any other system.

const http = require('node:http');
const crypto = require('node:crypto');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

const { loadKeys, TIERS, DEFAULT_TIER, DEFAULT_PROVIDERS, EXTENDED_SEAT_PROVIDERS } = require('./lib/config');
const { convene, ROLES } = require('./lib/council');
const { saveRun, RUNS_DIR } = require('./lib/store');
const auth = require('./lib/auth');

// 4821 locally (not the source project's 4820) so both consoles can run side
// by side; hosted platforms (Render) inject PORT.
const PORT = Number(process.env.PORT || process.env.BOARD_CONSOLE_PORT || 4821);
const ACCESS_KEY = process.env.BOARD_ACCESS_KEY || null;
const MAGIC = auth.isEnabled();
const HOSTED = !!(ACCESS_KEY || MAGIC);
const HOST = HOSTED ? '0.0.0.0' : '127.0.0.1';

function authed(req, u) {
  if (!HOSTED) return true; // local mode: loopback-only bind is the gate
  if (MAGIC && auth.sessionEmail(req.headers.cookie)) return true;
  if (!ACCESS_KEY) return false;
  const header = req.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : u.searchParams.get('key');
  if (!candidate) return false;
  const ha = crypto.createHash('sha256').update(candidate).digest();
  const hb = crypto.createHash('sha256').update(ACCESS_KEY).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Public base URL for building sign-in links: explicit env, Render's own env
// var, or derived from the request (proxy-aware).
function baseUrlFor(req) {
  if (process.env.BOARD_BASE_URL) return process.env.BOARD_BASE_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}`;
}

function isSecure(req) {
  return (req.headers['x-forwarded-proto'] || '') === 'https';
}

// ---- single-run state + SSE fanout ----
let running = false;
const subscribers = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(line);
}

async function startRun(opts) {
  running = true;
  broadcast({ type: 'started', opts: { tier: opts.tier, providers: opts.providers, compare: opts.compare } });
  try {
    const tiers = opts.compare && opts.compare.length ? opts.compare : [opts.tier];
    const results = [];
    for (const tier of tiers) {
      const run = await convene({
        question: opts.question,
        tier,
        providers: opts.providers,
        extras: opts.extras || [],
        baseRoles: opts.baseRoles || [],
        chairmanOverride: opts.chairman || null,
        keys: loadKeys(),
        log: (m) => broadcast({ type: 'log', tier, line: m }),
        onEvent: (e) => broadcast({ type: 'engine', tier, e }),
      });
      run.askedBy = opts.askedBy || null; // who convened this board (admin history)
      const dir = saveRun(run);
      broadcast({ type: 'run-done', tier, dir: path.basename(dir) });
      results.push({ tier, dir: path.basename(dir), run });
    }
    broadcast({
      type: 'done',
      results: results.map((r) => ({
        tier: r.tier,
        dir: r.dir,
        title: r.run.title,
        finalAnswer: r.run.finalAnswer,
        chairman: r.run.chairman,
        members: r.run.members,
        failedMembers: r.run.failedMembers,
        leaderboard: r.run.leaderboard,
        cost: { totalUsd: r.run.cost.totalUsd, prepaidUsd: r.run.cost.prepaidUsd, outOfPocketUsd: r.run.cost.outOfPocketUsd },
        warnings: r.run.warnings,
      })),
    });
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
  } finally {
    running = false;
  }
}

// ---- voice transcription (OpenAI audio API, raw multipart over https) ----
const https = require('node:https');

function transcribeAudio(audio, contentType, apiKey) {
  const ct = (contentType || 'audio/webm').split(';')[0].trim();
  const ext =
    { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
      'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac' }[ct] || 'webm';
  const tryModel = (model) =>
    new Promise((resolve, reject) => {
      const boundary = '----board' + crypto.randomBytes(10).toString('hex');
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${ct}\r\n\r\n`
        ),
        audio,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const rq = https.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': body.length,
          },
        },
        (rs) => {
          let d = '';
          rs.setEncoding('utf8');
          rs.on('data', (c) => (d += c));
          rs.on('end', () => {
            if (rs.statusCode < 200 || rs.statusCode >= 300) {
              return reject(new Error(`HTTP ${rs.statusCode}: ${d.slice(0, 200)}`));
            }
            try {
              const parsed = JSON.parse(d);
              if (!parsed.text || !parsed.text.trim()) return reject(new Error('empty transcript'));
              resolve(parsed.text.trim());
            } catch {
              reject(new Error('bad JSON from transcription API'));
            }
          });
        }
      );
      rq.setTimeout(120000, () => rq.destroy(new Error('transcription timed out')));
      rq.on('error', reject);
      rq.write(body);
      rq.end();
    });
  // Prefer the cheaper 4o-mini transcription model; fall back to whisper-1 if
  // this account/model combination rejects it.
  return tryModel('gpt-4o-mini-transcribe').catch((err) => {
    if (/model/i.test(err.message) || /HTTP 40[04]/.test(err.message)) return tryModel('whisper-1');
    throw err;
  });
}

// ---- helpers ----
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function listRuns(limit = 25) {
  if (!existsSync(RUNS_DIR)) return [];
  const dirs = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'comparisons')
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);
  const out = [];
  for (const dir of dirs) {
    try {
      const r = JSON.parse(readFileSync(path.join(RUNS_DIR, dir, 'run.json'), 'utf8'));
      out.push({
        dir,
        title: r.title,
        question: r.question || null,
        tier: r.tier,
        mixedTier: !!r.mixedTier,
        at: r.finishedAt,
        members: (r.members || []).map((m) => m.seatName || m.model),
        costUsd: r.cost ? r.cost.totalUsd : null,
        shortHanded: (r.failedMembers || []).length > 0,
      });
    } catch { /* skip unreadable run dirs */ }
  }
  return out;
}
// Admin: locally (no auth) the single user is the admin; hosted, only the
// magic-link session whose email matches BOARD_ADMIN_EMAIL.
function isAdminReq(req) {
  if (!HOSTED) return true;
  return auth.isAdminEmail(auth.sessionEmail(req.headers.cookie));
}

// Injected into the page ONLY for admin requests (see the '/' route). Talks
// to the main script through window.__board; polls briefly because the main
// script initialises asynchronously.
const ADMIN_FRAGMENT = `
      <div class="card" id="adminCard">
        <h2>All questions — admin</h2>
        <ul class="runlist" id="historyList"><li>Loading...</li></ul>
        <div class="hint">Every question put to the board: who asked it, when, at which tier, and what it cost. Tap a row for the full report including the final response. Only you see this section.</div>
      </div>
      <script>
      (function () {
        function init() {
          var B = window.__board;
          B.apiFetch('/api/history').then(function (r) { return r.json(); }).then(function (hist) {
            var el = document.getElementById('historyList');
            if (!hist.length) { el.innerHTML = '<li>No runs yet.</li>'; return; }
            el.innerHTML = hist.map(function (h) {
              var q = h.question.length > 160 ? h.question.slice(0, 160) + '\\u2026' : h.question;
              return '<li class="hrow" data-dir="' + B.esc(h.dir) + '"><span class="q">' + B.esc(q) + '</span>' +
                '<span class="sub">' + B.esc(h.askedBy || 'unknown') + ' \\u00b7 ' +
                B.esc((h.at || '').slice(0, 16).replace('T', ' ')) + ' \\u00b7 ' + B.esc(h.tier) +
                (h.costUsd != null ? ' \\u00b7 $' + h.costUsd.toFixed(2) + (h.outOfPocketUsd ? ' (oop $' + h.outOfPocketUsd.toFixed(2) + ')' : '') : '') +
                '</span></li>';
            }).join('');
            el.querySelectorAll('li[data-dir]').forEach(function (li) {
              li.addEventListener('click', function () { B.openReport(li.dataset.dir); });
            });
          }).catch(function () {
            document.getElementById('historyList').innerHTML = '<li>Could not load history.</li>';
          });
        }
        if (window.__board) init();
        else window.addEventListener('board-ready', init, { once: true });
      })();
      <\/script>`;

// The full record every question leaves behind, for the admin view: who
// asked, the question, the final response, and what it cost us.
function listHistory() {
  if (!existsSync(RUNS_DIR)) return [];
  const dirs = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'comparisons')
    .map((d) => d.name)
    .sort()
    .reverse();
  const out = [];
  for (const dir of dirs) {
    try {
      const r = JSON.parse(readFileSync(path.join(RUNS_DIR, dir, 'run.json'), 'utf8'));
      out.push({
        dir,
        at: r.finishedAt,
        title: r.title,
        question: r.question || '',
        askedBy: r.askedBy || null,
        tier: r.tier,
        costUsd: r.cost ? r.cost.totalUsd : null,
        outOfPocketUsd: r.cost ? r.cost.outOfPocketUsd : null,
      });
    } catch { /* skip unreadable run dirs */ }
  }
  return out;
}

function safeRunFile(dirName, file) {
  // dir names are our own stamp-slug format; refuse anything path-like
  if (!/^[a-z0-9-]+$/i.test(dirName)) return null;
  const p = path.join(RUNS_DIR, dirName, file);
  return existsSync(p) ? p : null;
}

// ---- server ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);

  // Public: the UI shell and the health check. The page carries ZERO trace of
  // the admin function unless this very request belongs to the admin - the
  // fragment is injected server-side at a neutral marker, so non-admins can't
  // learn it exists even from the page source. no-store so no cache can ever
  // hand the admin variant to someone else.
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    let html = readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    // Function form: a plain string replacement would interpret $-patterns
    // (the fragment contains "$'", which splices in the rest of the page).
    html = html.replace('<!-- @X@ -->', () => (isAdminReq(req) ? ADMIN_FRAGMENT : ''));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && u.pathname === '/healthz') {
    return json(res, 200, { ok: true });
  }

  // PWA assets are public: the install icon and manifest must load before auth.
  const staticFile = {
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
    '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
    '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  }[u.pathname];
  if (req.method === 'GET' && staticFile) {
    try {
      const data = readFileSync(path.join(__dirname, 'public', staticFile[0]));
      res.writeHead(200, { 'content-type': staticFile[1], 'cache-control': 'public, max-age=86400' });
      return res.end(data);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  // ---- magic-link auth endpoints (public by nature) ----
  const cookieAttrs = (v) =>
    `${auth.COOKIE_NAME}=${v}; Path=/; Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;

  if (req.method === 'POST' && u.pathname === '/auth/request') {
    if (!MAGIC) return json(res, 400, { error: 'Email sign-in is not configured on this deployment.' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let email;
      try { email = JSON.parse(body).email; } catch { return json(res, 400, { error: 'bad JSON' }); }
      try {
        json(res, 200, await auth.requestLink(email, baseUrlFor(req)));
      } catch (err) {
        console.error('[auth] send failed:', err.message);
        json(res, 502, { error: 'Could not send the sign-in email. Try again, or use the access key.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/auth/verify') {
    const cookieValue = MAGIC ? auth.verifyToken(u.searchParams.get('token')) : null;
    const ok = !!cookieValue;
    res.writeHead(ok ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8',
      ...(ok ? { 'set-cookie': cookieAttrs(cookieValue) } : {}),
    });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Advisory Board</title>
<body style="font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.2rem;line-height:1.6">
${ok
  ? '<h2>Signed in.</h2><p>The console page or app you requested this from signs itself in within a few seconds - you can return to it and close this tab.</p><p>Or continue right here: <a href="/">open the Board Console</a>.</p>'
  : '<h2>This link is no longer valid.</h2><p>Sign-in links work once and expire after 15 minutes. <a href="/">Request a fresh one.</a></p>'}
</body>`);
  }

  if (req.method === 'GET' && u.pathname === '/auth/poll') {
    if (!MAGIC) return json(res, 400, { status: 'unavailable' });
    const result = auth.pollRequest(u.searchParams.get('rid'));
    if (result.status === 'approved') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookieAttrs(result.cookieValue) });
      return res.end(JSON.stringify({ status: 'approved', email: result.email }));
    }
    return json(res, 200, { status: result.status });
  }

  if (req.method === 'GET' && u.pathname === '/auth/me') {
    const email = MAGIC ? auth.sessionEmail(req.headers.cookie) : null;
    // The admin field exists only in responses to the admin - its absence is
    // indistinguishable from the feature not existing.
    const payload = { authed: authed(req, u), email, magic: MAGIC, hosted: HOSTED };
    if (isAdminReq(req)) payload.admin = true;
    return json(res, 200, payload);
  }

  if (req.method === 'POST' && u.pathname === '/auth/logout') {
    auth.destroySession(req.headers.cookie);
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `${auth.COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Everything below reads records or spends money: gated in hosted mode
  // (session cookie from a magic link, or the access key).
  if (!authed(req, u)) {
    return json(res, 401, { error: 'unauthorized: sign in with an authorized email (or provide the access key)' });
  }

  if (req.method === 'GET' && u.pathname === '/api/config') {
    return json(res, 200, {
      tiers: TIERS,
      defaultTier: DEFAULT_TIER,
      defaultProviders: DEFAULT_PROVIDERS,
      roles: Object.entries(ROLES).map(([key, r]) => ({ key, name: r.name, blurb: r.blurb })),
      extendedSeats: EXTENDED_SEAT_PROVIDERS,
      running,
    });
  }

  if (req.method === 'GET' && u.pathname === '/api/runs') {
    return json(res, 200, listRuns());
  }

  if (req.method === 'GET' && u.pathname === '/api/history') {
    // Non-admins get the same 404 as any unknown route - probing this path
    // must not reveal that an admin function exists.
    if (!isAdminReq(req)) return json(res, 404, { error: 'not found' });
    return json(res, 200, listHistory());
  }

  if (req.method === 'GET' && u.pathname === '/api/report') {
    const p = safeRunFile(u.searchParams.get('dir') || '', 'report.md');
    if (!p) return json(res, 404, { error: 'no such run' });
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    return res.end(readFileSync(p));
  }

  if (req.method === 'GET' && u.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', running })}\n\n`);
    subscribers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); subscribers.delete(res); });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/transcribe') {
    let keys;
    try { keys = loadKeys(); } catch (err) { return json(res, 500, { error: err.message }); }
    if (!keys.openai) return json(res, 400, { error: 'Voice input needs OPENAI_API_KEY configured.' });
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20e6 && !aborted) { // OpenAI caps uploads at 25MB; stop earlier
        aborted = true;
        json(res, 413, { error: 'Recording too large (20MB cap) - keep it under ~2 minutes.' });
        req.destroy();
        return;
      }
      if (!aborted) chunks.push(c);
    });
    req.on('end', async () => {
      if (aborted) return;
      if (!chunks.length) return json(res, 400, { error: 'No audio received.' });
      try {
        const text = await transcribeAudio(Buffer.concat(chunks), req.headers['content-type'], keys.openai);
        json(res, 200, { text });
      } catch (err) {
        json(res, 502, { error: `Transcription failed: ${err.message}` });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/run') {
    if (running) return json(res, 409, { error: 'A board is already convened; wait for it to finish.' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let opts;
      try { opts = JSON.parse(body); } catch { return json(res, 400, { error: 'bad JSON' }); }
      if (!opts.question || !String(opts.question).trim()) return json(res, 400, { error: 'A question is required.' });
      if (!Array.isArray(opts.providers) || opts.providers.length < 2) return json(res, 400, { error: 'Seat at least two providers.' });
      const tier = opts.tier && TIERS[opts.tier] ? opts.tier : DEFAULT_TIER;
      const compare = Array.isArray(opts.compare) ? opts.compare.filter((t) => TIERS[t]) : [];
      // Extended board: 2 roles -> +Claude +GPT (5 members); 4 roles ->
      // +Claude +GPT +Gemini +Claude (7 members).
      const extendedRoles = Array.isArray(opts.extended) ? opts.extended.map(String) : [];
      let extras = [];
      if (extendedRoles.length) {
        const pattern = EXTENDED_SEAT_PROVIDERS[extendedRoles.length];
        if (!pattern) return json(res, 400, { error: 'The extended board takes exactly 2 or 4 role assignments.' });
        for (const r of extendedRoles) if (!ROLES[r]) return json(res, 400, { error: `Unknown role: ${r}` });
        extras = extendedRoles.map((role, i) => ({ provider: pattern[i], role }));
      }
      // Optional roles for the base (first three) members, aligned by index.
      const baseRoles = Array.isArray(opts.baseRoles)
        ? opts.baseRoles.slice(0, opts.providers.length).map((r) => (r ? String(r) : null))
        : [];
      for (const r of baseRoles) if (r && !ROLES[r]) return json(res, 400, { error: `Unknown role: ${r}` });
      // keys are validated up front so a missing key fails the request, not the run
      try {
        const keys = loadKeys();
        for (const spec of [...opts.providers, ...extras.map((e) => e.provider)]) {
          const p = String(spec).split(':')[0];
          if (!keys[p]) return json(res, 400, { error: `No API key configured for ${p}.` });
        }
      } catch (err) { return json(res, 500, { error: err.message }); }
      const askedBy =
        (MAGIC && auth.sessionEmail(req.headers.cookie)) || (HOSTED ? 'access-key' : 'local');
      startRun({ question: String(opts.question), tier, providers: opts.providers.map(String), chairman: opts.chairman || null, compare, extras, baseRoles, askedBy });
      json(res, 202, { ok: true });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  for (const p of auth.configProblems()) console.error(`[auth] WARNING: ${p} - email sign-in disabled`);
  if (HOSTED) {
    const modes = [MAGIC ? `magic-link email auth (${auth.allowedEmails().length} authorized address(es))` : null, ACCESS_KEY ? 'access key' : null]
      .filter(Boolean)
      .join(' + ');
    console.log(`Advisory Board console: listening on ${HOST}:${PORT} (HOSTED mode - auth: ${modes})`);
  } else {
    console.log(`Advisory Board console: http://${HOST}:${PORT}  (local only, no auth; set BOARD_ACCESS_KEY and/or BOARD_ALLOWED_EMAILS to host publicly; Ctrl-C to stop)`);
  }
});
