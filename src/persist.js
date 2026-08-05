// Every sitting is persisted to disk so a decision can be revisited later:
// full JSON record + a human-readable report.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "./report.js";

const ROOT =
  process.env.AB_DATA_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITTINGS = path.join(ROOT, "sittings");

export async function persistSitting(record) {
  const slug = (record.title ?? record.question ?? "sitting")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  const dir = path.join(SITTINGS, `${record.startedAt.slice(0, 19).replace(/[:]/g, "")}-${slug}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "record.json"), JSON.stringify(record, null, 2));
  if (!record.error) {
    await fs.writeFile(path.join(dir, "report.md"), renderReport(record));
  }
  return dir;
}
