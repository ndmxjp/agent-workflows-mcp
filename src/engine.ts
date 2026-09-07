import type {
  AgentDefinition,
  NodeResult,
  RunAgentFn,
  RunOptions,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowResult,
} from "./types.ts";

/** Hard cap on review rounds regardless of what a definition asks for. */
export const MAX_REVIEW_ITERATIONS = 10;

const TEMPLATE_REF = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function interpolate(
  template: string,
  inputs: Record<string, string>,
  outputs: Map<string, string>,
): string {
  return template.replace(TEMPLATE_REF, (whole, ref: string) => {
    if (ref.startsWith("inputs.")) {
      return inputs[ref.slice("inputs.".length)] ?? whole;
    }
    return outputs.get(ref) ?? whole;
  });
}

/**
 * Runs the workflow DAG. Every node whose dependencies have succeeded starts
 * immediately (independent nodes run in parallel); a failed node marks all of
 * its transitive dependents as skipped.
 */
export async function runWorkflow(
  wf: WorkflowDefinition,
  agents: Map<string, AgentDefinition>,
  inputs: Record<string, string>,
  runAgent: RunAgentFn,
  opts: RunOptions = {},
): Promise<WorkflowResult> {
  const missing = wf.inputs.filter((i) => i.required && !(i.name in inputs)).map((i) => i.name);
  if (missing.length > 0) {
    return { ok: false, nodes: {}, error: `missing required inputs: ${missing.join(", ")}` };
  }
  const unknown = Object.keys(inputs).filter((k) => !wf.inputs.some((i) => i.name === k));
  if (unknown.length > 0) {
    return { ok: false, nodes: {}, error: `unknown inputs: ${unknown.join(", ")}` };
  }

  const results: Record<string, NodeResult> = {};
  const outputs = new Map<string, string>();
  const running = new Map<string, Promise<void>>();
  const pending = new Set(wf.nodes.map((n) => n.id));
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));

  const startNode = (node: WorkflowNode): Promise<void> =>
    executeNode(wf, node, agents, inputs, outputs, runAgent, opts).then((result) => {
      results[node.id] = result;
      if (result.status === "succeeded" && result.output !== undefined) {
        outputs.set(node.id, result.output);
      }
      running.delete(node.id);
    });

  while (pending.size > 0 || running.size > 0) {
    for (const id of [...pending]) {
      const node = byId.get(id)!;
      const depResults = node.needs.map((d) => results[d]);
      if (depResults.some((r) => r && r.status !== "succeeded")) {
        results[id] = { status: "skipped", error: "a dependency failed" };
        pending.delete(id);
        continue;
      }
      if (node.needs.every((d) => results[d]?.status === "succeeded")) {
        pending.delete(id);
        running.set(id, startNode(node));
      }
    }
    if (running.size > 0) {
      await Promise.race(running.values());
    } else if (pending.size > 0) {
      // Unreachable for a validated (acyclic) workflow; guard against livelock anyway.
      return { ok: false, nodes: results, error: "scheduler stalled (unresolvable dependencies)" };
    }
  }

  const finalResult = results[wf.output];
  const ok = Object.values(results).every((r) => r.status === "succeeded");
  return {
    ok,
    nodes: results,
    final: finalResult?.status === "succeeded" ? finalResult.output : undefined,
    error: ok ? undefined : "one or more nodes did not succeed",
  };
}

async function executeNode(
  wf: WorkflowDefinition,
  node: WorkflowNode,
  agents: Map<string, AgentDefinition>,
  inputs: Record<string, string>,
  outputs: Map<string, string>,
  runAgent: RunAgentFn,
  opts: RunOptions,
): Promise<NodeResult> {
  const agent = agents.get(node.agent)!;
  const task = interpolate(node.task, inputs, outputs);
  try {
    let result = await runAgent(agent, task, opts);
    if (!result.ok) {
      return { status: "failed", error: result.error ?? "agent run failed" };
    }

    const review = wf.review;
    if (!review || review.target !== node.id) {
      return { status: "succeeded", output: result.output };
    }

    const reviewer = agents.get(review.reviewer)!;
    const rounds = Math.min(review.maxIterations, MAX_REVIEW_ITERATIONS);
    // reviewIterations counts reviewer invocations: one per pass, and a pass
    // revises only on rejection, so at most `rounds` reviews and `rounds` revisions.
    let reviews = 0;
    for (let pass = 0; pass < rounds; pass++) {
      const verdict = await runAgent(
        reviewer,
        `Review the following output for the task below. If it must be revised, include the exact string "${review.trigger}" in your reply along with concrete feedback; otherwise state that it is acceptable.\n\n## Task\n${task}\n\n## Output\n${result.output}`,
        opts,
      );
      reviews++;
      if (!verdict.ok) {
        return {
          status: "failed",
          error: `reviewer failed: ${verdict.error}`,
          reviewIterations: reviews,
        };
      }
      if (!verdict.output.includes(review.trigger)) break;
      const revision = await runAgent(
        agent,
        `${task}\n\nA reviewer rejected your previous attempt. Revise it.\n\n## Previous attempt\n${result.output}\n\n## Reviewer feedback\n${verdict.output}`,
        opts,
      );
      if (!revision.ok) {
        return {
          status: "failed",
          error: revision.error ?? "revision run failed",
          reviewIterations: reviews,
        };
      }
      result = revision;
    }
    return { status: "succeeded", output: result.output, reviewIterations: reviews };
  } catch (e) {
    return { status: "failed", error: (e as Error).message };
  }
}
