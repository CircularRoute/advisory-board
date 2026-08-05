// Aggregate leaderboard: average ranking position per model across all
// sittings. A standing dataset, not a by-product — persisted at the project
// root and updated on every run.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT =
  process.env.AB_DATA_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "leaderboard.json");

export async function readLeaderboard() {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    return { models: {}, sittings: 0, updated: null };
  }
}

export async function updateLeaderboard(record) {
  const data = await readLeaderboard();
  for (const entry of record.sittingLeaderboard) {
    const m = (data.models[entry.model] ??= { positionSum: 0, votes: 0, sittings: 0 });
    m.positionSum += entry.avgPosition * entry.votes;
    m.votes += entry.votes;
    m.sittings += 1;
  }
  data.sittings += 1;
  data.updated = new Date().toISOString();
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
  return formatAggregate(data);
}

export function formatAggregate(data) {
  return {
    sittings: data.sittings,
    updated: data.updated,
    ranking: Object.entries(data.models)
      .map(([model, m]) => ({
        model,
        avgPosition: m.votes ? +(m.positionSum / m.votes).toFixed(3) : null,
        votes: m.votes,
        sittings: m.sittings,
      }))
      .sort((a, b) => (a.avgPosition ?? 99) - (b.avgPosition ?? 99)),
  };
}
