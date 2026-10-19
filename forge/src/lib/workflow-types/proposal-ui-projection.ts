// src/lib/workflow-types/proposal-ui-projection.ts
//
// ASSIGNMENT 37.10 — DETERMINISTIC PROPOSAL → UI GRAPH PROJECTION.
//
// A proposal is a record of steps keyed by a proposal-local ref; a canvas is a
// React Flow graph of positioned nodes and directed edges. This module is the
// ONE place the second is derived from the first, and it is pure: no I/O, no
// clock, no model call, no mutation of its inputs, no persistence and no
// materialization. The same (proposal, decisions, options) always yields
// byte-identical `uiNodes` and `uiEdges`.
//
// It is deliberately NOT a second validator and NOT a second representation:
//
//   - VALIDATION is `compileWorkflowProposal` — the existing 37.4 pipeline
//     (structural → references → mapping → graph semantics, including
//     `UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY` and `CYCLE`). This module does
//     not re-implement any of it; it stops on the same `ProposalIssue[]`.
//   - CRITICALITY is the existing 37.7 exact-set rule
//     (`collectCriticalityIssues` from `./workflow-criticality-set`), imported
//     rather than re-derived, so a missing or extra decision is rejected by
//     the same code the server uses. A decision the human did not make is
//     never defaulted to `false` — the projection fails instead.
//   - PERSISTENCE does not belong here at all. Nothing in this file writes a
//     Workflow, a Task or any row; turning an approved proposal into a
//     persisted workflow is Assignment 37.11.
//
// The output is presentation-only `AppNode`/`AppEdge` (the same types the
// canvas uses) so the preview can reuse the existing `ActionNode` renderer.
// The nodes are NOT savable workflow state: a proposal has no trigger node and
// no run has happened, so no node carries an execution status.
//
// LAYOUT CONTRACT (documented, hand-rolled — the dependency tree has no
// dagre/elk and none was added):
//
//   1. `layer(ref) = 0` when the step has no dependencies, otherwise
//      `1 + max(layer(dep))` over its dependencies — the longest-path depth
//      from a root, so every dependency sits strictly left of its dependent.
//   2. Computed by iterative relaxation over refs in sorted order, at most
//      `refs.length` passes, so the result is total (never a stack overflow)
//      and independent of record-key insertion order. Cycles cannot reach this
//      point — `compileWorkflowProposal` rejects them first.
//   3. Within a layer, refs are sorted lexicographically and stacked
//      top-to-bottom.
//   4. `x = x0 + layer * (nodeWidth + horizontalGap)`
//      `y = y0 + indexInLayer * (nodeHeight + verticalGap)`
//   5. Output order is layer 0…n, then ref — so node order is deterministic
//      too. Edges are emitted in sorted-target then sorted-dependency order,
//      once per distinct dependency.

import type { AppEdge, AppNode } from "./workflow";
import type { ProposalIssue, WorkflowProposal } from "./workflow-proposal";
import { compileWorkflowProposal } from "./workflow-proposal-compiler";
import {
  collectCriticalityIssues,
  type CriticalityIssue,
} from "./workflow-criticality-set";

/**
 * Documented layout constants. Exported so the contract above is asserted by
 * tests rather than restated, and so a caller can vary the geometry without
 * forking the algorithm.
 *
 * `nodeWidth`/`nodeHeight` approximate the shared `ActionNode` renderer
 * (`min-w-[250px]` plus its header/body); `ReactFlow` `fitView` corrects any
 * drift, and the gaps keep the assumed box from overlapping the real one.
 */
export const PROPOSAL_UI_LAYOUT = {
  x0: 100,
  y0: 100,
  nodeWidth: 250,
  nodeHeight: 140,
  horizontalGap: 80,
  verticalGap: 60,
} as const;

/**
 * A caller-supplied variation on those constants.
 *
 * Mapped rather than `Partial<typeof PROPOSAL_UI_LAYOUT>`: the constants are
 * `as const`, so that form would accept only the literal numbers it declares
 * (`x0?: 100`), which makes the option unusable for anyone actually varying the
 * geometry. The keys are fixed; the values are numbers.
 */
export type ProposalUILayoutOptions = {
  [K in keyof typeof PROPOSAL_UI_LAYOUT]?: number;
};

/**
 * The projection's failures, in the two established `{ code, path, message }`
 * vocabularies. The code unions do not overlap, so `issue.code` discriminates
 * between a proposal rejection and a criticality rejection without a second
 * tag.
 */
export type ProposalUIProjectionIssue = ProposalIssue | CriticalityIssue;

export type ProposalUIProjectionResult =
  | { success: true; uiNodes: AppNode[]; uiEdges: AppEdge[] }
  | { success: false; issues: ProposalUIProjectionIssue[] };

/** Sorted refs: the one ordering the layout and the edge emission agree on. */
function sortedRefs(proposal: WorkflowProposal): string[] {
  return Object.keys(proposal.steps).sort();
}

/**
 * Longest-path layering, by relaxation.
 *
 * `next[ref] = max(next[ref], next[dep] + 1)` over every dependency, repeated
 * until a pass changes nothing (or `refs.length` passes have run, which bounds
 * even an impossible cyclic input instead of hanging). Each pass reads only the
 * previous pass's values, so the result does not depend on visit order.
 */
function computeLayers(
  proposal: WorkflowProposal,
  refs: readonly string[],
): Map<string, number> {
  const layer = new Map<string, number>(refs.map((ref) => [ref, 0]));

  for (let pass = 0; pass < refs.length; pass++) {
    let changed = false;

    for (const ref of refs) {
      for (const dep of proposal.steps[ref].dependsOn) {
        const depLayer = layer.get(dep);
        if (depLayer === undefined) continue; // rejected by the compiler already
        const candidate = depLayer + 1;
        if (candidate > (layer.get(ref) ?? 0)) {
          layer.set(ref, candidate);
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  return layer;
}

type PositionedRef = {
  ref: string;
  x: number;
  y: number;
  layer: number;
};

function layoutProposalGraph(
  proposal: WorkflowProposal,
  options: ProposalUILayoutOptions = {},
): PositionedRef[] {
  const refs = sortedRefs(proposal);
  const layout = { ...PROPOSAL_UI_LAYOUT, ...options };
  const layer = computeLayers(proposal, refs);

  const byLayer = new Map<number, string[]>();
  for (const ref of refs) {
    const depth = layer.get(ref) ?? 0;
    const bucket = byLayer.get(depth);
    if (bucket) bucket.push(ref);
    else byLayer.set(depth, [ref]);
  }
  for (const bucket of byLayer.values()) bucket.sort();

  const maxLayer =
    refs.length === 0 ? -1 : Math.max(...Array.from(byLayer.keys()));

  const positioned: PositionedRef[] = [];
  for (let depth = 0; depth <= maxLayer; depth++) {
    const bucket = byLayer.get(depth) ?? [];
    for (let index = 0; index < bucket.length; index++) {
      positioned.push({
        ref: bucket[index],
        x: layout.x0 + depth * (layout.nodeWidth + layout.horizontalGap),
        y: layout.y0 + index * (layout.nodeHeight + layout.verticalGap),
        layer: depth,
      });
    }
  }
  return positioned;
}

/**
 * Project a validated proposal plus the human's COMPLETE criticality decision
 * set into a positioned, read-only React Flow graph.
 *
 * `completeCriticalityDecisions` is typed `unknown` on purpose: the whole point
 * of the rule is that a TypeScript type is not evidence that a runtime value
 * was validated. Anything other than exactly one boolean per step fails the
 * projection with the 37.7 issue vocabulary — there is no `?? false`, so a step
 * the human never classified is never rendered as non-critical.
 *
 * Pure and total: it never throws for bad input, it returns structured issues,
 * and it never writes anything.
 */
export function projectProposalToUIGraph(
  proposal: WorkflowProposal,
  completeCriticalityDecisions: unknown,
  options: ProposalUILayoutOptions = {},
): ProposalUIProjectionResult {
  const compiled = compileWorkflowProposal(proposal);
  if (!compiled.success) {
    return { success: false, issues: compiled.issues };
  }

  const validated = compiled.proposal;
  const refs = sortedRefs(validated);

  const criticalityIssues = collectCriticalityIssues(
    refs,
    completeCriticalityDecisions,
  );
  if (criticalityIssues.length > 0) {
    return { success: false, issues: criticalityIssues };
  }

  const decisions = completeCriticalityDecisions as Record<string, boolean>;

  const uiNodes: AppNode[] = layoutProposalGraph(validated, options).map(
    (position): AppNode => {
      const step = validated.steps[position.ref];

      return {
        id: position.ref,
        type: "action",
        position: { x: position.x, y: position.y },
        data: {
          // Readable label format: "<ref> (<action>)". The ref is the stable
          // identity the review card and the decision set both use; the action
          // is appended so the graph is legible on its own. `ActionNode` also
          // renders `actionType` in the body, so nothing is hidden either way.
          label: `${position.ref} (${step.action})`,
          actionType: step.action,
          config: { ...step.inputs },
          isConfigured: true,
          isCritical: decisions[position.ref],
          // A proposal step's inputs are literal and its ordering is
          // `dependsOn`, so the canvas's upstream-wiring "Missing Data" check
          // does not apply. The step's completeness was proven by
          // `compileWorkflowProposal` before this projection ran.
          inputsComplete: true,
        },
      };
    },
  );

  const uiEdges: AppEdge[] = [];
  for (const ref of refs) {
    // Deduplicated: `dependsOn` is a free-form array, so a repeated dependency
    // must still produce exactly one edge between the pair.
    const dependencies = [...new Set(validated.steps[ref].dependsOn)].sort();
    for (const dependency of dependencies) {
      uiEdges.push({
        // `e:<dependency>-><ref>` is unique per ordered pair and records the
        // direction in the id itself, which is what makes an edge traceable
        // back to the dependency it encodes.
        id: `e:${dependency}->${ref}`,
        source: dependency,
        target: ref,
      });
    }
  }

  return { success: true, uiNodes, uiEdges };
}
