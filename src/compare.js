// Tier comparison mode: run the same question at 2-3 tiers, report side by
// side, and answer the only question that matters for daily use — where does
// the expensive board change the answer versus merely cost more?
import { runSitting, summariseCost } from "./engine.js";
import { callModel } from "./providers.js";
import { comparisonPrompt } from "./prompts.js";
import { COMPARISON_MODEL, costOf, providerOfModel } from "./config.js";

export async function runComparison({ question, tiers, providers, onProgress = () => {} }) {
  const tierResults = [];
  for (const tier of tiers) {
    onProgress(`\n=== Running ${tier.toUpperCase()} tier ===`);
    const record = await runSitting({ question, tier, providers, onProgress });
    tierResults.push({ tier, record, finalAnswer: record.finalAnswer });
  }

  onProgress(`\nComparing tier answers with ${COMPARISON_MODEL}…`);
  const res = await callModel(COMPARISON_MODEL, {
    ...comparisonPrompt(question, tierResults),
    maxTokens: 6000,
  });
  const comparisonCost = costOf(COMPARISON_MODEL, res.inputTokens, res.outputTokens).usd;

  return {
    question,
    tiers,
    tierResults,
    verdictText: res.text,
    verdictModel: `${providerOfModel(COMPARISON_MODEL)}/${COMPARISON_MODEL}`,
    comparisonCostUsd: comparisonCost,
  };
}
