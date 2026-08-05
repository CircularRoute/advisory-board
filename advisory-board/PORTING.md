# Porting the Advisory Board to another project

Written for a Claude Code agent (or a human) dropping this tool into a different project. The whole tool is this one folder, zero npm dependencies, Node 18+. It was built for Greenlight AI; four things are Greenlight-specific and each is called out below.

## What this is

A multi-vendor deliberation engine. One question goes independently to a board of frontier models (OpenAI + Anthropic, optionally Google); they blind-review each other's answers (identities stripped, label order shuffled per reviewer); a Chairman - by default a model NOT sitting on the board, anonymised too - synthesises one answer that must name where the board agreed, where it split (strongest version of the minority view), and what would resolve the disagreement. Every run persists to `runs/` with full verbatim records and per-model dollar cost.

Two front ends over the same engine:
- `board.js` - CLI. `node board.js --help`.
- `console.js` - local web console at http://127.0.0.1:4820 with a Run button, live progress, cost estimates, and a past-run report viewer.

## Files

```
board.js              CLI entry
console.js            local web console (HTTP + SSE server)
public/console.html   the console UI (vanilla JS, no build step)
lib/config.js         THE file to adapt: tiers, model IDs, prices, key loading
lib/providers.js      raw HTTPS calls to Anthropic/OpenAI/Gemini + retry/backoff
lib/council.js        the three-stage engine (opinions -> blind review -> synthesis)
lib/store.js          run persistence (runs/<stamp>-<slug>/, leaderboard.jsonl)
package.json          metadata only (no dependencies)
```

Copy all of that. Do NOT copy `runs/` - it contains the source project's internal deliberations; the folder is recreated on first run.

## The four things you must adapt (all in one file, `lib/config.js`, plus one prompt)

1. **Key loading** (`ENV_PATH` / `loadKeys`). It reads a plain `KEY=value` env file from a hardcoded path outside the repo, overridable with the `GREENLIGHT_ENV_FILE` env var. Point it at your project's secret store convention. It expects `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (any two are enough; the board needs at least 2 providers). Never hardcode keys; never commit them; never log them.
2. **The tier table** (`TIERS`). Model IDs and $/1M-token prices as of 2026-08-05. VERIFY every ID against each provider's live models endpoint before trusting it, and re-check prices - one of them (claude-sonnet-5) is an intro price that expires 2026-08-31. This table is deliberately the single place a tier is edited.
3. **Provider economics** (`PREPAID_PROVIDERS`, `DEFAULT_PROVIDERS`). In the source project, Anthropic + OpenAI drew prepaid credit and Google spent real money, so Gemini is off by default and its cost is flagged "out-of-pocket". If your project's economics differ, change the set and the copy that references it (console.html banners, README).
4. **The opinion prompt** (`OPINION_SYSTEM` in `lib/council.js`) says the board advises "the founders of an early-stage company". Reword for your project's context. The Greenlight-flavored copy in `public/console.html` (the lede, the "measured 2026-08-05" hints) should also be rewritten or deleted - those findings belong to the source project, not yours.

## Invariants to preserve (they are the product)

- Blind review labels are shuffled PER REVIEWER - a fixed order leaks identity across runs.
- The Chairman is anonymised too (canonical labels, per-review translation lines); it learns model identities only after synthesis, in the report.
- The Chairman default is never a sitting member; on a 2-member board this matters most. If the default chair dies after retries, a same-tier different-provider fallback salvages the run rather than discarding stage-1/2 work.
- Failures degrade loudly, never silently: dropped members, lost votes, and short-handed runs are named in the output and the record. If all members fail, error out - never fabricate a synthesis.
- Cost is printed per model on every run, and the leaderboard is labelled low-confidence below 3 members.
- `console.js` binds to 127.0.0.1 ONLY. The Run button spends API credit - never bind it to a public interface, never add this port to any proxy.

## Bring-up checklist

1. Copy the folder (minus `runs/`), adapt the four items above.
2. `node --check` each file, then `node board.js --help`.
3. Cheapest live smoke: `node board.js --tier=low "any short real question"` (well under $0.15 at current low-tier prices).
4. `node console.js`, open http://127.0.0.1:4820, run the same question from the UI.
5. Optional, Claude Code preview: add to `.claude/launch.json`:
   `{ "name": "advisory-board-console", "runtimeExecutable": "node", "runtimeArgs": ["<absolute path>/console.js"], "port": 4820 }`

## Known limits (inherited, documented, fine to keep)

- One console run at a time (409 on concurrent convene) - deliberate, it spends money.
- With 2 members, each blind review covers a single response, so rankings are degenerate; the value is in the critiques and the synthesis. The leaderboard becomes meaningful at 3 members.
- The console's cost estimate is calibrated to observed runs (roughly half-to-double accuracy); real cost is always printed after the run.
