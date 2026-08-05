#!/usr/bin/env node
// Web console for the Advisory Board - the cockpit on top of the CLI.
//
// Two modes, decided by whether BOARD_ACCESS_KEY is set:
//   - Local (no key):  binds 127.0.0.1 ONLY, no auth. Same as always.
//       node console.js          ->  http://127.0.0.1:4821
//   - Hosted (key set): binds 0.0.0.0 and EVERY /api/* endpoint requires the
//       key (Authorization: Bearer, or ?key= for EventSource). Runs spend API
//       credit, so a public bind without a key is impossible by construction.
//
// Advisory only, same as the CLI: convenes boards, persists records, never
// writes to any other system.

const http = require('node:http');
const crypto = require('node:crypto');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

const { loadKeys, TIERS, DEFAULT_TIER, DEFAULT_PROVIDERS } = require('./lib/config');
const { convene } = require('./lib/council');
const { saveRun, RUNS_DIR } = require('./lib/store');

// 4821 locally (not the source project's 4820) so both consoles can run side
// by side; hosted platforms (Render) inject PORT.
const PORT = Number(process.env.PORT || process.env.BOARD_CONSOLE_PORT || 4821);
const ACCESS_KEY = process.env.BOARD_ACCESS_KEY || null;
const HOST = ACCESS_KEY ? '0.0.0.0' : '127.0.0.1';

function authed(req, u) {
  if (!ACCESS_KEY) return true; // local mode: loopback-only bind is the gate
  const header = req.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : u.searchParams.get('key');
  if (!candidate) return false;
  const ha = crypto.createHash('sha256').update(candidate).digest();
  const hb = crypto.createHash('sha256').update(ACCESS_KEY).digest();
  return crypto.timingSafeEqual(ha, hb);
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
        chairmanOverride: opts.chairman || null,
        keys: loadKeys(),
        log: (m) => broadcast({ type: 'log', tier, line: m }),
      });
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
        tier: r.tier,
        mixedTier: !!r.mixedTier,
        at: r.finishedAt,
        members: (r.members || []).map((m) => m.model),
        costUsd: r.cost ? r.cost.totalUsd : null,
        shortHanded: (r.failedMembers || []).length > 0,
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

  // Public: the UI shell (no secrets in it) and the health check.
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    const html = readFileSync(path.join(__dirname, 'public', 'console.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (req.method === 'GET' && u.pathname === '/healthz') {
    return json(res, 200, { ok: true });
  }

  // Everything below reads records or spends money: key-gated in hosted mode.
  if (!authed(req, u)) {
    return json(res, 401, { error: 'unauthorized: this console requires an access key' });
  }

  if (req.method === 'GET' && u.pathname === '/api/config') {
    return json(res, 200, {
      tiers: TIERS,
      defaultTier: DEFAULT_TIER,
      defaultProviders: DEFAULT_PROVIDERS,
      running,
    });
  }

  if (req.method === 'GET' && u.pathname === '/api/runs') {
    return json(res, 200, listRuns());
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
      // keys are validated up front so a missing key fails the request, not the run
      try {
        const keys = loadKeys();
        for (const spec of opts.providers) {
          const p = String(spec).split(':')[0];
          if (!keys[p]) return json(res, 400, { error: `No API key configured for ${p}.` });
        }
      } catch (err) { return json(res, 500, { error: err.message }); }
      startRun({ question: String(opts.question), tier, providers: opts.providers.map(String), chairman: opts.chairman || null, compare });
      json(res, 202, { ok: true });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  if (ACCESS_KEY) {
    console.log(`Advisory Board console: listening on ${HOST}:${PORT} (HOSTED mode - every /api endpoint requires the access key)`);
  } else {
    console.log(`Advisory Board console: http://${HOST}:${PORT}  (local only, no auth; set BOARD_ACCESS_KEY to host publicly; Ctrl-C to stop)`);
  }
});
