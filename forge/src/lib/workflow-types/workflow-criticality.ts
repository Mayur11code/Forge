// src/lib/workflow-types/workflow-criticality.ts
//
// ASSIGNMENT 37.7 — HUMAN CRITICALITY DECISION CONTRACT.
//
// `isCritical` is a backend-owned property of a workflow step: it decides
// whether a failure of that step rolls back the rest of the run (see
// evaluator.ts:242, which gates rollback on it). A model must never author it,
// which is why `WorkflowProposalSchema` is closed against it
// (workflow-proposal.ts:16,40). The only legitimate author is a human.
//
// This module is that human's contract, and nothing else:
//
//   1. It validates a submitted decision set against a proposal's exact step
//      set. The set must be COMPLETE and EXACT - one boolean per step, no
//      extra keys, no missing keys. There is deliberately no partial overlay
//      and no `?? false`: a decision the human did not make is not a decision
//      the backend may invent.
//   2. It applies a validated decision set to a compiled definition, touching
//      `isCritical` and nothing else.
//
// A decision is bound to the EXACT proposal revision it was approved against,
// not merely to a set of step references. Matching refs are necessary but not
// sufficient: two revisions can share every `localRef` and differ in action,
// inputs, dependencies, name or description. So an approved set carries the
// proposal's canonical fingerprint (`computeProposalCorrelationId`, the one
// fingerprint algorithm in the codebase) and `applyCriticalityDecisions`
// refuses it unless that fingerprint still matches the proposal in hand.
//
// It performs no I/O, reads no clock, and consults no model. The same
// (proposal, decisions) always yields the same result, so the decision is
// reproducible and its record can be verified later (37.8) and re-applied at
// materialization (37.11).
//
// PLACEHOLDER vs DECISION. `mapProposalToDefinition` writes `isCritical: false`
// as a pre-decision placeholder (workflow-proposal-compiler.ts:113). That value
// is meaningful only until a human decides; it is NOT a decision. The
// distinction is enforced by types: `applyCriticalityDecisions` accepts an
// `ApprovedCriticality`, which can only be produced by
// `validateCriticalityDecisions`, so the placeholder can never be mistaken for
// a human answer and raw model data can never be passed as one.
//
// ASSIGNMENT 37.10 NOTE. The exact-set rule and its issue vocabulary moved
// verbatim to `./workflow-criticality-set` so the browser-side proposal
// projection can enforce the same rule without pulling `node:crypto` (reached
// through `computeProposalCorrelationId`) into a client bundle. They are
// re-exported below, so this module is still the single import path for the
// contract and there is still exactly one implementation of the rule.

import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";

import {
  collectCriticalityIssues,
  type CriticalityDecisions,
  type CriticalityIssue,
} from "./workflow-criticality-set";
import { mapProposalToDefinition } from "./workflow-proposal-compiler";
import type { WorkflowProposal } from "./workflow-proposal";
import type { WorkflowDefinition, WorkflowStep } from "./workflow";

/**
 * The issue vocabulary and the exact-set rule moved to
 * `./workflow-criticality-set` in Assignment 37.10 so a browser bundle can
 * enforce the same rule without dragging `node:crypto` in. They are re-exported
 * here so this module remains the single import path for the whole 37.7
 * contract.
 */
export type {
  CriticalityDecision,
  CriticalityDecisions,
  CriticalityIssue,
  CriticalityIssueCode,
} from "./workflow-criticality-set";

/**
 * The nominal brand that makes a validated decision set unforgeable.
 *
 * Only `validateCriticalityDecisions` can produce a value of this type, and it
 * does so only after the exact-and-complete check passes. That is the entire
 * point: `applyCriticalityDecisions` takes an `ApprovedCriticality`, so a
 * caller physically cannot apply a partial set, an unvalidated object, or the
 * compiler's placeholder as though a human had approved it.
 */
declare const approvedCriticalityBrand: unique symbol;

export type ApprovedCriticality = {
  readonly [approvedCriticalityBrand]: true;
  /** The complete, validated decision set. Frozen; never mutated. */
  readonly decisions: Readonly<CriticalityDecisions>;
  /**
   * The canonical fingerprint of the proposal this set was approved against.
   * Recomputed server-side by `validateCriticalityDecisions`; never supplied by
   * a client and never trusted from a request.
   */
  readonly fingerprint: string;
};

export type CriticalityValidationResult =
  | { success: true; approved: ApprovedCriticality }
  | { success: false; issues: CriticalityIssue[] };

export type CriticalityApplicationResult =
  | { success: true; definition: WorkflowDefinition }
  | { success: false; issues: CriticalityIssue[] };

/**
 * Validate a human decision set against a proposal.
 *
 * On success the set is copied and frozen, the proposal's canonical fingerprint
 * is stamped onto the result, and the returned `ApprovedCriticality` is the only
 * value `applyCriticalityDecisions` will accept.
 */
export function validateCriticalityDecisions(
  proposal: WorkflowProposal,
  raw: unknown,
): CriticalityValidationResult {
  const refs = Object.keys(proposal.steps);
  const issues = collectCriticalityIssues(refs, raw);

  if (issues.length > 0) {
    return { success: false, issues };
  }

  const source = raw as CriticalityDecisions;
  const decisions: CriticalityDecisions = {};
  for (const ref of refs) {
    decisions[ref] = source[ref];
  }

  return {
    success: true,
    approved: Object.freeze({
      decisions: Object.freeze(decisions),
      fingerprint: computeProposalCorrelationId(proposal),
    }) as ApprovedCriticality,
  };
}

/**
 * Apply a validated decision set to a compiled definition.
 *
 * The definition is produced by `mapProposalToDefinition`, so every field the
 * proposal carried (action, dependsOn, config, the local-ref identity) is
 * preserved exactly; only `isCritical` is replaced, per step, with the human's
 * decision. The input proposal is not mutated and the placeholder is never
 * carried through.
 *
 * The set is re-checked against THIS proposal before applying: first that every
 * `localRef` matches, then that the approved fingerprint still equals the
 * proposal's canonical fingerprint. A same-ref but different-content revision
 * therefore fails as `REVISION_MISMATCH` rather than silently mislabelling
 * `isCritical`. It is pure and deterministic: no clock, no I/O, no model call.
 */
export function applyCriticalityDecisions(
  proposal: WorkflowProposal,
  approved: ApprovedCriticality,
): CriticalityApplicationResult {
  const refs = Object.keys(proposal.steps);
  const issues = collectCriticalityIssues(refs, approved.decisions);

  if (issues.length > 0) {
    return { success: false, issues };
  }

  if (computeProposalCorrelationId(proposal) !== approved.fingerprint) {
    return {
      success: false,
      issues: [
        {
          code: "REVISION_MISMATCH",
          path: "",
          message:
            "The criticality decision was approved for a different revision of this proposal.",
        },
      ],
    };
  }

  const base = mapProposalToDefinition(proposal);
  const steps: Record<string, WorkflowStep> = {};

  for (const [localRef, step] of Object.entries(base.steps)) {
    steps[localRef] = {
      ...step,
      isCritical: approved.decisions[localRef],
    };
  }

  return { success: true, definition: { ...base, steps } };
}
