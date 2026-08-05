// Advisory Board configuration: tiers, pricing, chairman defaults, key loading.
// All model IDs below were verified against each provider's live models endpoint
// on 2026-08-05. Prices are $ per 1M tokens (provider list prices on that date).

const { readFileSync } = require('node:fs');

// Keys resolve in two steps: process environment variables first (the hosted
// deployment - Render injects them from its dashboard), then a KEY=value env
// file outside the repo (local runs on this Mac; path confirmed by the user
// 2026-08-05). Only the path appears in code; keys are never printed,
// persisted, or committed.
const ENV_PATH =
  process.env.ADVISORY_BOARD_ENV_FILE ||
  '/Users/rashadabbasov/Desktop/Claude Playground/greenlight.env';

let envFileCache;
function readEnvFile() {
  if (envFileCache) return envFileCache;
  const file = {};
  let err = null;
  try {
    const raw = readFileSync(ENV_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.indexOf('=');
      if (i === -1) continue;
      file[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
    }
  } catch (e) {
    err = e;
  }
  envFileCache = { file, err };
  return envFileCache;
}

// Generic secret lookup: process env first (hosted), env file second (local).
function envSecret(name) {
  return process.env[name] || readEnvFile().file[name] || null;
}

function loadKeys() {
  const { file, err: fileErr } = readEnvFile();
  const keys = {
    anthropic: process.env.ANTHROPIC_API_KEY || file.ANTHROPIC_API_KEY || null,
    openai: process.env.OPENAI_API_KEY || file.OPENAI_API_KEY || null,
    google: process.env.GEMINI_API_KEY || file.GEMINI_API_KEY || null,
  };
  if (!keys.anthropic && !keys.openai && !keys.google) {
    throw new Error(
      `No API keys found. Set ANTHROPIC_API_KEY / OPENAI_API_KEY (and optionally GEMINI_API_KEY) as environment variables, ` +
        `or provide a key env file at ${ENV_PATH} (override the path with ADVISORY_BOARD_ENV_FILE)` +
        (fileErr ? `. Env file was unreadable: ${fileErr.message}` : '')
    );
  }
  return keys;
}

// One place to edit when a provider ships a new model (founder decision 2026-08-05).
// OpenAI + Anthropic names confirmed by the CEO 2026-08-05; Gemini tier picks made
// by the Advisory Board from the live models endpoint (pro-class only exists as a
// preview ID; the flash line is the current mid/low tier).
const TIERS = {
  top: {
    openai:    { model: 'gpt-5.6-sol',            inPerM: 5,    outPerM: 30 },
    anthropic: { model: 'claude-fable-5',         inPerM: 10,   outPerM: 50 },
    google:    { model: 'gemini-3.1-pro-preview', inPerM: 2,    outPerM: 12 },
  },
  mid: {
    openai:    { model: 'gpt-5.6-terra',          inPerM: 2.5,  outPerM: 15 },
    anthropic: { model: 'claude-opus-5',          inPerM: 5,    outPerM: 25 },
    google:    { model: 'gemini-3.6-flash',       inPerM: 1.5,  outPerM: 7.5 },
  },
  low: {
    openai:    { model: 'gpt-5.6-luna',           inPerM: 1,    outPerM: 6 },
    // Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31, then $3/$15.
    anthropic: { model: 'claude-sonnet-5',        inPerM: 2,    outPerM: 10 },
    google:    { model: 'gemini-3.5-flash-lite',  inPerM: 0.3,  outPerM: 2.5 },
  },
};

// Housekeeping (run titles, tier-difference checks): always the cheapest model,
// never billed to the board's cost line, regardless of the board's tier.
const HOUSEKEEPING = { provider: 'anthropic', model: 'claude-haiku-4-5', inPerM: 1, outPerM: 5 };

// Anthropic and OpenAI draw on prepaid credit; Google is out-of-pocket.
const PREPAID_PROVIDERS = new Set(['anthropic', 'openai']);

// Default board: all three vendors, with the Gemini seat pinned to MID tier
// (owner decision 2026-08-05: Gemini in by default; toggle it off when not
// wanted). Google still spends out-of-pocket money and every run's output
// flags that share.
const DEFAULT_PROVIDERS = ['anthropic', 'openai', 'google:mid'];
const DEFAULT_TIER = 'mid';

// Extended-board seat pattern (owner decision 2026-08-05): +2 roles seats one
// extra Claude and one extra GPT; +4 roles seats a second Claude, GPT and
// Gemini plus a third Claude. Extras always sit at the board's tier and each
// carries a perspective role; the first three members stay objective.
const EXTENDED_SEAT_PROVIDERS = {
  2: ['anthropic', 'openai'],
  4: ['anthropic', 'openai', 'google', 'anthropic'],
};

// Chairman default: an Anthropic model from a DIFFERENT tier than the board, so
// the Chairman is never a sitting member (matters most on a 2-member board).
// Same-provider as one member is imperfect but materially better than
// chairman-equals-member; the output always states the choice.
const CHAIRMAN_DEFAULT = {
  top: { provider: 'anthropic', tier: 'mid' }, // board has Fable 5 -> chair Opus 5
  mid: { provider: 'anthropic', tier: 'top' }, // board has Opus 5  -> chair Fable 5
  low: { provider: 'anthropic', tier: 'mid' }, // board has Sonnet 5 -> chair Opus 5
};

// If the default chairman fails even after retries (e.g. a sustained provider
// outage), the run's finished stage-1/2 work should not be discarded: fall back
// to the OpenAI model from the same tier as the default chairman - still not a
// sitting member of any board at a different tier than its own.
function resolveFallbackChairman(tier) {
  const def = CHAIRMAN_DEFAULT[tier];
  const slot = TIERS[def.tier].openai;
  return { provider: 'openai', ...slot, source: `fallback (openai ${def.tier}-tier) after default chairman failed` };
}

// roster: array of {provider, model} actually seated on the board.
function resolveChairman(tier, roster, override) {
  if (override) {
    // "provider:model" (pricing looked up from any tier slot, else unknown -> 0)
    const [provider, ...rest] = override.split(':');
    const model = rest.join(':');
    if (!provider || !model) throw new Error(`Bad --chairman value: ${override} (want provider:model)`);
    for (const t of Object.keys(TIERS)) {
      const slot = TIERS[t][provider];
      if (slot && slot.model === model) return { provider, ...slot, source: `override (${t} tier)` };
    }
    return { provider, model, inPerM: 0, outPerM: 0, source: 'override (pricing unknown, logged as $0 - fix TIERS)' };
  }
  const def = CHAIRMAN_DEFAULT[tier];
  let slot = TIERS[def.tier][def.provider];
  let source = `default (${def.provider} ${def.tier}-tier)`;
  // Mixed-tier boards can seat the would-be default chairman (e.g. a top board
  // with anthropic:mid seats Opus 5, the top board's default chair). Walk the
  // Anthropic tiers for one that is not on the board rather than seating a member.
  if (roster.some((m) => m.provider === def.provider && m.model === slot.model)) {
    const alt = Object.keys(TIERS).find(
      (t) => !roster.some((m) => m.provider === def.provider && m.model === TIERS[t][def.provider].model)
    );
    if (alt) {
      slot = TIERS[alt][def.provider];
      source = `default (${def.provider} ${alt}-tier; ${def.tier}-tier chair sits on this mixed board)`;
    }
  }
  return { provider: def.provider, ...slot, source };
}

module.exports = {
  ENV_PATH,
  envSecret,
  loadKeys,
  TIERS,
  HOUSEKEEPING,
  PREPAID_PROVIDERS,
  DEFAULT_PROVIDERS,
  DEFAULT_TIER,
  EXTENDED_SEAT_PROVIDERS,
  resolveChairman,
  resolveFallbackChairman,
};
