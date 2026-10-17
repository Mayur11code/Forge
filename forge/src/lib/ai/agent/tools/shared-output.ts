// src/lib/ai/agent/tools/shared-output.ts
//
// Two things live here, both about what a tool hands back to the model:
//
// 1. The compact task shape. The full `Task` row carries fields the model has no
//    business reasoning about and which change on unrelated edits (`updatedAt`,
//    ids it cannot use). Project arrives as a NAME, not an id: a CUID is not
//    something the model can usefully hold, and a name is what the user actually
//    said. Success and failure shapes are both described so the model can always
//    branch on `ok`.
//
// 2. `buildValidationFailure`, the single shape every tool uses to report a
//    schema rejection. It is shared on purpose - the self-healing loop is only
//    trustworthy if a model that gets an argument wrong is told the same way by
//    every tool, so that one prompt rule covers all of them.

import { z } from "zod";
import type { ZodError } from "zod";
import type { ToolResultPart } from "ai";

import type { JsonValue } from "@/lib/workflow-types/type";

/**
 * One machine-readable schema violation, as the model sees it.
 *
 * `path` is the field that failed, dotted for nesting. It is the field that
 * makes a validation failure recoverable: without it the model is told that
 * *something* is the wrong type and has to guess which of the optional fields it
 * invented. See `buildValidationFailure`.
 */
export type ToolValidationIssue = {
  path: string;
  code: string;
  message: string;
};

/**
 * Cap on reported issues.
 *
 * A model that sends a wholly wrong object can produce a large issue list, and
 * the point of reporting them is that the model corrects itself on the next
 * turn. A wall of forty violations is not more useful than the first few and
 * costs context in a transcript that is rebuilt on every turn. The count of
 * what was dropped is reported so truncation is never silent.
 */
const MAX_REPORTED_ISSUES = 8;

export type ValidationFailure = {
  ok: false;
  code: "INVALID_INPUT";
  error: string;
  issues: ToolValidationIssue[];
};

/**
 * Turn a Zod failure into the observation the model receives.
 *
 * Three properties this has to have, all of which the previous
 * `issues[0]?.message` did not:
 *
 * 1. **The failing field is named.** `path` is the difference between "expected
 *    number, received string" and "limit: expected number, received string".
 *    The first is unrecoverable; the model has to correlate it against every
 *    field it could have meant. The second is a one-line fix.
 * 2. **Every issue is reported, not just the first.** A model that omits three
 *    required fields was previously told about one of them, and burned a step
 *    per round trip rediscovering the rest.
 * 3. **No value is echoed back.** Only the schema's own issue `code`, `path`,
 *    and `message` are returned - never any part of the submitted input. Zod's
 *    `unrecognized_keys` message names the offending *keys* (which the model
 *    itself just wrote) and never their values, so an injected `orgId` or a
 *    hallucinated credential cannot be reflected back into the transcript.
 */
export function buildValidationFailure(
  error: ZodError,
  toolName: string,
): ValidationFailure {
  const issues: ToolValidationIssue[] = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));

  return failureFromIssues(issues, error.issues.length, toolName);
}

/**
 * Same observation, for tools whose validation does not happen at the tool
 * boundary.
 *
 * `generateWorkflow` delegates to the workflow proposal compiler rather than
 * re-validating at the edge, so its failures arrive as an already-structured
 * `{ code, path, message }[]` instead of a `ZodError`. Funnelling them through
 * the same builder keeps the recovery contract identical: whatever a model
 * learns from a `createTask` rejection it also learns from a proposal one.
 *
 * `issues` are copied so the caller's array cannot be mutated through the
 * returned value.
 */
export function buildStructuredValidationFailure(
  issues: readonly ToolValidationIssue[],
  toolName: string,
): ValidationFailure {
  const reported = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => ({ ...issue }));

  return failureFromIssues(reported, issues.length, toolName);
}

/**
 * Shared tail of the two builders: report `kept` issues, say how many were
 * dropped, and never skip the truncation notice.
 */
function failureFromIssues(
  kept: readonly ToolValidationIssue[],
  total: number,
  toolName: string,
): ValidationFailure {
  const omitted = total - kept.length;

  const summary =
    kept.length === 0
      ? `${toolName} received arguments that do not match its schema.`
      : `${toolName} received invalid arguments: ` +
        kept
          .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
          .join("; ") +
        (omitted > 0
          ? `; and ${omitted} more problem${omitted === 1 ? "" : "s"} not listed.`
          : ".");

  return {
    ok: false,
    code: "INVALID_INPUT",
    error: summary,
    issues: [...kept],
  };
}

/**
 * Assignment 37.6: Missing-user-input clarification protocol.
 *
 * Represents one required workflow action field that the user genuinely
 * never supplied and which the model cannot invent.
 */
export type MissingUserInputField = {
  field: string;
  reason: string;
  question: string;
  candidateValues?: JsonValue[];
};

/**
 * Top-level outcome indicating that the workflow generation process is halted
 * waiting for human clarification, distinguishable from ordinary `INVALID_INPUT`.
 */
export type ClarificationFailure = {
  ok: false;
  status: "NEEDS_USER_INPUT";
  code: "NEEDS_USER_INPUT";
  error: string;
  fields: MissingUserInputField[];
  correlationId?: string;
  /**
   * Assignment 37.6 remediation: the backend-owned correlation handle.
   *
   * `correlationId` is a content fingerprint of the proposal revision (it says
   * *what* was asked about); it cannot on its own prove *which* persisted
   * interaction is being answered, because a regenerated revision with the same
   * missing field hashes the same. `interactionId` is the durable
   * `AgentToolExecution.id`, attached at the worker boundary - the only place
   * that knows it - so an answer can be bound to the exact pending interaction.
   *
   * It is optional on the pure executor output (which never sees an execution
   * row) and always present on the persisted tool result.
   */
  interactionId?: string;
  proposal?: JsonValue;
};

/**
 * Narrow an arbitrary tool-result value to a clarification failure.
 *
 * Used by the worker (to decide whether to pause the loop) and by the
 * clarification service (to find a pending interaction in the transcript). A
 * plain structural check on `code`, deliberately not a Zod parse: the value
 * came from our own executor, and a stricter parse here would turn a benign
 * shape change into a silent "no clarification" rather than a visible one.
 */
export function isClarificationFailure(
  value: unknown,
): value is ClarificationFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { code?: unknown }).code === "NEEDS_USER_INPUT"
  );
}

/**
 * Attach the backend interaction id to a clarification tool result.
 *
 * The executor stays pure: it does not know its execution row, and it must not
 * (it is called in tests and in contexts with no execution). The worker owns
 * that identity, so the binding happens here, once, at the boundary: the
 * persisted result carries `interactionId` and the worker learns whether it
 * should pause the loop.
 */
export function withClarificationBinding(
  output: ToolResultPart["output"],
  interactionId: string,
): {
  output: ToolResultPart["output"];
  clarification: ClarificationFailure | null;
} {
  if (output.type !== "json" || !isClarificationFailure(output.value)) {
    return { output, clarification: null };
  }

  const bound: ClarificationFailure = {
    ...output.value,
    interactionId,
  };

  return {
    output: { type: "json", value: bound },
    clarification: bound,
  };
}

/**
 * Narrow an arbitrary value to a persisted clarification result and recover its
 * backend interaction id. Used by the transcript scan, which sees JSON that has
 * already crossed the wire.
 */
export function readClarificationInteraction(
  value: unknown,
): (ClarificationFailure & { interactionId: string }) | null {
  if (
    !isClarificationFailure(value) ||
    typeof value.interactionId !== "string" ||
    value.interactionId.length === 0
  ) {
    return null;
  }

  return value as ClarificationFailure & { interactionId: string };
}

/**
 * Build the structured `NEEDS_USER_INPUT` clarification outcome.
 *
 * Distinguishable from model self-correction (`INVALID_INPUT`) and human
 * confirmation (`PENDING_CONFIRMATION`) at the top level.
 */
export function buildClarificationFailure({
  fields,
  correlationId,
  proposal,
}: {
  fields: readonly MissingUserInputField[];
  correlationId?: string;
  proposal?: JsonValue;
}): ClarificationFailure {
  const count = fields.length;
  const noun = count === 1 ? "input" : "inputs";
  const fieldList = fields.map((f) => f.field).join(", ");
  const summary = `Clarification required: missing user ${noun} for ${fieldList}.`;

  return {
    ok: false,
    status: "NEEDS_USER_INPUT",
    code: "NEEDS_USER_INPUT",
    error: summary,
    fields: fields.map((f) => ({
      field: f.field,
      reason: f.reason,
      question: f.question,
      ...(f.candidateValues && f.candidateValues.length > 0
        ? { candidateValues: [...f.candidateValues] }
        : {}),
    })),
    ...(correlationId ? { correlationId } : {}),
    ...(proposal !== undefined ? { proposal } : {}),
  };
}

export const taskSummaryOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
  projectName: z.string(),
  assigneeId: z.string().nullable(),
});

export type TaskOutput =
  | { ok: true; tasks: z.infer<typeof taskSummaryOutputSchema>[] }
  | {
      ok: false;
      code: string;
      error: string;
      /**
       * Present only on INVALID_INPUT, from `buildValidationFailure`. Names the
       * field that failed so the model can correct that argument on its next
       * turn. Never contains any part of the submitted input.
       */
      issues?: ToolValidationIssue[];
      suggestions?: { id: string; name: string }[];
    };
