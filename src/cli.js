#!/usr/bin/env node
// Advisory Board CLI (Phase 1).
//
// Usage:
//   node src/cli.js "Should we build X or buy Y?" [--tier=top|mid|low]
//        [--providers=anthropic,openai,google] [--chairman=<model-id>]
//        [--compare=mid,low] [--env-file=path] [--leaderboard]
import fs from "node:fs/promises";
import path from "node:path";
import { loadDefaultEnv } from "./env.js";
import { DEFAULT_PROVIDERS, DEFAULT_TIER } from "./config.js";
import { runSitting, readLeaderboard } from "./engine.js";
import { runComparison } from "./compare.js";
import { renderSummary, renderComparison } from "./report.js";
import { formatAggregate } from "./leaderboard.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] ?? true;
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
loadDefaultEnv(args["env-file"]);

if (args.leaderboard) {
  const data = await readLeaderboard();
  const agg = formatAggregate(data);
  console.log(`Aggregate leaderboard — ${agg.sittings} sitting(s), updated ${agg.updated ?? "never"}`);
  for (const e of agg.ranking) {
    console.log(`  ${e.model}: avg position ${e.avgPosition} (${e.votes} votes, ${e.sittings} sittings)`);
  }
  process.exit(0);
}

const question = args._.join(" ").trim();
if (!question) {
  console.error(`Usage: node src/cli.js "your question" [options]

Options:
  --tier=top|mid|low            board tier (default: ${DEFAULT_TIER})
  --providers=a,b,c             anthropic,openai[,google] (default: ${DEFAULT_PROVIDERS.join(",")};
                                google is opt-in — no prepaid credit)
  --chairman=<model-id>         override chairman model
  --compare=tier1,tier2[,t3]    run the same question at multiple tiers
  --env-file=path               load API keys from a .env-style file
  --leaderboard                 print the aggregate leaderboard and exit`);
  process.exit(1);
}

const providers = (args.providers ? String(args.providers).split(",") : DEFAULT_PROVIDERS).map((s) => s.trim());
const onProgress = (msg) => console.error(msg);

try {
  if (args.compare) {
    const tiers = String(args.compare).split(",").map((s) => s.trim());
    if (tiers.length < 2 || tiers.length > 3) {
      console.error("--compare takes 2 or 3 tiers, e.g. --compare=mid,low");
      process.exit(1);
    }
    const result = await runComparison({ question, tiers, providers, onProgress });
    const report = renderComparison(question, result.tierResults, result.verdictText, result.comparisonCostUsd);
    const dir = result.tierResults[0].record.dir;
    const outFile = path.join(path.dirname(dir), `comparison-${Date.now()}.md`);
    await fs.writeFile(outFile, report);
    console.log("\n" + report);
    console.error(`\nComparison saved to ${outFile}`);
  } else {
    const record = await runSitting({
      question,
      tier: args.tier ?? DEFAULT_TIER,
      providers,
      chairman: args.chairman,
      onProgress,
    });
    console.log("\n" + renderSummary(record));
  }
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  if (err.record?.dir) console.error(`Partial record: ${err.record.dir}`);
  process.exit(1);
}
