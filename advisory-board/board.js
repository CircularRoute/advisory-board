#!/usr/bin/env node
// Advisory Board CLI - a multi-vendor deliberation instrument.
//
//   node board.js "the question"                       # mid tier, anthropic+openai
//   node board.js --tier=top "the question"
//   node board.js --providers=anthropic,openai,google "the question"   # Gemini opt-in (out-of-pocket)
//   node board.js --chairman=openai:gpt-5.6-sol "the question"
//   node board.js --compare=mid,top "the question"     # same question at 2-3 tiers, side by side
//
// Advisory only: prints an answer and persists the record. Never writes to any
// other system, never sends, never decides.

const { loadKeys, DEFAULT_TIER, DEFAULT_PROVIDERS, HOUSEKEEPING, TIERS } = require('./lib/config');
const { convene } = require('./lib/council');
const { callModel } = require('./lib/providers');
const { saveRun, saveComparison, fmtUsd } = require('./lib/store');

function parseArgs(argv) {
  const opts = { tier: DEFAULT_TIER, providers: DEFAULT_PROVIDERS.slice(), chairman: null, compare: null };
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--tier=')) opts.tier = a.slice(7);
    else if (a.startsWith('--providers=')) opts.providers = a.slice(12).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--chairman=')) opts.chairman = a.slice(11);
    else if (a.startsWith('--compare=')) opts.compare = a.slice(10).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  opts.question = rest.join(' ').trim();
  return opts;
}

function printHeader(run) {
  const line = '='.repeat(72);
  console.log(`\n${line}`);
  console.log(`ADVISORY BOARD - TIER: ${run.tier.toUpperCase()}${run.mixedTier ? ' (MIXED-TIER BOARD)' : ''}`);
  console.log(`Board:    ${run.members.map((m) => `${m.provider}/${m.model}${m.memberTier && m.memberTier !== run.tier ? ` [${m.memberTier}-tier member]` : ''}`).join('  +  ')}${run.failedMembers.length ? `   (SHORT-HANDED, failed: ${run.failedMembers.map((m) => m.model).join(', ')})` : ''}`);
  console.log(`Chairman: ${run.chairman.provider}/${run.chairman.model} - ${run.chairman.source}${run.chairman.isSittingMember ? ' [SITTING MEMBER - bias risk]' : ' [not a sitting member]'}`);
  const perModel = Object.entries(run.cost.byModel)
    .map(([m, v]) => `${m} ${fmtUsd(v.costUsd)}`)
    .join(' | ');
  console.log(`Cost:     ${fmtUsd(run.cost.totalUsd)} total  (${perModel})`);
  console.log(`          prepaid credit ${fmtUsd(run.cost.prepaidUsd)}, out-of-pocket ${fmtUsd(run.cost.outOfPocketUsd)}`);
  console.log(line);
}

function printRun(run, dir) {
  printHeader(run);
  console.log(`\n${run.finalAnswer}\n`);
  console.log('-'.repeat(72));
  console.log(`Leaderboard (${run.leaderboard.confidence === 'normal' ? 'blind peer ranking' : run.leaderboard.confidence}):`);
  run.leaderboard.entries.forEach((e, i) =>
    console.log(`  ${i + 1}. ${e.member}  avg position ${e.avgPosition === null ? 'n/a' : e.avgPosition.toFixed(2)}  (${e.votes} votes)`)
  );
  for (const w of run.warnings) console.log(`  ! ${w}`);
  console.log(`Record: ${dir}`);
}

async function compareAcrossTiers(opts, keys) {
  const tiers = opts.compare;
  for (const t of tiers) if (!TIERS[t]) throw new Error(`Unknown tier in --compare: ${t}`);
  console.log(`Tier comparison: running the same question at [${tiers.join(', ')}]...`);
  const runs = [];
  for (const tier of tiers) {
    // Sequential on purpose: keeps concurrent load down and output readable.
    const run = await convene({
      question: opts.question,
      tier,
      providers: opts.providers,
      chairmanOverride: opts.chairman,
      keys,
      log: (m) => console.log(`[${tier}] ${m}`),
    });
    const dir = saveRun(run);
    printRun(run, dir);
    runs.push({ run, dir });
  }

  // Did the tiers actually reach different conclusions? Judged by the cheap
  // housekeeping model (not billed to the board's cost line).
  const verdicts = [];
  for (let i = 0; i < runs.length - 1; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j];
      let verdict = 'UNKNOWN (housekeeping comparison failed)';
      try {
        const cmp = await callModel(
          HOUSEKEEPING,
          {
            system:
              'You compare two answers to the same question. Reply with one line "VERDICT: SAME" if they reach materially the same conclusion/recommendation, or "VERDICT: DIFFERENT" if a decision-maker would act differently depending on which they read. Then 1-3 sentences naming the material difference (or the shared conclusion).',
            user: `Question:\n${opts.question}\n\n--- Answer 1 (${a.run.tier} tier) ---\n${a.run.finalAnswer}\n\n--- Answer 2 (${b.run.tier} tier) ---\n${b.run.finalAnswer}`,
            maxTokens: 1000,
          },
          keys
        );
        verdict = cmp.text.trim();
      } catch (err) {
        verdict += `: ${err.message}`;
      }
      verdicts.push({ tiers: [a.run.tier, b.run.tier], verdict });
    }
  }

  const comparison = {
    title: runs[0].run.title,
    question: opts.question,
    at: new Date().toISOString(),
    tiers: runs.map(({ run, dir }) => ({
      tier: run.tier,
      costUsd: run.cost.totalUsd,
      runDir: dir,
      finalAnswer: run.finalAnswer,
    })),
    verdicts,
  };
  const file = saveComparison(comparison);

  console.log(`\n${'='.repeat(72)}\nTIER COMPARISON - ${comparison.title}`);
  for (const t of comparison.tiers) console.log(`  ${t.tier.padEnd(4)} cost ${fmtUsd(t.costUsd)}  -> ${t.runDir}`);
  for (const v of verdicts) console.log(`\n[${v.tiers.join(' vs ')}]\n${v.verdict}`);
  console.log(`\nComparison record: ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.question) {
    console.log(`Usage: node board.js [--tier=top|mid|low] [--providers=...] [--chairman=provider:model] [--compare=tier1,tier2[,tier3]] "the question"

Defaults: --tier=mid --providers=anthropic,openai,google:mid (the Gemini seat
is pinned to mid tier and spends out-of-pocket money; drop it with
--providers=anthropic,openai. Anthropic and OpenAI draw prepaid credit).

A provider entry may pin its member to another tier or an exact model
(mixed-tier board), e.g. a top board with a cheaper Gemini seat:
  --tier=top --providers=anthropic,openai,google:mid
  --tier=top --providers=anthropic,openai,google:gemini-3.5-flash-lite`);
    process.exit(opts.help ? 0 : 1);
  }
  const keys = loadKeys();
  for (const spec of opts.providers) {
    const p = spec.split(':')[0];
    if (!keys[p]) throw new Error(`Provider "${p}" requested but no key found in the key env file.`);
  }
  if (opts.chairman) {
    const chairProvider = opts.chairman.split(':')[0];
    if (!keys[chairProvider]) throw new Error(`Chairman provider "${chairProvider}" has no key configured.`);
  }

  if (opts.compare) {
    await compareAcrossTiers(opts, keys);
    return;
  }

  const run = await convene({
    question: opts.question,
    tier: opts.tier,
    providers: opts.providers,
    chairmanOverride: opts.chairman,
    keys,
    log: (m) => console.log(m),
  });
  const dir = saveRun(run);
  printRun(run, dir);
}

main().catch((err) => {
  console.error(`\nBOARD ERROR: ${err.message}`);
  process.exit(1);
});
