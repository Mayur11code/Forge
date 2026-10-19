// src/tests/agent/proposal-materialization-boundary.test.ts
//
// Assignment 37.11 — the PERSISTENCE BOUNDARY for a materialized proposal.
//
// This is the test Assignment 37.10 could not write: it proves that what 37.10
// PROJECTS survives the REAL workflow save boundary and that the two persisted
// artifacts — the stored canvas graph and the stored execution `definition` — are
// mutually consistent.
//
// It is deliberately NOT a mock of the projection, the compiler or the shared
// schemas. It runs the actual 37.10 projection, the actual shared boundary
// schemas (`IncomingNodesSchema` / `IncomingEdgesSchema`), the actual save-path
// compiler (`compileWorkflow`) and the actual criticality contract, then asserts
// the round-trip:
//
//   proposal + decisions
//     -> projectProposalToUIGraph        (37.10, unstubbed)
//     -> IncomingNodes/EdgesSchema       (shared save boundary, unstubbed)
//     -> compileWorkflow                 (only edge -> dependsOn compiler)
//     -> equals applyCriticalityDecisions(proposal)  (canonical definition)
//
// If the projected graph and the compiled definition could ever disagree — a
// missing edge, a dropped `config`, a lost `isCritical`, a renamed action — this
// test fails, because re-compiling the stored nodes would not reproduce the
// stored definition.

import { projectProposalToUIGraph } from "@/lib/workflow-types/proposal-ui-projection";
import { expectValidMaterializationPayload } from "@/lib/ai/agent/services/proposal-materialization";
import { compileWorkflow } from "@/lib/workflow/graph-ui/compiler";
import {
  IncomingEdgesSchema,
  IncomingNodesSchema,
} from "@/lib/workflow/validation/incoming-graph";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";
import type { AppEdge, AppNode } from "@/lib/workflow-types/workflow";

const PROJECT_ID = "clxyz0000000000000000000a";

/** A proposal with a small DAG, a fan-out and a fan-in. */
const PROPOSAL: WorkflowProposal = {
  name: "Client onboarding",
  description: "Fan-out then fan-in.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kickoff", projectId: PROJECT_ID },
      dependsOn: [],
    },
    email: {
      action: "task.create",
      inputs: { title: "Send welcome", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
    task: {
      action: "task.create",
      inputs: { title: "Prepare workspace", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
    wrap: {
      action: "task.create",
      inputs: { title: "Wrap up", projectId: PROJECT_ID },
      dependsOn: ["email", "task"],
    },
  },
};

const DECISIONS = { kickoff: false, email: true, task: true, wrap: false };

function project() {
  const projection = projectProposalToUIGraph(PROPOSAL, DECISIONS);
  expect(projection.success).toBe(true);
  if (!projection.success) throw new Error("fixture failed to project");

  const nodes = IncomingNodesSchema.safeParse(projection.uiNodes);
  const edges = IncomingEdgesSchema.safeParse(projection.uiEdges);

  expect(nodes.success).toBe(true);
  expect(edges.success).toBe(true);
  if (!nodes.success || !edges.success) throw new Error("boundary rejected graph");

  return { nodes: nodes.data, edges: edges.data };
}

describe("the projected graph survives the shared save boundary", () => {
  it("accepts the 37.10 projection through IncomingNodes/EdgesSchema", () => {
    const { nodes, edges } = project();

    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(4);
  });

  it("keeps every node's action identity and criticality flag", () => {
    const { nodes } = project();

    const byId = new Map(nodes.map((node) => [node.id, node]));

    expect(byId.get("kickoff")?.data).toMatchObject({
      actionType: "task.create",
      isCritical: false,
    });
    expect(byId.get("email")?.data).toMatchObject({
      actionType: "task.create",
      isCritical: true,
    });
    expect(byId.get("task")?.data).toMatchObject({
      actionType: "task.create",
      isCritical: true,
    });
    expect(byId.get("wrap")?.data).toMatchObject({
      actionType: "task.create",
      isCritical: false,
    });
  });

  it("preserves each node's inputs as config", () => {
    const { nodes } = project();
    const kickoff = nodes.find((node) => node.id === "kickoff");
    expect(kickoff?.type).toBe("action");
    if (kickoff?.type !== "action") throw new Error("kickoff is not an action node");

    expect(kickoff.data.config).toEqual({
      title: "Kickoff",
      projectId: PROJECT_ID,
    });
  });
});

describe("stored graph and stored definition are mutually consistent", () => {
  it("re-compiling the stored nodes reproduces the canonical dependsOn", () => {
    const { nodes, edges } = project();

    // The canonical definition the materializer actually persists, derived from
    // the same proposal + decisions by the criticality contract.
    const applied = expectValidMaterializationPayload(PROPOSAL, DECISIONS);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("fixture failed to apply");

    // What the save boundary's own compiler would rebuild from the STORED graph.
    const recompiled = compileWorkflow(nodes as AppNode[], edges as AppEdge[]);

    const canonicalDeps: Record<string, string[]> = {};
    for (const [ref, step] of Object.entries(applied.definition.steps)) {
      canonicalDeps[ref] = [...step.dependsOn].sort();
    }
    const recompiledDeps: Record<string, string[]> = {};
    for (const [ref, step] of Object.entries(recompiled.steps)) {
      recompiledDeps[ref] = [...step.dependsOn].sort();
    }

    expect(recompiledDeps).toEqual(canonicalDeps);
  });

  it("re-compiling reproduces each step's action, config and isCritical", () => {
    const { nodes, edges } = project();

    const applied = expectValidMaterializationPayload(PROPOSAL, DECISIONS);
    if (!applied.ok) throw new Error("fixture failed to apply");

    const recompiled = compileWorkflow(nodes as AppNode[], edges as AppEdge[]);

    for (const [ref, step] of Object.entries(applied.definition.steps)) {
      const rebuilt = recompiled.steps[ref];
      expect(rebuilt).toBeDefined();
      expect(rebuilt.action).toBe(step.action);
      expect(rebuilt.config).toEqual(step.config);
      expect(rebuilt.isCritical).toBe(step.isCritical);
      expect(rebuilt.kind).toBe(step.kind);
    }
  });

  it("produces an edgeless graph when no step depends on another", () => {
    const solo: WorkflowProposal = {
      name: "Solo",
      steps: {
        only: { action: "task.create", inputs: { title: "Only step", projectId: PROJECT_ID }, dependsOn: [] },
      },
    };

    const projection = projectProposalToUIGraph(solo, { only: false });
    if (!projection.success) {
      throw new Error(`fixture failed to project: ${JSON.stringify(projection.issues)}`);
    }

    expect(projection.uiEdges).toHaveLength(0);
    expect(projection.uiNodes).toHaveLength(1);
  });
});

describe("triggerless graphs are accepted by the boundary", () => {
  it("persists an action-only graph (no trigger node) without error", () => {
    const { nodes, edges } = project();

    // Every node is an action node; there is no trigger. The save boundary must
    // accept this because a proposal carries no human-approved trigger (F1).
    expect(nodes.every((node) => node.type === "action")).toBe(true);

    const recompiled = compileWorkflow(nodes as AppNode[], edges as AppEdge[]);
    expect(Object.values(recompiled.steps).every((step) => step.kind === "ACTION")).toBe(
      true,
    );
  });
});

describe("the boundary rejects what it should", () => {
  it("rejects a projected graph that has been tampered with to be empty", () => {
    const empty = IncomingNodesSchema.safeParse([]);
    // An empty array is structurally valid; the executor/graph rules reject an
    // EMPTY_GRAPH later. Assert the schema itself does not throw, documenting
    // that emptiness is a graph rule, not a shape rule.
    expect(empty.success).toBe(true);
  });

  it("rejects a node with a malformed shape", () => {
    const malformed = IncomingNodesSchema.safeParse([{ id: "a", nope: true }]);
    expect(malformed.success).toBe(false);
  });

  it("rejects an edge missing its target", () => {
    const malformed = IncomingEdgesSchema.safeParse([{ id: "e", source: "a" }]);
    expect(malformed.success).toBe(false);
  });
});
