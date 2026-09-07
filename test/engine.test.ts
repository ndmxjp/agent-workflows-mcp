import { describe, expect, test } from "bun:test";
import { runWorkflow, interpolate } from "../src/engine.ts";
import type { AgentDefinition, RunAgentFn, WorkflowDefinition } from "../src/types.ts";

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

const node = (id: string, needs: string[] = [], task = `task:${id}`) => ({
  id,
  agent: "worker",
  task,
  needs,
});

const wf = (partial: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  name: "wf",
  description: "d",
  inputs: [],
  nodes: [],
  output: "a",
  ...partial,
});

/** Runner that records concurrency and resolves on the next macrotask tick. */
function trackingRunner() {
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const run: RunAgentFn = async (_agent, task) => {
    active++;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${task}`);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    events.push(`end:${task}`);
    return { ok: true, output: `out(${task})` };
  };
  return {
    run,
    events,
    get maxActive() {
      return maxActive;
    },
  };
}

describe("runWorkflow scheduling", () => {
  test("independent nodes run in parallel; dependent node waits", async () => {
    const t = trackingRunner();
    const w = wf({
      nodes: [node("a"), node("b"), node("c", ["a", "b"])],
      output: "c",
    });
    const result = await runWorkflow(w, agents, {}, t.run);
    expect(result.ok).toBe(true);
    expect(t.maxActive).toBe(2); // a and b overlapped
    // c started only after both a and b ended
    const cStart = t.events.indexOf("start:task:c");
    expect(cStart).toBeGreaterThan(t.events.indexOf("end:task:a"));
    expect(cStart).toBeGreaterThan(t.events.indexOf("end:task:b"));
  });

  test("dependency outputs are interpolated into downstream tasks", async () => {
    const runs: string[] = [];
    const run: RunAgentFn = async (_a, task) => {
      runs.push(task);
      return { ok: true, output: `out:${task}` };
    };
    const w = wf({
      inputs: [{ name: "topic", required: true }],
      nodes: [node("a", [], "research {{inputs.topic}}"), node("b", ["a"], "summarize {{a}}")],
      output: "b",
    });
    const result = await runWorkflow(w, agents, { topic: "bun" }, run);
    expect(result.ok).toBe(true);
    expect(runs[0]).toBe("research bun");
    expect(runs[1]).toBe("summarize out:research bun");
    expect(result.final).toBe("out:summarize out:research bun");
  });

  test("a failed node skips its dependents and fails the workflow", async () => {
    const run: RunAgentFn = async (_a, task) =>
      task === "task:a" ? { ok: false, output: "", error: "boom" } : { ok: true, output: "fine" };
    const w = wf({
      nodes: [node("a"), node("b", ["a"]), node("c")],
      output: "b",
    });
    const result = await runWorkflow(w, agents, {}, run);
    expect(result.ok).toBe(false);
    expect(result.nodes["a"]?.status).toBe("failed");
    expect(result.nodes["b"]?.status).toBe("skipped");
    expect(result.nodes["c"]?.status).toBe("succeeded"); // independent branch still ran
    expect(result.final).toBeUndefined();
  });

  test("missing required inputs fail before any node runs", async () => {
    let ran = false;
    const run: RunAgentFn = async () => {
      ran = true;
      return { ok: true, output: "x" };
    };
    const w = wf({ inputs: [{ name: "topic", required: true }], nodes: [node("a")] });
    const result = await runWorkflow(w, agents, {}, run);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing required inputs: topic/);
    expect(ran).toBe(false);
  });

  test("unknown inputs are rejected", async () => {
    const w = wf({ nodes: [node("a")] });
    const result = await runWorkflow(w, agents, { bogus: "x" }, async () => ({
      ok: true,
      output: "x",
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown inputs: bogus/);
  });
});

describe("review loop", () => {
  const reviewWf = (maxIterations: number) =>
    wf({
      nodes: [node("a")],
      review: { target: "a", reviewer: "critic", trigger: "REJECT", maxIterations },
    });

  test("stops when the reviewer accepts", async () => {
    let reviews = 0;
    const run: RunAgentFn = async (a) => {
      if (a.name === "critic") {
        reviews++;
        return { ok: true, output: reviews < 2 ? "REJECT: weak" : "acceptable" };
      }
      return { ok: true, output: `draft${reviews}` };
    };
    const result = await runWorkflow(reviewWf(5), agents, {}, run);
    expect(result.ok).toBe(true);
    expect(result.nodes["a"]?.reviewIterations).toBe(2);
    expect(result.final).toBe("draft1"); // one revision after the first REJECT
  });

  test("gives up after max_iterations even if the reviewer keeps rejecting", async () => {
    let targetRuns = 0;
    const run: RunAgentFn = async (a) => {
      if (a.name === "critic") return { ok: true, output: "REJECT forever" };
      targetRuns++;
      return { ok: true, output: `draft${targetRuns}` };
    };
    const result = await runWorkflow(reviewWf(3), agents, {}, run);
    expect(result.ok).toBe(true);
    expect(result.nodes["a"]?.reviewIterations).toBe(3);
    expect(targetRuns).toBe(4); // initial + 3 revisions, then the loop stops
  });

  test("a failing reviewer fails the node", async () => {
    const run: RunAgentFn = async (a) =>
      a.name === "critic"
        ? { ok: false, output: "", error: "reviewer crashed" }
        : { ok: true, output: "draft" };
    const result = await runWorkflow(reviewWf(2), agents, {}, run);
    expect(result.ok).toBe(false);
    expect(result.nodes["a"]?.error).toMatch(/reviewer failed/);
  });
});

describe("interpolate", () => {
  test("leaves unknown references intact", () => {
    expect(interpolate("x {{mystery}}", {}, new Map())).toBe("x {{mystery}}");
  });
});
