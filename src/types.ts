/** Parsed agent definition (agents/<name>.md frontmatter + body). */
export interface AgentDefinition {
  name: string;
  description: string;
  /** System prompt: the markdown body below the frontmatter. */
  prompt: string;
  /** Read-only filesystem tools (fs_read, grep, glob). Defaults to true. */
  read: boolean;
  /**
   * Shell command patterns the agent may run (kiro-cli allowedCommands regexes).
   * Empty means the shell tool is not granted at all.
   */
  allowedCommands: string[];
  /**
   * Whether the agent may be granted a write tool. Writes are only actually enabled
   * when the tool caller also names a write_dir; the definition alone never enables them.
   */
  write: boolean;
  /**
   * Network opt-in. When false (default), allowedCommands containing network clients
   * (curl, wget, nc, ssh) are rejected at load time. No builtin network tool is ever granted.
   */
  network: boolean;
  model: string | null;
}

export interface WorkflowNode {
  id: string;
  agent: string;
  /** Task template. May reference {{inputs.<name>}} and {{<dep-id>}} for ids in needs. */
  task: string;
  needs: string[];
}

export interface ReviewLoop {
  /** Node id whose output is reviewed. */
  target: string;
  /** Agent name that reviews the target's output. */
  reviewer: string;
  /** The review is a rejection iff the reviewer's output contains this string. */
  trigger: string;
  /** Revision rounds, 1..10 (hard cap 10). */
  maxIterations: number;
}

export interface WorkflowInput {
  name: string;
  description?: string;
  required: boolean;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  inputs: WorkflowInput[];
  nodes: WorkflowNode[];
  /** Node id whose output is the workflow's final text. */
  output: string;
  review?: ReviewLoop;
}

export type NodeStatus = "succeeded" | "failed" | "skipped";

export interface NodeResult {
  status: NodeStatus;
  output?: string;
  error?: string;
  /** Review rounds that ran for this node (only set on a review target). */
  reviewIterations?: number;
}

export interface WorkflowResult {
  ok: boolean;
  nodes: Record<string, NodeResult>;
  /** Output of the workflow's `output` node, when it succeeded. */
  final?: string;
  error?: string;
}

export interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface RunOptions {
  /** Directory writes are confined to. Absent = agent gets no write tool. */
  writeDir?: string;
  /** Working directory for the child process. Defaults to the server's cwd. */
  cwd?: string;
  timeoutMs?: number;
}

export type RunAgentFn = (
  agent: AgentDefinition,
  task: string,
  opts: RunOptions,
) => Promise<RunResult>;

/** Error in a definition file or workflow shape; always surfaced loudly. */
export class DefinitionError extends Error {}
