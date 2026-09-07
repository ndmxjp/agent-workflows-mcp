import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildChildEnv } from "../env.ts";
import type { AgentDefinition, RunOptions, RunResult } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Builds the kiro-cli agent profile for a child run. The profile is the security
 * boundary: only the tools the definition earns are listed, allowedTools mirrors
 * tools so a headless run never blocks on a prompt, and includeMcpJson is false
 * so the child cannot pick up MCP servers from whatever mcp.json is lying around.
 */
export function buildProfile(
  agent: AgentDefinition,
  opts: { writeDir?: string } = {},
): Record<string, unknown> {
  const tools: string[] = ["thinking"];
  const toolsSettings: Record<string, unknown> = {};
  if (agent.read) {
    tools.push("read", "grep", "glob");
  }
  if (agent.allowedCommands.length > 0) {
    tools.push("shell");
    toolsSettings["shell"] = {
      allowedCommands: agent.allowedCommands,
    };
  }
  // Writes require BOTH the definition's opt-in and a caller-named directory.
  if (agent.write && opts.writeDir) {
    tools.push("write");
    toolsSettings["write"] = {
      allowedPaths: [join(resolve(opts.writeDir), "**")],
    };
  }
  return {
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    mcpServers: {},
    tools,
    toolAliases: {},
    allowedTools: tools,
    resources: [],
    toolsSettings,
    includeMcpJson: false,
    model: agent.model,
  };
}

/** Strips ANSI escape sequences from CLI output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
}

/**
 * Runs one agent task through `kiro-cli chat --no-interactive` with a generated
 * profile written to a private temp dir and a minimal environment (see env.ts).
 * Never passes --trust-all-tools; trust comes from the profile's allowedTools.
 */
export async function runKiroAgent(
  agent: AgentDefinition,
  task: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const profileDir = mkdtempSync(join(tmpdir(), "agent-workflows-"));
  const profilePath = join(profileDir, `${agent.name}.json`);
  writeFileSync(profilePath, JSON.stringify(buildProfile(agent, opts), null, 2));

  const { env, forwarded } = buildChildEnv();
  console.error(
    `[agent-workflows] spawning kiro-cli agent=${agent.name} env=[${forwarded.join(",")}]`,
  );

  const timeoutMs = opts.timeoutMs ?? Number(process.env["AGENT_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS);
  try {
    const proc = Bun.spawn(["kiro-cli", "chat", "--no-interactive", "--agent", profilePath, task], {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const killTimer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killTimer);
    // kiro-cli --no-interactive prefixes the reply with "> "; strip it.
    const output = stripAnsi(stdout).trim().replace(/^>\s?/, "");
    if (exitCode !== 0) {
      const detail = stripAnsi(stderr).trim().slice(0, 2000);
      return {
        ok: false,
        output,
        error: `kiro-cli exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
      };
    }
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: "", error: `failed to start kiro-cli: ${(e as Error).message}` };
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}
