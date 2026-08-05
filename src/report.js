// Human-readable report. Tier and cost print at the top of every output —
// a top-tier answer and a low-tier answer must never be mistakable.

const usd = (n) => (n == null ? "?" : `$${n.toFixed(4)}`);

export function renderReport(record) {
  const c = record.cost;
  const providerLines = Object.entries(c.byProvider)
    .map(([p, v]) => `  - ${p}: ${usd(v)}`)
    .join("\n");
  const lines = [];
  lines.push(`# ${record.title ?? "Advisory Board sitting"}`);
  lines.push("");
  lines.push(`**TIER: ${record.tier.toUpperCase()}**  |  **TOTAL COST: ${usd(c.totalUsd)}**${c.estimatedPricesUsed ? " (includes estimated Gemini pricing)" : ""}`);
  lines.push("");
  lines.push(`- Board: ${record.board.join(", ")}`);
  lines.push(`- Chairman: ${record.chairman} (non-member)`);
  lines.push(`- Cost split by provider:\n${providerLines}`);
  lines.push(`- Cost by line: board ${usd(c.boardUsd)} | housekeeping ${usd(c.housekeepingUsd)}${c.comparisonUsd ? ` | comparison ${usd(c.comparisonUsd)}` : ""}`);
  lines.push(`- Sitting: ${record.startedAt} (${record.id})`);
  if (record.notes?.length) {
    lines.push("");
    lines.push("**⚠ Notes:**");
    for (const n of record.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`## Question\n\n${record.question}`);
  lines.push("");
  lines.push(`## FINAL ANSWER\n\n${record.finalAnswer}`);
  if (record.agreements) lines.push(`\n## WHERE THE BOARD AGREED\n\n${record.agreements}`);
  if (record.disagreements) lines.push(`\n## WHERE THE BOARD SPLIT\n\n${record.disagreements}`);
  if (record.resolution) lines.push(`\n## WHAT WOULD RESOLVE IT\n\n${record.resolution}`);

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## De-anonymised mapping (revealed after synthesis)");
  lines.push("");
  for (const [label, model] of Object.entries(record.chairmanMapping ?? {})) {
    lines.push(`- Response ${label} = ${model}`);
  }
  lines.push("");
  lines.push("## Rankings");
  lines.push("");
  for (const r of record.reviews ?? []) {
    if (!r.ok) {
      lines.push(`- ${r.reviewer}: REVIEW FAILED (${r.rankingError})`);
    } else if (!r.ranking) {
      lines.push(`- ${r.reviewer}: ranking UNPARSEABLE (${r.rankingError})`);
    } else {
      const named = r.ranking.map((l, i) => `${i + 1}. ${r.labelMap[l]}`).join("  ");
      lines.push(`- ${r.reviewer} ranked: ${named}${r.rankingMethod === "fallback" ? " (parsed via fallback scan)" : ""}`);
    }
  }
  lines.push("");
  lines.push(`## Leaderboard — this sitting (confidence: ${record.leaderboardConfidence})`);
  lines.push("");
  for (const e of record.sittingLeaderboard ?? []) {
    lines.push(`- ${e.model}: avg position ${e.avgPosition.toFixed(2)} over ${e.votes} vote(s)`);
  }
  if (record.aggregateLeaderboard) {
    lines.push("");
    lines.push(`## Aggregate leaderboard (all ${record.aggregateLeaderboard.sittings} sittings)`);
    lines.push("");
    for (const e of record.aggregateLeaderboard.ranking) {
      lines.push(`- ${e.model}: avg position ${e.avgPosition} over ${e.votes} vote(s) in ${e.sittings} sitting(s)`);
    }
  }
  lines.push("");
  lines.push("## Original responses and reviews");
  lines.push("");
  for (const o of record.opinions ?? []) {
    lines.push(`### Opinion — ${o.member}${o.chairLabel ? ` (Response ${o.chairLabel} to the chairman)` : ""}`);
    lines.push("");
    lines.push(o.ok ? o.text : `FAILED: ${o.error}`);
    lines.push("");
  }
  for (const r of record.reviews ?? []) {
    if (!r.ok) continue;
    lines.push(`### Review — by ${r.reviewer}`);
    lines.push("");
    lines.push(`(label map: ${Object.entries(r.labelMap).map(([l, m]) => `${l}=${m}`).join(", ")})`);
    lines.push("");
    lines.push(r.text);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderSummary(record) {
  const c = record.cost;
  const head =
    `TIER: ${record.tier.toUpperCase()} | COST: ${usd(c.totalUsd)}` +
    `${c.estimatedPricesUsed ? " (incl. estimated Gemini pricing)" : ""} | ` +
    `board ${record.board.join(" + ")} | chairman ${record.chairman}`;
  const parts = [head, ""];
  if (record.notes?.length) {
    parts.push("⚠ " + record.notes.join("\n⚠ "), "");
  }
  parts.push("═".repeat(70), "FINAL ANSWER", "═".repeat(70), "", record.finalAnswer, "");
  if (record.agreements) parts.push("── WHERE THE BOARD AGREED ──", "", record.agreements, "");
  if (record.disagreements) parts.push("── WHERE THE BOARD SPLIT ──", "", record.disagreements, "");
  if (record.resolution) parts.push("── WHAT WOULD RESOLVE IT ──", "", record.resolution, "");
  parts.push(`Full record: ${record.dir}`);
  return parts.join("\n");
}

export function renderComparison(question, tierResults, verdictText, comparisonCostUsd) {
  const lines = [];
  lines.push("# Tier comparison");
  lines.push("");
  lines.push(`Question: ${question}`);
  lines.push("");
  lines.push("| Tier | Cost | Board |");
  lines.push("|---|---|---|");
  for (const t of tierResults) {
    lines.push(`| ${t.tier.toUpperCase()} | ${usd(t.record.cost.totalUsd)} | ${t.record.board.join(", ")} |`);
  }
  lines.push(`| comparison verdict | ${usd(comparisonCostUsd)} | — |`);
  lines.push("");
  lines.push(verdictText);
  lines.push("");
  for (const t of tierResults) {
    lines.push(`\n---\n\n# ${t.tier.toUpperCase()} tier — full answer\n`);
    lines.push(t.record.finalAnswer);
    if (t.record.disagreements) lines.push(`\n## Where the ${t.tier} board split\n\n${t.record.disagreements}`);
  }
  return lines.join("\n");
}
