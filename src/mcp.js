// Phase 3: the engine exposed as a remote MCP server (Streamable HTTP).
// One tool: ask_advisory_board. Once connected in Claude's connector
// settings, the board is available inside any Claude conversation.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSitting } from "./engine.js";
import { DEFAULT_PROVIDERS, DEFAULT_TIER } from "./config.js";

export function buildMcpServer() {
  const server = new McpServer({ name: "advisory-board", version: "0.1.0" });

  server.registerTool(
    "ask_advisory_board",
    {
      title: "Ask the Advisory Board",
      description:
        "Put a hard question to a multi-provider AI advisory board. The strongest model from " +
        "each provider answers independently, the members blind-review each other, and a " +
        "non-member Chairman synthesises one answer that names where the board disagreed. " +
        "Advisory only — it answers, it never acts. Expect a run to take several minutes and " +
        "to cost real money (logged in the result).",
      inputSchema: {
        question: z.string().min(1).describe("The question to deliberate"),
        tier: z
          .enum(["top", "mid", "low"])
          .optional()
          .describe(`Board tier (default ${DEFAULT_TIER})`),
        providers: z
          .array(z.enum(["anthropic", "openai", "google"]))
          .min(2)
          .optional()
          .describe(`Which providers sit on the board (default ${DEFAULT_PROVIDERS.join(",")})`),
      },
    },
    async ({ question, tier, providers }, extra) => {
      const progress = async (msg) => {
        try {
          if (extra?._meta?.progressToken !== undefined) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken: extra._meta.progressToken, progress: 0, message: msg },
            });
          }
        } catch {
          /* progress is best-effort */
        }
      };
      const record = await runSitting({
        question,
        tier: tier ?? DEFAULT_TIER,
        providers: providers ?? DEFAULT_PROVIDERS,
        onProgress: progress,
      });
      const result = {
        final_answer: record.finalAnswer,
        agreements: record.agreements,
        disagreements: record.disagreements,
        what_would_resolve_it: record.resolution,
        leaderboard: {
          this_sitting: record.sittingLeaderboard,
          confidence: record.leaderboardConfidence,
          aggregate: record.aggregateLeaderboard,
        },
        cost: record.cost,
        tier: record.tier,
        board: record.board,
        chairman: record.chairman,
        notes: record.notes,
      };
      const header =
        `TIER: ${record.tier.toUpperCase()} | COST: $${record.cost.totalUsd.toFixed(4)}` +
        ` | board: ${record.board.join(" + ")} | chairman: ${record.chairman}` +
        (record.notes.length ? `\n⚠ ${record.notes.join("\n⚠ ")}` : "");
      return {
        content: [
          {
            type: "text",
            text:
              `${header}\n\n## FINAL ANSWER\n\n${record.finalAnswer}\n\n` +
              (record.agreements ? `## WHERE THE BOARD AGREED\n\n${record.agreements}\n\n` : "") +
              (record.disagreements ? `## WHERE THE BOARD SPLIT\n\n${record.disagreements}\n\n` : "") +
              (record.resolution ? `## WHAT WOULD RESOLVE IT\n\n${record.resolution}` : ""),
          },
        ],
        structuredContent: result,
      };
    }
  );

  return server;
}
