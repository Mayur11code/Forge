import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ToolResultPart } from "ai";

import type { JsonValue } from "@/lib/workflow-types/type";
import {
  compileWorkflowProposal,
  mapProposalToDefinition,
  toProposalIssues,
} from "@/lib/workflow-types/workflow-proposal-compiler";
import {
  WorkflowProposalSchema,
  type WorkflowProposal,
} from "@/lib/workflow-types/workflow-proposal";
import { validateProposalReferences } from "@/lib/workflow-types/workflow-proposal-references";
import { collectWorkflowDefinitionIssues } from "@/lib/workflow-types/workflow";

import {
  buildStructuredValidationFailure,
  type MissingUserInputField,
  type ToolValidationIssue,
} from "../shared-output";
import {
  ClarificationRequestItemSchema,
  type ClarificationRequestItem,
} from "./schema";
import type {
  GeneratedProposal,
  GeneratedProposalStep,
  GenerateWorkflowOutput,
} from "./types";

type ToolOutput = ToolResultPart["output"];

/**
 * Canonical JSON with sorted object keys, so the fingerprint depends on the
 * proposal's CONTENT and not on the key insertion order a provider or transport
 * happened to produce. Two byte-different-but-equal payloads must correlate to
 * the same revision, otherwise a resubmitted answer would be rejected as stale.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Compute a deterministic correlation ID binding a clarification request
 * to the exact proposal revision.
 *
 * This is a fingerprint, not proof: two revisions that differ only in a field
 * that does not affect the missing inputs can share it. The authoritative
 * handle is the worker-stamped `interactionId`; this value is a secondary check
 * and a human-recognisable revision label.
 */
export function computeProposalCorrelationId(proposal: unknown): string {
  try {
    const hash = createHash("sha256")
      .update(stableStringify(proposal))
      .digest("hex")
      .slice(0, 16);
    return `prop_corr_${hash}`;
  } catch {
    return `prop_corr_${Date.now()}`;
  }
}

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
 * Safely project an uncompiled or partially-valid proposal object for
 * inclusion in a clarification response.
 */
function safeToGeneratedProposal(
  proposal: unknown,
): GeneratedProposal | undefined {
  if (
    typeof proposal !== "object" ||
    proposal === null ||
    !("name" in proposal) ||
    !("steps" in proposal)
  ) {
    return undefined;
  }

  const p = proposal as {
    name: string;
    description?: string;
    steps: Record<
      string,
      {
        action: string;
        inputs?: Record<string, unknown>;
        dependsOn?: string[];
      }
    >;
  };

  const steps: Record<string, GeneratedProposalStep> = {};
  for (const [localRef, step] of Object.entries(p.steps)) {
    steps[localRef] = {
      action: step.action,
      inputs: toJsonObject(step.inputs ?? {}),
      dependsOn: Array.isArray(step.dependsOn) ? [...step.dependsOn] : [],
    };
  }

  return {
    name: p.name,
    ...(p.description !== undefined ? { description: p.description } : {}),
    steps,
  };
}

/**
 * Dissect input into proposal payload and optional clarification requests.
 */
function extractProposalAndClarifications(input: unknown): {
  proposalInput: unknown;
  clarifications?: ClarificationRequestItem[];
} {
  if (typeof input !== "object" || input === null) {
    return { proposalInput: input };
  }

  const obj = input as Record<string, unknown>;

  // Form A: { proposal: { ... }, clarifications: [ ... ] }
  if ("proposal" in obj && "clarifications" in obj) {
    return {
      proposalInput: obj.proposal,
      clarifications: Array.isArray(obj.clarifications)
        ? (obj.clarifications as ClarificationRequestItem[])
        : undefined,
    };
  }

  // Form B: { name, description?, steps, clarifications: [ ... ] }
  if ("clarifications" in obj) {
    const { clarifications, ...proposalOnly } = obj;
    return {
      proposalInput: proposalOnly,
      clarifications: Array.isArray(clarifications)
        ? (clarifications as ClarificationRequestItem[])
        : undefined,
    };
  }

  // Standard proposal without clarifications
  return { proposalInput: input };
}

/**
 * Executor for the generateWorkflow agent tool.
 *
 * Responsibilities:
 *  1. Reject a null payload.
 *  2. Dissect input to determine if the caller requested clarification for missing user input.
 *  3. In standard proposal mode:
 *     Delegate to `compileWorkflowProposal`. If compilation fails, return `INVALID_INPUT`
 *     so the model self-corrects in the existing bounded agent loop (even for missing inputs).
 *  4. In clarification mode:
 *     - Validate that any model errors (unknown action, cycle, malformed input, invalid reference)
 *       short-circuit to `INVALID_INPUT` for model correction.
 *     - Validate that every requested clarification field corresponds to a genuinely missing
 *       required input in the proposal (preventing false clarification claims).
 *     - If valid, return structured `NEEDS_USER_INPUT` with field questions and correlation ID.
 *
 * READ_ONLY by policy: reads and writes nothing in the workflow domain.
 */
export async function executeGenerateWorkflow(
  input: Prisma.JsonValue,
): Promise<ToolOutput> {
  if (input === null) {
    throw new Error("Tool input cannot be null.");
  }

  const { proposalInput, clarifications } =
    extractProposalAndClarifications(input);

  const result = compileWorkflowProposal(proposalInput);

  // Path 1: Standard proposal without clarification requests.
  if (!clarifications || clarifications.length === 0) {
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

  // Path 2: Proposal with clarification requests.
  // Validate clarification items schema
  const validationIssues: ToolValidationIssue[] = [];
  const validRequests: ClarificationRequestItem[] = [];

  for (let i = 0; i < clarifications.length; i++) {
    const parsed = ClarificationRequestItemSchema.safeParse(clarifications[i]);
    if (!parsed.success) {
      for (const err of parsed.error.issues) {
        validationIssues.push({
          path: `clarifications.${i}.${err.path.join(".")}`,
          code: "INVALID_INPUT",
          message: err.message,
        });
      }
    } else {
      validRequests.push(parsed.data);
    }
  }

  if (validationIssues.length > 0) {
    const value: GenerateWorkflowOutput = buildStructuredValidationFailure(
      validationIssues,
      "generateWorkflow",
    );
    return { type: "json", value };
  }

  // If the proposal is already valid with no issues, no clarification is needed
  if (result.success) {
    const value: GenerateWorkflowOutput = buildStructuredValidationFailure(
      [
        {
          path: "clarifications",
          code: "INVALID_INPUT",
          message:
            "Clarification requested for a workflow proposal that is already valid and complete with no missing required inputs.",
        },
      ],
      "generateWorkflow",
    );
    return { type: "json", value };
  }

  // The set of input-field paths a clarification request asks the user to fill.
  const requestedPaths = new Set(validRequests.map((r) => r.field));

  /**
   * A placeholder reference is an `UNKNOWN_REFERENCE_SOURCE` issue on an
   * input-field path that a clarification request also names. A model that is
   * asking the user for a value often writes a `{{placeholder}}` (or a
   * `{{notAStep}}`) into that same field, which the compiler reports as an
   * unknown reference source rather than a missing input. Sending that back as
   * `INVALID_INPUT` would discard the clarification and trap the model in a
   * bounded self-correction loop it cannot exit: no amount of retrying invents
   * the value the human is being asked for. It is therefore resolved by the
   * answer, not by the model.
   *
   * Deliberately narrow: ONLY `UNKNOWN_REFERENCE_SOURCE` on a clarified path is
   * demoted. A malformed reference syntax (MALFORMED_REFERENCE), a self
   * reference, an unknown output, a missing data dependency, an unknown action,
   * a dangling dependency or a cycle is a genuine model error and still forces
   * `INVALID_INPUT` so the existing bounded loop can correct it.
   */
  const placeholderPaths = new Set(
    result.issues
      .filter((issue) => issue.code === "UNKNOWN_REFERENCE_SOURCE")
      .map((issue) => issue.path)
      .filter((path) => requestedPaths.has(path)),
  );

  // Check if there are any compiler issues that are NOT MISSING_REQUIRED_INPUT.
  // Model-correctable errors (UNKNOWN_ACTION, UNKNOWN_DEPENDENCY, CYCLE,
  // MALFORMED_REFERENCE, etc.) must be corrected by the model in the bounded
  // loop, NOT sent to the human as questions. A placeholder reference the
  // clarification already covers is the one exception: it is the human's to
  // supply, so it does not force a model correction.
  const modelErrors = result.issues.filter(
    (issue) =>
      issue.code !== "MISSING_REQUIRED_INPUT" &&
      !(issue.code === "UNKNOWN_REFERENCE_SOURCE" && requestedPaths.has(issue.path)),
  );
  if (modelErrors.length > 0) {
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

  // Every remaining issue is either a missing required input or a placeholder
  // reference the human will resolve. Verify that every clarification request
  // corresponds to one of them: a field that is neither missing nor an
  // unresolved placeholder reference cannot be justified as a user question.
  const missingPaths = new Set(result.issues.map((i) => i.path));
  const resolvablePaths = new Set([...missingPaths, ...placeholderPaths]);

  const clarificationErrors: ToolValidationIssue[] = [];

  for (const req of validRequests) {
    if (!resolvablePaths.has(req.field)) {
      clarificationErrors.push({
        path: req.field,
        code: "INVALID_INPUT",
        message: `Field "${req.field}" is not a missing required input in the workflow proposal.`,
      });
    }
  }

  // Also check if any required inputs were omitted without being covered by
  // clarification requests. A placeholder reference the clarification already
  // covers is resolved by the answer, so it is not an uncovered omission.
  for (const issue of result.issues) {
    if (!requestedPaths.has(issue.path)) {
      clarificationErrors.push({
        path: issue.path,
        code: "MISSING_REQUIRED_INPUT",
        message: issue.message,
      });
    }
  }

  if (clarificationErrors.length > 0) {
    const value: GenerateWorkflowOutput = buildStructuredValidationFailure(
      clarificationErrors,
      "generateWorkflow",
    );
    return { type: "json", value };
  }

  // Ensure downstream graph and reference semantics have no model-correctable
  // errors (cycles, dangling dependencies, invalid {{...}} paths) before asking
  // the human. A placeholder reference on a clarified input is the human's value
  // to supply, so it is excluded: the answer replaces it with real data, and
  // re-reporting it here would defeat the clarification.
  const parsedProposal = WorkflowProposalSchema.safeParse(proposalInput);
  if (parsedProposal.success) {
    const proposal = parsedProposal.data;
    const refIssues = validateProposalReferences(proposal).filter(
      (issue) => !placeholderPaths.has(issue.path),
    );
    if (refIssues.length > 0) {
      const issues: ToolValidationIssue[] = refIssues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      }));
      return {
        type: "json",
        value: buildStructuredValidationFailure(issues, "generateWorkflow"),
      };
    }

    const definition = mapProposalToDefinition(proposal);
    const graphIssues = collectWorkflowDefinitionIssues(definition);
    if (graphIssues.length > 0) {
      const issues: ToolValidationIssue[] = toProposalIssues(graphIssues).map(
        (issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        }),
      );
      return {
        type: "json",
        value: buildStructuredValidationFailure(issues, "generateWorkflow"),
      };
    }
  }

  // All missing inputs are verified as genuine user omissions with valid clarification requests.
  const correlationId = computeProposalCorrelationId(proposalInput);

  const fields: MissingUserInputField[] = validRequests.map((req) => {
    const fieldEntry: MissingUserInputField = {
      field: req.field,
      reason: req.reason,
      question: req.question,
    };
    if (req.candidateValues && req.candidateValues.length > 0) {
      fieldEntry.candidateValues = toJsonValue(
        req.candidateValues,
      ) as JsonValue[];
    }
    return fieldEntry;
  });

  const value: GenerateWorkflowOutput = {
    ok: false,
    status: "NEEDS_USER_INPUT",
    code: "NEEDS_USER_INPUT",
    error: `Clarification required: missing user information for ${fields.map((f) => f.field).join(", ")}.`,
    fields,
    correlationId,
    proposal: safeToGeneratedProposal(proposalInput),
  };

  return { type: "json", value };
}
