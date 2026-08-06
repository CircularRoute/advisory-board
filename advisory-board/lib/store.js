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

// The on-disk report keeps everything. The emailed edition drops money:
// the header cost line, the cost table, and the one cost-related warning the
// engine emits (the Gemini out-of-pocket note - every other warning is about
// board integrity and must survive). It also drops the run.json pointer, which
// names a directory the email's recipient has no access to.
function renderReport(run, { omitCost = false } = {}) {
  const lb = run.leaderboard.entries
    .map((e, i) => `${i + 1}. ${e.member} - avg position ${e.avgPosition === null ? 'n/a (no parsed votes)' : e.avgPosition.toFixed(2)} (${e.votes} vote${e.votes === 1 ? '' : 's'})`)
    .join('\n');
  const shortHanded = run.failedMembers.length
    ? `\n**RAN SHORT-HANDED** - failed members: ${run.failedMembers.map((m) => m.seatName || m.model).join(', ')}`
    : '';
  const costLine = omitCost
    ? shortHanded.replace(/^\n/, '')
    : `**Cost: ${fmtUsd(run.cost.totalUsd)}** (prepaid ${fmtUsd(run.cost.prepaidUsd)}, out-of-pocket ${fmtUsd(run.cost.outOfPocketUsd)})${shortHanded}`;
  const warnings = omitCost
    ? run.warnings.filter((w) => !/OUT-OF-POCKET/i.test(w))
    : run.warnings;
  return `# Advisory Board - ${run.title}

**Tier: ${run.tier.toUpperCase()}${run.mixedTier ? ' (mixed-tier board)' : ''}** | Board: ${run.members.map((m) => `${m.seatName || m.model}${m.memberTier && m.memberTier !== run.tier ? ` [${m.memberTier}]` : ''}`).join(' + ')} | Chairman: ${run.chairman.model} (${run.chairman.source}${run.chairman.isSittingMember ? '; SITTING MEMBER - known bias risk' : '; not a sitting member'})
${costLine}

## Question

${run.question}
${run.context ? `
**Context attached:** ${run.context.name} (${run.context.chars.toLocaleString('en-US')} characters) - every member, reviewer and the chairman received it with the question.${omitCost ? '' : ' Full text in run.json.'}
` : ''}

## Final answer (Chairman synthesis)

${run.finalAnswer}

## Per-run leaderboard (${run.leaderboard.confidence === 'normal' ? 'blind peer ranking' : 'confidence: ' + run.leaderboard.confidence})

${lb}
${omitCost ? '' : `
## Cost

${costTable(run.cost)}
`}
${warnings.length ? `## Warnings\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}---
${omitCost ? '' : `Full record (verbatim opinions, blind reviews, de-anonymised label mappings, call ledger): run.json in this directory.\n`}Chairman anonymisation: ${run.chairmanView.note}
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

function saveComparison(comparison) {
  const dir = path.join(RUNS_DIR, 'comparisons');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}-${slugify(comparison.title)}.json`);
  writeFileSync(file, JSON.stringify(comparison, null, 2));
  return file;
}

module.exports = { saveRun, saveComparison, renderReport, fmtUsd, RUNS_DIR };
