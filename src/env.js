// Minimal .env loader (no dependency). Only fills variables that are not
// already set; never prints values.
import fs from "node:fs";

export function loadEnvFile(file) {
  if (!file) return;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Cannot read env file: ${file}`);
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let [, key, value] = m;
    value = value.replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadDefaultEnv(explicitFile) {
  loadEnvFile(explicitFile ?? process.env.AB_ENV_FILE);
}
