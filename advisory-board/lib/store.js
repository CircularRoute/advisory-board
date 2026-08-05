// Persistence: every run is written to disk so a decision can be revisited.
// runs/<stamp>-<slug>/run.json   - full inspectable record (opinions, reviews,
//                                  de-anonymised mappings, ledger)
// runs/<stamp>-<slug>/report.md  - human-readable report
// runs/leaderboard.jsonl         - one line per run: the standing dataset of
//                                  which provider the board rates highest
// runs/comparisons/<stamp>.json  - tier-comparison records

const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const path = require('node:path');

// BOARD_RUNS_DIR points at a persistent disk in hosted deployments (Render);
// default is the local runs/ folder next to the code.
const RUNS_DIR = process.env.BOARD_RUNS_DIR || path.join(__dirname, '..', 'runs');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function fmtUsd(n) {
  return `$${n.toFixed(4)}`;
}

function costTable(cost) {
  const lines = ['| Model | Calls | In tokens | Out tokens | Cost |', '|---|---|---|---|---|'];
  for (const [model, v] of Object.entries(cost.byModel)) {
    lines.push(`| ${model} | ${v.calls} | ${v.inputTokens} | ${v.outputTokens} | ${fmtUsd(v.costUsd)} |`);
  }
  lines.push(`| **total** | | | | **${fmtUsd(cost.totalUsd)}** |`);
  return lines.join('\n');
}

function renderReport(run) {
  const lb = run.leaderboard.entries
    .map((e, i) => `${i + 1}. ${e.member} - avg position ${e.avgPosition === null ? 'n/a (no parsed votes)' : e.avgPosition.toFixed(2)} (${e.votes} vote${e.votes === 1 ? '' : 's'})`)
    .join('\n');
  return `# Advisory Board - ${run.title}

**Tier: ${run.tier.toUpperCase()}${run.mixedTier ? ' (mixed-tier board)' : ''}** | Board: ${run.members.map((m) => `${m.seatName || m.model}${m.memberTier && m.memberTier !== run.tier ? ` [${m.memberTier}]` : ''}`).join(' + ')} | Chairman: ${run.chairman.model} (${run.chairman.source}${run.chairman.isSittingMember ? '; SITTING MEMBER - known bias risk' : '; not a sitting member'})
**Cost: ${fmtUsd(run.cost.totalUsd)}** (prepaid ${fmtUsd(run.cost.prepaidUsd)}, out-of-pocket ${fmtUsd(run.cost.outOfPocketUsd)})${run.failedMembers.length ? `\n**RAN SHORT-HANDED** - failed members: ${run.failedMembers.map((m) => m.seatName || m.model).join(', ')}` : ''}

## Question

${run.question}

## Final answer (Chairman synthesis)

${run.finalAnswer}

## Per-run leaderboard (${run.leaderboard.confidence === 'normal' ? 'blind peer ranking' : 'confidence: ' + run.leaderboard.confidence})

${lb}

## Cost

${costTable(run.cost)}

${run.warnings.length ? `## Warnings\n\n${run.warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}
---
Full record (verbatim opinions, blind reviews, de-anonymised label mappings, call ledger): run.json in this directory.
Chairman anonymisation: ${run.chairmanView.note}
`;
}

function saveRun(run) {
  const dir = path.join(RUNS_DIR, `${stamp()}-${slugify(run.title)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  writeFileSync(path.join(dir, 'report.md'), renderReport(run));
  appendFileSync(
    path.join(RUNS_DIR, 'leaderboard.jsonl'),
    JSON.stringify({
      at: run.finishedAt,
      title: run.title,
      tier: run.tier,
      memberCount: run.members.length,
      confidence: run.leaderboard.confidence === 'normal' ? 'normal' : 'low',
      leaderboard: run.leaderboard.entries,
      costUsd: run.cost.totalUsd,
    }) + '\n'
  );
  return dir;
}

// An interrupted run: the process died (deploy restart, crash) or synthesis
// failed after all retries, BEFORE the chairman delivered a final answer. The
// paid-for opinions and reviews are preserved verbatim so the work is never
// lost; the report says loudly that no synthesis exists.
function renderInterruptedReport(run) {
  const ops = (run.opinions || [])
    .map((o) => `### ${o.seatName || o.model}${o.role ? ` (${o.role})` : ''}\n\n${o.text}`)
    .join('\n\n---\n\n') || '_No opinions were completed._';
  const revs = (run.reviews || [])
    .map((r) => `### Review by ${r.reviewer.seatName}\n\n${r.text}`)
    .join('\n\n---\n\n') || '_The run was interrupted before any peer review finished._';
  return `# Advisory Board - INTERRUPTED RUN (no final answer)

**This run did not finish.** It stopped at: ${run.phase || 'unknown stage'} - most likely a deploy/restart of the service or a chairman failure. There is NO chairman synthesis; nothing below is a final answer. Everything the board completed before the interruption is preserved verbatim, so re-convening the question costs only what was still missing.

**Tier: ${run.tier.toUpperCase()}${run.mixedTier ? ' (mixed-tier board)' : ''}** | Board: ${(run.members || []).map((m) => m.seatName || m.model).join(' + ')}
**Cost so far: ${fmtUsd(run.cost.totalUsd)}** (prepaid ${fmtUsd(run.cost.prepaidUsd)}, out-of-pocket ${fmtUsd(run.cost.outOfPocketUsd)})${(run.failedMembers || []).length ? `\n**RAN SHORT-HANDED** - failed members: ${run.failedMembers.map((m) => m.seatName || m.model).join(', ')}` : ''}

## Question

${run.question}

## Member opinions (verbatim - no synthesis was produced)

${ops}

## Blind peer reviews

${revs}

${run.warnings && run.warnings.length ? `## Warnings\n\n${run.warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}`;
}

function saveInterrupted(run) {
  const dir = path.join(RUNS_DIR, `${stamp()}-interrupted-${slugify(run.question || 'run').slice(0, 30)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  writeFileSync(path.join(dir, 'report.md'), renderInterruptedReport(run));
  // Deliberately NOT appended to leaderboard.jsonl - an unfinished run has no
  // standing in the aggregate dataset.
  return dir;
}

function saveComparison(comparison) {
  const dir = path.join(RUNS_DIR, 'comparisons');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}-${slugify(comparison.title)}.json`);
  writeFileSync(file, JSON.stringify(comparison, null, 2));
  return file;
}

module.exports = { saveRun, saveInterrupted, saveComparison, renderReport, fmtUsd, RUNS_DIR };
