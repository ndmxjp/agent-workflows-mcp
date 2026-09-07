/**
 * Minimal environment for child agent processes.
 *
 * Children get PATH/HOME/TMPDIR (process bootstrap) and KIRO_API_KEY (the model
 * backend needs it). Everything else — in particular GITHUB_TOKEN / GH_TOKEN —
 * is deliberately not forwarded: an MCP server runs with the job's credentials,
 * and a child agent has no business holding the GitHub token.
 */
const FORWARDED_VARS = ["PATH", "HOME", "TMPDIR", "KIRO_API_KEY"] as const;

export interface ChildEnv {
  env: Record<string, string>;
  /** Names of the vars actually forwarded (for logging). */
  forwarded: string[];
}

export function buildChildEnv(parent: Record<string, string | undefined> = process.env): ChildEnv {
  const env: Record<string, string> = {};
  const forwarded: string[] = [];
  for (const name of FORWARDED_VARS) {
    const value = parent[name];
    if (value !== undefined) {
      env[name] = value;
      forwarded.push(name);
    }
  }
  return { env, forwarded };
}
