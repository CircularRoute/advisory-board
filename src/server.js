// Phase 2 + 3: HTTP service wrapping the engine, plus the remote MCP
// endpoint. Protected by a shared secret — this service spends money and
// must never be open to the internet.
//
//   POST /ask   {question, tier?, providers?, chairman?}  -> full record
//   GET  /leaderboard                                     -> aggregate
//   GET  /      minimal web page
//   ALL  /mcp   Model Context Protocol (Streamable HTTP)
//
// Auth: Authorization: Bearer $ADVISORY_BOARD_KEY  (or ?key= for /mcp,
// since some MCP clients cannot set custom headers).
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadDefaultEnv } from "./env.js";
import { runSitting, readLeaderboard } from "./engine.js";
import { formatAggregate } from "./leaderboard.js";
import { buildMcpServer } from "./mcp.js";
import { DEFAULT_PROVIDERS, DEFAULT_TIER } from "./config.js";

loadDefaultEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.ADVISORY_BOARD_KEY;
if (!KEY) {
  console.error(
    "Refusing to start: ADVISORY_BOARD_KEY is not set. This service spends money; it must be protected by a shared secret."
  );
  process.exit(1);
}

function timingSafeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authed(req) {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const candidate = bearer ?? req.query.key;
  return candidate != null && timingSafeEqual(candidate, KEY);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Static page and health check are public; everything that spends money is not.
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

app.post("/ask", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const { question, tier, providers, chairman } = req.body ?? {};
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "question (string) is required" });
  }
  try {
    const record = await runSitting({
      question,
      tier: tier ?? DEFAULT_TIER,
      providers: providers ?? DEFAULT_PROVIDERS,
      chairman,
      onProgress: (m) => console.log(`[ask] ${m}`),
    });
    res.json(record);
  } catch (err) {
    console.error("[ask] failed:", err.message);
    res.status(502).json({ error: err.message, record: err.record ?? null });
  }
});

app.get("/leaderboard", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  res.json(formatAggregate(await readLeaderboard()));
});

// ---- MCP (stateless Streamable HTTP: fresh server+transport per request) ----
app.all("/mcp", async (req, res) => {
  if (!authed(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "unauthorized: pass Authorization: Bearer <key> or ?key=<key>" },
      id: null,
    });
  }
  if (req.method !== "POST") {
    // Stateless mode: no server-initiated streams or session deletion.
    return res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "method not allowed" },
      id: null,
    });
  }
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "internal error" },
        id: null,
      });
    }
  }
});

const port = process.env.PORT ?? 8787;
app.listen(port, () => {
  console.log(`Advisory Board listening on :${port}`);
  console.log(`  POST /ask, GET /leaderboard (Bearer auth), MCP at /mcp`);
});
