// One unified entry point per model call. API keys come from environment
// variables at runtime — never hardcoded, never logged.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { providerOfModel, costOf } from "./config.js";

const CALL_TIMEOUT_MS = 15 * 60 * 1000; // Fable/Sol turns can run many minutes

let anthropicClient = null;
let openaiClient = null;

function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  anthropicClient ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: "https://api.anthropic.com", // ignore any inherited ANTHROPIC_BASE_URL
    timeout: CALL_TIMEOUT_MS,
    maxRetries: 2,
  });
  return anthropicClient;
}

function openai() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  openaiClient ??= new OpenAI({ timeout: CALL_TIMEOUT_MS, maxRetries: 2 });
  return openaiClient;
}

/**
 * Call a model. Returns { text, inputTokens, outputTokens, costUsd,
 * costEstimated, elapsedMs, warnings } or throws with a clear message.
 */
export async function callModel(model, { system, prompt, maxTokens = 8000 }) {
  const provider = providerOfModel(model);
  const start = Date.now();
  const warnings = [];
  let text, inputTokens, outputTokens;

  if (provider === "anthropic") {
    const req = {
      model,
      max_tokens: Math.min(maxTokens, 16000),
      messages: [{ role: "user", content: prompt }],
    };
    if (system) req.system = system;
    // Thinking is on by default on Claude Opus 5 / Sonnet 5 and always-on for
    // Fable 5 — no thinking config needed. No fallbacks: the board's integrity
    // depends on knowing exactly which model answered, so a refusal is
    // surfaced as a member failure rather than silently re-served by a
    // different model.
    const res = await anthropic().messages.create(req);
    if (res.stop_reason === "refusal") {
      const cat = res.stop_details?.category ?? "unspecified";
      throw new Error(`${model} refused the request (category: ${cat})`);
    }
    if (res.stop_reason === "max_tokens") warnings.push("output truncated at max_tokens");
    text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    inputTokens = res.usage.input_tokens +
      (res.usage.cache_creation_input_tokens ?? 0) +
      (res.usage.cache_read_input_tokens ?? 0);
    outputTokens = res.usage.output_tokens;
  } else if (provider === "openai") {
    const res = await openai().responses.create({
      model,
      input: prompt,
      ...(system ? { instructions: system } : {}),
      // Reasoning tokens count against max_output_tokens — give headroom.
      max_output_tokens: maxTokens + 16000,
    });
    if (res.status === "incomplete") {
      const why = res.incomplete_details?.reason ?? "unknown";
      if (!res.output_text) throw new Error(`${model} returned incomplete response (${why})`);
      warnings.push(`incomplete response (${why})`);
    }
    text = res.output_text;
    inputTokens = res.usage.input_tokens;
    outputTokens = res.usage.output_tokens;
  } else {
    // Google — raw REST (verified shape); off by default, opt-in provider.
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    let res;
    try {
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens + 16000 },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const httpRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
      res = await httpRes.json();
      if (!httpRes.ok || res.error) {
        throw new Error(`${model}: ${res.error?.message ?? `HTTP ${httpRes.status}`}`);
      }
    } finally {
      clearTimeout(timer);
    }
    const cand = res.candidates?.[0];
    text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text) throw new Error(`${model} returned no text (finishReason: ${cand?.finishReason ?? "none"})`);
    if (cand.finishReason && cand.finishReason !== "STOP") {
      warnings.push(`finishReason: ${cand.finishReason}`);
    }
    inputTokens = res.usageMetadata?.promptTokenCount ?? 0;
    outputTokens =
      (res.usageMetadata?.candidatesTokenCount ?? 0) +
      (res.usageMetadata?.thoughtsTokenCount ?? 0);
  }

  if (!text || !text.trim()) throw new Error(`${model} returned an empty response`);
  const cost = costOf(model, inputTokens, outputTokens);
  return {
    text,
    inputTokens,
    outputTokens,
    costUsd: cost.usd,
    costEstimated: cost.estimated,
    elapsedMs: Date.now() - start,
    warnings,
  };
}
