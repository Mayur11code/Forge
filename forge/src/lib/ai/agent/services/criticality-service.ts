// src/lib/ai/agent/services/criticality-service.ts
//
// ASSIGNMENT 37.7 — HUMAN CRITICALITY DECISION SERVICE.
//
// The human side of the criticality contract. A `generateWorkflow` execution
// that succeeded leaves a persisted proposal in the transcript; this service is
// the only thing that lets a human decide, per step, whether that step is
// critical. It never asks the model and never accepts criticality from the
// request: the decision set is validated against the proposal the backend
// already holds, and only booleans the human actually supplied are recorded.
//
// Scope, deliberately narrow (see the 37.7 decision record):
//   - 37.7 RECORDS the decision, in-session, schema-free. It does NOT persist a
//     new column, does NOT fire a trigger, and does NOT halt or re-drive the
//     worker. Durable, restart-surviving storage is 37.8; applying the decision
//     at materialization is 37.11.
//   - There is intentionally NO outbox event here. Adding an
//     AGENT_LOOP_REQUESTED would re-enter the model, which is exactly what the
//     deferred-trigger decision rules out.
//
// Identity, and why `interactionId` is the only handle:
//   - `interactionId` is the durable `AgentToolExecution.id`. It pins a decision
//     to one specific proposal, so a decision for a proposal that has since been
//     superseded is rejected instead of silently landing on a newer one.
//   - A proposal-revision fingerprint is recomputed here from the recovered
//     proposal and recorded alongside the decision. It is a label and an
//     integrity check, never an input: a client-supplied fingerprint is not part
//     of the request contract and is never trusted.
//
// The proposal is recovered from the PERSISTED, successful tool result - the
// same artifact the model saw - and re-validated server-side. `execution.input`
// is not re-parsed, because it may be wrapped (Form A/B) and because the result
// is the authoritative record of what actually compiled.

import { AgentToolExecutionStatus } from "@prisma/client";

import { db } from "@/lib/prisma/db";
import {
  WorkflowProposalSchema,
  type WorkflowProposal,
} from "@/lib/workflow-types/workflow-proposal";
import {
  validateCriticalityDecisions,
  type ApprovedCriticality,
} from "@/lib/workflow-types/workflow-criticality";

import { withAgentSessionLock } from "../locks";
import { getAgentSessionForUser } from "../session-service";
import { computeProposalCorrelationId } from "../tools/generate-workflow/execute";
import { createMessage, getMessages } from "./message-service";
import { getToolExecutionsForSession } from "./tool-execution-service";
import { recordCriticalityDecision } from "./proposal-service";

export type CriticalityDecisionRequest = {
  sessionId: string;
  userId: string;
  /** The durable `AgentToolExecution.id` of the proposal being decided. */
  interactionId: string;
  /** One boolean per proposal step, keyed by proposal-local ref. */
  decisions: Record<string, unknown>;
};

export type CriticalityDecisionResult =
  | {
      ok: true;
      sessionId: string;
      step: number;
      /** True when an identical decision was already recorded. */
      idempotent?: boolean;
    }
  | {
      ok: false;
      httpStatus: 400 | 404 | 409;
      code: string;
      error: string;
    };

/**
 * Versioned marker that makes a recorded decision self-describing.
 *
 * It is the first line of the stored content, and it is deliberately DIFFERENT
 * from the clarification-answer marker (`Clarification response for interaction
 * ...`). Both kinds of record share the `AgentMessage.toolCallId` tag, so the
 * two can be told apart only by their own content; a shared marker would let a
 * decision be read back as an answer, or vice versa.
 */
export const CRITICALITY_DECISION_MARKER = "forge:criticality-decision:v1";

/** The subset of an `AgentMessage` row this module reads. */
type AgentMessageRow = {
  step: number;
  toolCallId: string | null;
  message: unknown;
  createdAt: Date;
};

/** The subset of an `AgentToolExecution` row this module reads. */
type AgentExecutionRow = {
  id: string;
  toolCallId: string;
  toolName: string;
  status: string;
  createdAt: Date;
};

/**
 * Extract the string content of a user turn, or null for anything else.
 *
 * A clarification answer and a criticality decision are both user turns tagged
 * by interaction id; this only reads the text so the two can then be
 * distinguished by marker.
 */
function readUserStringContent(message: unknown): string | null {
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
 * True when a transcript string is a recorded criticality decision.
 *
 * Deliberately a marker check and not a parse: the marker is what separates a
 * decision from a clarification answer that happens to be tagged the same way.
 */
export function isCriticalityDecisionContent(content: unknown): content is string {
  return (
    typeof content === "string" &&
    content.startsWith(CRITICALITY_DECISION_MARKER)
  );
}

/**
 * Canonical, deterministic record content.
 *
 * Sorted by ref so two logically identical decisions produce byte-identical
 * content, which is what makes duplicate detection by string comparison
 * trustworthy rather than insertion-order-sensitive. The fingerprint binds the
 * record to the proposal revision the decision was made against.
 */
function buildDecisionContent(
  interactionId: string,
  proposalFingerprint: string,
  decisions: Readonly<Record<string, boolean>>,
): string {
  const lines = Object.keys(decisions)
    .sort()
    .map((ref) => `- ${ref}: ${decisions[ref] ? "critical" : "not-critical"}`);

  return [
    CRITICALITY_DECISION_MARKER,
    `interaction: ${interactionId}`,
    `proposal: ${proposalFingerprint}`,
    "steps:",
    ...lines,
  ].join("\n");
}

/** Read the recorded `proposal: <fingerprint>` line, or null when absent. */
function readRecordedFingerprint(content: string): string | null {
  for (const line of content.split("\n")) {
    if (line.startsWith("proposal: ")) {
      return line.slice("proposal: ".length);
    }
  }

  return null;
}

/** Read the recorded `- <ref>: critical|not-critical` lines, or null if malformed. */
function readRecordedDecisions(content: string): Record<string, boolean> | null {
  const lines = content.split("\n");
  const headerIndex = lines.indexOf("steps:");

  if (headerIndex === -1) {
    return null;
  }

  const decisions: Record<string, boolean> = {};

  for (const line of lines.slice(headerIndex + 1)) {
    const match = /^- (\S+): (critical|not-critical)$/.exec(line);

    if (!match) {
      return null;
    }

    decisions[match[1]] = match[2] === "critical";
  }

  return decisions;
}

export type CriticalityRecordReadResult =
  | { ok: true; approved: ApprovedCriticality }
  | {
      ok: false;
      code: "NOT_A_DECISION_RECORD" | "REVISION_MISMATCH";
      error: string;
    };

/**
 * Reconstruct an approved decision set from a stored criticality record, but
 * only for the exact proposal revision it was recorded against.
 *
 * This is the inverse of `buildDecisionContent`. It is deliberately strict: the
 * RECORDED fingerprint - written by this service, never supplied by a client -
 * must equal the fingerprint recomputed from the proposal in hand, using the
 * one canonical algorithm. A record made for revision A therefore cannot be
 * read as an approval for revision B, even when B shares A's step references.
 * The decisions are then re-validated so the returned set is genuinely
 * well-formed for this proposal.
 */
export function readCriticalityDecisionRecord(
  content: unknown,
  proposal: WorkflowProposal,
): CriticalityRecordReadResult {
  if (!isCriticalityDecisionContent(content)) {
    return {
      ok: false,
      code: "NOT_A_DECISION_RECORD",
      error: "The stored content is not a criticality decision record.",
    };
  }

  const recordedFingerprint = readRecordedFingerprint(content);
  const decisions = readRecordedDecisions(content);

  if (recordedFingerprint === null || decisions === null) {
    return {
      ok: false,
      code: "NOT_A_DECISION_RECORD",
      error: "The criticality decision record is malformed.",
    };
  }

  if (recordedFingerprint !== computeProposalCorrelationId(proposal)) {
    return {
      ok: false,
      code: "REVISION_MISMATCH",
      error:
        "The criticality decision was recorded against a different proposal revision.",
    };
  }

  const validation = validateCriticalityDecisions(proposal, decisions);

  if (!validation.success) {
    return {
      ok: false,
      code: "NOT_A_DECISION_RECORD",
      error: "The criticality decision record does not match the proposal.",
    };
  }

  return { ok: true, approved: validation.approved };
}

/**
 * Recover the proposal a successful tool-result carries, if it carries one.
 *
 * A result is a proposal only when its value says `ok: true` AND the proposal
 * parses against the structural schema. That is the same predicate the worker
 * uses to decide a result is a success, and it is stricter than
 * `status === COMPLETED`: a validation failure and a clarification are also
 * COMPLETED, and neither is a decision subject.
 */
function proposalFromToolResult(message: unknown): WorkflowProposal | null {
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

    if (typeof value !== "object" || value === null) {
      continue;
    }

    const result = value as { ok?: unknown; proposal?: unknown };

    if (result.ok !== true) {
      return null;
    }

    const parsed = WorkflowProposalSchema.safeParse(result.proposal);

    return parsed.success ? parsed.data : null;
  }

  return null;
}

/**
 * The proposal for one execution, found by its persisted result message.
 *
 * Bound by the execution's `toolCallId`, which is `@unique` on
 * `AgentToolExecution` and copied verbatim onto the result message by the
 * worker - so this is an exact join, not a heuristic.
 */
function findProposalForExecution(
  execution: AgentExecutionRow,
  messages: readonly AgentMessageRow[],
): WorkflowProposal | null {
  for (const row of messages) {
    if (row.toolCallId !== execution.toolCallId) {
      continue;
    }

    const proposal = proposalFromToolResult(row.message);

    if (proposal) {
      return proposal;
    }
  }

  return null;
}

/** Total order on executions: by `createdAt`, then by id to break ties. */
function isLater(candidate: AgentExecutionRow, than: AgentExecutionRow): boolean {
  const candidateTime = candidate.createdAt.getTime();
  const thanTime = than.createdAt.getTime();

  if (candidateTime !== thanTime) {
    return candidateTime > thanTime;
  }

  return candidate.id > than.id;
}

/**
 * Record a human criticality decision for a proposal.
 *
 * Order of checks, and why:
 *   1. Cheap shape checks first - no lock for a malformed request.
 *   2. Ownership (404) and liveness (409) - cheap, and a 4xx should not take a
 *      lock. Ownership uses the session's persisted `userId`; knowing a
 *      sessionId is not authorization.
 *   3. Under the session lock: resolve the interaction, recover the proposal,
 *      validate the decision set, then check idempotency/conflict, then
 *      supersession, then write.
 *
 * A 404 covers both "no such session for this caller" and "no such interaction
 * in this session", indistinguishably, so owning session A never reveals
 * whether an interaction id exists under session B.
 *
 * The decision is validated BEFORE the duplicate check, so a malformed request
 * is reported as malformed even if some earlier, different decision exists;
 * then an identical repeat is a no-op success and a changed repeat is a
 * conflict, because a human cannot silently change a decision the backend has
 * already recorded.
 */
export async function submitCriticalityDecision({
  sessionId,
  userId,
  interactionId,
  decisions,
}: CriticalityDecisionRequest): Promise<CriticalityDecisionResult> {
  if (typeof interactionId !== "string" || interactionId.trim() === "") {
    return {
      ok: false,
      httpStatus: 400,
      code: "INVALID_REQUEST",
      error: "A non-empty interactionId is required.",
    };
  }

  if (
    decisions === null ||
    typeof decisions !== "object" ||
    Array.isArray(decisions)
  ) {
    return {
      ok: false,
      httpStatus: 400,
      code: "INVALID_REQUEST",
      error: "Criticality decisions must be an object of booleans.",
    };
  }

  const session = await getAgentSessionForUser({ sessionId, userId });

  if (!session) {
    return {
      ok: false,
      httpStatus: 404,
      code: "INTERACTION_NOT_FOUND",
      error: "Not found.",
    };
  }

  if (session.status !== "RUNNING") {
    return {
      ok: false,
      httpStatus: 409,
      code: "SESSION_NOT_RUNNING",
      error: "This session is not running and cannot accept a decision.",
    };
  }

  const outcome = await withAgentSessionLock(sessionId, async () => {
    const messages = (await getMessages(sessionId)) as AgentMessageRow[];
    const executions = (await getToolExecutionsForSession(
      sessionId,
    )) as AgentExecutionRow[];

    const target = executions.find(
      (execution) => execution.id === interactionId,
    );

    if (!target) {
      return {
        ok: false as const,
        httpStatus: 404 as const,
        code: "INTERACTION_NOT_FOUND",
        error: "Not found.",
      };
    }

    if (
      target.toolName !== "generateWorkflow" ||
      target.status !== AgentToolExecutionStatus.COMPLETED
    ) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "NOT_A_PROPOSAL",
        error: "This interaction did not produce a workflow proposal.",
      };
    }

    const proposal = findProposalForExecution(target, messages);

    if (!proposal) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "NOT_A_PROPOSAL",
        error: "This interaction did not produce a workflow proposal.",
      };
    }

    const validation = validateCriticalityDecisions(proposal, decisions);

    if (!validation.success) {
      const first = validation.issues[0];
      return {
        ok: false as const,
        httpStatus: 400 as const,
        code: first.code,
        error: first.message,
      };
    }

    const fingerprint = computeProposalCorrelationId(proposal);
    const content = buildDecisionContent(
      interactionId,
      fingerprint,
      validation.approved.decisions,
    );

    const priorDecision = messages.find(
      (row) =>
        row.toolCallId === interactionId &&
        isCriticalityDecisionContent(readUserStringContent(row.message)),
    );

    if (priorDecision) {
      if (readUserStringContent(priorDecision.message) === content) {
        return {
          ok: true as const,
          sessionId,
          step: session.currentStep,
          idempotent: true,
        };
      }

      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "CRITICALITY_CONFLICT",
        error:
          "This proposal already has a different criticality decision recorded.",
      };
    }

    // Supersession: a LATER successful proposal in the same session makes this
    // interaction stale, because a decision about it would no longer describe
    // what the user is looking at. Only a genuinely successful proposal
    // supersedes: an invalid result, a clarification, or an unrelated execution
    // does not, because none of them present a newer thing to decide about.
    const superseded = executions.some(
      (candidate) =>
        candidate.id !== target.id &&
        candidate.toolName === "generateWorkflow" &&
        candidate.status === AgentToolExecutionStatus.COMPLETED &&
        isLater(candidate, target) &&
        findProposalForExecution(candidate, messages) !== null,
    );

    if (superseded) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "STALE_CRITICALITY",
        error: "A newer proposal superseded this one; decide on the newest.",
      };
    }

    // Assignment 37.8: the durable decision on the proposal row and the
    // transcript record commit together. The proposal advances to
    // AWAITING_APPROVAL (still parked: approval is 37.9). No companion outbox
    // event: recording a decision does not re-enter the model (deferred trigger).
    //
    // The compare-and-set runs FIRST, and its result is honoured. Writing the
    // transcript first (the pre-fix order) let a lost CAS leave a user turn that
    // claims a decision the proposal row never took - a transcript and a
    // lifecycle state that disagree. Ordering the CAS first means a lost race
    // commits no transcript record at all.
    const applied = await db.$transaction(async (tx) => {
      const recorded = await recordCriticalityDecision(tx, {
        executionId: interactionId,
        sessionId,
        decisions: validation.approved.decisions,
      });

      if (!recorded) {
        return false;
      }

      await createMessage({
        sessionId,
        step: session.currentStep,
        toolCallId: interactionId,
        message: { role: "user", content },
        tx,
      });

      return true;
    });

    if (!applied) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "CRITICALITY_NOT_APPLIED",
        error:
          "The proposal is no longer awaiting a criticality decision; " +
          "reload the session and decide on the current proposal.",
      };
    }

    return { ok: true as const, sessionId, step: session.currentStep };
  });

  if (outcome === null) {
    return {
      ok: false,
      httpStatus: 409,
      code: "SESSION_BUSY",
      error: "This session is busy; retry the decision shortly.",
    };
  }

  return outcome;
}
