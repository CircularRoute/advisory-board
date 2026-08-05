---
name: advisory-board
description: Convene the Advisory Board on a hard question. Use when the user says "ask the board", "advisory board", "use the advisory skill", or wants a multi-vendor second opinion on a strategic, technical, or contested decision. Opens the local Board Console with the question pre-filled; the HUMAN presses Convene - that tap is the spend approval. Never trigger a run programmatically.
---

# Convene the Advisory Board

The Advisory Board is a local deliberation engine (`advisory-board/` in this project): frontier models from multiple vendors answer independently, blind-review each other, and a non-sitting Chairman synthesises one answer that names where the board disagreed. Every run spends real API credit, so the human presses the button - you only set the table.

## What you do

1. **Shape the question.** Make it decision-shaped and self-contained: the context, the constraint, and what a useful answer decides. A vague question wastes a board. If the user's phrasing lacks context they clearly intended, add it; do not change the substance of what they asked.

2. **Make sure the console is up.** Check with:
   ```
   curl -s --max-time 2 http://127.0.0.1:4821/api/config
   ```
   If it does not respond, start it: use the Browser preview tool with the launch config named `advisory-board-console` (defined in `.claude/launch.json`). If no browser/preview tools are available in your session, run `node "/Users/rashadabbasov/Desktop/Claude Playground/Advisory Board/advisory-board/console.js"` as a background process instead and give the user the URL.

3. **Open the console with the question pre-filled.** Navigate the Browser pane to:
   ```
   http://127.0.0.1:4821/?q=<URL-ENCODED QUESTION>
   ```
   Optional parameters, only when the user asked for a specific configuration:
   - `&tier=low|mid|top` (default mid)
   - `&providers=anthropic,openai,google:mid` (comma list; `provider:tier` pins a seat off-tier; google spends out-of-pocket money - include it only if the user said so)
   - `&chairman=anthropic|top` (provider|tier; default auto-picks a non-sitting Anthropic chair)
   - `&compare=mid,top` or `&compare=low,mid,top` (same question at multiple tiers)

4. **Hand over, do not run.** Tell the user the board is staged and what the console's estimate says; they review seats and cost and press **Convene the board**. NEVER call `POST /api/run`, never click Convene via browser automation, never run `board.js` to answer the user's question - the tap is the human's spend approval. (Exception: none. If the user says "just run it", ask them to press the button; it is one tap and it keeps the spend gate human.)

5. **After the run** (the console shows the answer live): if the user wants it summarized or compared with prior runs, read the newest record under `advisory-board/runs/` in this project.

## Rules inherited from the board's charter

- Never convene the board on a question a single model would answer just as well.
- The board is advisory only: it answers to a human, decides nothing, sends nothing.
- Do not edit the engine from this skill.
