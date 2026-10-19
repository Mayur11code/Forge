// src/lib/workflow-types/workflow-criticality-set.ts
//
// THE EXACT-SET HALF OF THE 37.7 CRITICALITY CONTRACT, CLIENT-SAFE.
//
// Assignment 37.7 defined one contract with two halves:
//   1. the EXACT-AND-COMPLETE rule - one boolean per proposal step, no unknown
//      keys, no missing keys, no invented decisions (this file);
//   2. proposal-REVISION BINDING - stamping and comparing the proposal's
//      canonical fingerprint (still `workflow-criticality.ts`).
//
// Half 2 stamps `computeProposalCorrelationId`, which lives in the
// generateWorkflow tool executor and pulls `node:crypto` into whatever imports
// it. That is correct for a route or a service and fatal for a browser bundle.
//
// Assignment 37.10 projects a proposal into a React Flow graph *in the
// browser*, and the full-preview projection must reject a missing or extra
// decision using the SAME rule the server uses - a second, parallel
// implementation would be a second validator. So the pure half is extracted
// here and `workflow-criticality.ts` imports it back, which leaves exactly one
// implementation of the rule and no duplicated logic.
//
// The code moved VERBATIM from `workflow-criticality.ts`; only its home
// changed. It performs no I/O, reads no clock, consults no model, and imports
// nothing that a client component cannot load.

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

/**
 * One structured rejection, in the same `{ code, path, message }` shape as
 * `ProposalIssue`, so a caller that receives either contract renders one
 * failure list rather than two.
 */
export type CriticalityIssue = {
  code: CriticalityIssueCode;
  path: string;
  message: string;
};

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
export function collectCriticalityIssues(
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
