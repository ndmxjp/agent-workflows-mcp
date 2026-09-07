import { DefinitionError, type AgentDefinition, type WorkflowDefinition } from "./types.ts";

/** Matches {{inputs.<name>}} and {{<node-id>}} references in task templates. */
const TEMPLATE_REF = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Structural validation of a workflow against the loaded agents.
 * Throws DefinitionError listing every problem found, not just the first.
 */
export function validateWorkflow(
  wf: WorkflowDefinition,
  agents: Map<string, AgentDefinition>,
): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const node of wf.nodes) {
    if (ids.has(node.id)) problems.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
  }
  for (const node of wf.nodes) {
    if (!agents.has(node.agent)) {
      problems.push(`node "${node.id}" references unknown agent "${node.agent}"`);
    }
    for (const dep of node.needs) {
      if (dep === node.id) problems.push(`node "${node.id}" depends on itself`);
      else if (!ids.has(dep)) problems.push(`node "${node.id}" needs unknown node "${dep}"`);
    }
    problems.push(...validateTemplateRefs(wf, node.id, node.task, node.needs));
  }
  if (!ids.has(wf.output)) {
    problems.push(`output node "${wf.output}" does not exist`);
  }
  const cycle = findCycle(wf);
  if (cycle) {
    problems.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  if (wf.review) {
    if (!ids.has(wf.review.target)) {
      problems.push(`review target "${wf.review.target}" is not a node`);
    }
    if (!agents.has(wf.review.reviewer)) {
      problems.push(`review reviewer "${wf.review.reviewer}" is not a known agent`);
    }
    const target = wf.nodes.find((n) => n.id === wf.review!.target);
    if (target && target.agent === wf.review.reviewer) {
      problems.push(
        `review reviewer "${wf.review.reviewer}" is the target's own agent (self-review loop)`,
      );
    }
  }
  if (problems.length > 0) {
    throw new DefinitionError(`workflow "${wf.name}": ${problems.join("; ")}`);
  }
}

function validateTemplateRefs(
  wf: WorkflowDefinition,
  nodeId: string,
  task: string,
  needs: string[],
): string[] {
  const problems: string[] = [];
  const inputNames = new Set(wf.inputs.map((i) => i.name));
  for (const match of task.matchAll(TEMPLATE_REF)) {
    const ref = match[1]!;
    if (ref.startsWith("inputs.")) {
      const name = ref.slice("inputs.".length);
      if (!inputNames.has(name)) {
        problems.push(`node "${nodeId}" task references undeclared input "${name}"`);
      }
    } else if (!needs.includes(ref)) {
      // A node may only read outputs it declared a dependency on; this keeps the
      // template references and the scheduling graph in agreement.
      problems.push(`node "${nodeId}" task references "${ref}" which is not in its needs`);
    }
  }
  return problems;
}

/** DFS cycle detection; returns one cycle path (e.g. ["a","b","a"]) or null. */
export function findCycle(wf: WorkflowDefinition): string[] | null {
  const needsById = new Map(wf.nodes.map((n) => [n.id, n.needs]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "visiting") {
      return [...stack.slice(stack.indexOf(id)), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of needsById.get(id) ?? []) {
      if (!needsById.has(dep)) continue; // unknown dep reported separately
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const node of wf.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}
