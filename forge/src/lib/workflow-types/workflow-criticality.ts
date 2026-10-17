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

import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";

import { mapProposalToDefinition } from "./workflow-proposal-compiler";
import type { WorkflowProposal } from "./workflow-proposal";
import type { WorkflowDefinition, WorkflowStep } from "./workflow";

/**
 * One human decision: whether a named step is critical.
 *
 * `true` means "a failure of this step rolls back the run"; `false` means it
 * does not. There is no third state - "unsure" is not a decision and the human
 * is required to make one for every step (see `INCOMPLETE_CRITICALITY`).
 */
export type CriticalityDecision = boolean;

/** A decision for every step, keyed by proposal-local ref. */
export type CriticalityDecisions = Record<string, CriticalityDecision>;

/** Machine-readable reason a decision set was rejected. */
export type CriticalityIssueCode =
  | "UNKNOWN_CRITICALITY_STEP"
  | "INCOMPLETE_CRITICALITY"
  | "INVALID_CRITICALITY_VALUE"
  | "REVISION_MISMATCH";

/** One structured rejection, in the same `{ code, path, message }` shape as `ProposalIssue`. */
export type CriticalityIssue = {
  code: CriticalityIssueCode;
  path: string;
  message: string;
};

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
 * The exact-and-complete check, shared by validation and application.
 *
 * Two rules, and both directions matter:
 *   - every step in `refs` must have a decision, or the set is incomplete;
 *   - every key in the set must name a step in `refs`, or it is unknown.
 *
 * The second direction is what stops a decision from a different proposal
 * revision being applied here: a ref that this proposal does not contain is
 * rejected rather than ignored, so an approved set is bound to the proposal it
 * was made against.
 */
function collectCriticalityIssues(
  refs: readonly string[],
  raw: unknown,
): CriticalityIssue[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [
      {
        code: "INVALID_CRITICALITY_VALUE",
        path: "",
        message:
          "Criticality decisions must be an object mapping each step id to a boolean.",
      },
    ];
  }

  const decisions = raw as Record<string, unknown>;
  const known = new Set(refs);
  const issues: CriticalityIssue[] = [];

  for (const key of Object.keys(decisions)) {
    if (!known.has(key)) {
      issues.push({
        code: "UNKNOWN_CRITICALITY_STEP",
        path: key,
        message: `Step "${key}" is not a step in this workflow proposal.`,
      });
      continue;
    }

    if (typeof decisions[key] !== "boolean") {
      issues.push({
        code: "INVALID_CRITICALITY_VALUE",
        path: key,
        message: `The decision for step "${key}" must be true or false.`,
      });
    }
  }

  for (const ref of refs) {
    if (!Object.prototype.hasOwnProperty.call(decisions, ref)) {
      issues.push({
        code: "INCOMPLETE_CRITICALITY",
        path: ref,
        message: `No criticality decision was supplied for step "${ref}".`,
      });
    }
  }

  return issues;
}

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
