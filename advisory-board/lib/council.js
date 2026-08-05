// The three-stage deliberation engine.
// Stage 1: independent opinions (parallel, no member sees another's answer).
// Stage 2: blind peer review - identities stripped AND order shuffled per
//          reviewer, so neither name nor position leaks identity.
// Stage 3: Chairman synthesis - the Chairman ALSO receives responses and
//          reviews anonymized (a deliberate fix over the llm-council reference,
//          whose chairman saw model names and could favor a provider by
//          reputation). Identities are attached only afterwards, for the report.

const crypto = require('node:crypto');
const { callModel } = require('./providers');
const { TIERS, HOUSEKEEPING, PREPAID_PROVIDERS, resolveChairman, resolveFallbackChairman } = require('./config');

const MEMBER_MAX_TOKENS = 16000;
const CHAIRMAN_MAX_TOKENS = 16000;

const LABELS = 'ABCDEFGH';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- prompts ----------

const OPINION_SYSTEM = `You are one member of a small advisory board convened to answer a hard question for the person who asked it. The board serves no particular company or project - judge the question on its own terms, using whatever context it provides. Other members are answering the same question independently; you cannot see their answers and they cannot see yours.

Give your own best answer. Take a clear position and defend it - a hedged non-answer is a failed contribution. Structure: your position first, then your reasoning, then the strongest argument against your position and why you still hold it, then what evidence would change your mind. Be concrete and direct. Aim for focused depth over length.`;

function reviewPrompt(question, labeled) {
  const responses = labeled
    .map((l) => `### Response ${l.label}\n\n${l.text}`)
    .join('\n\n---\n\n');
  const labels = labeled.map((l) => `Response ${l.label}`).join(', ');
  return `You are a member of an advisory board. You and several peers each independently answered the question below. You are now reviewing your peers' answers. Authorship is hidden and the order is randomized - judge only the content.

## The question

${question}

## Peer responses to review

${responses}

## Your task

First, evaluate each response individually: what it gets right AND what it gets wrong or misses. Your reasoning must come before any ranking.

Then rank the responses (${labels}) from best to worst on accuracy and insight.

End your reply with a final block in EXACTLY this format - the line "FINAL RANKING:" in all caps with the colon, followed by a numbered list from best to worst, each line containing ONLY the number, a period, and the response label. No commentary inside the ranking block.

Example of a correctly formatted reply (for illustration only - use your own judgment):

Response A is well-reasoned about X but overlooks Y...
Response B correctly identifies Z, however it misjudges W...

FINAL RANKING:
1. Response B
2. Response A`;
}

function chairmanPrompt(question, canonical, reviewsForChairman) {
  const responses = canonical
    .map((c) => `### Response ${c.label}\n\n${c.text}`)
    .join('\n\n---\n\n');
  const reviews = reviewsForChairman
    .map(
      (r) =>
        `### Review by ${r.reviewerAlias}\n(label translation for this review: ${r.translation})\n\n${r.text}`
    )
    .join('\n\n---\n\n');
  return `You are the Chairman of an advisory board. Several board members independently answered a hard question, then blind-reviewed and ranked each other's answers. Authorship is hidden from you too - judge only the content. Each reviewer saw the responses under different labels; a translation line above each review maps that reviewer's labels to the canonical labels used below.

## The question

${question}

## Member responses (canonical labels)

${responses}

## Blind peer reviews

${reviews}

## Your task

Produce the board's final answer. Hard rules:

1. Reconcile what the members said - do NOT introduce claims that appear in no member response. Every substantive claim in your answer must be traceable to a response or review above.
2. Surface agreement and disagreement explicitly. Your answer MUST contain these three sections after the main answer:
   - **Where the board agreed** - the points of genuine consensus.
   - **Where the board split** - name which response (by canonical label) held which position, and present the STRONGEST version of the minority view, not a strawman. If the board was divided, saying so is mandatory; a synthesis that reads as unanimous when it was not is a failed synthesis.
   - **What would resolve the disagreement** - the evidence or test that would settle each split.
3. Open with the final answer itself: a direct, decision-ready recommendation.`;
}

// ---------- ranking parse ----------

function parseRanking(text, validLabels) {
  const result = { positions: null, method: null };
  const tail = text.split(/FINAL RANKING:/i)[1];
  if (tail) {
    const found = [];
    for (const m of tail.matchAll(/^\s*\d+\.\s*Response\s+([A-Z])\b/gim)) {
      const label = m[1].toUpperCase();
      if (validLabels.includes(label) && !found.includes(label)) found.push(label);
    }
    if (found.length === validLabels.length) {
      result.positions = found;
      result.method = 'final-ranking-block';
      return result;
    }
  }
  // Fallback: scan for "Response X" mentions in order of appearance after the
  // marker (or in the whole text), dedup.
  const scanText = tail || text;
  const found = [];
  for (const m of scanText.matchAll(/Response\s+([A-Z])\b/gi)) {
    const label = m[1].toUpperCase();
    if (validLabels.includes(label) && !found.includes(label)) found.push(label);
  }
  if (found.length === validLabels.length) {
    result.positions = found;
    result.method = 'fallback-scan';
  }
  return result;
}

// ---------- cost helpers ----------

function newLedger() {
  return { calls: [] };
}

function record(ledger, stage, member, out) {
  ledger.calls.push({
    stage,
    provider: member.provider,
    model: member.model,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    costUsd: out.costUsd,
    ms: out.ms,
  });
}

function summarizeCost(ledger) {
  const byModel = {};
  const byProvider = {};
  let total = 0;
  for (const c of ledger.calls) {
    const k = `${c.provider}/${c.model}`;
    byModel[k] = byModel[k] || { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
    byModel[k].inputTokens += c.inputTokens;
    byModel[k].outputTokens += c.outputTokens;
    byModel[k].costUsd += c.costUsd;
    byModel[k].calls += 1;
    byProvider[c.provider] = (byProvider[c.provider] || 0) + c.costUsd;
    total += c.costUsd;
  }
  const outOfPocket = Object.entries(byProvider)
    .filter(([p]) => !PREPAID_PROVIDERS.has(p))
    .reduce((s, [, v]) => s + v, 0);
  return { byModel, byProvider, totalUsd: total, prepaidUsd: total - outOfPocket, outOfPocketUsd: outOfPocket };
}

// ---------- the engine ----------

// A provider spec is "name" (member drawn from the board's tier) or
// "name:tier" / "name:model-id" (member drawn from another tier - e.g. a top
// board with a cheaper Gemini: --tier=top --providers=anthropic,openai,google:mid).
function resolveMember(spec, boardTier) {
  const [provider, ...rest] = String(spec).split(':');
  const suffix = rest.join(':');
  if (!TIERS[boardTier][provider]) throw new Error(`Unknown provider in --providers: ${provider}`);
  if (!suffix) return { provider, memberTier: boardTier, ...TIERS[boardTier][provider] };
  if (TIERS[suffix]) return { provider, memberTier: suffix, ...TIERS[suffix][provider] };
  for (const t of Object.keys(TIERS)) {
    if (TIERS[t][provider] && TIERS[t][provider].model === suffix) {
      return { provider, memberTier: t, ...TIERS[t][provider] };
    }
  }
  throw new Error(
    `Bad member spec "${spec}": "${suffix}" is neither a tier (${Object.keys(TIERS).join('/')}) nor a ${provider} model in the tier table`
  );
}

async function convene({ question, tier, providers, chairmanOverride, keys, log = () => {} }) {
  if (!TIERS[tier]) throw new Error(`Unknown tier: ${tier}`);
  const roster = providers.map((spec) => resolveMember(spec, tier));
  const mixedTier = roster.some((m) => m.memberTier !== tier);
  if (roster.length < 2) throw new Error('The board needs at least 2 members (use --providers)');
  const chairman = resolveChairman(tier, roster, chairmanOverride);
  const chairmanIsSitting = roster.some(
    (m) => m.provider === chairman.provider && m.model === chairman.model
  );

  const ledger = newLedger();
  const warnings = [];

  // Stage 1 - independent opinions, in parallel.
  log(`stage 1: asking ${roster.map((m) => m.model).join(', ')} independently...`);
  const stage1 = await Promise.allSettled(
    roster.map((m) =>
      callModel(m, { system: OPINION_SYSTEM, user: question, maxTokens: MEMBER_MAX_TOKENS }, keys)
    )
  );
  const members = [];
  stage1.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      record(ledger, 'opinion', roster[i], r.value);
      members.push({ ...roster[i], opinion: r.value.text });
      log(`  ${roster[i].model}: ok (${r.value.outputTokens} out tokens, ${(r.value.ms / 1000).toFixed(0)}s)`);
    } else {
      warnings.push(`Member ${roster[i].provider}/${roster[i].model} FAILED in stage 1: ${r.reason.message}. The board ran short-handed.`);
      log(`  ${roster[i].model}: FAILED - ${r.reason.message}`);
    }
  });
  if (members.length === 0) {
    throw new Error(`All board members failed:\n${warnings.join('\n')}`);
  }

  // Stage 2 - blind peer review (skipped if only one member survived).
  let reviews = [];
  if (members.length >= 2) {
    log(`stage 2: blind peer review (${members.length} reviewers, labels shuffled per reviewer)...`);
    const reviewJobs = members.map((reviewer) => {
      const others = members.filter((m) => m !== reviewer);
      const labeled = shuffle(others).map((m, i) => ({
        label: LABELS[i],
        member: m,
        text: m.opinion,
      }));
      return { reviewer, labeled };
    });
    const stage2 = await Promise.allSettled(
      reviewJobs.map((job) =>
        callModel(
          job.reviewer,
          { system: 'You are a rigorous, fair reviewer.', user: reviewPrompt(question, job.labeled), maxTokens: MEMBER_MAX_TOKENS },
          keys
        )
      )
    );
    stage2.forEach((r, i) => {
      const job = reviewJobs[i];
      const mapping = job.labeled.map((l) => ({
        label: l.label,
        provider: l.member.provider,
        model: l.member.model,
      }));
      if (r.status === 'fulfilled') {
        record(ledger, 'review', job.reviewer, r.value);
        const validLabels = job.labeled.map((l) => l.label);
        const parsed = parseRanking(r.value.text, validLabels);
        if (!parsed.positions) {
          warnings.push(`Ranking by ${job.reviewer.model} could not be parsed; its vote is EXCLUDED from the leaderboard (review text kept).`);
        }
        reviews.push({
          reviewer: { provider: job.reviewer.provider, model: job.reviewer.model },
          labelMapping: mapping,
          text: r.value.text,
          ranking: parsed.positions,
          rankingParseMethod: parsed.method,
        });
        log(`  ${job.reviewer.model}: ok (ranking ${parsed.positions ? parsed.positions.join(' > ') : 'PARSE FAILED'})`);
      } else {
        warnings.push(`Reviewer ${job.reviewer.model} FAILED in stage 2: ${r.reason.message}. Its review and vote are missing.`);
        log(`  ${job.reviewer.model}: FAILED - ${r.reason.message}`);
      }
    });
  } else {
    warnings.push('Only one member survived stage 1 - peer review skipped; no deliberation happened.');
  }

  // Aggregate leaderboard: convert each parsed ranking to positions, average.
  const tally = {};
  for (const m of members) tally[`${m.provider}/${m.model}`] = { positions: [] };
  for (const rev of reviews) {
    if (!rev.ranking) continue;
    rev.ranking.forEach((label, idx) => {
      const entry = rev.labelMapping.find((lm) => lm.label === label);
      if (entry) tally[`${entry.provider}/${entry.model}`].positions.push(idx + 1);
    });
  }
  const leaderboard = Object.entries(tally)
    .map(([key, t]) => ({
      member: key,
      votes: t.positions.length,
      avgPosition: t.positions.length
        ? t.positions.reduce((a, b) => a + b, 0) / t.positions.length
        : null,
    }))
    .sort((a, b) => (a.avgPosition ?? Infinity) - (b.avgPosition ?? Infinity));
  const leaderboardConfidence =
    members.length >= 3
      ? 'normal'
      : 'LOW - with fewer than 3 members this is only "who did the other one prefer", not a finding';

  // Stage 3 - Chairman synthesis, anonymized for the Chairman too.
  log(`stage 3: chairman synthesis by ${chairman.model}${chairmanIsSitting ? ' (SITTING MEMBER - bias risk)' : ''}...`);
  const canonical = shuffle(members).map((m, i) => ({
    label: LABELS[i],
    provider: m.provider,
    model: m.model,
    text: m.opinion,
  }));
  const canonicalLabelOf = (provider, model) => {
    const hit = canonical.find((c) => c.provider === provider && c.model === model);
    return hit ? hit.label : '?';
  };
  const reviewsForChairman = reviews.map((rev, i) => ({
    reviewerAlias: `Reviewer ${i + 1}`,
    translation: rev.labelMapping
      .map((lm) => `this review's Response ${lm.label} = canonical Response ${canonicalLabelOf(lm.provider, lm.model)}`)
      .join('; '),
    text: rev.text,
  }));
  const chairmanRequest = {
    system: 'You are the Chairman of an advisory board. You reconcile; you do not invent.',
    user: chairmanPrompt(question, canonical, reviewsForChairman),
    maxTokens: CHAIRMAN_MAX_TOKENS,
  };
  let actingChairman = chairman;
  let synthesis;
  try {
    synthesis = await callModel(chairman, chairmanRequest, keys);
  } catch (err) {
    // Don't discard the board's finished stage-1/2 work over a chairman-side
    // outage: fall back to the same-tier OpenAI chairman (still non-sitting),
    // unless the caller pinned a chairman explicitly.
    if (chairmanOverride) throw err;
    const fallback = resolveFallbackChairman(tier);
    if (roster.some((m) => m.provider === fallback.provider && m.model === fallback.model)) {
      throw err; // fallback would be a sitting member - refuse silently degrading the mechanism
    }
    warnings.push(
      `Default chairman ${chairman.model} FAILED (${err.message}); synthesis by fallback chairman ${fallback.model} instead.`
    );
    log(`  chairman ${chairman.model} FAILED - falling back to ${fallback.model}...`);
    actingChairman = fallback;
    synthesis = await callModel(fallback, chairmanRequest, keys);
  }
  record(ledger, 'synthesis', actingChairman, synthesis);

  // Housekeeping: short run title from the LOW-cost model; NOT on the board's cost line.
  let title = question.slice(0, 60);
  let housekeepingCost = null;
  try {
    const t = await callModel(
      HOUSEKEEPING,
      {
        system: 'You label records. Reply with ONLY a 3-6 word title, no quotes, no punctuation at the end.',
        user: `Title for this advisory-board question: ${question}`,
        maxTokens: 100,
      },
      keys
    );
    title = t.text.trim().replace(/^#+\s*/, '').replace(/["\n]/g, '').slice(0, 80) || title;
    housekeepingCost = { model: HOUSEKEEPING.model, costUsd: t.costUsd, inputTokens: t.inputTokens, outputTokens: t.outputTokens };
  } catch (err) {
    warnings.push(`Housekeeping title call failed (cosmetic only): ${err.message}`);
  }

  const cost = summarizeCost(ledger);
  if (roster.some((m) => m.provider === 'google')) {
    warnings.push(
      `Gemini seat: $${cost.byProvider.google ? cost.byProvider.google.toFixed(4) : '0'} of this run was OUT-OF-POCKET (Anthropic and OpenAI draw prepaid credit). Toggle the Google seat off to avoid it.`
    );
  }

  return {
    title,
    question,
    tier,
    mixedTier,
    members: members.map((m) => ({ provider: m.provider, model: m.model, memberTier: m.memberTier })),
    failedMembers: roster
      .filter((r) => !members.some((m) => m.provider === r.provider && m.model === r.model))
      .map((r) => ({ provider: r.provider, model: r.model })),
    chairman: {
      provider: actingChairman.provider,
      model: actingChairman.model,
      source: actingChairman.source,
      isSittingMember: roster.some(
        (m) => m.provider === actingChairman.provider && m.model === actingChairman.model
      ),
    },
    opinions: members.map((m) => ({ provider: m.provider, model: m.model, text: m.opinion })),
    reviews,
    chairmanView: {
      canonicalMapping: canonical.map((c) => ({ label: c.label, provider: c.provider, model: c.model })),
      note: 'The Chairman saw only canonical labels, never model names; this mapping was attached after synthesis.',
    },
    leaderboard: { entries: leaderboard, confidence: leaderboardConfidence },
    finalAnswer: synthesis.text,
    cost,
    housekeepingCost,
    warnings,
    ledger: ledger.calls,
    finishedAt: new Date().toISOString(),
  };
}

module.exports = { convene, MEMBER_MAX_TOKENS };
