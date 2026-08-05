# Advisory Board handoff

Updated: 2026-08-05 (single long build session: port from gl-board, Render-ready hosted
console, magic-link auth + PWA, extended boards with roles, live session screen).

## State: code COMPLETE and pushed to GitHub. Render deployment NOT yet live - blocked on founder dashboard steps.

- Repo: `git@github.com:CircularRoute/advisory-board.git`, branch `main`, local clone is
  this folder. Every change this session is committed and pushed; Render (once created)
  auto-deploys `main`.
- As of the last check `advisory-board.onrender.com` returns Render's no-service 404 -
  the founder said keys were added, but no service answered yet. First job next session:
  verify the deploy (see "Next session starts with").
- Local console runs at `http://127.0.0.1:4821` (currently as a detached `node console.js`
  process - see gotcha about the preview pane).

## What lives where

- **`advisory-board/`** - THE product. Ported from gl-board's engine (mechanism preserved:
  independent opinions → blind peer review with per-reviewer label shuffling → anonymised
  non-sitting Chairman). Zero npm dependencies, Node 18+.
  - `lib/config.js` - tiers/prices/chairman/extended-seat pattern/key loading. The one
    file to edit when models change.
  - `lib/council.js` - engine + ROLES (12: contrarian, expansionist, outsider, executor,
    psychologist, tradeoff, arbiter, scout, analyst, futurist, economist, advocate) +
    structured `onEvent` stream for the live UI. The no-role state is labeled "Default"
    in the UI (renamed from "Objective", 2026-08-05).
  - `lib/auth.js` - magic-link email auth (Brevo), sessions, admin check.
  - `lib/context.js` - "+ Add Context" attachments: .md/.txt read directly, PDFs
    transcribed by claude-haiku-4-5 via Anthropic document support (a hand-rolled
    PDF parser would silently produce garbage on CID fonts - wrong context is worse
    than a rejected upload). 10 MB / 200k-char caps.
  - `console.js` - HTTP server: UI, SSE, transcription, history, admin injection.
  - `public/console.html` - the whole UI (vanilla, one file). `public/icons/` + manifest = PWA.
  - `board.js` - CLI (`--tier --providers --extended --base-roles --chairman --compare`).
- **`src/` + `public/index.html`** - the FIRST implementation from this session (REST
  `POST /ask` + remote MCP server + plain page). Still functional, but `render.yaml` no
  longer deploys it; treat as legacy unless the founder wants the MCP surface.
- **`render.yaml`** - deploys `advisory-board/console.js` (rootDir advisory-board, starter
  plan, disk at /var/data, healthCheckPath /healthz).
- **`.github/workflows/claude.yml`** - @claude-mention → PR automation (needs the Claude
  GitHub app installed on the repo + `ANTHROPIC_API_KEY` Actions secret - NOT yet done).
- **`.claude/skills/advisory-board/SKILL.md`** - stages the console via `?q=` prefill;
  the HUMAN always presses Convene. Never trigger runs programmatically.

## Deployment config (Render env vars)

| Var | Value / status |
|---|---|
| ANTHROPIC_API_KEY / OPENAI_API_KEY | required; founder says added |
| GEMINI_API_KEY | required for the default board (Gemini mid is seated by default) |
| BOARD_ALLOWED_EMAILS | magic-link allowlist, comma-separated (rashad@shopwithme.me + guests) |
| BOARD_ADMIN_EMAIL | the admin account (sees all-questions history; invisible to others) |
| BREVO_API_KEY | transactional email for sign-in links |
| BOARD_MAGIC_FROM | fixed in render.yaml: rashad@circularroute.com (verified with Brevo 2026-08-05) |
| BOARD_ACCESS_KEY | auto-generated; fallback auth only, admin never derives from it |
| BOARD_RUNS_DIR | /var/data/runs (persistent disk; sessions file lives next to it) |

Locally, keys resolve env-first then fall back to
`~/Desktop/Claude Playground/greenlight.env` (path confirmed by founder; override with
`ADVISORY_BOARD_ENV_FILE`). No auth configured locally → binds 127.0.0.1 only, single
user is admin.

## Verified facts (2026-08-05)

- Model IDs live-verified against all three providers: gpt-5.6-{sol,terra,luna};
  claude-{fable-5,opus-5,sonnet-5}; gemini-3.1-pro-preview / 3.6-flash / 3.5-flash-lite.
  `claude-haiku-4-5` (housekeeping) is an alias - list endpoint shows the dated ID.
- **claude-sonnet-5 price in TIERS is the intro price ($2/$10) which EXPIRES 2026-08-31**
  → becomes $3/$15; update `lib/config.js` then. Gemini prices are estimates (no
  published list verified).
- Live runs done this session: 2-member low ($0.09-0.11), 3-member low ($0.13),
  5-member extended low with Contrarian+Executor ($0.27), plus mid-tier runs in the src/
  era. Records in `advisory-board/runs/` (gitignored).
- Brevo sends verified from rashad@circularroute.com (messageId received).
- CLI `--extended` / `--base-roles` are wired identically to the console path but have
  NOT had a live CLI run.

## Gotchas a new session must know

- **The console server broadcasts BEFORE the POST /api/run 202 returns** (startRun runs
  synchronously to its first await). The UI therefore opens the session screen BEFORE
  sending the request. Don't "fix" that order back.
- **`String.replace` $-patterns**: the admin fragment contains `$'` (in "oop $"), which
  splices in the rest of the page if used as a string replacement. The `/` route uses the
  function form `html.replace(marker, () => FRAGMENT)`. Keep it that way.
- **Admin invisibility is server-side**: the fragment is injected at `<!-- @X@ -->` only
  for admin sessions, `/auth/me` omits the admin field for others, `/api/history` 404s
  (not 403s) for non-admins, and `/` is served `cache-control: no-store`. Don't move any
  admin markup back into the static page.
- **The request handler is crash-guarded** (`handle()` wrapped in try/catch → 500). This
  exists because a bad edit once made `/api/history` throw and an uncaught throw KILLS
  the process - which on Render would kill mid-run deliberations. Keep the guard.
- **/api/runs returns `{total, runs}`** (badge counts beyond the 25-row cap);
  `/api/history` returns a bare array. Both consumed in console.html + admin fragment.
- **iOS specifics**: form controls must stay ≥16px on phones (zoom-on-focus); the
  installed PWA has a SEPARATE cookie jar from Safari, which is why sign-in uses the
  poll-for-approval flow (`/auth/request` → emailed link → `/auth/poll` sets the
  poller's own cookie). Mic (MediaRecorder → `/api/transcribe` →
  gpt-4o-mini-transcribe, whisper-1 fallback) needs https or localhost.
- **Fable/Opus refusals are member failures by design** - no server-side fallbacks; the
  board's identity guarantees matter more than rescue. Board sits short-handed, loudly.
- **One run at a time** (409 on concurrent convene) - deliberate, it spends money.
- **Attached context goes to EVERY stage** (opinions, peer reviews, chairman) by
  design: reviewers who could not see the briefing would penalise answers that cite
  it. That means context tokens are charged once per seat per stage - the console's
  estimate accounts for this (~$0.30 extra per 40k chars on a mid 3-member board).
  Context is stored in run.json and named in report.md.
- **Runs survive drops two ways** (added 2026-08-05): (1) every run event is journaled
  in memory and replayed to any SSE subscriber that connects mid-run, so a phone that
  locks/reconnects rebuilds the live screen (EventSource auto-reconnects); (2)
  `runs/inflight.json` tracks the sitting board - normal completion removes it, and if
  the process dies mid-run (deploy!) the next boot converts it into a visible
  "Interrupted" record in Past sessions/history. A run that errors while the process
  lives leaves a "Failed" record. NEVER deploy while a board is in session - it still
  kills the deliberation; it just no longer hides the corpse.
- **Engine events**: `convene({onEvent})` emits roster/stage/opinion-done/review-done/
  consensus/chairman-start/done/title. Seats have identity (`seat` index + unique
  `seatName`) because one model can hold 3 seats on a 7-member board. The leaderboard
  (runs/leaderboard.jsonl) is keyed by seatName.
- **Dev hooks**: `window.__board` exposes apiFetch/esc/md/openReport/engineEvent/
  openSession - engineEvent + openSession let you simulate a full live session in the
  browser with zero API spend (how the session screen was verified).
- **Local dev environment trap**: the Claude desktop preview pane's server manager
  wedged after `pkill`ing its children mid-session; console.js instances also piled up
  (6 orphans at one point) making stale code answer on 4821. If 4821 behaves oddly:
  `pkill -f "node console.js"`, then start one instance. `.claude/launch.json` entry
  `advisory-board-console` is the normal path.
- Extended-board rules: +2 roles = Claude+GPT seats, +4 = Claude+GPT+Gemini+Claude, all
  at board tier; roles are MANDATORY per extended seat (UI blocks convene until chosen);
  base members optional roles; 7-member requires the Gemini seat on. Chairman is told
  which roles sat, never which label held them.
- The old `verification-run.log` + `sittings/` at repo root are src/-era artifacts
  (gitignored), not the product's records.

## Next session starts with

1. **Verify the Render deploy**: find the real URL in the founder's Render dashboard
   (name may be suffixed), check `/healthz`, then the startup log line - it must say
   `HOSTED mode - auth: magic-link email auth (N address(es))`. If it says access key
   only, an env var name is wrong.
2. Founder phone test: sign-in link arrives from rashad@circularroute.com → poll signs
   the page in → Add to Home Screen → Dictate → one low-tier run end-to-end.
3. Finish remote-editing setup if wanted: install github.com/apps/claude on the repo +
   add ANTHROPIC_API_KEY Actions secret (workflow already committed).
4. 2026-08-31: sonnet-5 intro pricing expires - bump TIERS.
5. Consider: first live CLI `--extended` run; whether to retire `src/` or expose its MCP
   surface on Render too.
