// Direct provider calls (no OpenRouter, no SDKs - zero dependencies).
// Uses node:https directly so long frontier-model turns (minutes of thinking
// before any byte arrives) never trip an HTTP-client idle timeout; a hard
// wall-clock cap is enforced per call instead.

const https = require('node:https');

const CALL_TIMEOUT_MS = 20 * 60 * 1000; // hard per-call ceiling

function postJson(url, headers, body, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} from ${u.hostname}: ${data.slice(0, 400)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Bad JSON from ${u.hostname}: ${err.message}`));
          }
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`Call to ${u.hostname} exceeded ${Math.round(timeoutMs / 60000)} min wall-clock cap`));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('close', () => clearTimeout(timer));
    req.write(payload);
    req.end();
  });
}

async function callAnthropic({ model, system, user, maxTokens, apiKey }) {
  // Thinking: Fable 5 is always-on (omit the param); Opus 5 / Sonnet 5 default
  // to adaptive when omitted. So no thinking config is sent for any tier.
  const resp = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }
  );
  if (resp.stop_reason === 'refusal') {
    const cat = resp.stop_details && resp.stop_details.category;
    throw new Error(`${model} declined the request (refusal${cat ? `, category: ${cat}` : ''})`);
  }
  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text.trim()) throw new Error(`${model} returned no text (stop_reason: ${resp.stop_reason})`);
  return { text, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
}

async function callOpenAI({ model, system, user, maxTokens, apiKey }) {
  // gpt-5.x are reasoning models: max_completion_tokens covers reasoning + text.
  const resp = await postJson(
    'https://api.openai.com/v1/chat/completions',
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }
  );
  const choice = resp.choices && resp.choices[0];
  const text = choice && choice.message && choice.message.content;
  if (!text || !text.trim()) {
    throw new Error(`${model} returned no text (finish_reason: ${choice && choice.finish_reason})`);
  }
  return { text, inputTokens: resp.usage.prompt_tokens, outputTokens: resp.usage.completion_tokens };
}

async function callGoogle({ model, system, user, maxTokens, apiKey }) {
  const resp = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {},
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }
  );
  const cand = resp.candidates && resp.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || [])
    .map((p) => p.text || '')
    .join('');
  if (!text.trim()) {
    throw new Error(`${model} returned no text (finishReason: ${cand && cand.finishReason})`);
  }
  const um = resp.usageMetadata || {};
  // Output billing includes thinking tokens.
  const outputTokens = (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0);
  return { text, inputTokens: um.promptTokenCount || 0, outputTokens };
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
  // Non-HTTP errors from the transport layer (ECONNRESET, timeouts, bad JSON
  // from a proxy) are worth one more try; provider-content errors are not.
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

module.exports = { callModel };
