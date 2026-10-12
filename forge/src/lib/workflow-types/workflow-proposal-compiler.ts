// src/lib/workflow-types/workflow-proposal-compiler.ts
//
// ASSIGNMENT 37.4 — PROPOSAL COMPILER / SEMANTIC VALIDATION ADAPTER.
//
// One deterministic boundary from an untrusted model artifact to an executable
// `WorkflowDefinition`, or to a structured list of `ProposalIssue`s. It composes
// existing layers rather than re-implementing them:
//
//   1. validateWorkflowProposal        structure, limits, action membership, inputs
//   2. validateProposalReferences       reference + data-dependency integrity
//   3. mapProposalToDefinition          pure, total proposal -> definition mapping
//   4. collectWorkflowDefinitionIssues  existing graph-semantic rules (authority)
//   5. toProposalIssues                 normalise collector issues into ProposalIssue
//
// Two properties are load-bearing:
//
//   DETERMINISTIC. No clock, no randomness, no database, no queue, no model call,
//   no runtime execution. The same input always yields the same output. In
//   particular the definition's `id` is a documented constant, never a
//   timestamped value — identity is backend-owned and assigned at materialization
//   (37.11), never by this compiler.
//
//   STRUCTURED. Expected validation failures are returned as typed
//   `ProposalIssue[]`, never flattened into prose and never mistaken for an
//   unexpected programming error. The caller can branch on `code` and `path`.
//
// F5 / AD-P4 resolution. There are two existing entry points to graph-semantic
// validation: the `WorkflowDefinitionSchema.superRefine` gate and the collector
// `collectWorkflowDefinitionIssues`. The collector is canonical here, because the
// schema's `superRefine` re-emits every issue as `z.ZodIssueCode.custom`,
// discarding both the semantic `code` and the cycle `path` (./workflow.ts:243-250).
// The schema is unchanged and still serves as the runtime read-boundary validator
// in the evaluator; this compiler simply does not route expected graph failures
// through its lossy output.

import {
  validateWorkflowProposal,
  type ProposalIssue,
  type WorkflowProposal,
} from "./workflow-proposal";
import { validateProposalReferences } from "./workflow-proposal-references";
import {
  collectWorkflowDefinitionIssues,
  type WorkflowDefinition,
  type WorkflowDefinitionIssue,
  type WorkflowStep,
} from "./workflow";

/**
 * Placeholder definition id.
 *
 * `WorkflowDefinition.id` is descriptive metadata, not an identity: it is read by
 * nothing at runtime (the engine resolves by step key; `WorkflowRun.workflowId`
 * is the execution identity) and the canvas compiler regenerates it as a
 * timestamped placeholder on every save. A deterministic compiler cannot use a
 * clock, and a proposal cannot name backend identity (AD-10), so this constant
 * stands in until materialization (37.11) assigns the real `Workflow.id`. F2
 * tracks the same placeholder-vs-provenance decision.
 */
export const PROPOSAL_DEFINITION_ID = "proposal";

/**
 * Placeholder definition name.
 *
 * The human-facing name lives on `Workflow.name` (F2); `definition.name` has only
 * ever been a constant. This matches the canvas compiler's constant
 * (`compiler.ts:62`) so both producers of a `WorkflowDefinition` agree.
 */
export const PROPOSAL_DEFINITION_NAME = "Compiled Execution Graph";

/**
 * Result of compiling a proposal.
 *
 * Mirrors the `ProposalValidationResult` discriminated-union convention, but the
 * success arm carries BOTH the validated proposal (retaining its name/description
 * metadata) and the candidate definition, so no validated metadata is discarded.
 * The compiler never persists or materializes anything.
 */
export type WorkflowCompilationResult =
  | {
      success: true;
      proposal: WorkflowProposal;
      definition: WorkflowDefinition;
    }
  | {
      success: false;
      issues: ProposalIssue[];
    };

/**
 * Pure, total mapping from a validated proposal to a candidate definition.
 *
 * No I/O, no mutation of `proposal`, no clock. Every step becomes an `ACTION`
 * (a proposal has no trigger node — the trigger is a runtime namespace, not a
 * step), and `inputs` becomes `config`. Step ids are the proposal-local refs, so
 * the record key and the inner `id` are identical by construction. Criticality
 * is provisionally `false`; routing conditions are not expressible in a proposal
 * and are not synthesized.
 */
export function mapProposalToDefinition(
  proposal: WorkflowProposal,
): WorkflowDefinition {
  const steps: Record<string, WorkflowStep> = {};

  for (const [localRef, step] of Object.entries(proposal.steps)) {
    steps[localRef] = {
      id: localRef,
      action: step.action,
      // Copied rather than aliased: the returned definition must not share mutable
      // arrays with the input proposal.
      dependsOn: [...step.dependsOn],
      config: { ...step.inputs },
      isCritical: false,
      kind: "ACTION",
    };
  }

  return {
    id: PROPOSAL_DEFINITION_ID,
    name: PROPOSAL_DEFINITION_NAME,
    steps,
  };
}

/**
 * Input location for a graph-semantic issue, as a dotted `ProposalIssue` path.
 *
 * `ProposalIssue.path` always denotes a location in the proposal INPUT; it is
 * never repurposed to carry a graph path. The collector's cycle sequence is
 * therefore preserved in the issue `message`, not in `path`.
 *
 * The switch is exhaustive over `WorkflowDefinitionIssueCode`, so a future
 * collector code cannot be silently dropped or rewritten into a generic message —
 * adding one becomes a compile error here.
 */
function locationForGraphIssue(issue: WorkflowDefinitionIssue): string {
  const step = issue.stepId ? `steps.${issue.stepId}` : "steps";

  switch (issue.code) {
    case "EMPTY_GRAPH":
      return "steps";
    case "ID_MISMATCH":
    case "DUPLICATE_STEP_ID":
      return step;
    case "UNKNOWN_DEPENDENCY":
    case "SELF_DEPENDENCY":
      return `${step}.dependsOn`;
    case "UNKNOWN_ROUTING_CONDITION":
      return `${step}.routingConditions`;
    case "CYCLE":
      return "steps";
    default: {
      // Exhaustiveness guard. Unreachable while the collector union is fully
      // covered above; it exists so a new code cannot slip through unhandled.
      const unhandled: never = issue.code;
      return unhandled;
    }
  }
}

/**
 * Normalize the collector's semantic issues into the existing `ProposalIssue`
 * contract, preserving `code` and `message`. Codes are identical between the two
 * vocabularies (see the graph members added to `ProposalIssueCode`), so nothing
 * is translated and nothing is dropped.
 */
export function toProposalIssues(
  issues: WorkflowDefinitionIssue[],
): ProposalIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    path: locationForGraphIssue(issue),
    message: issue.message,
  }));
}

/**
 * Compile a proposal into a candidate definition, running the full deterministic
 * pipeline in order and short-circuiting on the first stage that fails.
 */
export function compileWorkflowProposal(
  input: unknown,
): WorkflowCompilationResult {
  // Stage 1 — structural, bounded, action-membership and per-action input checks.
  const structural = validateWorkflowProposal(input);
  if (!structural.success) {
    return structural;
  }

  const proposal = structural.data;

  // Stage 2 — reference and data-dependency integrity. Runs only on a
  // structurally-valid proposal (its documented precondition).
  const referenceIssues = validateProposalReferences(proposal);
  if (referenceIssues.length > 0) {
    return { success: false, issues: referenceIssues };
  }

  // Stage 3 — pure mapping. Cannot fail.
  const definition = mapProposalToDefinition(proposal);

  // Stage 4 — existing graph-semantic authority.
  const graphIssues = collectWorkflowDefinitionIssues(definition);
  if (graphIssues.length > 0) {
    return { success: false, issues: toProposalIssues(graphIssues) };
  }

  return { success: true, proposal, definition };
}
