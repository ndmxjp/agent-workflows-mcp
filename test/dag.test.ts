import { describe, expect, test } from "bun:test";
import { findCycle, validateWorkflow } from "../src/dag.ts";
import type { AgentDefinition, WorkflowDefinition } from "../src/types.ts";

const agent = (name: string): AgentDefinition => ({
  name,
  description: name,
  prompt: "p",
  read: true,
  allowedCommands: [],
  write: false,
  network: false,
  model: null,
});

const agents = new Map([
  ["worker", agent("worker")],
  ["critic", agent("critic")],
]);

const wf = (partial: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  name: "wf",
  description: "d",
  inputs: [],
  nodes: [],
  output: "a",
  ...partial,
});

const node = (id: string, needs: string[] = [], task = "t") => ({
  id,
  agent: "worker",
  task,
  needs,
});

describe("validateWorkflow", () => {
  test("accepts a valid diamond DAG", () => {
    const w = wf({
      nodes: [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])],
      output: "d",
    });
    expect(() => validateWorkflow(w, agents)).not.toThrow();
  });

  test("rejects a self-loop (a needs a)", () => {
    const w = wf({ nodes: [node("a", ["a"])] });
    expect(() => validateWorkflow(w, agents)).toThrow(/depends on itself/);
  });

  test("rejects a two-node cycle (a -> b -> a)", () => {
    const w = wf({ nodes: [node("a", ["b"]), node("b", ["a"])] });
    expect(() => validateWorkflow(w, agents)).toThrow(/cycle/);
  });

  test("rejects an unknown agent", () => {
    const w = wf({ nodes: [{ id: "a", agent: "ghost", task: "t", needs: [] }] });
    expect(() => validateWorkflow(w, agents)).toThrow(/unknown agent "ghost"/);
  });

  test("rejects a needs reference to a missing node", () => {
    const w = wf({ nodes: [node("a", ["nope"])] });
    expect(() => validateWorkflow(w, agents)).toThrow(/unknown node "nope"/);
  });

  test("rejects a template reference to a node not in needs", () => {
    const w = wf({ nodes: [node("a"), node("b", [], "use {{a}}")], output: "b" });
    expect(() => validateWorkflow(w, agents)).toThrow(/not in its needs/);
  });

  test("rejects a template reference to an undeclared input", () => {
    const w = wf({ nodes: [node("a", [], "use {{inputs.topic}}")] });
    expect(() => validateWorkflow(w, agents)).toThrow(/undeclared input "topic"/);
  });

  test("rejects a missing output node", () => {
    const w = wf({ nodes: [node("a")], output: "zzz" });
    expect(() => validateWorkflow(w, agents)).toThrow(/output node "zzz"/);
  });

  test("rejects a review whose reviewer is the target's own agent", () => {
    const w = wf({
      nodes: [node("a")],
      review: { target: "a", reviewer: "worker", trigger: "X", maxIterations: 2 },
    });
    expect(() => validateWorkflow(w, agents)).toThrow(/self-review/);
  });

  test("rejects a review target that is not a node", () => {
    const w = wf({
      nodes: [node("a")],
      review: { target: "nope", reviewer: "critic", trigger: "X", maxIterations: 2 },
    });
    expect(() => validateWorkflow(w, agents)).toThrow(/review target/);
  });
});

describe("findCycle", () => {
  test("returns the cycle path for a -> b -> a", () => {
    const w = wf({ nodes: [node("a", ["b"]), node("b", ["a"])] });
    const cycle = findCycle(w);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  test("returns null for an acyclic graph", () => {
    const w = wf({ nodes: [node("a"), node("b", ["a"])] });
    expect(findCycle(w)).toBeNull();
  });
});
