// src/tests/workflow/proposal-ui-projection.test.ts
//
// Assignment 37.10 — the deterministic proposal to UI-graph projection.
//
// The projection is the ONE place a React Flow graph is derived from a reviewed
// proposal. These tests pin the four properties the preview depends on:
//
//   1. LAYOUT. The documented layered algorithm (longest-path depth, sorted
//      within a layer) actually produces the positions the contract claims, for
//      a chain, a fan-out, a fan-in and a diamond.
//   2. DETERMINISM AND PURITY. Identical input yields deep-equal output, key
//      insertion order and `dependsOn` order do not leak into the result, and
//      the input proposal is not mutated.
//   3. CRITICALITY IS NEVER INVENTED. The exact-and-complete rule from 37.7 is
//      enforced here too, and an incomplete set FAILS the projection rather than
//      rendering an unclassified step as non-critical.
//   4. VALIDATION IS DELEGATED. Structural and graph failures come back as 37.4
//      `ProposalIssue`s; this module adds no second validator.

import {
  PROPOSAL_UI_LAYOUT,
  projectProposalToUIGraph,
  type ProposalUILayoutOptions,
} from "@/lib/workflow-types/proposal-ui-projection";
import {
  ActionNodeDataSchema,
  type ActionNodeType,
  type AppNode,
} from "@/lib/workflow-types/workflow";
import {
  WorkflowProposalSchema,
  type WorkflowProposal,
} from "@/lib/workflow-types/workflow-proposal";

// The only catalogued action (37.1), so every fixture below uses it.
const ACTION = "task.create";
const PROJECT_ID = "clxyz0000000000000000000a";

function step(dependsOn: string[] = [], title = "Task") {
  return {
    action: ACTION,
    inputs: { title, projectId: PROJECT_ID },
    dependsOn,
  };
}

function proposal(
  steps: Record<string, ReturnType<typeof step>>,
): WorkflowProposal {
  return WorkflowProposalSchema.parse({ name: "Test proposal", steps });
}

/** Every step critical: `true`, the "complete set" fixture default. */
function allCritical(p: WorkflowProposal): Record<string, boolean> {
  return Object.fromEntries(Object.keys(p.steps).map((ref) => [ref, true]));
}

function project(p: WorkflowProposal, decisions: unknown) {
  const result = projectProposalToUIGraph(p, decisions);
  if (!result.success) {
    throw new Error(
      `expected a successful projection, got: ${JSON.stringify(result.issues)}`,
    );
  }
  return result;
}

function positions(result: ReturnType<typeof project>) {
  return Object.fromEntries(
    result.uiNodes.map((node) => [
      node.id,
      { x: node.position.x, y: node.position.y },
    ]),
  );
}

function actionData(node: AppNode) {
  expect(node.type).toBe("action");
  return (node as ActionNodeType).data;
}

function edgePairs(result: ReturnType<typeof project>) {
  return result.uiEdges.map((edge) => [edge.source, edge.target]);
}

const { x0, y0, nodeWidth, nodeHeight, horizontalGap, verticalGap } =
  PROPOSAL_UI_LAYOUT;

/** The documented x for a layer, derived from the exported constants. */
const columnX = (layer: number) => x0 + layer * (nodeWidth + horizontalGap);
/** The documented y for the nth entry within a layer. */
const rowY = (index: number) => y0 + index * (nodeHeight + verticalGap);

describe("37.10 projection — layout", () => {
  it("documents the layout constants it claims", () => {
    expect(PROPOSAL_UI_LAYOUT).toEqual({
      x0: 100,
      y0: 100,
      nodeWidth: 250,
      nodeHeight: 140,
      horizontalGap: 80,
      verticalGap: 60,
    });
  });

  it("projects a single-step proposal to one node and no edges", () => {
    const p = proposal({ only: step() });

    const result = project(p, allCritical(p));

    expect(result.uiNodes.map((node) => node.id)).toEqual(["only"]);
    expect(positions(result)).toEqual({ only: { x: columnX(0), y: rowY(0) } });
    expect(result.uiEdges).toEqual([]);
  });

  it("lays a linear chain left to right, one node per layer, in one row", () => {
    const p = proposal({
      a: step(),
      b: step(["a"]),
      c: step(["b"]),
    });

    const result = project(p, allCritical(p));

    expect(positions(result)).toEqual({
      a: { x: columnX(0), y: rowY(0) },
      b: { x: columnX(1), y: rowY(0) },
      c: { x: columnX(2), y: rowY(0) },
    });
    expect(edgePairs(result)).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
  });

  it("stacks independent roots in the same layer, top to bottom, by ref", () => {
    const p = proposal({
      // Deliberately not inserted in ref order: the layout sorts.
      second: step(),
      first: step(),
    });

    const result = project(p, allCritical(p));

    expect(result.uiNodes.map((node) => node.id)).toEqual(["first", "second"]);
    expect(positions(result)).toEqual({
      first: { x: columnX(0), y: rowY(0) },
      second: { x: columnX(0), y: rowY(1) },
    });
  });

  it("gives every child of a fan-out the same layer and stacks the siblings", () => {
    const p = proposal({
      root: step(),
      beta: step(["root"]),
      alpha: step(["root"]),
    });

    const result = project(p, allCritical(p));

    expect(result.uiNodes.map((node) => node.id)).toEqual([
      "root",
      "alpha",
      "beta",
    ]);
    expect(positions(result)).toEqual({
      root: { x: columnX(0), y: rowY(0) },
      alpha: { x: columnX(1), y: rowY(0) },
      beta: { x: columnX(1), y: rowY(1) },
    });
  });

  it("places a fan-in join one layer past the deepest of its parents", () => {
    const p = proposal({
      a: step(),
      b: step(),
      join: step(["a", "b"]),
    });

    const result = project(p, allCritical(p));

    expect(positions(result)).toEqual({
      a: { x: columnX(0), y: rowY(0) },
      b: { x: columnX(0), y: rowY(1) },
      join: { x: columnX(1), y: rowY(0) },
    });
    expect(edgePairs(result)).toEqual([
      ["a", "join"],
      ["b", "join"],
    ]);
  });

  it("places a diamond's join after both of its parents", () => {
    const p = proposal({
      a: step(),
      b: step(["a"]),
      c: step(["a"]),
      d: step(["b", "c"]),
    });

    const result = project(p, allCritical(p));

    expect(result.uiNodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(positions(result)).toEqual({
      a: { x: columnX(0), y: rowY(0) },
      b: { x: columnX(1), y: rowY(0) },
      c: { x: columnX(1), y: rowY(1) },
      d: { x: columnX(2), y: rowY(0) },
    });
  });

  it("uses the LONGEST path to a node, not the first path found", () => {
    // `d` can be reached a -> b -> d (depth 2) or c -> d (depth 1). The
    // longest-path rule puts it at depth 2, so it sits strictly right of
    // every dependency.
    const p = proposal({
      a: step(),
      b: step(["a"]),
      c: step(),
      d: step(["b", "c"]),
    });

    const result = project(p, allCritical(p));

    expect(positions(result).d).toEqual({ x: columnX(2), y: rowY(0) });
    expect(positions(result).c).toEqual({ x: columnX(0), y: rowY(1) });
  });

  it("honours layout options without changing the algorithm", () => {
    const p = proposal({
      a: step(),
      b: step(["a"]),
    });
    const options: ProposalUILayoutOptions = {
      x0: 0,
      y0: 0,
      verticalGap: 0,
    };

    const result = projectProposalToUIGraph(p, allCritical(p), options);
    if (!result.success) throw new Error("expected success");

    expect(positions(result)).toEqual({
      a: { x: 0, y: 0 },
      b: { x: nodeWidth + horizontalGap, y: 0 },
    });
  });
});

describe("37.10 projection — nodes and edges", () => {
  const p = proposal({
    kickoff: step([], "Kick off"),
    follow: step(["kickoff"], "Follow up"),
  });

  it("emits one edge per dependency, in sorted target then dependency order", () => {
    const result = project(p, allCritical(p));

    expect(result.uiEdges).toEqual([
      { id: "e:kickoff->follow", source: "kickoff", target: "follow" },
    ]);
  });

  it("emits each edge exactly once and never duplicates an id", () => {
    const result = project(p, { kickoff: true, follow: false });
    const ids = result.uiEdges.map((edge) => edge.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("deduplicates a repeated dependency to a single edge", () => {
    const repeated = proposal({
      root: step(),
      // A free-form array can name the same dependency twice.
      child: step(["root", "root"]),
    });

    const result = project(repeated, allCritical(repeated));

    expect(edgePairs(result)).toEqual([["root", "child"]]);
  });

  it("carries ref, action, inputs and the human's decision onto each node", () => {
    const result = project(p, { kickoff: true, follow: false });
    const nodes = Object.fromEntries(
      result.uiNodes.map((node) => [node.id, node]),
    );

    expect(nodes.kickoff.position).toEqual({ x: columnX(0), y: rowY(0) });
    expect(nodes.follow.position).toEqual({ x: columnX(1), y: rowY(0) });

    expect(actionData(nodes.kickoff)).toEqual({
      label: "kickoff (task.create)",
      actionType: ACTION,
      config: { title: "Kick off", projectId: PROJECT_ID },
      isConfigured: true,
      isCritical: true,
      inputsComplete: true,
    });
    expect(actionData(nodes.follow).isCritical).toBe(false);
  });

  it("carries no execution status, because no run has happened", () => {
    const result = project(p, allCritical(p));

    for (const node of result.uiNodes) {
      expect("executionStatus" in actionData(node)).toBe(false);
    }
  });

  it("produces node data the canvas node schema accepts", () => {
    const result = project(p, { kickoff: true, follow: false });

    for (const node of result.uiNodes) {
      expect(ActionNodeDataSchema.safeParse(actionData(node)).success).toBe(
        true,
      );
    }
  });

  it("copies inputs so a node cannot be edited through the proposal", () => {
    const result = project(p, allCritical(p));
    const kickoff = result.uiNodes.find((node) => node.id === "kickoff");
    if (!kickoff) throw new Error("expected the kickoff node");

    expect(actionData(kickoff).config).not.toBe(p.steps.kickoff.inputs);
  });
});

describe("37.10 projection — determinism and purity", () => {
  const p = proposal({
    a: step(),
    b: step(["a"]),
    c: step(["a"]),
    d: step(["b", "c"]),
  });
  const decisions = { a: true, b: false, c: true, d: false };

  it("returns deep-equal output for the same input", () => {
    const first = project(p, decisions);
    const second = project(p, decisions);

    expect(second).toEqual(first);
  });

  it("does not depend on step key insertion order", () => {
    const shuffled = proposal({
      d: step(["c", "b"]),
      c: step(["a"]),
      b: step(["a"]),
      a: step(),
    });

    expect(project(shuffled, decisions)).toEqual(project(p, decisions));
  });

  it("does not depend on dependsOn order", () => {
    const reordered = proposal({
      a: step(),
      b: step(["a"]),
      c: step(["a"]),
      d: step(["c", "b"]),
    });

    expect(project(reordered, decisions).uiEdges).toEqual(
      project(p, decisions).uiEdges,
    );
  });

  it("does not mutate the proposal it is given", () => {
    const before = JSON.parse(JSON.stringify(p)) as unknown;

    project(p, decisions);

    expect(JSON.parse(JSON.stringify(p))).toEqual(before);
  });
});

describe("37.10 projection — criticality is enforced, never invented", () => {
  const p = proposal({
    kickoff: step(),
    follow: step(["kickoff"]),
  });

  it("accepts an exact, complete set of booleans", () => {
    const result = projectProposalToUIGraph(p, {
      kickoff: true,
      follow: false,
    });

    expect(result.success).toBe(true);
  });

  it("fails an incomplete set as INCOMPLETE_CRITICALITY and renders nothing", () => {
    const result = projectProposalToUIGraph(p, { kickoff: true });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INCOMPLETE_CRITICALITY",
          path: "follow",
        }),
      ]);
    }
  });

  it("fails a set naming a step the proposal does not contain", () => {
    const result = projectProposalToUIGraph(p, {
      kickoff: true,
      follow: false,
      ghost: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "UNKNOWN_CRITICALITY_STEP",
          path: "ghost",
        }),
      ]);
    }
  });

  it("fails a non-boolean decision rather than coercing it", () => {
    const result = projectProposalToUIGraph(p, {
      kickoff: true,
      follow: "false",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "INVALID_CRITICALITY_VALUE",
          path: "follow",
        }),
      ]);
    }
  });

  it.each([
    ["null", null],
    ["an array", [true, false]],
    ["a string", "critical"],
  ])("fails %s as a decision set", (_label, raw) => {
    const result = projectProposalToUIGraph(p, raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "INVALID_CRITICALITY_VALUE" }),
      ]);
    }
  });
});

describe("37.10 projection — validation is delegated to the 37.4 compiler", () => {
  it("fails a cyclic proposal with CYCLE and no nodes", () => {
    const p = proposal({
      a: step(["b"]),
      b: step(["a"]),
    });

    const result = projectProposalToUIGraph(p, allCritical(p));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "CYCLE" }),
      ]);
    }
  });

  it("fails a dependency on a step that does not exist", () => {
    const p = proposal({ a: step(["ghost"]) });

    const result = projectProposalToUIGraph(p, allCritical(p));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "UNKNOWN_DEPENDENCY" }),
      ]);
    }
  });

  it("fails a self-dependency", () => {
    const p = proposal({ a: step(["a"]) });

    const result = projectProposalToUIGraph(p, allCritical(p));

    expect(result.success).toBe(false);
    if (!result.success) {
      // A self-dependency is also a degenerate cycle, so both codes may appear;
      // the point is that the graph-semantic collector rejects it.
      expect(result.issues.map((issue) => issue.code)).toContain(
        "SELF_DEPENDENCY",
      );
    }
  });

  it("fails an action outside the capability catalog", () => {
    const p = proposal({ a: { ...step(), action: "task.destroy" } });

    const result = projectProposalToUIGraph(p, allCritical(p));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "UNKNOWN_ACTION" }),
      ]);
    }
  });

  it("fails an empty proposal", () => {
    // Built directly: the strict schema rejects an empty proposal, so it cannot
    // be produced through `WorkflowProposalSchema.parse`.
    const p: WorkflowProposal = { name: "Test proposal", steps: {} };

    const result = projectProposalToUIGraph(p, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "EMPTY_PROPOSAL" }),
      ]);
    }
  });

  it("reports proposal issues before criticality issues", () => {
    const cyclic = proposal({
      a: step(["b"]),
      b: step(["a"]),
    });

    // Both contracts would reject this input; the proposal failure wins, so the
    // caller is never shown a downstream symptom of an upstream error.
    const result = projectProposalToUIGraph(cyclic, null);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["CYCLE"]);
    }
  });
});
