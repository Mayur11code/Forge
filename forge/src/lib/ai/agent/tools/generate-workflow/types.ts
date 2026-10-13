import type { JsonValue } from "@/lib/workflow-types/type";

import type { ToolValidationIssue } from "../shared-output";

/**
 * A proposal as it crosses the tool boundary.
 *
 * Structurally identical to the Assignment 37.2 `WorkflowProposal`, with one
 * transport difference: `inputs` is bounded to `JsonValue` because a tool result
 * is serialized as JSON. A successful compilation has already proven the whole
 * proposal is JSON-serialisable, so this loses nothing; it only makes the
 * serialisable bound explicit to the type system.
 */
export type GeneratedProposalStep = {
  action: string;
  inputs: Record<string, JsonValue>;
  dependsOn: string[];
};

export type GeneratedProposal = {
  name: string;
  description?: string;
  steps: Record<string, GeneratedProposalStep>;
};

/**
 * Successful outcome: the validated proposal, unchanged in content.
 *
 * The compiler also produces a candidate `WorkflowDefinition`, but that is
 * backend-owned (identity is assigned at materialization) and is deliberately
 * not returned: a model must not mistake a candidate for a persisted workflow,
 * and it has no use for the mapped shape.
 */
export type GenerateWorkflowSuccess = {
  ok: true;
  proposal: GeneratedProposal;
};

/**
 * Rejected outcome, in the same envelope every other tool uses so one prompt
 * rule covers recovery regardless of which tool produced it.
 *
 * `issues` are the compiler's `ProposalIssue`s mapped one-for-one onto
 * `ToolValidationIssue` (`code`, `path`, `message` preserved).
 */
export type GenerateWorkflowFailure = {
  ok: false;
  code: "INVALID_INPUT";
  error: string;
  issues: ToolValidationIssue[];
};

export type GenerateWorkflowOutput =
  | GenerateWorkflowSuccess
  | GenerateWorkflowFailure;
