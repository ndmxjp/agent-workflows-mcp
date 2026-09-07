import { describe, expect, test } from "bun:test";
import { buildChildEnv } from "../src/env.ts";

describe("buildChildEnv", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    TMPDIR: "/tmp",
    KIRO_API_KEY: "ksk_test123456789",
    GITHUB_TOKEN: "ghp_shouldnotleak000000000000",
    GH_TOKEN: "gho_shouldnotleak000000000000",
    AWS_SECRET_ACCESS_KEY: "x",
    NPM_TOKEN: "y",
  };

  test("forwards only the allowlist", () => {
    const { env, forwarded } = buildChildEnv(parent);
    expect(Object.keys(env).sort()).toEqual(["HOME", "KIRO_API_KEY", "PATH", "TMPDIR"]);
    expect(forwarded.sort()).toEqual(["HOME", "KIRO_API_KEY", "PATH", "TMPDIR"]);
  });

  test("never forwards GITHUB_TOKEN or GH_TOKEN", () => {
    const { env } = buildChildEnv(parent);
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  test("omits allowlisted vars that are unset in the parent", () => {
    const { env, forwarded } = buildChildEnv({ PATH: "/usr/bin" });
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(forwarded).toEqual(["PATH"]);
  });
});
