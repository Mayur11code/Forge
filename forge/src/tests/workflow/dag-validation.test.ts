// src/tests/workflow/dag-validation.test.ts
//
// Graph validation: finding 8.
//
// The workflow schema validated each step in isolation. Every step was a
// well-formed object, and the set of them could be nonsense. That is a
// directory, not a graph, and the consequences all show up at run time:
//
//   unknown dependency  the step never becomes ready. The run stalls silently.
//   self-dependency     the same, plus it looks like it is waiting for something
//   cycle               a -> b -> a. Neither can ever start; the run hangs with
//                       no error and no timeout, because nothing is wrong enough
//                       to fail.
//   key/ID mismatch     a graph that references `a` but stores the step under
//                       `fetch_data`. Indistinguishable from a missing step.
//
// The last is the reason validation lives in the schema rather than only in the
// compiler: `compileWorkflow` is reached when a graph is materialised for the
// editor, which is too late for a workflow started from an API call or an event.

import {
  WorkflowDefinitionSchema,
  WorkflowValidationError,
  collectWorkflowDefinitionIssues,
  type AppEdge,
  type AppNode,
} from "@/lib/workflow-types/workflow";
import { compileWorkflow } from "@/lib/workflow/graph-ui/compiler";

type StepDef = {
  id: string;
  action: string;
  dependsOn?: string[];
  kind?: "TRIGGER" | "ACTION";
  config?: Record<string, unknown>;
  isCritical?: boolean;
  routingConditions?: Record<string, string>;
};

/**
 * `dependsOn` and `kind` have no defaults in the schema, so fixtures supply them
 * explicitly. That is deliberate on the schema's side - a step with an unstated
 * dependency list is a step whose author was not thinking about dependencies, and
 * it should not silently mean "none" - but it means a fixture that omits them is
 * testing the shape, not the graph.
 */
function step(id: string, dependsOn: string[] = [], action = "task.create"): StepDef {
  return { id, action, dependsOn, kind: "ACTION", config: {}, isCritical: false };
}

function graph(steps: StepDef[]) {
  return {
    id: "wf_1",
    name: "test workflow",
    steps: Object.fromEntries(steps.map((entry) => [entry.id, entry])),
  };
}

function linear() {
  return graph([step("a"), step("b", ["a"], "task.update")]);
}

function issuesOf(input: unknown) {
  const result = WorkflowDefinitionSchema.safeParse(input);
  if (result.success) return [] as string[];
  return result.error.issues.map((issue) => issue.code);
}

function messagesOf(input: unknown) {
  const result = WorkflowDefinitionSchema.safeParse(input);
  if (result.success) return [] as string[];
  return result.error.issues.map((issue) => issue.message);
}

// ---------------------------------------------------------------------------
// Graphs that must be accepted
// ---------------------------------------------------------------------------

describe("WorkflowDefinitionSchema: valid graphs", () => {
  it("accepts a linear chain", () => {
    expect(issuesOf(linear())).toEqual([]);
  });

  it("accepts a parallel fan-out", () => {
    // Three branches from one trigger is the shape the parallel-merge bug
    // lived in, so it has to be representable.
    const valid = graph([
      step("start"),
      step("b", ["start"], "task.update"),
      step("c", ["start"], "task.update"),
      step("d", ["start"], "task.update"),
    ]);

    expect(issuesOf(valid)).toEqual([]);
  });

  it("accepts a diamond, where a join depends on two branches", () => {
    const valid = graph([
      step("a"),
      step("b", ["a"], "task.update"),
      step("c", ["a"], "task.update"),
      step("d", ["b", "c"], "task.update"),
    ]);

    expect(issuesOf(valid)).toEqual([]);
  });

  it("accepts a step with no dependencies", () => {
    expect(issuesOf(graph([step("a")]))).toEqual([]);
  });

  it("keeps validating step shape", () => {
    // The semantic checks are additive. A step missing its action was invalid
    // before and must stay invalid.
    const broken = graph([{ id: "a" } as unknown as StepDef]);
    expect(WorkflowDefinitionSchema.safeParse(broken).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

describe("WorkflowDefinitionSchema: cycles", () => {
  it("rejects a direct two-step cycle", () => {
    const cyclic = graph([step("a", ["b"]), step("b", ["a"], "task.update")]);

    const messages = messagesOf(cyclic);
    expect(messages.join(" ")).toMatch(/cycle/i);
  });

  it("rejects a self-dependency", () => {
    const selfish = graph([step("a", ["a"])]);
    expect(messagesOf(selfish).join(" ")).toMatch(/itself/i);
  });

  it("reports the cycle path so the offending arrows can be named", () => {
    // "There is a cycle" is not actionable in an editor. The path names the
    // nodes, so the UI can point at the connections to delete.
    //
    // Read through `collectWorkflowDefinitionIssues` rather than `.parse`,
    // because parsing a cyclic graph is exactly what throws - the issues are the
    // return value here.
    const issues = collectWorkflowDefinitionIssues({
      steps: {
        a: step("a", ["b"]),
        b: step("b", ["a"], "task.update"),
      },
    } as never);

    const cycle = issues.find((issue) => issue.code === "CYCLE");
    expect(cycle?.path?.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a cycle in a deep graph without overflowing the stack", () => {
    // A recursive walk blows the stack somewhere in the low thousands and takes
    // the process down. Detection is iterative precisely so a long chain is a
    // slow test rather than a crashed one.
    const steps: StepDef[] = Array.from({ length: 5_000 }, (_, index) =>
      step(`s${index}`, [`s${index + 1}`], "task.update"),
    );
    steps[steps.length - 1].dependsOn = ["s0"];

    expect(messagesOf(graph(steps)).join(" ")).toMatch(/cycle/i);
  });

  it("accepts a long acyclic chain", () => {
    const steps: StepDef[] = Array.from({ length: 5_000 }, (_, index) =>
      step(`s${index}`, index === 0 ? [] : [`s${index - 1}`], "task.update"),
    );

    expect(issuesOf(graph(steps))).toEqual([]);
  });

  it("rejects a cycle reachable only through several branches", () => {
    // The cycle is not on the path a reader would look at first, so a
    // pairwise "do these two depend on each other" check misses it.
    const cyclic = graph([
      step("a"),
      step("b", ["a", "c"], "task.update"),
      step("c", ["b"], "task.update"),
    ]);

    expect(messagesOf(cyclic).join(" ")).toMatch(/cycle/i);
  });
});

// ---------------------------------------------------------------------------
// Dangling references
// ---------------------------------------------------------------------------

describe("WorkflowDefinitionSchema: unresolvable references", () => {
  it("rejects a dependency on a step that does not exist", () => {
    // This is the silent-stall case: the step waits on a name nothing will ever
    // provide, so it is never ready, and the run stops without an error.
    const dangling = graph([step("a"), step("b", ["a", "missing"], "task.update")]);

    const messages = messagesOf(dangling);
    expect(messages.join(" ")).toMatch(/missing/);
  });

  it("rejects a mismatch between the step key and its inner id", () => {
    // Two different names for the same step. Downstream code that looks the step
    // up by key finds nothing, and a graph that reads correctly on screen behaves
    // as though the step were missing.
    //
    // Written as an explicit record rather than through `graph()`: that helper
    // keys each step by its own `id`, which would have made the key and the
    // inner id agree by construction and asserted nothing.
    const mismatched = {
      id: "wf_1",
      name: "test workflow",
      steps: {
        a: step("a"),
        b: { ...step("b", ["a"], "task.update"), id: "wrong_id" },
      },
    };

    expect(messagesOf(mismatched).join(" ")).toMatch(/wrong_id/);
  });

  it("rejects two steps sharing one inner id", () => {
    const duplicated = {
      id: "wf_1",
      name: "test workflow",
      steps: {
        a: { ...step("a"), id: "same" },
        b: { ...step("b", ["a"], "task.update"), id: "same" },
      },
    };

    const messages = messagesOf(duplicated).join(" ");
    expect(messages).toMatch(/used by both/);
  });

  it("rejects a routing condition on a step it does not depend on", () => {
    // The engine only reads routing conditions for steps it is already waiting
    // on, so a condition on a non-dependency silently behaves as unconditional.
    const misrouted = graph([
      step("a"),
      {
        ...step("b", ["a"], "task.update"),
        routingConditions: { c: "outputs.ok == true" },
      },
    ]);

    expect(messagesOf(misrouted).join(" ")).toMatch(/routing condition/i);
  });

  it("rejects an empty graph", () => {
    const empty = { id: "wf_1", name: "nothing", steps: {} };
    expect(WorkflowDefinitionSchema.safeParse(empty).success).toBe(false);
  });

  it("reports several problems at once", () => {
    // A user who drew a broken canvas should see all of it, not one error per
    // save attempt.
    const issues = collectWorkflowDefinitionIssues({
      steps: {
        a: { ...step("a", ["missing"]), id: "mismatched" },
        b: step("b", ["a"], "task.update"),
      },
    } as never);

    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("ID_MISMATCH");
    expect(codes).toContain("UNKNOWN_DEPENDENCY");
  });
});

// ---------------------------------------------------------------------------
// The materialisation boundary
// ---------------------------------------------------------------------------

describe("compileWorkflow", () => {
  function actionNode(id: string): AppNode {
    return {
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: id,
        actionType: "task.create",
        config: {},
        isConfigured: true,
        isCritical: false,
      },
    };
  }

  function edge(source: string, target: string): AppEdge {
    return { id: `${source}->${target}`, source, target };
  }

  it("turns canvas edges into dependencies", () => {
    const result = compileWorkflow(
      [actionNode("a"), actionNode("b")],
      [edge("a", "b")],
    );

    expect(result.steps.b.dependsOn).toEqual(["a"]);
    expect(result.steps.a.dependsOn).toEqual([]);
  });

  it("deduplicates repeated edges between the same pair of nodes", () => {
    // A duplicated edge makes a step look like it has more parents than it does.
    // Invisible in the UI, wrong in the engine's readiness arithmetic.
    const result = compileWorkflow(
      [actionNode("a"), actionNode("b")],
      [edge("a", "b"), edge("a", "b")],
    );

    expect(result.steps.b.dependsOn).toEqual(["a"]);
  });

  it("gives every step its key as its id", () => {
    const result = compileWorkflow([actionNode("a")], []);

    expect(result.steps.a.id).toBe("a");
  });

  it("refuses to compile a cyclic canvas", () => {
    // The schema already rejects the equivalent definition, so reaching here
    // means the definition arrived by a path that skipped the schema. The
    // compiler is the last place that can still refuse.
    expect(() =>
      compileWorkflow(
        [actionNode("a"), actionNode("b")],
        [edge("a", "b"), edge("b", "a")],
      ),
    ).toThrow(WorkflowValidationError);
  });

  it("ignores an edge whose target is not on the canvas", () => {
    // The node set is authoritative: steps are built from nodes, so an edge with
    // no matching target contributes nothing. Recorded here because it is the
    // reason a typo in an edge id cannot produce a graph that hangs - it produces
    // a graph with one fewer dependency.
    const result = compileWorkflow(
      [actionNode("a")],
      [edge("a", "b"), edge("a", "ghost")],
    );

    expect(result.steps.a.dependsOn).toEqual([]);
  });

  it("throws a structured error rather than a bare string", () => {
    try {
      compileWorkflow(
        [actionNode("a"), actionNode("b")],
        [edge("a", "b"), edge("b", "a")],
      );
      throw new Error("expected compileWorkflow to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const issues = (error as WorkflowValidationError).issues;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues[0].code).toBe("CYCLE");
    }
  });

  it("refuses an empty canvas", () => {
    expect(() => compileWorkflow([], [])).toThrow(WorkflowValidationError);
  });
});
