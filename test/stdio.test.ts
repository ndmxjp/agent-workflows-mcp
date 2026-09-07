import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(REPO_ROOT, "src", "server.ts");

function rpc(id: number, method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

/** Spawns the real server over stdio and drives a JSON-RPC exchange. */
async function talk(messages: string[], env: Record<string, string>): Promise<string[]> {
  const proc = Bun.spawn(["bun", "run", SERVER], {
    cwd: REPO_ROOT,
    env: { PATH: process.env["PATH"]!, HOME: process.env["HOME"]!, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  for (const m of messages) {
    proc.stdin.write(m);
  }
  proc.stdin.flush();
  const lines: string[] = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 10_000;
  // A response is expected per request with an id (notifications get none).
  const expected = messages.filter((m) => JSON.parse(m).id !== undefined).length;
  while (lines.length < expected && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) lines.push(line);
    }
  }
  proc.kill();
  await proc.exited;
  return lines;
}

describe("stdio handshake", () => {
  test("initialize -> tools/list exposes the four tools with schemas", async () => {
    const lines = await talk(
      [
        rpc(1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
        rpc(2, "tools/list"),
      ],
      {}, // default definitions dir = <repo>/definitions (ships with the repo)
    );
    expect(lines.length).toBe(2);
    const init = JSON.parse(lines[0]!);
    expect(init.result.serverInfo.name).toBe("agent_workflows");

    const toolsResp = JSON.parse(lines[1]!);
    const tools = toolsResp.result.tools as Array<{ name: string; inputSchema: unknown }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_agents", "list_workflows", "run_agent", "run_workflow"]);
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
    }
  }, 15_000);

  test("server exits non-zero at startup when the definitions directory is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awm-bad-"));
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "broken.md"), "no frontmatter here");
    const proc = Bun.spawn(["bun", "run", SERVER], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env["PATH"]!,
        HOME: process.env["HOME"]!,
        AGENT_WORKFLOWS_DIR: dir,
      },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("startup failed");
  }, 15_000);
});
