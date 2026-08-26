# Porting the Advisory Board to another project

Written for a Claude Code agent (or a human) reusing this tool in a different
project. Read this first, then `HANDOFF.md` (deployment state + gotchas that
cost real debugging time). The product is the `advisory-board/` folder: zero
npm dependencies, Node 18+, self-contained.

## Where the code lives

- **Local (this machine, read it directly):**
  `/Users/rashadabbasov/Desktop/Claude Playground/Advisory Board/advisory-board/`
  Treat as READ-ONLY source - copy, never edit in place. Do NOT copy `runs/`
  (this project's private deliberations) or `board-sessions.json` (auth state).
- **Git:** `git@github.com:CircularRoute/advisory-board.git` (branch `main`,
  auto-deploys to Render on push - so do not push experiments here; copy out.)
- **Live deployment (option zero - reuse instead of porting):**
  `https://advisory-board-no57.onrender.com` is already hosted with magic-link
  auth. If the other project just needs to ASK the board, add its user's email
  to `BOARD_ALLOWED_EMAILS` on Render and stop - no port needed. Port when the
  project needs its own branding, keys, allowlist, or records.

## What this is

A multi-vendor deliberation engine. One question (optionally with an attached
Markdown/PDF context briefing) goes independently to a board of frontier
models from Anthropic + OpenAI + Google; they blind-review each other's
answers (identities stripped AND label order shuffled per reviewer); a
Chairman - by default a model NOT sitting on the board, anonymised too -
synthesises one answer that must name where the board agreed, where it split
(strongest version of the minority view), and what would resolve the
disagreement. Every run persists with full verbatim records and per-model
cost, and the finished decision is emailed to the asker as a PDF
("Decisions of the Advisory Board").

Two front ends over the same engine:
- `board.js` - CLI. `node board.js --help`.
- `console.js` - web console. Local mode: `http://127.0.0.1:4821`, no auth,
  loopback only. Hosted mode (any auth configured): binds 0.0.0.0 with
  magic-link email sign-in + PWA install + admin history.

Board sizes: standard 3 (one seat per provider, optional roles) or extended 6
(a second Claude, GPT and Gemini seat, each with a MANDATORY perspective role
chosen from 12 personas). The chairman is a 7th, non-sitting voice.

## Files

```
advisory-board/
  board.js              CLI entry (--tier --providers --extended --base-roles --chairman --compare)
  console.js            web console: HTTP + SSE, auth routes, admin injection,
                        context upload, run lifecycle (journal replay, inflight
                        crash recovery), decision-email hook
  public/console.html   the whole UI (vanilla JS, no build step) + PWA manifest/icons
  lib/config.js         THE file to adapt: tiers, model IDs, prices, key loading
  lib/providers.js      raw HTTPS calls to Anthropic/OpenAI/Gemini - every call
                        STREAMS, so a dead connection trips the idle cap while a
                        slow-but-alive synthesis is allowed to finish
  lib/council.js        three-stage engine + ROLES (12 personas) + onEvent stream
  lib/auth.js           magic-link email auth (Brevo), sessions, allowlist, admin
  lib/context.js        attachment -> text (.md direct; PDF via claude-haiku-4-5)
  lib/mailer.js         Brevo send with PDF attachment (decision delivery)
  lib/pdf.js            dependency-free PDF writer (base-14 fonts, A4, tables)
  lib/store.js          run persistence + report renderer (omitCost edition for email)
  package.json          metadata only (no dependencies)
render.yaml             Render blueprint (root repo) - copy if hosting your own
.claude/skills/advisory-board/SKILL.md   how an agent stages the console for a human
```

## What you must adapt

1. **Key loading** (`lib/config.js`: `ENV_PATH` / `envSecret` / `loadKeys`).
   Env vars first, then a plain `KEY=value` file at a hardcoded path
   (`~/Desktop/Claude Playground/greenlight.env` here), overridable with
   `ADVISORY_BOARD_ENV_FILE`. Point at the new project's secret convention.
   ASK THE OWNER where keys live before touching this - do not guess. Needs
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (any two providers
   are enough to sit a board; Anthropic is also needed for PDF context
   attachments). Never hardcode, commit, print, or log keys.
2. **The tier table** (`TIERS` in `lib/config.js`). Model IDs and $/1M prices
   verified 2026-08-05. VERIFY every ID against each provider's live models
   endpoint before trusting them, and re-check prices - claude-sonnet-5 is an
   intro price that EXPIRES 2026-08-31 ($2/$10 -> $3/$15). Single edit point
   by design.
3. **Provider economics** (`PREPAID_PROVIDERS`). Here, Anthropic + OpenAI drew
   prepaid credit and Google was out-of-pocket, so Gemini cost is flagged
   separately everywhere. Change the set + the copy that references it if the
   new project's economics differ.
4. **Hosted-mode config** (env vars, all read at boot): `BOARD_ALLOWED_EMAILS`
   (comma-separated allowlist), `BOARD_ADMIN_EMAIL` (sees all-questions
   history - invisible to everyone else, keep it that way), `BREVO_API_KEY` +
   `BOARD_MAGIC_FROM` (transactional email: sign-in links AND decision PDFs;
   the sender must be verified with Brevo first), `BOARD_ACCESS_KEY` (fallback
   auth), `BOARD_RUNS_DIR` (persistent disk in hosting), `PORT`. No auth env
   at all = local mode, loopback only, single user is admin.
5. **Branding/copy**: `public/console.html` hero + hints, mailer email body,
   PDF document title (`DOC_TITLE` in `lib/mailer.js`), PWA icons + manifest
   name. Port numbers: 4821 here (4820 is the gl-board original) - pick a new
   one so consoles can run side by side.

## Invariants to preserve (they are the product - do not "improve" them away)

- Blind review labels shuffled PER REVIEWER; the Chairman is anonymised too
  and learns identities only after synthesis, in the report.
- Chairman default is never a sitting member; fallback walks tiers rather than
  silently seating a member as judge.
- Failures degrade loudly: dropped members, lost votes, short-handed runs are
  named in output and record. Anthropic refusals are member failures - no
  fallbacks, the board sits short-handed. If all members fail, error out;
  never fabricate a synthesis.
- A HUMAN presses Convene. The skill stages the console with `?q=` prefill;
  never POST /api/run programmatically - the tap is the spend approval.
- Attached context goes to EVERY stage (members, reviewers, chairman) and is
  framed as facts-not-instructions inside `<attached_context>`.
- Hosted mode is impossible to bind publicly without auth by construction.
  GET /auth/verify must NEVER consume the sign-in token (mail scanners fetch
  links; only the button's POST spends it). Admin existence must not leak:
  server-side fragment injection, /api/history 404s for non-admins.
- Run resilience: every event journaled and replayed to reconnecting SSE
  clients; `inflight.json` turns a mid-run crash/deploy into a visible
  "Interrupted" record on next boot. Never deploy while a board sits.
- The emailed decision document carries no cost figures (`renderReport(run,
  {omitCost:true})`); the on-disk record keeps full cost. Owner preference -
  ask your owner what theirs is.

## Bring-up checklist

1. Copy `advisory-board/` (minus `runs/`, minus `board-sessions.json`); adapt
   the five items above.
2. `node --check` every file, then `node board.js --help`.
3. Zero-spend UI verification: open the console, and in the browser console
   use `window.__board.openSession(...)` + `window.__board.engineEvent(...)`
   to simulate a full live session (see HANDOFF.md "Dev hooks").
4. Cheapest live smoke: `node board.js --tier=low "any short real question"`
   (~$0.10-0.15). Confirm the run dir, report.md, and (hosted) the decision
   email arrive.
5. Hosted: deploy, then check boot log says
   `HOSTED mode - auth: magic-link email auth (N address(es))` - if it says
   access key only, an env var name is wrong.

## Known limits (inherited, documented, fine to keep)

- One run at a time (409 on concurrent convene) - deliberate, it spends money.
- 2-member boards produce degenerate rankings; the leaderboard means something
  from 3 members up (it is labelled accordingly).
- Decisions are synthesised by argument, not majority vote - there is no
  tie-break to worry about and no need for odd seat counts.
- Cost estimate is calibrated to observed runs (half-to-double accuracy); the
  real cost prints with the answer and in the admin history.
- The PDF writer covers the report's Markdown (headings, bold, lists, quotes,
  rules, pipe tables) - it is not a general Markdown engine.
