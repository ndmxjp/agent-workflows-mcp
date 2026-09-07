#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadDefinitions, type Definitions } from "./definitions.ts";
import { runWorkflow } from "./engine.ts";
import { redact } from "./redact.ts";
import { getRunner } from "./runner/index.ts";

/**
 * Definitions are loaded from the server's own definitions/ directory (or an
 * explicit --definitions / AGENT_WORKFLOWS_DIR override) — never from the caller's
 * cwd, which may be an attacker-controlled checkout. They live under definitions/
 * rather than a top-level agents/ so that plugin-aware clients (Claude Code scans
 * agents/ for its own native subagents) do not load them as unsandboxed agents.
 */
function definitionsDir(): string {
  const argIdx = process.argv.indexOf("--definitions");
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    return resolve(process.argv[argIdx + 1]!);
  }
  const fromEnv = process.env["AGENT_WORKFLOWS_DIR"];
  if (fromEnv) return resolve(fromEnv);
  return join(dirname(fileURLToPath(import.meta.url)), "..", "definitions");
}

function textResult(payload: unknown, isError = false) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: redact(text) }], isError };
}

function errorResult(message: string) {
  return textResult({ error: message }, true);
}

function main(defs: Definitions): void {
  const server = new McpServer({ name: "agent_workflows", version: "0.2.0" });

  server.registerTool(
    "list_agents",
    {
      description:
        "List the agent definitions this server can run, with their descriptions and permissions.",
      inputSchema: {},
    },
    async () =>
      textResult({
        agents: [...defs.agents.values()].map((a) => ({
          name: a.name,
          description: a.description,
          read: a.read,
          shell: a.allowedCommands.length > 0 ? a.allowedCommands : false,
          write: a.write,
          network: a.network,
        })),
      }),
  );

  server.registerTool(
    "list_workflows",
    {
      description:
        "List the workflow definitions this server can run, with their inputs and node graphs.",
      inputSchema: {},
    },
    async () =>
      textResult({
        workflows: [...defs.workflows.values()].map((w) => ({
          name: w.name,
          description: w.description,
          inputs: w.inputs,
          nodes: w.nodes.map((n) => ({ id: n.id, agent: n.agent, needs: n.needs })),
          output: w.output,
          review: w.review ?? null,
        })),
      }),
  );

  server.registerTool(
    "run_agent",
    {
      description:
        "Run one agent definition against a task and return its text output. " +
        "The agent runs read-only unless its definition grants more; writes additionally require write_dir.",
      inputSchema: {
        name: z.string().describe("Agent name from list_agents"),
        task: z.string().describe("The task for the agent"),
        context: z.string().optional().describe("Extra context appended to the task"),
        write_dir: z
          .string()
          .optional()
          .describe("Directory the agent may write into (only honored if the definition opts in)"),
      },
    },
    async ({ name, task, context, write_dir }) => {
      const agent = defs.agents.get(name);
      if (!agent) {
        return errorResult(`unknown agent "${name}" (see list_agents)`);
      }
      const fullTask = context ? `${task}\n\n## Context\n${context}` : task;
      const result = await getRunner()(agent, fullTask, { writeDir: write_dir });
      if (!result.ok) {
        return errorResult(result.error ?? "agent run failed");
      }
      return textResult(result.output);
    },
  );

  server.registerTool(
    "run_workflow",
    {
      description:
        "Run a workflow DAG of agents. Independent nodes run in parallel; returns per-node " +
        "status and the final node's text.",
      inputSchema: {
        name: z.string().describe("Workflow name from list_workflows"),
        inputs: z
          .record(z.string(), z.string())
          .default({})
          .describe("Values for the workflow's declared inputs"),
        write_dir: z.string().optional().describe("Directory write-enabled agents may write into"),
      },
    },
    async ({ name, inputs, write_dir }) => {
      const wf = defs.workflows.get(name);
      if (!wf) {
        return errorResult(`unknown workflow "${name}" (see list_workflows)`);
      }
      const result = await runWorkflow(wf, defs.agents, inputs, getRunner(), {
        writeDir: write_dir,
      });
      return textResult(result, !result.ok);
    },
  );

  const transport = new StdioServerTransport();
  void server.connect(transport);
}

// Fail loud at startup: an invalid definitions directory exits non-zero so a
// client using --require-mcp-startup sees a hard failure, not a silent absence.
try {
  const dir = definitionsDir();
  const defs = loadDefinitions(dir);
  console.error(
    `[agent-workflows] loaded ${defs.agents.size} agents, ${defs.workflows.size} workflows from ${dir}`,
  );
  main(defs);
} catch (e) {
  console.error(`[agent-workflows] startup failed: ${(e as Error).message}`);
  process.exit(1);
}
