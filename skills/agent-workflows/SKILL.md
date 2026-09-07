---
name: agent-workflows
description: How to delegate work through the agent_workflows MCP server — running single agents and multi-step DAG workflows as tool calls. Use when the agent_workflows tools (list_agents, list_workflows, run_agent, run_workflow) are available and a task is worth delegating to a specialized child agent or a predefined workflow.
---

# Delegating through agent_workflows

The `agent_workflows` MCP server runs predefined agent and workflow definitions
and returns their text output. It never posts anywhere itself — you receive text
and you decide what to do with it.

## Discover, then run

1. Call `list_agents` / `list_workflows` once to see what exists. Each agent
   entry shows its permissions (read, shell patterns, write, network) — pick the
   least-privileged agent that can do the job.
2. For a one-shot delegated task, call `run_agent` with `name` and a
   self-contained `task`. The child does not see your conversation; put every
   fact it needs into `task` or `context`.
3. For multi-step work, call `run_workflow` with `name` and the workflow's
   declared `inputs`. The result is JSON: per-node `status` and `output`, plus
   `final` (the output node's text). Check `ok` before trusting `final`.

## Rules

- Children are sandboxed: read-only by default, no network, no GitHub token.
  Do not ask a child to post comments, push, or call APIs — it cannot, and the
  reporting channel is yours, not its.
- Writes happen only when you pass `write_dir` AND the agent definition opts
  in. Name a directory you own, then verify what appeared in it.
- A tool result with `isError: true` means the run failed loudly (bad
  definition, agent could not start, node failed). Read the `error` field and
  either fix your inputs or report the failure — do not retry blindly.
- Workflow inputs are plain strings. Pass file contents, not paths, when the
  child might run in a different working directory than yours.
