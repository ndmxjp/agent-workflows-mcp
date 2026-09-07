import type { RunAgentFn } from "../types.ts";
import { runKiroAgent } from "./kiro.ts";

/**
 * Runner backends. kiro-cli is the first implementation (the Kiro-action runner
 * already has the CLI and KIRO_API_KEY); other hosts can add theirs here and
 * select it with AGENT_WORKFLOWS_RUNNER.
 */
const RUNNERS: Record<string, RunAgentFn> = {
  "kiro-cli": runKiroAgent,
};

export function getRunner(name = process.env["AGENT_WORKFLOWS_RUNNER"] ?? "kiro-cli"): RunAgentFn {
  const runner = RUNNERS[name];
  if (!runner) {
    throw new Error(`unknown runner "${name}" (available: ${Object.keys(RUNNERS).join(", ")})`);
  }
  return runner;
}
