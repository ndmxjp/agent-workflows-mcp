import { describe, expect, test } from "bun:test";
import { parseAgentMarkdown, parseWorkflowJson } from "../src/definitions.ts";
import { DefinitionError } from "../src/types.ts";

const agentMd = (frontmatter: string, body = "Do the task.") =>
  `---\n${frontmatter}\n---\n\n${body}\n`;

describe("parseAgentMarkdown", () => {
  test("parses a minimal agent with safe defaults", () => {
    const a = parseAgentMarkdown(agentMd("name: reader\ndescription: reads"), "a.md");
    expect(a.name).toBe("reader");
    expect(a.read).toBe(true);
    expect(a.allowedCommands).toEqual([]);
    expect(a.write).toBe(false);
    expect(a.network).toBe(false);
    expect(a.prompt).toBe("Do the task.");
  });

  test("rejects a file without frontmatter", () => {
    expect(() => parseAgentMarkdown("just a prompt", "a.md")).toThrow(DefinitionError);
  });

  test("rejects an empty prompt body", () => {
    expect(() => parseAgentMarkdown(agentMd("name: x\ndescription: d", ""), "a.md")).toThrow(
      /prompt.*empty|empty/,
    );
  });

  test("rejects unknown frontmatter keys (strict schema)", () => {
    expect(() =>
      parseAgentMarkdown(agentMd("name: x\ndescription: d\ntrust_all: true"), "a.md"),
    ).toThrow(DefinitionError);
  });

  test("rejects network clients in allowed_commands when network is false", () => {
    expect(() =>
      parseAgentMarkdown(
        agentMd('name: x\ndescription: d\nallowed_commands:\n  - "curl .*"'),
        "a.md",
      ),
    ).toThrow(/network/);
  });

  test("allows network clients when network is true", () => {
    const a = parseAgentMarkdown(
      agentMd('name: x\ndescription: d\nnetwork: true\nallowed_commands:\n  - "curl .*"'),
      "a.md",
    );
    expect(a.allowedCommands).toEqual(["curl .*"]);
  });
});

describe("parseWorkflowJson", () => {
  const base = {
    name: "wf",
    description: "d",
    nodes: [{ id: "a", agent: "reader", task: "t" }],
  };

  test("defaults output to the last node", () => {
    const wf = parseWorkflowJson(JSON.stringify(base), "wf.json");
    expect(wf.output).toBe("a");
  });

  test("normalizes string inputs to required inputs", () => {
    const wf = parseWorkflowJson(JSON.stringify({ ...base, inputs: ["topic"] }), "wf.json");
    expect(wf.inputs).toEqual([{ name: "topic", required: true }]);
  });

  test.each([0, 11, -1])("rejects max_iterations=%p outside 1..10", (n) => {
    const raw = {
      ...base,
      review: { target: "a", reviewer: "critic", trigger: "X", max_iterations: n },
    };
    expect(() => parseWorkflowJson(JSON.stringify(raw), "wf.json")).toThrow(DefinitionError);
  });

  test("accepts max_iterations=10 (the cap)", () => {
    const raw = {
      ...base,
      review: { target: "a", reviewer: "critic", trigger: "X", max_iterations: 10 },
    };
    expect(parseWorkflowJson(JSON.stringify(raw), "wf.json").review?.maxIterations).toBe(10);
  });

  test("rejects invalid JSON loudly", () => {
    expect(() => parseWorkflowJson("{nope", "wf.json")).toThrow(/invalid JSON/);
  });
});
