import { mkdir } from "node:fs/promises";
import path from "node:path";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { closeBrowser } from "./browser.ts";
import { log } from "./log.ts";
import { buildServer, links, readPrompt, type RunState } from "./tools.ts";

const DEFAULT_URL = "https://try-nomore.com/products/nomorecolds-red-light-therapy-colds-sinusitis";
const MODEL = process.env.MODEL || "claude-opus-5-5";
const MAX_TURNS = Number(process.env.MAX_TURNS || 40);
const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD || 2);
const MAX_SECTION_WRITES = 8;

const url = process.argv[2] || DEFAULT_URL;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const state: RunState = { themeDir: path.resolve("runs", runId, "theme"), templateWritten: false, renders: 0 };
await mkdir(state.themeDir, { recursive: true });

// loop guards: the budget and turn caps bound cost, these catch a model stuck repeating itself
const recentCalls: string[] = [];
let sectionWrites = 0;
const guard: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const deny = (reason: string) => {
    log.warn(`blocked ${input.tool_name}`, reason);
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } };
  };
  if (state.finished || state.issue) return deny("the run is already finished");
  const signature = `${input.tool_name}:${JSON.stringify(input.tool_input)}`;
  recentCalls.push(signature);
  if (recentCalls.slice(-3).length === 3 && recentCalls.slice(-3).every((s) => s === signature)) {
    return deny("this exact call already ran twice in a row; change the input or move on");
  }
  if (/__(write|edit)_section$/.test(input.tool_name) && ++sectionWrites > MAX_SECTION_WRITES) {
    return deny(`section write limit (${MAX_SECTION_WRITES}) reached; finish with what you have or report_issue`);
  }
  return {};
};

log.title(`Rebuilding the first 3 sections of ${url}`);
log.info(`model ${MODEL} · max ${MAX_TURNS} turns · budget $${MAX_BUDGET_USD.toFixed(2)}`);

const run = query({
  prompt: `Source product page: ${url}\nRebuild its first three sections as described.`,
  options: {
    model: MODEL,
    systemPrompt: await readPrompt(),
    // no built-in file, shell or web tools: the agent can only act through the shop tools
    tools: [],
    mcpServers: { shop: buildServer(state) },
    allowedTools: ["mcp__shop__*"],
    settingSources: [],
    persistSession: false,
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    hooks: { PreToolUse: [{ matcher: "mcp__shop__.*", hooks: [guard] }] },
    // screenshots plus the source extract exceed the default mcp output cap
    env: { ...process.env, MAX_MCP_OUTPUT_TOKENS: "80000" },
  },
});

let result: any;
for await (const message of run) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim()) log.agent(block.text.trim().replace(/\s+/g, " ").slice(0, 220));
      if (block.type === "tool_use") log.tool(block.name.replace("mcp__shop__", ""));
    }
  }
  if (message.type === "result") result = message;
}
await closeBrowser();

const { storefront, editor } = await links(state);
log.title(state.finished ? "Done" : state.issue ? "Stopped: agent reported an issue" : `Stopped: ${result?.subtype ?? "unknown"}`);
if (state.finished) log.info(state.finished.summary);
if (state.issue) log.info(state.issue);
if (result) {
  log.info(`turns ${result.num_turns} · api cost $${Number(result.total_cost_usd).toFixed(4)} · ${Math.round(result.duration_ms / 1000)}s`);
}
if (storefront) log.info(`storefront: ${storefront}`);
if (editor) log.info(`theme editor: ${editor}`);
log.info(`generated files: ${path.relative(process.cwd(), state.themeDir)}`);
process.exit(state.finished ? 0 : 1);
