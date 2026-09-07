# agent-workflows-mcp

An MCP server that exposes **agents and DAG workflows as plain MCP tools**, so a
client with no native subagent or workflow feature (or one that deliberately does
not enable it) can still delegate multi-step work. Agent Plugins 1.0.0
standardizes skills and MCP servers — agents and workflows are outside the spec —
so shipping them as MCP tools is the client-portable route: the same repository
works from [Kiro-action](https://github.com/ndmxjp/Kiro-action), Claude Code,
Kiro, or any other MCP client.

Definitions live in this repository (`agents/*.md`, `workflows/*.json`); the
server reads them from its **own** directory — never from the caller's working
directory, which may be an untrusted checkout. Every tool returns text. The
server never posts to GitHub and needs no GitHub token; the calling agent owns
its own reporting channel.

## Tools

- **`list_agents`** — names, descriptions, and the permission surface (read /
  shell patterns / write / network) of every agent definition.
- **`list_workflows`** — names, declared inputs, node graphs, and review loops
  of every workflow definition.
- **`run_agent`** `{ name, task, context?, write_dir? }` — runs one agent
  definition against a task and returns its text output.
- **`run_workflow`** `{ name, inputs, write_dir? }` — runs a DAG of agents:
  nodes are agent runs, `needs` edges are dependencies, independent nodes run
  in parallel, and an optional review loop re-runs the target node until a
  reviewer agent accepts (capped at 10 iterations). Returns JSON with per-node
  `status`/`output` and the output node's `final` text.

Failures are loud: an unparsable definition, a cyclic workflow, or an agent
that cannot start returns `isError: true` with a message, and an invalid
definitions directory makes the server **exit non-zero at startup** (so a
client using `--require-mcp-startup` sees exit 3, not a silent absence).

## Runner backend

Agent definitions are executed by shelling out to
`kiro-cli chat --no-interactive --agent <generated-profile>`. This was chosen
first because the primary consumer (Kiro-action's runner) already has the CLI
and `KIRO_API_KEY` — no extra model API key is required. The runner is a small
pluggable interface (`src/runner/`); other hosts can add a backend and select
it with `AGENT_WORKFLOWS_RUNNER`.

Constraints of the kiro-cli backend:

- `kiro-cli` must be on `PATH` and authenticated (env `KIRO_API_KEY` or an
  existing login under `HOME`).
- One child process per agent run; per-run timeout via `AGENT_TIMEOUT_MS`
  (default 300000).

## Security model

The generated per-run profile is the security boundary; children are never
less restricted than their definition earns:

- **Read-only by default.** An agent gets `read`/`grep`/`glob` only. Shell is
  OFF unless the definition lists `allowed_commands` patterns, which become the
  profile's scoped `allowedCommands`. `--trust-all-tools` is never passed.
- **Writes need two keys.** A write tool appears only when the definition sets
  `write: true` **and** the tool caller names a `write_dir`; writes are
  confined to that directory.
- **No network tools.** No builtin network tool is ever granted, and
  `allowed_commands` naming network clients (curl, wget, nc, ssh, …) are
  rejected at load time unless the definition sets `network: true`.
- **Minimal child environment.** Children receive `PATH`, `HOME`, `TMPDIR`,
  and `KIRO_API_KEY` — nothing else. In particular `GITHUB_TOKEN`/`GH_TOKEN`
  are never forwarded. The forwarded set is logged to stderr per spawn.
- **Redaction.** Secret-shaped strings (`ksk_`, `ghp_`/`gho_`/`github_pat_`,
  AWS access keys and labeled secrets, JWTs) are redacted from every tool
  result.
- **Definitions are trusted code-adjacent data.** They load from the server's
  own directory (or an explicit `--definitions` / `AGENT_WORKFLOWS_DIR`
  override), never from the caller's cwd. `includeMcpJson` is false in every
  generated profile, so children cannot pick up ambient MCP servers.

**This server is code you run with the job's credentials.** Trust it the way
you trust a `uses:` line in a workflow, and pin it by SHA. The host's shell and
write scoping do not extend into what an MCP server does internally — that is
exactly why this server rebuilds those guarantees for its children.

## Definition formats

Agent (`agents/<name>.md`):

```markdown
---
name: repo-analyst
description: Inspects the current repository read-only.
allowed_commands: # optional; omit for no shell at all
  - "git status.*"
  - "git log.*"
write: false # optional; true still requires the caller's write_dir
network: false # optional; gates network clients in allowed_commands
model: null # optional model override
---

System prompt for the agent goes here.
```

Workflow (`workflows/<name>.json`):

```json
{
  "name": "analyze-and-summarize",
  "description": "Analyze the repo and merge with notes.",
  "inputs": ["question", { "name": "notes", "required": false }],
  "nodes": [
    { "id": "analyze", "agent": "repo-analyst", "task": "Answer: {{inputs.question}}" },
    { "id": "digest", "agent": "summarizer", "task": "Summarize: {{inputs.notes}}" },
    {
      "id": "merge",
      "agent": "summarizer",
      "task": "Merge {{analyze}} and {{digest}}",
      "needs": ["analyze", "digest"]
    }
  ],
  "output": "merge",
  "review": {
    "target": "merge",
    "reviewer": "critic",
    "trigger": "NEEDS_REVISION",
    "max_iterations": 2
  }
}
```

Task templates may reference `{{inputs.<name>}}` and `{{<node-id>}}` — only for
node ids listed in `needs`, so the data flow and the scheduling graph always
agree. Cycles, self-loops, unknown agents, and out-of-range `max_iterations`
(1–10) are rejected at load time.

## Install

### Kiro-action (`mcp_servers` input)

Check out this repository at a pinned SHA in a prior step, then:

```yaml
mcp_servers: |
  {
    "agent_workflows": {
      "command": "bun",
      "args": ["run", "${{ github.workspace }}/.tools/agent-workflows-mcp/src/server.ts"]
    }
  }
```

### Claude Code (plugin)

```
/plugin marketplace add ndmxjp/agent-workflows-mcp
/plugin install agent-workflows-mcp
```

Or as a plain project MCP server in `.mcp.json`:

```json
{
  "mcpServers": {
    "agent_workflows": {
      "command": "bun",
      "args": ["run", "/path/to/agent-workflows-mcp/src/server.ts"]
    }
  }
}
```

## Development

```
bun install
bun test          # unit + real stdio handshake tests
bun run format
```

No build step; TypeScript runs from source under bun.

## Future (not in v1)

- Additional runner backends (Claude Code / claude CLI, direct model APIs).
- HTTP/SSE transport (stdio only for now, matching the consumers).
- Streaming per-node progress notifications.
