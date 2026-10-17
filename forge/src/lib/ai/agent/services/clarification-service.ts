// src/lib/ai/agent/services/clarification-service.ts
//
// Assignment 37.6 remediation: the human side of the missing-input protocol.
//
// The tool worker halts on a `NEEDS_USER_INPUT` result and records no
// continuation. This module is the only thing that can release that halt: it
// reads the pending request out of the durable transcript, validates the
// human's answer against the EXACT interaction that asked for it, and re-enters
// the ordinary bounded loop through an `AGENT_LOOP_REQUESTED` outbox intent.
//
// Two identity handles, and why both are needed:
//   - `correlationId` is a content fingerprint of the proposal revision. It
//     survives a process restart (it is in the persisted tool result) but it
//     cannot distinguish two interactions that asked about the same missing
//     field, because their revisions hash the same.
//   - `interactionId` is the durable `AgentToolExecution.id`, stamped onto the
//     request by the worker. It is the authoritative handle: it pins an answer
//     to one specific ask, so a stale answer for a superseded request is
//     rejected instead of silently satisfying a newer one.
//
// Durability is deliberately NOT claimed here. Answer correlation is
// schema-free (it rides on existing columns), which is enough to make the
// in-session lifecycle correct, but surviving a cold restart of the whole
// system is Assignment 37.8's persistence decision. See Requirement F / the
// durability gate in the phase record.

import { db } from "@/lib/prisma/db";
import { withAgentSessionLock } from "../locks";
import { getAgentSessionForUser } from "../session-service";
import { createMessage, getMessages } from "./message-service";
import { recordAgentEvent } from "../outbox";
import {
  readClarificationInteraction,
  type MissingUserInputField,
} from "../tools/shared-output";

/**
 * The pending question, as reconstructed from the durable transcript.
 *
 * Derived, never stored: it exists for exactly as long as a clarification
 * tool-result has no matching answer message.
 */
export type PendingClarification = {
  interactionId: string;
  correlationId: string | null;
  fields: MissingUserInputField[];
  toolName: string;
  step: number;
};

/**
 * The subset of an `AgentMessage` row this module reads.
 *
 * Kept structural rather than importing the Prisma type so the transcript scan
 * can be unit-tested with plain objects.
 */
export type AgentMessageRow = {
  step: number;
  toolCallId: string | null;
  message: unknown;
  createdAt: Date;
};

export type ClarificationAnswerInput = {
  sessionId: string;
  userId: string;
  /**
   * The backend interaction handle the answer is for. Required, not optional:
   * the correlation fingerprint alone cannot prove which ask is being answered.
   */
  interactionId: string;
  correlationId: string;
  answers: Record<string, unknown>;
};

export type ClarificationResumeResult =
  | {
      ok: true;
      sessionId: string;
      step: number;
      /** True when an identical submission was already accepted. */
      idempotent?: boolean;
    }
  | {
      ok: false;
      httpStatus: 400 | 403 | 404 | 409;
      code: string;
      error: string;
    };

/**
 * Read a clarification request out of one tool-result row.
 *
 * Returns null for anything that is not a clarification - validation failures,
 * successful results, non-tool rows - so the scan never mistakes a model
 * self-correction result for a question.
 */
function parseClarificationRow(
  row: AgentMessageRow,
): Omit<PendingClarification, "step"> | null {
  const message = row.message;

  if (typeof message !== "object" || message === null) {
    return null;
  }

  const content = (message as { content?: unknown }).content;

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }

    const partObject = part as Record<string, unknown>;

    if (partObject.type !== "tool-result") {
      continue;
    }

    const output = partObject.output;

    if (typeof output !== "object" || output === null) {
      continue;
    }

    const value = (output as { value?: unknown }).value;
    const clarification = readClarificationInteraction(value);

    if (!clarification) {
      continue;
    }

    return {
      interactionId: clarification.interactionId,
      correlationId: clarification.correlationId ?? null,
      fields: clarification.fields ?? [],
      toolName:
        typeof partObject.toolName === "string" ? partObject.toolName : "",
    };
  }

  return null;
}

/**
 * Read a persisted answer's deterministic content, if the row is one.
 *
 * Answers are tagged by writing the interaction id into the existing
 * `toolCallId` column, so no schema change is needed. A row is an answer when
 * it carries that tag AND its content is a plain user string.
 */
function readAnswerContent(row: AgentMessageRow): string | null {
  const message = row.message;

  if (typeof message !== "object" || message === null) {
    return null;
  }

  if ((message as { role?: unknown }).role !== "user") {
    return null;
  }

  const content = (message as { content?: unknown }).content;

  return typeof content === "string" ? content : null;
}

/**
 * Find the pending clarification in an ordered transcript, if any.
 *
 * "Pending" means: the most recent clarification request whose interaction id
 * has not been answered by a later answer message. Answers are matched by the
 * `interactionId` tag, so answering request A does not retire a newer request
 * B that asks about the same field.
 */
export function findPendingClarification(
  messages: readonly AgentMessageRow[],
): PendingClarification | null {
  const answered = new Set<string>();
  const requests: PendingClarification[] = [];

  for (const row of messages) {
    if (row.toolCallId) {
      const answer = readAnswerContent(row);

      if (answer !== null) {
        answered.add(row.toolCallId);
        continue;
      }
    }

    const parsed = parseClarificationRow(row);

    if (parsed) {
      requests.push({ ...parsed, step: row.step });
    }
  }

  for (let i = requests.length - 1; i >= 0; i -= 1) {
    if (!answered.has(requests[i].interactionId)) {
      return requests[i];
    }
  }

  return null;
}

export async function getPendingClarification(
  sessionId: string,
): Promise<PendingClarification | null> {
  const messages = await getMessages(sessionId);
  return findPendingClarification(messages);
}

/**
 * Cheap liveness probe for the recovery sweeps: is this session legitimately
 * parked waiting on a human? A session that is waiting must not be re-driven or
 * failed as though it were stalled.
 */
export async function hasPendingClarification(
  sessionId: string,
): Promise<boolean> {
  return (await getPendingClarification(sessionId)) !== null;
}

/**
 * Canonical JSON so two logically identical submissions produce byte-identical
 * answer content, which is what makes duplicate detection by string comparison
 * trustworthy rather than order-sensitive.
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

function buildAnswerContent(
  interactionId: string,
  correlationId: string,
  answers: Record<string, unknown>,
): string {
  const lines = Object.keys(answers)
    .sort()
    .map((field) => `- ${field}: ${stableStringify(answers[field])}`);

  return [
    `Clarification response for interaction ${interactionId}`,
    `correlation: ${correlationId}`,
    ...lines,
  ].join("\n");
}

/**
 * Validate and accept a human answer, then resume the bounded loop.
 *
 * The whole read-decide-write runs under the session lock, so an answer cannot
 * race a concurrently dispatched turn on the same session, and two answers for
 * the same interaction serialise instead of both writing.
 *
 * Ordering is deliberate: identity/liveness first (cheap, and a 4xx should not
 * take a lock), then pending-state checks under the lock, then the idempotency
 * check before any write. A repeat of an already-accepted answer is a no-op
 * that reports success; a repeat with different content is a conflict, because
 * the human cannot change an answer the model has not yet consumed.
 */
export async function submitClarificationAnswer({
  sessionId,
  userId,
  interactionId,
  correlationId,
  answers,
}: ClarificationAnswerInput): Promise<ClarificationResumeResult> {
  if (typeof correlationId !== "string" || correlationId.trim() === "") {
    return {
      ok: false,
      httpStatus: 400,
      code: "INVALID_CORRELATION_ID",
      error: "A non-empty correlationId is required.",
    };
  }

  if (typeof interactionId !== "string" || interactionId.trim() === "") {
    return {
      ok: false,
      httpStatus: 400,
      code: "INVALID_INTERACTION_ID",
      error: "A non-empty interactionId is required.",
    };
  }

  if (
    typeof answers !== "object" ||
    answers === null ||
    Array.isArray(answers) ||
    Object.keys(answers).length === 0
  ) {
    return {
      ok: false,
      httpStatus: 400,
      code: "EMPTY_ANSWERS",
      error: "At least one answer must be supplied.",
    };
  }

  for (const [field, value] of Object.entries(answers)) {
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return {
        ok: false,
        httpStatus: 400,
        code: "INVALID_ANSWER_VALUE",
        error: `Answer for field "${field}" must be a non-empty value.`,
      };
    }
  }

  const session = await getAgentSessionForUser({ sessionId, userId });

  if (!session) {
    return {
      ok: false,
      httpStatus: 404,
      code: "NOT_FOUND",
      error: "Session not found.",
    };
  }

  if (session.status !== "RUNNING") {
    return {
      ok: false,
      httpStatus: 409,
      code: "SESSION_NOT_RUNNING",
      error: `Session is ${session.status} and cannot accept an answer.`,
    };
  }

  const outcome = await withAgentSessionLock<ClarificationResumeResult>(
    sessionId,
    async () => {
      const content = buildAnswerContent(interactionId, correlationId, answers);

      const messages = await getMessages(sessionId);

      // Idempotency is checked BEFORE "is anything pending": an answer that was
      // already accepted retires its request, so a pending scan would not see it
      // and a retry would be misreported as "nothing to answer". A repeat must
      // be a no-op that reports success, and a changed repeat a conflict.
      const priorAnswer = messages.find(
        (row) =>
          row.toolCallId === interactionId && readAnswerContent(row) !== null,
      );

      if (priorAnswer) {
        if (readAnswerContent(priorAnswer) === content) {
          return {
            ok: true,
            sessionId,
            step: session.currentStep,
            idempotent: true,
          };
        }

        return {
          ok: false,
          httpStatus: 409,
          code: "CLARIFICATION_CONFLICT",
          error:
            "This clarification has already been answered with different content.",
        };
      }

      const pending = findPendingClarification(messages);

      if (!pending) {
        return {
          ok: false,
          httpStatus: 409,
          code: "NO_PENDING_CLARIFICATION",
          error: "This session is not waiting for clarification.",
        };
      }

      if (pending.interactionId !== interactionId) {
        return {
          ok: false,
          httpStatus: 409,
          code: "STALE_CLARIFICATION",
          error:
            "The supplied interactionId does not match the pending clarification.",
        };
      }

      if (
        pending.correlationId !== null &&
        pending.correlationId !== correlationId
      ) {
        return {
          ok: false,
          httpStatus: 409,
          code: "STALE_CLARIFICATION",
          error:
            "The supplied correlationId does not match the pending clarification.",
        };
      }

      const requested = new Set(pending.fields.map((field) => field.field));

      for (const field of Object.keys(answers)) {
        if (!requested.has(field)) {
          return {
            ok: false,
            httpStatus: 400,
            code: "INVALID_ANSWER_VALUE",
            error: `Field "${field}" was not part of the pending clarification.`,
          };
        }
      }

      for (const field of requested) {
        if (!(field in answers)) {
          return {
            ok: false,
            httpStatus: 400,
            code: "INVALID_ANSWER_VALUE",
            error: `An answer for field "${field}" is required.`,
          };
        }
      }

      // Message and continuation intent commit together: an answer that is
      // recorded without the intent to consume it would strand the session
      // exactly like the tool-result gap this outbox exists to close.
      await db.$transaction(async (tx) => {
        await createMessage({
          sessionId,
          step: session.currentStep,
          toolCallId: interactionId,
          message: { role: "user", content },
          tx,
        });

        await recordAgentEvent({
          tx,
          eventType: "AGENT_LOOP_REQUESTED",
          sessionId,
          // Per-interaction, so answering two different pending requests on the
          // same step cannot collapse onto one outbox row.
          aggregateId: `${sessionId}:${session.currentStep}:clarification:${interactionId}`,
          payload: {
            orgId: session.orgId,
            sessionId,
            expectedStep: session.currentStep,
          },
        });
      });

      return { ok: true, sessionId, step: session.currentStep };
    },
  );

  if (outcome === null) {
    return {
      ok: false,
      httpStatus: 409,
      code: "SESSION_BUSY",
      error: "This session is busy; retry the answer shortly.",
    };
  }

  return outcome;
}
