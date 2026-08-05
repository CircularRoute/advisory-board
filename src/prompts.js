// Prompt builders for the three stages. Reasoning must come BEFORE the
// ranking in stage 2, or the model rationalises a snap judgement.

export function stage1Prompt(question) {
  return {
    system:
      "You are one member of a small advisory board of independent experts. " +
      "You are answering alone; you will not see anyone else's answer. " +
      "Give your genuine best answer: commit to a position, show the key reasoning " +
      "behind it, and be honest about real uncertainty rather than hedging everything. " +
      "Substance over length.",
    prompt: question,
  };
}

export function stage2Prompt(question, labeledResponses) {
  const labels = labeledResponses.map((r) => r.label);
  const blocks = labeledResponses
    .map((r) => `### Response ${r.label}\n\n${r.text}`)
    .join("\n\n---\n\n");
  const exampleLines = labels.map((l, i) => `${i + 1}. Response ${l}`).join("\n");
  return {
    system:
      "You are one member of an advisory board, now acting as a blind peer reviewer. " +
      "The responses below were written by other experts; their identities have been removed " +
      "and the order is randomised. Judge only what is on the page.",
    prompt: `The board was asked:

<question>
${question}
</question>

Below ${labels.length === 1 ? "is the anonymised response" : "are the anonymised responses"} from the other member${labels.length === 1 ? "" : "s"}:

${blocks}

---

Your task, in this exact order:

1. Evaluate each response individually. For each one, say concretely what it does well and what it does poorly, judged on accuracy and insight. Refer to responses only by their labels ("Response ${labels[0]}"${labels.length > 1 ? ", etc." : ""}).
2. Only after you have written all the evaluations, rank the responses from best to worst on accuracy and insight.

Your reply MUST end with a machine-readable ranking block in exactly this format — all caps with the colon, a numbered list from best to worst, each line containing only "N. Response X", and no commentary inside or after the block.

Worked example (for illustration only — use your own ranking of the actual responses above):

FINAL RANKING:
${exampleLines}

Now write your evaluations, then the FINAL RANKING block.`,
  };
}

export function chairmanPrompt({ question, answers, reviews, shortHandedNote }) {
  const answerBlocks = answers
    .map((a) => `### Response ${a.label}\n\n${a.text}`)
    .join("\n\n---\n\n");
  const reviewBlocks = reviews
    .map(
      (r) =>
        `### Reviewer ${r.reviewerNum} (author of Response ${r.authorLabel})\n\n${r.text}`
    )
    .join("\n\n---\n\n");
  return {
    system:
      "You are the Chairman of an advisory board. Several independent experts answered a question " +
      "and then blind-reviewed each other's answers. Their identities are hidden from you too — " +
      "you know them only by anonymous labels, so judge arguments, not reputations. " +
      "Your job is to synthesise, and above all to surface disagreement rather than manufacture consensus: " +
      "a synthesis that reads unanimous when the board was split is a failure. " +
      "You reconcile; you never invent — do not introduce any substantive claim that no board member made.",
    prompt: `The board was asked:

<question>
${question}
</question>

${shortHandedNote ? shortHandedNote + "\n\n" : ""}## The anonymised answers

${answerBlocks}

---

## The blind peer reviews

(Reviewers saw the other members' answers under the same labels used above. Each reviewer is also the author of one response, as noted — but a reviewer NEVER saw, reviewed, or ranked their own response, so a ranking can never express self-preference.)

${reviewBlocks}

---

Write the board's final synthesis using exactly these four markdown sections, in this order:

## FINAL ANSWER
The board's answer to the question, as one coherent, decision-ready piece. Ground every claim in what a member actually said.

## WHERE THE BOARD AGREED
The substantive points of genuine agreement across members.

## WHERE THE BOARD SPLIT
Every real disagreement: name the opposing positions (by response label), and present the STRONGEST version of the minority view, not a strawman. If the board did not meaningfully disagree on anything, say so explicitly and say why you are confident that is real agreement rather than shallow overlap.

## WHAT WOULD RESOLVE IT
Concretely, what evidence, experiment, data, or decision would settle each open disagreement.`,
  };
}

export function titlePrompt(question) {
  return {
    system: "You generate short titles. Respond with the title only — no quotes, no punctuation at the end.",
    prompt: `Write a 3-7 word title for this question:\n\n${question.slice(0, 2000)}`,
  };
}

export function comparisonPrompt(question, tierResults) {
  const blocks = tierResults
    .map((t) => `### ${t.tier.toUpperCase()} tier final answer\n\n${t.finalAnswer}`)
    .join("\n\n---\n\n");
  return {
    system:
      "You compare answers produced by different configurations of the same advisory process. " +
      "Be blunt about whether they actually differ. 'No meaningful difference' is a valuable finding, not a failure.",
    prompt: `The same question was put to an advisory board at ${tierResults.length} different capability/cost tiers.

<question>
${question}
</question>

${blocks}

---

Answer, using exactly these sections:

## VERDICT
One of: SAME CONCLUSION / DIFFERENT EMPHASIS / DIFFERENT CONCLUSION — then one sentence of justification.

## WHAT DIFFERS
The concrete differences in conclusions, recommendations, or reasoning quality between the tiers, if any. Quote or paraphrase specifics.

## WHICH TIER TO USE FOR QUESTIONS LIKE THIS
A practical recommendation: does the expensive tier change the answer here, or merely cost more?`,
  };
}
