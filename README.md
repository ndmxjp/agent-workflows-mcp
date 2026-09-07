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
- **Shell patterns are linted at load time.** A pattern like `git status.*`
  matches `git status; curl x | sh`, so it is rejected. Patterns must be
  anchored and provably unable to match shell metacharacters — safe literals,
  `(a|b)` groups, and `[^…]` classes excluding `` ;&|<>$` `` and newline, e.g.
  ``^git (status|log)[^;&|<>$`\n]*$``. A definition with an unsafe pattern
  fails the server at startup.
- **Read access is NOT path-scoped (known limitation).** kiro-cli 2.21 ignores
  read-path restrictions in `toolsSettings` (verified empirically), so a child
  can read any file the job's user can — including credentials — and return
  them in its output. Redaction (below) catches common token shapes and PEM
  private-key blocks, but treat child output as able to contain anything the
  user account can read. Run the server under a job user whose HOME holds
  nothing secret beyond what the job needs.
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
  AWS access keys and labeled secrets, JWTs, PEM private-key blocks) are
  redacted from every tool result.
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
allowed_commands: # optional; omit for no shell at all. Anchored + metacharacter-excluding (linted at load)
  - "^git (status|log)[^;&|<>$`\\n]*$"
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

### npm / npx

The package ships a self-contained node bundle (`node >= 18`, no bun required)
plus the default `agents/` and `workflows/` definitions:

```json
{
  "mcpServers": {
    "agent_workflows": {
      "command": "npx",
      "args": ["-y", "agent-workflows-mcp"]
    }
  }
}
```

To serve your own definitions instead of the bundled ones, point
`AGENT_WORKFLOWS_DIR` (or `--definitions <dir>`) at a directory containing
`agents/` and `workflows/`. Note the security caveat: only do this with a
directory you control, never a checked-out PR.

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
bun run build     # bundle dist/server.js (node target) for npm publishing
```

TypeScript runs from source under bun; the build step exists only to produce
the node-compatible bundle that npm/npx installs (`prepublishOnly` runs it).

## Prior art and how this differs

Exposing agents as MCP tools is not a new idea; this server exists for the
combination the existing projects don't cover:

- **[shinpr/sub-agents-mcp](https://github.com/shinpr/sub-agents-mcp)** — the
  closest neighbor: markdown-defined sub-agents behind a `run_agent` tool, with
  many CLI backends (cursor-agent, claude, gemini, codex, …). It has no
  workflows (single-agent runs only), no kiro-cli backend, and no child
  sandboxing — children run with whatever the backend CLI allows. Its
  multi-backend abstraction is a good reference for future runners here.
- **[lastmile-ai/mcp-agent](https://github.com/lastmile-ai/mcp-agent)** and
  **[fast-agent](https://fast-agent.ai/agents/workflows)** — Python frameworks
  where agents and workflows (parallel, evaluator-optimizer, orchestrator) are
  defined in code and can be served over MCP. Powerful, but code-defined and
  heavyweight where this server wants declarative data files a CI runner can
  load at a pinned SHA.
- **MCP workflow engines** (e.g. the MCP Mediator pattern) — run DAGs of MCP
  _tool calls_, not agent runs; a different layer.

What this server adds that none of the above combine: declarative definitions
(markdown agents + JSON DAG workflows) loaded only from the server's own
directory, a kiro-cli backend for hosts that already carry `KIRO_API_KEY`, and
a per-run least-privilege child sandbox (generated profile, minimal env, no
GitHub token, output redaction) as a design requirement rather than an option.

## Future (not in v1)

- Additional runner backends (Claude Code / claude CLI, direct model APIs).
- HTTP/SSE transport (stdio only for now, matching the consumers).
- Streaming per-node progress notifications.
