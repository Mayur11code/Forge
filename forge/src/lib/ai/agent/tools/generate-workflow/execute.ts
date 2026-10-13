import type { Prisma } from "@prisma/client";
import type { ToolResultPart } from "ai";

import type { JsonValue } from "@/lib/workflow-types/type";
import { compileWorkflowProposal } from "@/lib/workflow-types/workflow-proposal-compiler";
import type { WorkflowProposal } from "@/lib/workflow-types/workflow-proposal";

import {
  buildStructuredValidationFailure,
  type ToolValidationIssue,
} from "../shared-output";
import type {
  GeneratedProposal,
  GeneratedProposalStep,
  GenerateWorkflowOutput,
} from "./types";

type ToolOutput = ToolResultPart["output"];

/**
 * Bound an arbitrary value to the JSON the tool result will be serialized as.
 *
 * A proposal that compiled successfully is already known to be serialisable
 * (`validateWorkflowProposal` rejects a non-serialisable payload before this
 * point), so this never drops data. It exists only so the output type is honest
 * about the JSON boundary; it is deliberately total, mapping the impossible
 * non-JSON remainder to `null` rather than throwing.
 */
function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    return toJsonObject(value as Record<string, unknown>);
  }

  return null;
}

function toJsonObject(
  value: Record<string, unknown>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toJsonValue(entry);
  }
  return result;
}

/**
 * Project a compiled proposal onto the shape returned to the model.
 *
 * Content-preserving: name, description, step keys, actions, inputs and
 * dependencies all survive. This is transport, not validation - it adds no rules
 * and repairs nothing.
 */
function toGeneratedProposal(proposal: WorkflowProposal): GeneratedProposal {
  const steps: Record<string, GeneratedProposalStep> = {};

  for (const [localRef, step] of Object.entries(proposal.steps)) {
    steps[localRef] = {
      action: step.action,
      inputs: toJsonObject(step.inputs),
      dependsOn: [...step.dependsOn],
    };
  }

  return {
    name: proposal.name,
    ...(proposal.description !== undefined
      ? { description: proposal.description }
      : {}),
    steps,
  };
}

/**
 * Executor for the generateWorkflow agent tool.
 *
 * Responsibilities:
 *  1. Reject a null payload. The model-facing schema is an object schema, so a
 *     null can only come from a caller bug, not from the model; that is treated
 *     as an unexpected error rather than as model input.
 *  2. Delegate the entire validation boundary to `compileWorkflowProposal`. It is
 *     the single authority for structure, action membership, reference integrity
 *     and graph semantics. This executor adds no rules and repairs nothing.
 *  3. Return the validated proposal, or the compiler's issues in the shared
 *     failure envelope.
 *
 * READ_ONLY by policy: it reads nothing and writes nothing. The candidate
 * `WorkflowDefinition` the compiler also produces is deliberately not returned:
 * no workflow is created, saved, scheduled or run here. Expected validation
 * failures are returned, never thrown; unexpected programming errors remain
 * unexpected.
 *
 * No `ToolExecutionContext` is taken because no trusted identity is needed or
 * used: a proposal carries no organization, user or database id, and compilation
 * never touches the database.
 */
export async function executeGenerateWorkflow(
  input: Prisma.JsonValue,
): Promise<ToolOutput> {
  if (input === null) {
    throw new Error("Tool input cannot be null.");
  }

  const result = compileWorkflowProposal(input);

  if (!result.success) {
    const issues: ToolValidationIssue[] = result.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    }));

    const value: GenerateWorkflowOutput = buildStructuredValidationFailure(
      issues,
      "generateWorkflow",
    );

    return { type: "json", value };
  }

  const value: GenerateWorkflowOutput = {
    ok: true,
    proposal: toGeneratedProposal(result.proposal),
  };

  return { type: "json", value };
}
