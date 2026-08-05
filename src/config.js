// Central config: edit a tier in one place when a provider ships a new model.
//
// Model IDs verified against provider /models endpoints on 2026-08-05:
//   OpenAI:    gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna   (confirmed)
//   Anthropic: claude-fable-5, claude-opus-5, claude-sonnet-5 (confirmed)
//   Google:    gemini-3.1-pro-preview, gemini-3.6-flash, gemini-3.5-flash-lite
//              (resolved at build time; the "pro" tier is only served as a
//               -preview ID on the public API right now)

export const PROVIDERS = ["openai", "anthropic", "google"];

// Google is OFF by default: there is prepaid credit on Anthropic and OpenAI
// but not Google. Opt in with --providers=anthropic,openai,google.
export const DEFAULT_PROVIDERS = ["anthropic", "openai"];

export const DEFAULT_TIER = "mid";

export const TIERS = {
  top: {
    openai: "gpt-5.6-sol",
    anthropic: "claude-fable-5",
    google: "gemini-3.1-pro-preview",
  },
  mid: {
    openai: "gpt-5.6-terra",
    anthropic: "claude-opus-5",
    google: "gemini-3.6-flash",
  },
  low: {
    openai: "gpt-5.6-luna",
    anthropic: "claude-sonnet-5",
    google: "gemini-3.5-flash-lite",
  },
};

// Chairman preference list per tier. The first model NOT sitting on the board
// is chosen, so the Chairman is always a non-member by default (with two
// members a member-as-chairman would mean half the board grades its own
// synthesis). Override with --chairman=<model-id>.
export const CHAIRMAN_PREFERENCES = {
  top: ["claude-opus-5", "gpt-5.6-terra", "gemini-3.6-flash"],
  mid: ["claude-fable-5", "gpt-5.6-sol", "gemini-3.1-pro-preview"],
  low: ["claude-opus-5", "gpt-5.6-terra", "gemini-3.6-flash"],
};

// Cheapest model for housekeeping calls (run titles). Billed separately,
// never on the board's cost line.
export const HOUSEKEEPING_MODEL = "claude-haiku-4-5";

// Model used to compare tier answers in --compare mode (billed as "comparison").
export const COMPARISON_MODEL = "claude-opus-5";

// USD per million tokens. `estimated: true` marks prices not confirmed
// against a published price list (Gemini 3.x pricing was not verifiable at
// build time — treat those cost lines as estimates).
export const PRICING = {
  "gpt-5.6-sol":            { input: 5.0,  output: 30.0 },
  "gpt-5.6-terra":          { input: 2.5,  output: 15.0 },
  "gpt-5.6-luna":           { input: 1.0,  output: 6.0 },
  "claude-fable-5":         { input: 10.0, output: 50.0 },
  "claude-opus-5":          { input: 5.0,  output: 25.0 },
  // Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31; list is $3/$15.
  "claude-sonnet-5":        { input: 2.0,  output: 10.0 },
  "claude-haiku-4-5":       { input: 1.0,  output: 5.0 },
  "gemini-3.1-pro-preview": { input: 2.0,  output: 12.0, estimated: true },
  "gemini-3.6-flash":       { input: 0.5,  output: 3.0,  estimated: true },
  "gemini-3.5-flash-lite":  { input: 0.1,  output: 0.4,  estimated: true },
};

export function providerOfModel(model) {
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  throw new Error(`Unknown provider for model ${model}`);
}

export function boardFor(tier, providers) {
  if (!TIERS[tier]) throw new Error(`Unknown tier "${tier}" (top|mid|low)`);
  const bad = providers.filter((p) => !PROVIDERS.includes(p));
  if (bad.length) throw new Error(`Unknown provider(s): ${bad.join(", ")}`);
  if (providers.length < 2) throw new Error("The board needs at least 2 members");
  return providers.map((p) => ({ provider: p, model: TIERS[tier][p] }));
}

export function pickChairman(tier, members, override) {
  if (override) return override;
  const onBoard = new Set(members.map((m) => m.model));
  const pick = CHAIRMAN_PREFERENCES[tier].find((m) => !onBoard.has(m));
  if (!pick) throw new Error("No non-member chairman available; pass --chairman");
  return pick;
}

export function costOf(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) return { usd: null, estimated: true };
  return {
    usd: (inputTokens * p.input + outputTokens * p.output) / 1e6,
    estimated: !!p.estimated,
  };
}
