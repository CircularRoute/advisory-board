// The deliberation engine: three stages, anonymisation, ranking parse,
// leaderboard, cost accounting. Fails loudly, never fabricates.
import crypto from "node:crypto";
import { boardFor, pickChairman, providerOfModel } from "./config.js";
import { callModel } from "./providers.js";
import {
  stage1Prompt,
  stage2Prompt,
  chairmanPrompt,
  titlePrompt,
} from "./prompts.js";
import { parseRanking } from "./ranking.js";
import { updateLeaderboard, readLeaderboard } from "./leaderboard.js";
import { persistSitting } from "./persist.js";

const LABELS = "ABCDEFGH".split("");

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Wrap a model call, recording it on the cost ledger under `line`. */
async function tracked(calls, line, stage, model, args) {
  const memberName = `${providerOfModel(model)}/${model}`;
  try {
    const res = await callModel(model, args);
    calls.push({
      line, // "board" | "housekeeping" | "comparison"
      stage,
      model: memberName,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costUsd: res.costUsd,
      costEstimated: res.costEstimated,
      elapsedMs: res.elapsedMs,
      warnings: res.warnings,
      ok: true,
    });
    return res;
  } catch (err) {
    calls.push({ line, stage, model: memberName, ok: false, error: String(err.message ?? err) });
    throw err;
  }
}

export async function runSitting({
  question,
  tier = "mid",
  providers,
  chairman: chairmanOverride,
  onProgress = () => {},
}) {
  const startedAt = new Date().toISOString();
  const members = boardFor(tier, providers).map((m, i) => ({
    ...m,
    id: i,
    name: `${m.provider}/${m.model}`,
  }));
  const chairmanModel = pickChairman(tier, members, chairmanOverride);
  const calls = [];
  const notes = [];

  // ---------- Stage 1: independent opinions (parallel) ----------
  onProgress(`Stage 1: asking ${members.length} members independently (${tier} tier)…`);
  const opinionResults = await Promise.allSettled(
    members.map((m) =>
      tracked(calls, "board", "opinion", m.model, {
        ...stage1Prompt(question),
        maxTokens: 10000,
      })
    )
  );
  const opinions = members.map((m, i) => ({
    member: m,
    ok: opinionResults[i].status === "fulfilled",
    text: opinionResults[i].status === "fulfilled" ? opinionResults[i].value.text : null,
    error:
      opinionResults[i].status === "rejected"
        ? String(opinionResults[i].reason?.message ?? opinionResults[i].reason)
        : null,
  }));
  const alive = opinions.filter((o) => o.ok);
  const failed = opinions.filter((o) => !o.ok);
  for (const f of failed) {
    notes.push(`Member ${f.member.name} failed in stage 1: ${f.error}. The board sat short-handed.`);
  }
  if (alive.length === 0) {
    const record = baseRecord();
    record.error = "All board members failed to respond. No answer was synthesised.";
    await persistSitting(record);
    throw Object.assign(new Error(record.error), { record });
  }

  // ---------- Stage 2: blind peer review (parallel) ----------
  // Each surviving member reviews the OTHER members' answers, identities
  // stripped, order shuffled per reviewer (a fixed order leaks identity
  // across runs).
  let reviews = [];
  if (alive.length >= 2) {
    onProgress(`Stage 2: ${alive.length} members blind-reviewing each other…`);
    const reviewJobs = alive.map((reviewer) => {
      const targets = shuffle(alive.filter((o) => o.member.id !== reviewer.member.id));
      const labeled = targets.map((t, i) => ({ label: LABELS[i], target: t, text: t.text }));
      return { reviewer, labeled };
    });
    const reviewResults = await Promise.allSettled(
      reviewJobs.map((job) =>
        tracked(calls, "board", "review", job.reviewer.member.model, {
          ...stage2Prompt(question, job.labeled),
          maxTokens: 8000,
        })
      )
    );
    reviews = reviewJobs.map((job, i) => {
      const settled = reviewResults[i];
      const base = {
        reviewer: job.reviewer.member,
        labelMap: Object.fromEntries(job.labeled.map((l) => [l.label, l.target.member.name])),
        labelToMemberId: Object.fromEntries(job.labeled.map((l) => [l.label, l.target.member.id])),
      };
      if (settled.status === "rejected") {
        notes.push(
          `Reviewer ${job.reviewer.member.name} failed in stage 2: ${String(
            settled.reason?.message ?? settled.reason
          )}. Their vote is missing.`
        );
        return { ...base, ok: false, error: String(settled.reason?.message ?? settled.reason) };
      }
      const expected = job.labeled.map((l) => l.label);
      const parsed = parseRanking(settled.value.text, expected);
      if (!parsed.ranking) {
        notes.push(
          `Ranking from ${job.reviewer.member.name} could not be parsed (${parsed.error}). Their vote is excluded from the leaderboard but their written review stands.`
        );
      }
      return {
        ...base,
        ok: true,
        text: settled.value.text,
        ranking: parsed.ranking,
        rankingMethod: parsed.method ?? null,
        rankingError: parsed.error ?? null,
      };
    });
  } else {
    notes.push(
      "Only one member responded — no peer review is possible. The final answer below reflects a single model, not a deliberation."
    );
  }

  // ---------- Leaderboard for this sitting ----------
  const positions = {}; // member name -> [positions]
  for (const r of reviews) {
    if (!r.ok || !r.ranking) continue;
    r.ranking.forEach((label, idx) => {
      const name = r.labelMap[label];
      (positions[name] ??= []).push(idx + 1);
    });
  }
  const sittingLeaderboard = Object.entries(positions)
    .map(([name, pos]) => ({
      model: name,
      avgPosition: pos.reduce((a, b) => a + b, 0) / pos.length,
      votes: pos.length,
    }))
    .sort((a, b) => a.avgPosition - b.avgPosition);
  const leaderboardConfidence =
    alive.length < 3
      ? "low (fewer than 3 members — with two members each reviewer ranks a single response, so positions are degenerate)"
      : "normal";

  // ---------- Stage 3: chairman synthesis ----------
  // Anonymise for the Chairman too — fresh labels, fresh shuffle. Reviews are
  // re-labelled into the chairman's label space so the chairman reads one
  // consistent set of labels. Identities are revealed only after synthesis.
  onProgress(`Stage 3: chairman (${chairmanModel}) synthesising…`);
  const chairOrder = shuffle(alive);
  const chairLabelOfMemberId = new Map(chairOrder.map((o, i) => [o.member.id, LABELS[i]]));
  const chairAnswers = chairOrder.map((o, i) => ({ label: LABELS[i], text: o.text }));
  const chairReviews = reviews
    .filter((r) => r.ok)
    .map((r, i) => ({
      reviewerNum: i + 1,
      authorLabel: chairLabelOfMemberId.get(r.reviewer.id),
      text: r.text.replace(/\bResponse\s+([A-Z])\b/g, (whole, lab) => {
        const memberId = r.labelToMemberId[lab];
        return memberId === undefined ? whole : `Response ${chairLabelOfMemberId.get(memberId)}`;
      }),
    }));
  const shortHandedNote = failed.length
    ? `Note: ${failed.length} invited member(s) failed to respond — the board sat short-handed with ${alive.length} member(s).`
    : alive.length < 2
      ? "Note: only a single member responded. There was no deliberation; present this answer with that caveat stated prominently."
      : null;

  const chairRes = await tracked(calls, "board", "chairman", chairmanModel, {
    ...chairmanPrompt({ question, answers: chairAnswers, reviews: chairReviews, shortHandedNote }),
    maxTokens: 14000,
  });
  const sections = parseChairmanSections(chairRes.text);

  // ---------- Housekeeping: title (cheapest model, separate cost line) ----------
  let title = null;
  try {
    const t = await tracked(calls, "housekeeping", "title", "claude-haiku-4-5", {
      ...titlePrompt(question),
      maxTokens: 40,
    });
    title = t.text.trim().replace(/^["']|["']$/g, "");
  } catch {
    title = question.slice(0, 60);
  }

  // ---------- Assemble record ----------
  const cost = summariseCost(calls);
  const record = baseRecord();
  Object.assign(record, {
    title,
    finalAnswer: sections.finalAnswer,
    agreements: sections.agreements,
    disagreements: sections.disagreements,
    resolution: sections.resolution,
    chairmanRaw: chairRes.text,
    opinions: opinions.map((o) => ({
      member: o.member.name,
      ok: o.ok,
      text: o.text,
      error: o.error,
      chairLabel: o.ok ? chairLabelOfMemberId.get(o.member.id) : null,
    })),
    reviews: reviews.map((r) => ({
      reviewer: r.reviewer.name,
      ok: r.ok,
      text: r.text ?? null,
      ranking: r.ranking ?? null,
      rankingMethod: r.rankingMethod ?? null,
      rankingError: r.rankingError ?? r.error ?? null,
      labelMap: r.labelMap, // de-anonymised mapping: reviewer's label -> model
    })),
    chairmanMapping: Object.fromEntries(
      alive.map((o) => [chairLabelOfMemberId.get(o.member.id), o.member.name])
    ),
    sittingLeaderboard,
    leaderboardConfidence,
    cost,
    notes,
  });

  const aggregate = await updateLeaderboard(record);
  record.aggregateLeaderboard = aggregate;
  record.dir = await persistSitting(record);
  return record;

  function baseRecord() {
    return {
      id: `${startedAt.replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      question,
      tier,
      providers: members.map((m) => m.provider),
      board: members.map((m) => m.name),
      chairman: `${providerOfModel(chairmanModel)}/${chairmanModel}`,
      calls,
    };
  }
}

function parseChairmanSections(text) {
  const grab = (name, next) => {
    const re = new RegExp(
      `##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s*(?:${next.join("|")})|$)`,
      "i"
    );
    return text.match(re)?.[1].trim() ?? null;
  };
  const finalAnswer = grab("FINAL ANSWER", [
    "WHERE THE BOARD AGREED",
    "WHERE THE BOARD SPLIT",
    "WHAT WOULD RESOLVE IT",
  ]);
  return {
    finalAnswer: finalAnswer ?? text,
    agreements: grab("WHERE THE BOARD AGREED", ["WHERE THE BOARD SPLIT", "WHAT WOULD RESOLVE IT"]),
    disagreements: grab("WHERE THE BOARD SPLIT", ["WHAT WOULD RESOLVE IT"]),
    resolution: grab("WHAT WOULD RESOLVE IT", ["$ never"]),
  };
}

export function summariseCost(calls) {
  const byProvider = {};
  const byLine = {};
  let anyEstimated = false;
  for (const c of calls) {
    if (!c.ok) continue;
    const provider = c.model.split("/")[0];
    byProvider[provider] = (byProvider[provider] ?? 0) + (c.costUsd ?? 0);
    byLine[c.line] = (byLine[c.line] ?? 0) + (c.costUsd ?? 0);
    if (c.costEstimated) anyEstimated = true;
  }
  return {
    totalUsd: Object.values(byLine).reduce((a, b) => a + b, 0),
    boardUsd: byLine.board ?? 0,
    housekeepingUsd: byLine.housekeeping ?? 0,
    comparisonUsd: byLine.comparison ?? 0,
    byProvider,
    estimatedPricesUsed: anyEstimated,
  };
}

export { readLeaderboard };
