// src/lib/ai/agent/services/proposal-review.ts
//
// ASSIGNMENT 37.9 — THE REVIEW MODEL.
//
// A pure, deterministic projection of a persisted proposal into what a human
// reviewer needs to see: the workflow name, the steps and their dependencies,
// the per-step criticality the human already decided, and the missing-input
// resolutions recorded during clarification.
//
// It is deliberately PURE and CLIENT-SAFE: it imports only the client-safe
// proposal contract and no Prisma, no server-only action implementation, and no
// registry runtime edge. That is what lets the session read route and the
// `ProposalReviewCard` client component build the exact same view from the exact
// same data, so what the server renders and what the client renders cannot
// drift apart.
//
// The name is read from the PROPOSAL (`proposal.name`), never from the compiler's
// `definition.name`. That placeholder is a constant (F2) and reading it here
// would label every review "Compiled Execution Graph".

import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";

export type ProposalReviewStep = {
  /** The proposal-local step id (its record key). */
  ref: string;
  /** The registered action id. */
  action: string;
  /** Proposal-local refs this step depends on; [] means none. */
  dependsOn: string[];
  /** The action inputs as proposed. */
  inputs: Record<string, unknown>;
};

export type ProposalReviewModel = {
  /** Human-facing workflow name, from `proposal.name` (never `definition.name`). */
  name: string;
  description: string | null;
  stepCount: number;
  steps: ProposalReviewStep[];
  /**
   * Deterministic dependency order: every ref appears after the refs it depends
   * on. This IS the dependency structure the reviewer needs; a full layout is a
   * 37.10 concern and is not invented here.
   */
  order: string[];
  /** The human's recorded criticality decisions, or null when none exist. */
  criticality: Record<string, boolean> | null;
  /** The recorded clarification answers, or null when none exist. */
  clarification: Record<string, unknown> | null;
  /** ISO timestamp of the review deadline, or null when none is set. */
  reviewExpiresAt: string | null;
};

/**
 * Deterministic topological order of the proposal's steps.
 *
 * Kahn's algorithm with refs visited in sorted order, so the SAME proposal always
 * yields the SAME order - a reviewer's step ordering must not depend on object
 * key insertion order or on a scan race. A dependency that names a ref outside
 * the proposal is ignored here rather than throwing: reference EXISTENCE is
 * 37.3's gate, and a proposal that reached AWAITING_APPROVAL already passed it. A
 * cycle (which the 37.4 graph gate forbids) would leave the cycle members
 * unordered; they are appended in sorted order so the projection is still total
 * and never drops a step.
 */
export function orderProposalSteps(
  proposal: WorkflowProposal,
): string[] {
  const refs = Object.keys(proposal.steps).sort();
  const inSet = new Set(refs);
  const remaining = new Map<string, Set<string>>(
    refs.map((ref) => [
      ref,
      new Set(proposal.steps[ref].dependsOn.filter((dep) => inSet.has(dep))),
    ]),
  );

  const ordered: string[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([ref]) => ref)
      .sort();

    // No ref is ready: a cycle among the remaining nodes. Append them in sorted
    // order so no step is lost, then stop.
    if (ready.length === 0) {
      ordered.push(...[...remaining.keys()].sort());
      break;
    }

    for (const ref of ready) {
      ordered.push(ref);
      remaining.delete(ref);
    }

    for (const deps of remaining.values()) {
      for (const ref of ready) {
        deps.delete(ref);
      }
    }
  }

  return ordered;
}

/** Read a stored criticality decision map, or null when it is not one. */
function readCriticality(value: unknown): Record<string, boolean> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const result: Record<string, boolean> = {};

  for (const [ref, decision] of Object.entries(value as Record<string, unknown>)) {
    if (typeof decision !== "boolean") {
      return null;
    }
    result[ref] = decision;
  }

  return result;
}

/** Read a stored clarification answer map, or null when it is not one. */
function readClarification(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return { ...(value as Record<string, unknown>) };
}

/**
 * Project a validated proposal (plus the human inputs already recorded against
 * it) into the review model.
 *
 * The caller is responsible for having parsed the proposal through
 * `WorkflowProposalSchema`; this function does no validation of its own beyond
 * defensively reading the optional human inputs, so it can never be the place a
 * malformed proposal slips through.
 */
export function buildProposalReviewModel({
  proposal,
  criticality,
  clarification,
  reviewExpiresAt,
}: {
  proposal: WorkflowProposal;
  criticality?: unknown;
  clarification?: unknown;
  reviewExpiresAt?: Date | null;
}): ProposalReviewModel {
  const refs = Object.keys(proposal.steps).sort();

  const steps: ProposalReviewStep[] = refs.map((ref) => ({
    ref,
    action: proposal.steps[ref].action,
    dependsOn: [...proposal.steps[ref].dependsOn],
    inputs: proposal.steps[ref].inputs,
  }));

  return {
    name: proposal.name,
    description: proposal.description ?? null,
    stepCount: refs.length,
    steps,
    order: orderProposalSteps(proposal),
    criticality: readCriticality(criticality),
    clarification: readClarification(clarification),
    reviewExpiresAt: reviewExpiresAt ? reviewExpiresAt.toISOString() : null,
  };
}
