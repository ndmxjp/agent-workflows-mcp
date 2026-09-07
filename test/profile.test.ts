import { describe, expect, test } from "bun:test";
import { buildProfile, resolveTimeoutMs, stripAnsi } from "../src/runner/kiro.ts";
import type { AgentDefinition } from "../src/types.ts";

const base: AgentDefinition = {
  name: "t",
  description: "d",
  prompt: "p",
  read: true,
  allowedCommands: [],
  write: false,
  network: false,
  model: null,
};

describe("buildProfile", () => {
  test("read-only default: no shell, no write, no MCP passthrough", () => {
    const p = buildProfile(base) as Record<string, unknown>;
    expect(p["tools"]).toEqual(["thinking", "read", "grep", "glob"]);
    expect(p["allowedTools"]).toEqual(p["tools"]);
    expect(p["includeMcpJson"]).toBe(false);
    expect(p["mcpServers"]).toEqual({});
    expect(p["toolsSettings"]).toEqual({});
  });

  test("shell appears only with allowed command patterns, and scoped to them", () => {
    const pattern = "^git status[^;&|<>$`\\n]*$";
    const p = buildProfile({ ...base, allowedCommands: [pattern] }) as Record<string, any>;
    expect(p["tools"]).toContain("shell");
    expect(p["toolsSettings"]["shell"]).toEqual({ allowedCommands: [pattern] });
  });

  test("write requires both the definition opt-in AND a caller writeDir", () => {
    const optedIn = buildProfile({ ...base, write: true }) as Record<string, any>;
    expect(optedIn["tools"]).not.toContain("write"); // no writeDir named

    const dirOnly = buildProfile(base, { writeDir: "/tmp/out" }) as Record<string, any>;
    expect(dirOnly["tools"]).not.toContain("write"); // definition did not opt in

    const both = buildProfile({ ...base, write: true }, { writeDir: "/tmp/out" }) as Record<
      string,
      any
    >;
    expect(both["tools"]).toContain("write");
    expect(both["toolsSettings"]["write"]["allowedPaths"]).toEqual(["/tmp/out/**"]);
  });
});

describe("resolveTimeoutMs", () => {
  test("falls back to the default for unset, garbage, zero, and negative values", () => {
    const def = resolveTimeoutMs(undefined);
    expect(def).toBeGreaterThan(0);
    for (const raw of ["garbage", "", "0", "-5", "NaN", "Infinity"]) {
      expect(resolveTimeoutMs(raw)).toBe(def);
    }
  });

  test("uses a valid positive value", () => {
    expect(resolveTimeoutMs("120000")).toBe(120000);
  });
});

describe("stripAnsi", () => {
  test("removes color and cursor sequences", () => {
    expect(stripAnsi("\x1b[32mgreen\x1b[0m plain")).toBe("green plain");
  });
});
