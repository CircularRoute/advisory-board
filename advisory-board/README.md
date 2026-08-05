# Advisory Board (engine + console)

A multi-vendor deliberation engine for hard questions — not tied to any project, company, or dataset; ask it anything. Puts a question to the strongest model from each major provider independently, has them blind-review each other, and has a Chairman synthesise one answer that names where the board disagreed. Adapted from the public "LLM Council" pattern (Karpathy) - mechanism only, own code, direct provider APIs (no OpenRouter).

Advisory only: the board answers to a human. It never decides, acts, sends, or writes to any other system.

## Usage

```
node board.js "the question"                                  # mid tier, Anthropic + OpenAI
node board.js --tier=top "the question"
node board.js --tier=low "the question"
node board.js --providers=anthropic,openai,google "question"  # Gemini opt-in (OUT-OF-POCKET)
node board.js --tier=top --providers=anthropic,openai,google:mid "question"
                                                              # mixed-tier board: Fable + Sol with a
                                                              # cheaper Gemini seat (also accepts an
                                                              # exact model id after the colon)
node board.js --chairman=openai:gpt-5.6-sol "question"        # chairman override
node board.js --compare=mid,top "question"                    # same question at 2-3 tiers
```

No dependencies; Node 18+. Keys load at runtime from an env file (`ADVISORY_BOARD_ENV_FILE`, falling back to the path configured in `lib/config.js`). Never hardcoded, never printed, never committed.

## Local console (the cockpit)

```
node console.js        ->  http://127.0.0.1:4821
```

A web console over the same engine: pick tier and seats (including mixed-tier pinning per seat), see the cost estimate split prepaid vs out-of-pocket BEFORE convening, press Run, watch the stages stream live, read the chairman's answer and every past run's report. One board at a time.

The question can be typed or dictated: the **Dictate** button records with the browser microphone and transcribes server-side through OpenAI's audio API (`/api/transcribe`, key-gated like every spending endpoint; ~half a cent per minute, 2-minute cap). Microphone access needs a secure context - https (Render) or localhost.

Two modes, decided by whether any auth is configured:

- **Local (no auth configured, the default):** binds to 127.0.0.1 only, no auth - runs spend API credit, so the loopback bind is the gate. Port 4821, so it can run alongside the source project's console on 4820. In Claude desktop it opens via the `advisory-board-console` entry in `.claude/launch.json`.
- **Hosted:** binds 0.0.0.0 and every `/api/*` endpoint requires auth. A public bind without auth is impossible by construction. Two mechanisms, either or both:
  - **Magic-link email sign-in (primary):** set `BOARD_ALLOWED_EMAILS` (comma-separated allowlist) plus `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` (or `BOARD_MAGIC_FROM`). The console shows an email form; authorized addresses receive a single-use link (15 min TTL, sent via Brevo's HTTP API) and the open page **polls and signs itself in when the link is tapped anywhere** - required for the installed PWA on iOS, whose cookie jar is separate from Safari's. Sessions last 90 days and persist on disk across redeploys. Unknown addresses get the same generic response (no allowlist enumeration); link requests are rate-limited.
  - **Access key (fallback / scripts):** `BOARD_ACCESS_KEY` via `Authorization: Bearer` or `?key=`.

### Admin account

Set `BOARD_ADMIN_EMAIL` (Render environment) to one of the allowed emails. When that
account signs in it sees an extra **All questions** card: every question ever put to
the board, who asked it, when, at which tier, what it cost (with the out-of-pocket
share), and one tap to the full report including the final response. Locally (no
auth) the single user is the admin.

### Install on a phone (PWA)

The console ships a web-app manifest and icons: open the site in the phone browser, then **Add to Home Screen** (iOS Safari: Share → Add to Home Screen; Android Chrome: menu → Add to Home screen / Install). It opens standalone under its own icon, no URL typing. Anyone whose email is on `BOARD_ALLOWED_EMAILS` can install it on their own phone and sign in the same way.

## Hosting on Render

`render.yaml` at the repo root deploys this console as a web service: create a **Blueprint** on render.com pointing at the repo, then set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (and `GEMINI_API_KEY` only if you seat Google) in the dashboard. `BOARD_ACCESS_KEY` is auto-generated - copy it from the dashboard; treat it like a password, since anyone holding it can spend your API credit. Runs persist on the attached disk (`BOARD_RUNS_DIR=/var/data/runs`). A run takes minutes; progress streams live, and if the connection drops the finished record is in Past runs.

## Tiers (edit in one place: `lib/config.js`)

| Tier | OpenAI | Anthropic | Google |
|---|---|---|---|
| top | gpt-5.6-sol ($5/$30) | claude-fable-5 ($10/$50) | gemini-3.1-pro-preview ($2/$12) |
| mid (default) | gpt-5.6-terra ($2.50/$15) | claude-opus-5 ($5/$25) | gemini-3.6-flash ($1.50/$7.50) |
| low | gpt-5.6-luna ($1/$6) | claude-sonnet-5 ($2/$10 intro to 2026-08-31, then $3/$15) | gemini-3.5-flash-lite ($0.30/$2.50) |

All IDs verified against each provider's live models endpoint on 2026-08-05. Gemini pro-class only exists as a preview ID. **The default board seats all three vendors, with the Gemini seat pinned to mid tier** (`--providers=anthropic,openai,google:mid`). Anthropic and OpenAI draw prepaid credit; the Google seat spends real money - every run's output flags that out-of-pocket share, and the seat is one toggle (or `--providers=anthropic,openai`) to drop. A three-member board also makes the blind-ranking leaderboard meaningful (with two members it is degenerate).

## Extended boards and roles

The first three members are objective by default. **Extended · 5** adds a Claude and
a GPT seat at the board tier; **full bench · 7** adds a second Claude, GPT and Gemini
seat plus a third Claude. Every extra seat carries a perspective role, chosen per
seat (base members can optionally take a role too, via the seat's role selector or
`--base-roles=`):

- **Contrarian** - actively searches for flaws, risks, and everything that could fail.
- **Expansionist** - hunts for massive upside, hidden scaling opportunities, missed angles.
- **Outsider** - zero emotional attachment or industry bias; first principles.
- **Executor** - bypasses theory for immediate, high-ROI, practical next steps.
- **Behavioral Psychologist** - how real humans will actually react, not idealized ones.
- **Trade-off Analyst** - every choice has a cost; charts what you sacrifice for each upside.
- **Neutral Arbiter** - judges arguments strictly on logic and clarity, filtering hype.

The chairman is told which roles sat on the board (never which label held which
role). CLI: `--extended=contrarian,executor` (5 members) or four roles (7 members).

## The live session

Convening opens a live view instead of a frozen form: a three-step tracker
(opinions -> blind review -> synthesis), per-member cards that show thinking /
answered / reviewing / rankings in real time, a consensus banner with the blind
peer ranking, and a play-by-play feed. Results render as a styled document with
Share and Copy buttons, and every past session sits in a collapsible tab (first
lines of the question) that expands to the full conversation - also sharable.

## The mechanism

1. **Independent opinions** - the question fans out to all members in parallel; no member sees another's answer.
2. **Blind peer review** - each member ranks the others' answers on accuracy and insight, with written reasons required *before* the ranking. Identities are stripped and **label order is shuffled per reviewer** (an improvement over the reference implementation, whose fixed order leaks identity across runs). Rankings end in a machine-parseable `FINAL RANKING:` block; a parse failure excludes that vote *loudly* rather than silently.
3. **Chairman synthesis** - the Chairman receives the question, all responses, and all reviews **anonymised too** (the reference implementation shows its chairman the model names - the exact reputation bias the review stage exists to defeat). Identities attach only afterwards, in the report. The synthesis must name where the board agreed, where it split (with the strongest version of the minority view), and what would resolve the disagreement.

**Chairman default:** an Anthropic model from a *different* tier than the board, so the Chairman is never a sitting member (top/low boards get Opus 5; the mid board gets Fable 5). With a 2-member board a member-as-chairman would mean half the board grades the synthesis. Override with `--chairman=`; the output always states which chairman ran and whether it sat on the board.

## Outputs

- Console: tier + per-model cost header (a top-tier answer and a low-tier answer must never look alike), final answer, leaderboard, warnings.
- `runs/<stamp>-<slug>/run.json` - full record: verbatim opinions, blind reviews, de-anonymised label mappings, call ledger.
- `runs/<stamp>-<slug>/report.md` - human-readable report.
- `runs/leaderboard.jsonl` - the standing dataset: per-run average blind-ranking position per member. Across many runs this says which provider is actually strongest on OUR kinds of question. Labelled low-confidence below 3 members.
- `runs/comparisons/*.json` - tier-comparison records (per-tier answers, costs, and a SAME/DIFFERENT verdict on whether the tiers reached materially different conclusions).

## Failure handling

- Every call retries retryable failures (429/408/5xx incl. Anthropic 529, network errors) up to 3 attempts with exponential backoff.
- A member that still fails is dropped and the run continues short-handed, saying so plainly in the output and the record. A reviewer that fails loses its vote loudly, not silently.
- If the default Chairman fails after retries, synthesis falls back to the same-tier OpenAI chairman (still non-sitting; skipped if that would seat a board member; never applied over an explicit `--chairman=` override). The record names the acting chairman.
- If all members fail, the run errors - never a fabricated synthesis.
- Run-title labelling and tier-difference verdicts use the cheap housekeeping model (claude-haiku-4-5) and are not billed to the board's cost line.

## Cost discipline

Every run prints and persists token + dollar cost per model, split prepaid vs out-of-pocket. Expect well under a dollar for a 2-member run (a low-tier run is a few cents; the mid board's default chairman is the pricier Fable 5); the console shows an estimate before you convene and the real cost after. Don't convene the board on a question a single model would answer just as well.
