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

  const omitted = error.issues.length - issues.length;

  const summary =
    issues.length === 0
      ? `${toolName} received arguments that do not match its schema.`
      : `${toolName} received invalid arguments: ` +
        issues
          .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
          .join("; ") +
        (omitted > 0
          ? `; and ${omitted} more problem${omitted === 1 ? "" : "s"} not listed.`
          : ".");

  return {
    ok: false,
    code: "INVALID_INPUT",
    error: summary,
    issues,
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
