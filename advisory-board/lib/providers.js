// Direct provider calls (no OpenRouter, no SDKs - zero dependencies).
//
// Every call STREAMS (SSE). A frontier model handed a huge prompt - a
// 6-member board's chairman gets the question, the context file, every
// opinion and every review - can legitimately generate for longer than any
// sane fixed request timeout, and a non-streaming request gives no sign of
// life until the final byte. Streaming separates the two failure modes:
//   - a DEAD connection is caught by the idle cap (no bytes at all);
//   - a SLOW-but-alive generation keeps streaming and is allowed to finish,
//     bounded only by the (generous) wall-clock cap.
// With the old non-streaming 20-minute cap, a synthesis that needed 25
// minutes timed out deterministically on every retry - burning ~2 hours of
// retries and a fallback chairman to produce nothing.

const https = require('node:https');
const http = require('node:http');

const WALL_TIMEOUT_MS = 45 * 60 * 1000; // absolute per-call ceiling
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // no bytes at all for this long = dead

// POST `body` to `url` and parse the response as an SSE stream, invoking
// onEvent(parsedJson) for every `data: {...}` line. Resolves when the stream
// ends, rejects on HTTP errors (with the body, so retry classification keeps
// working), idle timeout, wall timeout, or an onEvent throw.
function postSse(url, headers, body, onEvent) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https; // http only for tests
    const payload = JSON.stringify(body);
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; cleanup(); req.destroy(); reject(err); } };
    const done = () => { if (!settled) { settled = true; cleanup(); resolve(); } };

    const wall = setTimeout(
      () => fail(new Error(`Call to ${u.hostname} exceeded the ${Math.round(WALL_TIMEOUT_MS / 60000)} min wall-clock cap`)),
      WALL_TIMEOUT_MS
    );
    let idle = null;
    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => fail(new Error(`Call to ${u.hostname} went silent: no bytes for ${Math.round(IDLE_TIMEOUT_MS / 60000)} min (dead connection)`)),
        IDLE_TIMEOUT_MS
      );
    };
    const cleanup = () => { clearTimeout(wall); clearTimeout(idle); };

    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          accept: 'text/event-stream',
          ...headers,
        },
      },
      (res) => {
        bumpIdle();
        res.setEncoding('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let data = '';
          res.on('data', (c) => { bumpIdle(); data += c; });
          res.on('end', () => fail(new Error(`HTTP ${res.statusCode} from ${u.hostname}: ${data.slice(0, 400)}`)));
          return;
        }
        let buf = '';
        res.on('data', (c) => {
          bumpIdle();
          buf += c;
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue; // event:/comment/blank lines
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; } // partial keep-alives
            try { onEvent(parsed); } catch (err) { return fail(err); }
          }
        });
        res.on('end', done);
        res.on('error', fail);
      }
    );
    req.on('error', fail);
    req.write(payload);
    req.end();
  });
}

async function callAnthropic({ model, system, user, maxTokens, apiKey, baseUrl }) {
  // Thinking: Fable 5 is always-on (omit the param); Opus 5 / Sonnet 5 default
  // to adaptive when omitted. So no thinking config is sent for any tier.
  // Thinking deltas stream too, so a model reasoning at length still feeds the
  // idle timer even before the first text byte.
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = null;
  let stopCategory = null;
  await postSse(
    baseUrl || 'https://api.anthropic.com/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], stream: true },
    (e) => {
      if (e.type === 'message_start' && e.message && e.message.usage) {
        inputTokens = e.message.usage.input_tokens || 0;
      }
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        text += e.delta.text;
      }
      if (e.type === 'message_delta') {
        if (e.delta && e.delta.stop_reason) stopReason = e.delta.stop_reason;
        if (e.delta && e.delta.stop_details && e.delta.stop_details.category) stopCategory = e.delta.stop_details.category;
        if (e.usage && e.usage.output_tokens != null) outputTokens = e.usage.output_tokens;
      }
      if (e.type === 'error') {
        const detail = e.error ? `${e.error.type}: ${e.error.message}` : 'unknown stream error';
        // overloaded_error is the streaming face of HTTP 529 - phrase it so
        // isRetryable's HTTP matcher picks it up.
        if (e.error && e.error.type === 'overloaded_error') throw new Error(`HTTP 529 from api.anthropic.com: ${detail}`);
        throw new Error(`stream error from api.anthropic.com: ${detail}`);
      }
    }
  );
  if (stopReason === 'refusal') {
    throw new Error(`${model} declined the request (refusal${stopCategory ? `, category: ${stopCategory}` : ''})`);
  }
  if (!text.trim()) throw new Error(`${model} returned no text (stop_reason: ${stopReason})`);
  return { text, inputTokens, outputTokens };
}

async function callOpenAI({ model, system, user, maxTokens, apiKey, baseUrl }) {
  // gpt-5.x are reasoning models: max_completion_tokens covers reasoning + text.
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = null;
  await postSse(
    baseUrl || 'https://api.openai.com/v1/chat/completions',
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
    (e) => {
      const choice = e.choices && e.choices[0];
      if (choice && choice.delta && typeof choice.delta.content === 'string') text += choice.delta.content;
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      if (e.usage) {
        inputTokens = e.usage.prompt_tokens || 0;
        outputTokens = e.usage.completion_tokens || 0;
      }
      if (e.error) throw new Error(`stream error from api.openai.com: ${e.error.message || JSON.stringify(e.error).slice(0, 200)}`);
    }
  );
  if (!text.trim()) throw new Error(`${model} returned no text (finish_reason: ${finishReason})`);
  return { text, inputTokens, outputTokens };
}

async function callGoogle({ model, system, user, maxTokens, apiKey, baseUrl }) {
  let text = '';
  let finishReason = null;
  let usage = {};
  await postSse(
    (baseUrl || `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`) + `?alt=sse&key=${apiKey}`,
    {},
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    },
    (e) => {
      const cand = e.candidates && e.candidates[0];
      if (cand && cand.content && cand.content.parts) {
        for (const p of cand.content.parts) if (p.text) text += p.text;
      }
      if (cand && cand.finishReason) finishReason = cand.finishReason;
      if (e.usageMetadata) usage = e.usageMetadata;
      if (e.error) throw new Error(`stream error from generativelanguage.googleapis.com: ${e.error.message || JSON.stringify(e.error).slice(0, 200)}`);
    }
  );
  if (!text.trim()) throw new Error(`${model} returned no text (finishReason: ${finishReason})`);
  // Output billing includes thinking tokens.
  const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return { text, inputTokens: usage.promptTokenCount || 0, outputTokens };
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle };

// Retryable: rate limits (429), server errors (5xx incl. Anthropic's 529
// overloaded), and network failures. NOT retryable: 4xx request errors,
// refusals, empty responses.
function isRetryable(err) {
  const m = err.message || '';
  const httpMatch = m.match(/^HTTP (\d{3}) /);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    return code === 429 || code === 408 || code >= 500;
  }
  // Non-HTTP errors from the transport layer (ECONNRESET, timeouts, a stream
  // that went silent) are worth one more try; provider-content errors are not.
  return !/declined the request|returned no text|No API key|Unknown provider/.test(m);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// member: { provider, model, inPerM, outPerM }. Returns text + tokens + dollar cost.
// Retries retryable failures with exponential backoff + jitter (3 attempts total).
async function callModel(member, { system, user, maxTokens }, keys, { maxAttempts = 3 } = {}) {
  const caller = CALLERS[member.provider];
  if (!caller) throw new Error(`Unknown provider: ${member.provider}`);
  const apiKey = keys[member.provider];
  if (!apiKey) throw new Error(`No API key configured for ${member.provider}`);
  const started = Date.now();
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const out = await caller({ model: member.model, system, user, maxTokens, apiKey });
      const costUsd =
        (out.inputTokens / 1e6) * member.inPerM + (out.outputTokens / 1e6) * member.outPerM;
      return { ...out, costUsd, ms: Date.now() - started, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) break;
      await sleep(2000 * 2 ** (attempt - 1) + Math.random() * 1000);
    }
  }
  throw lastErr;
}

module.exports = { callModel, callAnthropic, callOpenAI, callGoogle };
