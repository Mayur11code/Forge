// src/lib/ai/agent/services/proposal-materialization.ts
//
// ASSIGNMENT 37.11 — PURE MATERIALIZATION HELPERS.
//
// Kept separate from the service so the payload-building and boundary-validation
// logic is unit-testable without Prisma, without the session lock, and without
// any authorization. Nothing here reads the clock, performs I/O, calls the model,
// or writes a row.
//
// The two responsibilities are:
//
//   1. `expectValidMaterializationPayload` — bind the human's criticality
//      decisions to the exact proposal revision and produce the semantic
//      `WorkflowDefinition`. It reuses `validateCriticalityDecisions` and
//      `applyCriticalityDecisions` verbatim; it does NOT re-implement the exact
//      set rule or the fingerprint algorithm.
//
//   2. `validateWorkflowGraphForPersistence` — run the projected UI nodes and
//      edges through the SAME shared boundary schemas the workflow save action
//      uses, so the materializer cannot persist a graph the editor could not
//      have saved. Reusing the real schemas (rather than a weaker copy) is the
//      whole point of the I2 boundary.

import { validateCriticalityDecisions } from "@/lib/workflow-types/workflow-criticality";
import { applyCriticalityDecisions } from "@/lib/workflow-types/workflow-criticality";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";
import type { WorkflowDefinition } from "@/lib/workflow-types/workflow";

import {
  IncomingEdgesSchema,
  IncomingNodesSchema,
} from "@/lib/workflow/validation/incoming-graph";

export type MaterializationPayload =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; code: string; error: string };

/**
 * Validate the human criticality set against the proposal revision and apply it.
 *
 * Fail-closed on every negative: a set that is not the exact, complete set of
 * booleans for this proposal's steps is rejected with the first 37.7 issue, and
 * a set that was approved for a different revision is rejected as a revision
 * mismatch by `applyCriticalityDecisions`.
 */
export function expectValidMaterializationPayload(
  proposal: WorkflowProposal,
  rawCriticality: unknown,
): MaterializationPayload {
  const validation = validateCriticalityDecisions(proposal, rawCriticality);

  if (!validation.success) {
    const first = validation.issues[0];
    return {
      ok: false,
      code: first?.code ?? "INVALID_CRITICALITY",
      error: first?.message ?? "The criticality decisions are invalid.",
    };
  }

  const applied = applyCriticalityDecisions(proposal, validation.approved);

  if (!applied.success) {
    const first = applied.issues[0];
    return {
      ok: false,
      code: first?.code ?? "INVALID_CRITICALITY",
      error: first?.message ?? "The criticality decisions are invalid.",
    };
  }

  return { ok: true, definition: applied.definition };
}

export type GraphBoundaryResult =
  | {
      ok: true;
      nodes: ReturnType<typeof IncomingNodesSchema.parse>;
      edges: ReturnType<typeof IncomingEdgesSchema.parse>;
    }
  | { ok: false; error: string };

/**
 * Validate the projected graph through the shared persistence boundary.
 *
 * Returns the PARSED values, not the inputs, so the materializer persists exactly
 * what was validated - the same property the workflow save action relies on.
 */
export function validateWorkflowGraphForPersistence(
  uiNodes: unknown,
  uiEdges: unknown,
): GraphBoundaryResult {
  const nodes = IncomingNodesSchema.safeParse(uiNodes);

  if (!nodes.success) {
    return { ok: false, error: "Malformed workflow nodes." };
  }

  const edges = IncomingEdgesSchema.safeParse(uiEdges);

  if (!edges.success) {
    return { ok: false, error: "Malformed workflow edges." };
  }

  return { ok: true, nodes: nodes.data, edges: edges.data };
}
