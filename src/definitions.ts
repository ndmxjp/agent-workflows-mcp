import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  DefinitionError,
  type AgentDefinition,
  type WorkflowDefinition,
  type WorkflowInput,
} from "./types.ts";
import { validateWorkflow } from "./dag.ts";

// Network clients that shell patterns must not name unless the definition sets network: true.
const NETWORK_COMMANDS = /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp)\b/;

const agentFrontmatterSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase alphanumeric + hyphens"),
    description: z.string().min(1),
    read: z.boolean().default(true),
    allowed_commands: z.array(z.string().min(1)).default([]),
    write: z.boolean().default(false),
    network: z.boolean().default(false),
    model: z.string().nullable().default(null),
  })
  .strict();

const workflowSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase alphanumeric + hyphens"),
    description: z.string().min(1),
    inputs: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              name: z.string().min(1),
              description: z.string().optional(),
              required: z.boolean().default(true),
            })
            .strict(),
        ]),
      )
      .default([]),
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
            agent: z.string().min(1),
            task: z.string().min(1),
            needs: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .min(1),
    output: z.string().optional(),
    review: z
      .object({
        target: z.string().min(1),
        reviewer: z.string().min(1),
        trigger: z.string().min(1),
        max_iterations: z.number().int().min(1).max(10),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Splits `---\n<yaml>\n---\n<body>` markdown. Throws when the frontmatter fence is missing. */
export function parseAgentMarkdown(text: string, sourceName: string): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    throw new DefinitionError(`${sourceName}: missing YAML frontmatter (--- ... ---)`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(match[1]!);
  } catch (e) {
    throw new DefinitionError(`${sourceName}: invalid YAML frontmatter: ${(e as Error).message}`);
  }
  const parsed = agentFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DefinitionError(`${sourceName}: ${parsed.error.issues.map(fmtIssue).join("; ")}`);
  }
  const fm = parsed.data;
  if (!fm.network) {
    const offender = fm.allowed_commands.find((c) => NETWORK_COMMANDS.test(c));
    if (offender) {
      throw new DefinitionError(
        `${sourceName}: allowed_commands pattern "${offender}" names a network client but network is false`,
      );
    }
  }
  const prompt = match[2]!.trim();
  if (!prompt) {
    throw new DefinitionError(`${sourceName}: agent body (system prompt) is empty`);
  }
  return {
    name: fm.name,
    description: fm.description,
    prompt,
    read: fm.read,
    allowedCommands: fm.allowed_commands,
    write: fm.write,
    network: fm.network,
    model: fm.model,
  };
}

export function parseWorkflowJson(text: string, sourceName: string): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DefinitionError(`${sourceName}: invalid JSON: ${(e as Error).message}`);
  }
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DefinitionError(`${sourceName}: ${parsed.error.issues.map(fmtIssue).join("; ")}`);
  }
  const wf = parsed.data;
  const inputs: WorkflowInput[] = wf.inputs.map((i) =>
    typeof i === "string" ? { name: i, required: true } : i,
  );
  const lastNode = wf.nodes[wf.nodes.length - 1]!;
  return {
    name: wf.name,
    description: wf.description,
    inputs,
    nodes: wf.nodes,
    output: wf.output ?? lastNode.id,
    review: wf.review
      ? {
          target: wf.review.target,
          reviewer: wf.review.reviewer,
          trigger: wf.review.trigger,
          maxIterations: wf.review.max_iterations,
        }
      : undefined,
  };
}

function fmtIssue(issue: z.ZodIssue): string {
  return `${issue.path.join(".") || "(root)"}: ${issue.message}`;
}

export interface Definitions {
  agents: Map<string, AgentDefinition>;
  workflows: Map<string, WorkflowDefinition>;
}

/**
 * Loads agents/*.md and workflows/*.json from the definitions directory.
 * Any unparsable file, duplicate name, or invalid workflow throws — the caller
 * (server startup) exits non-zero rather than serving a partial catalog.
 */
export function loadDefinitions(dir: string): Definitions {
  const agents = new Map<string, AgentDefinition>();
  for (const file of listFiles(join(dir, "agents"), ".md")) {
    const def = parseAgentMarkdown(readFileSync(file, "utf8"), file);
    if (agents.has(def.name)) {
      throw new DefinitionError(`duplicate agent name "${def.name}" (${file})`);
    }
    agents.set(def.name, def);
  }
  const workflows = new Map<string, WorkflowDefinition>();
  for (const file of listFiles(join(dir, "workflows"), ".json")) {
    const wf = parseWorkflowJson(readFileSync(file, "utf8"), file);
    if (workflows.has(wf.name)) {
      throw new DefinitionError(`duplicate workflow name "${wf.name}" (${file})`);
    }
    validateWorkflow(wf, agents);
    workflows.set(wf.name, wf);
  }
  if (agents.size === 0) {
    throw new DefinitionError(`no agent definitions found under ${join(dir, "agents")}`);
  }
  return { agents, workflows };
}

function listFiles(dir: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // a missing agents/ dir is caught by the agents.size === 0 check above
  }
  return entries
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f));
}
