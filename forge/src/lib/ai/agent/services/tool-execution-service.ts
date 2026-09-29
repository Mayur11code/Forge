// src/lib/ai/agent/services/tool-execution-service.ts

import {
  AgentToolExecutionStatus,
  type Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma/extended";
// The RAW client, deliberately, for the transactional outbox paths below.
// The extended client only intercepts the `task` model to fire domain events;
// agent tables are not intercepted, and the outbox row is infrastructure rather
// than a domain event. Routing it through the interceptors would be wrong, and
// the extended transaction client is not assignable to the outbox's raw-client
// transaction type. Nothing is lost by using `db` for the tx bodies below.
import { db } from "@/lib/prisma/db";
import { JsonValue } from "../types";
import { getAgentApprovalTimeoutMs } from "../constants";
import { recordAgentEvent } from "../outbox";
import { createMessage } from "./message-service";

import type { ModelMessage } from "ai";

export interface CreateToolExecutionInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  /**
   * Derived from the trusted registry policy, never from model input.
   * When true the row is created as a PROPOSAL and is not dispatched.
   */
  requiresConfirmation: boolean;
  /**
   * Required when requiresConfirmation is false: the event that queues the
   * worker. Kept separate from the boolean so the caller cannot publish a tool
   * request it never asked to be created, or create one it forgets to publish.
   */
  dispatchEvent?: {
    orgId: string;
    expectedStep: number;
  };
}

/**
 * Creates the execution row and, when it is dispatchable, records the intent to
 * queue the worker inside the same transaction.
 *
 * These used to be two steps with a process-crash window between them, where the
 * database held a PENDING row that nothing would ever pick up. They are now one
 * transaction, so the row and its delivery intent either both exist or neither
 * does.
 *
 * A confirmation-required proposal is deliberately NOT given a dispatch event:
 * it must not reach the worker until a human decides, and the confirm path
 * records that event instead.
 */
export async function createToolExecution({
  sessionId,
  toolCallId,
  toolName,
  input,
  requiresConfirmation,
  dispatchEvent,
}: CreateToolExecutionInput) {
  if (!requiresConfirmation && !dispatchEvent) {
    throw new Error(
      "createToolExecution: a dispatchable execution requires dispatchEvent, otherwise it would be persisted with no intent to ever run it.",
    );
  }

  return db.$transaction(async (tx) => {
    const execution = await tx.agentToolExecution.create({
      data: {
        sessionId,
        toolCallId,
        toolName,
        // Persisted verbatim. This is the exact proposal: what the user approves
        // is what later executes, with no regeneration step in between.
        input,
        status: requiresConfirmation
          ? AgentToolExecutionStatus.PENDING_CONFIRMATION
          : AgentToolExecutionStatus.PENDING,
        // The approval deadline is fixed here, at proposal time, and persisted.
        // Deriving it from updatedAt instead would let any incidental write
        // slide the deadline forward and hang the session indefinitely.
        expiresAt: requiresConfirmation
          ? new Date(Date.now() + getAgentApprovalTimeoutMs())
          : null,
      },
    });

    if (dispatchEvent) {
      await recordAgentEvent({
        tx,
        eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
        sessionId,
        executionId: execution.id,
        aggregateId: execution.id,
        payload: {
          orgId: dispatchEvent.orgId,
          sessionId,
          executionId: execution.id,
          expectedStep: dispatchEvent.expectedStep,
        },
      });
    }

    return execution;
  });
}

export async function getToolExecutionForWorker(
  executionId: string,
) {
  return prisma.agentToolExecution.findUnique({
    where: {
      id: executionId,
    },
    include: {
      session: {
        include: {
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      },
    },
  });
}

const executionSelect = {
  id: true,
  toolCallId: true,
  toolName: true,
  input: true,
  status: true,
  error: true,
  confirmedAt: true,
  cancelledAt: true,
  expiresAt: true,
  expiredAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AgentToolExecutionSelect;

/**
 * Fetch an execution constrained to a session the caller has already proven
 * they own.
 *
 * The `sessionId` predicate is the security-relevant part: an execution id
 * alone would let a user who owns session A act on an execution belonging to
 * session B. Session ownership itself is established by the owner-scoped
 * session lookup, not here - this is not a second ownership implementation.
 */
export async function getToolExecutionInSession({
  executionId,
  sessionId,
}: {
  executionId: string;
  sessionId: string;
}) {
  return prisma.agentToolExecution.findFirst({
    where: { id: executionId, sessionId },
    select: executionSelect,
  });
}

/**
 * PENDING -> RUNNING. Returns false when another delivery already claimed it.
 *
 * Only PENDING may be claimed. A CANCELLED or PENDING_CONFIRMATION row is
 * therefore structurally unreachable by the worker, which is what makes
 * "cancelled must never execute" true rather than merely intended.
 */
export async function markToolExecutionRunning(
  executionId: string,
): Promise<boolean> {
  const { count } =
    await prisma.agentToolExecution.updateMany({
      where: {
        id: executionId,
        status: AgentToolExecutionStatus.PENDING,
      },
      data: {
        status: AgentToolExecutionStatus.RUNNING,
      },
    });

  return count === 1;
}

/**
 * PENDING_CONFIRMATION -> PENDING: the user approved the proposal.
 *
 * Compare-and-set from the proposal state only, so a second confirm cannot
 * re-queue an already dispatched execution.
 *
 * The transition and the intent to queue the worker commit together. A confirm
 * that transitioned the row but crashed before publishing would strand an
 * approved action with nothing to execute it.
 *
 * An EXPIRED proposal cannot be confirmed: the CAS matches PENDING_CONFIRMATION
 * only, so "expired" is not something a late-arriving user can talk the system
 * out of.
 */
export async function confirmToolExecution({
  executionId,
  sessionId,
  orgId,
  expectedStep,
}: {
  executionId: string;
  sessionId: string;
  orgId: string;
  expectedStep: number;
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.agentToolExecution.updateMany({
      where: {
        id: executionId,
        sessionId,
        status: AgentToolExecutionStatus.PENDING_CONFIRMATION,
      },
      data: {
        status: AgentToolExecutionStatus.PENDING,
        confirmedAt: new Date(),
        error: null,
      },
    });

    if (count !== 1) {
      return false;
    }

    await recordAgentEvent({
      tx,
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      sessionId,
      executionId,
      aggregateId: executionId,
      payload: {
        orgId,
        sessionId,
        executionId,
        expectedStep,
      },
    });

    return true;
  });
}

/**
 * PENDING_CONFIRMATION -> CANCELLED, and re-drive the loop, in ONE transaction.
 *
 * Terminal. The CAS means a cancel can never overwrite a RUNNING or COMPLETED
 * execution, and a cancelled row can never return to PENDING.
 *
 * The decline result and the continuation intent are committed with the
 * transition, for the same reason the timeout path is: a cancel used to write
 * the cancellation, then the transcript entry, then publish. A crash after the
 * first left a CANCELLED execution whose tool call was never answered and whose
 * loop was never told - a transcript with a dangling tool call and no path to
 * recovery, because the CAS can never fire again for a terminal row.
 *
 * The user is told explicitly not to retry and not to reach the same outcome by
 * another route. A capable model asked to "handle the decline" will otherwise
 * often find a different way to do the thing, which would defeat the approval
 * gate entirely.
 */
export async function cancelToolExecutionAndContinue({
  executionId,
  sessionId,
  orgId,
  expectedStep,
  toolCallId,
  toolName,
}: {
  executionId: string;
  sessionId: string;
  orgId: string;
  expectedStep: number;
  toolCallId: string;
  toolName: string;
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.agentToolExecution.updateMany({
      where: {
        id: executionId,
        sessionId,
        status: AgentToolExecutionStatus.PENDING_CONFIRMATION,
      },
      data: {
        status: AgentToolExecutionStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    if (count !== 1) {
      // No writes on a lost CAS: a confirm that already dispatched the execution
      // must not also leave a decline in the transcript.
      return false;
    }

    await createMessage({
      sessionId,
      step: expectedStep,
      toolCallId,
      message: buildDeclinedToolResult({ toolName, toolCallId }),
      tx,
    });

    await recordAgentEvent({
      tx,
      eventType: "AGENT_LOOP_REQUESTED",
      sessionId,
      executionId,
      aggregateId: executionId,
      payload: { orgId, sessionId, expectedStep },
    });

    return true;
  });
}

/** The tool-result that tells the model the user declined. */
function buildDeclinedToolResult({
  toolName,
  toolCallId,
}: {
  toolName: string;
  toolCallId: string;
}): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: {
          type: "json",
          value: {
            ok: false,
            code: "CANCELLED",
            error:
              "The user declined this action. Do not retry it " +
              "and do not attempt to achieve the same result " +
              "by another means.",
          },
        },
      },
    ],
  } as ModelMessage;
}

/**
 * Bounded scan for proposals whose approval window has closed.
 *
 * Only used to build a candidate list for `expireToolExecution`, which performs
 * the authoritative CAS. The list is ordered by expiresAt and capped, so a
 * maintenance pass never walks an unbounded result set; anything beyond the
 * cap is simply handled on the next tick.
 */
export async function findDueApprovalCandidates(
  limit: number,
  now: Date = new Date(),
): Promise<{ id: string; sessionId: string }[]> {
  return prisma.agentToolExecution.findMany({
    where: {
      status: AgentToolExecutionStatus.PENDING_CONFIRMATION,
      // A null expiresAt cannot be due. Rows written before approval expiry
      // existed stay PENDING_CONFIRMATION indefinitely rather than expiring
      // against a deadline that was never agreed with anyone.
      expiresAt: { lte: now },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { id: true, sessionId: true },
  });
}

/**
 * PENDING_CONFIRMATION -> EXPIRED, atomically, and only once the deadline passed.
 *
 * Both halves matter:
 *   - the status predicate makes it a compare-and-set, so two concurrent
 *     maintenance passes cannot both claim one proposal;
 *   - the expiresAt predicate means a proposal is never expired early, no
 *     matter what the caller believed.
 *
 * Returns false when the proposal was no longer awaiting approval, which is the
 * normal outcome for the race where a user confirms just as the timeout fires.
 * That race is resolved in favour of the user, and the caller should treat
 * `false` as "nothing to do", not as a failure.
 *
 * EXPIRED is deliberately distinct from CANCELLED: nobody declined, the window
 * simply closed. The agent is told which one happened so it does not claim the
 * user refused something they were never asked about.
 */
export async function expireToolExecution(
  executionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.agentToolExecution.updateMany({
    where: {
      id: executionId,
      status: AgentToolExecutionStatus.PENDING_CONFIRMATION,
      expiresAt: { lte: now },
    },
    data: {
      status: AgentToolExecutionStatus.EXPIRED,
      expiredAt: now,
      error: "APPROVAL_TIMEOUT",
    },
  });

  return count === 1;
}

/**
 * The timeout continuation, as ONE transaction: CAS the proposal to EXPIRED,
 * close its tool call in the transcript, and record the intent to re-drive the
 * loop.
 *
 * This existed as three separate steps in the reaper and that was a real
 * durability hole. Once the CAS committed, the execution was terminal and
 * `findDueApprovalCandidates` would never return it again, so a crash before the
 * publish stranded the session permanently: the proposal was closed, the
 * transcript still held an unanswered tool call, and nothing would ever run
 * again. There was no recovery path, because the only thing that would find the
 * work was the query that had just marked it done.
 *
 * Atomicity closes it. Either all three commit - and the intent is delivered by
 * the outbox dispatcher - or the proposal stays PENDING_CONFIRMATION and the
 * next maintenance tick picks it up again. There is no state in which the work
 * is forgotten.
 *
 * Returns false when the CAS lost, which is the normal outcome of a user
 * confirming just as the deadline passes. The user's decision wins that race,
 * and the caller treats it as "nothing to do".
 */
export async function expireToolExecutionAndContinue({
  executionId,
  sessionId,
  orgId,
  expectedStep,
  toolCallId,
  toolName,
  now = new Date(),
}: {
  executionId: string;
  sessionId: string;
  orgId: string;
  expectedStep: number;
  toolCallId: string;
  toolName: string;
  now?: Date;
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.agentToolExecution.updateMany({
      where: {
        id: executionId,
        status: AgentToolExecutionStatus.PENDING_CONFIRMATION,
        expiresAt: { lte: now },
      },
      data: {
        status: AgentToolExecutionStatus.EXPIRED,
        expiredAt: now,
        error: "APPROVAL_TIMEOUT",
      },
    });

    if (count !== 1) {
      // Commits with no writes. A lost CAS must not leave a transcript entry or
      // an outbox row for a proposal that is still awaiting the user.
      return false;
    }

    await createMessage({
      sessionId,
      step: expectedStep,
      toolCallId,
      message: buildExpiredToolResult({ toolName, toolCallId }),
      tx,
    });

    await recordAgentEvent({
      tx,
      eventType: "AGENT_LOOP_REQUESTED",
      sessionId,
      executionId,
      aggregateId: executionId,
      payload: { orgId, sessionId, expectedStep },
    });

    return true;
  });
}

/**
 * The tool-result that tells the model its proposal timed out.
 *
 * The wording is load-bearing rather than cosmetic. The model is explicitly told
 * the action did NOT happen, must not be retried, and must not be attempted by
 * another route. Without that last clause a capable model will often try to be
 * helpful and reach the same outcome a different way, which defeats the entire
 * point of the approval gate.
 */
function buildExpiredToolResult({
  toolName,
  toolCallId,
}: {
  toolName: string;
  toolCallId: string;
}): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: {
          type: "json",
          value: {
            ok: false,
            code: "APPROVAL_TIMEOUT",
            error:
              "The approval window expired before this action was " +
              "approved, so it was NOT executed. Tell the user the " +
              "approval window closed. Do not retry it and do not " +
              "attempt to achieve the same result by another means.",
          },
        },
      },
    ],
  } as ModelMessage;
}

/**
 * Any non-terminal state -> CANCELLED, for work that can no longer happen.
 *
 * Two callers, and the difference matters:
 *   - tool-worker, AFTER this worker claimed the row itself, when the session
 *     turned out to be terminal. Omitting RUNNING here would silently leave
 *     that row RUNNING forever, because the worker owns the claim and nobody
 *     else will ever transition it.
 *   - a recovery sweep, for rows nothing will claim.
 *
 * The compare-and-set still starts from a non-terminal status, so this can
 * never overwrite a COMPLETED or FAILED result, and it can never resurrect a
 * CANCELLED row. It is not safe to call for a row another worker owns.
 */
export async function abandonToolExecution(
  executionId: string,
  reason: string,
): Promise<boolean> {
  const { count } =
    await prisma.agentToolExecution.updateMany({
      where: {
        id: executionId,
        status: {
          in: [
            AgentToolExecutionStatus.PENDING,
            AgentToolExecutionStatus.PENDING_CONFIRMATION,
            AgentToolExecutionStatus.RUNNING,
          ],
        },
      },
      data: {
        status: AgentToolExecutionStatus.CANCELLED,
        cancelledAt: new Date(),
        error: reason,
      },
    });

  return count === 1;
}

/**
 * RUNNING heartbeat: prove this worker is still alive for the recovery sweep.
 *
 * Nothing else touches a RUNNING row while the executor runs, so `updatedAt`
 * is otherwise pinned at the moment of the claim. Without this, a legitimately
 * slow execution is indistinguishable from a worker that died holding it, and
 * the reaper cancels work that is still running.
 *
 * Compare-and-set on RUNNING so a heartbeat that lands after the row was
 * already reclaimed cannot resurrect it. Returns false once the row has left
 * RUNNING, which is the signal that this work has been taken away.
 */
export async function heartbeatToolExecution(
  executionId: string,
): Promise<boolean> {
  const { count } =
    await prisma.agentToolExecution.updateMany({
      where: {
        id: executionId,
        status: AgentToolExecutionStatus.RUNNING,
      },
      data: {
        updatedAt: new Date(),
      },
    });

  return count === 1;
}

export async function completeToolExecution(
  executionId: string,
) {
  const { count } =
    await prisma.agentToolExecution.updateMany({
      where: {
        id: executionId,
        status: AgentToolExecutionStatus.RUNNING,
      },
      data: {
        status: AgentToolExecutionStatus.COMPLETED,
        error: null,
      },
    });

  return count === 1;
}

export async function failToolExecution(
  executionId: string,
  error: unknown,
) {
  return prisma.agentToolExecution.update({
    where: {
      id: executionId,
    },
    data: {
      status: AgentToolExecutionStatus.FAILED,
      error:
        error instanceof Error
          ? (error.stack ?? error.message)
          : String(error),
    },
  });
}

/**
 * Session-scoped tool execution history, used for session recovery so a client
 * can rebuild its view after a refresh without a second query implementation.
 *
 * Callers must establish ownership first; this function is not a security
 * boundary.
 */
export async function getToolExecutionsForSession(sessionId: string) {
  return prisma.agentToolExecution.findMany({
    where: { sessionId },
    select: executionSelect,
    orderBy: { createdAt: "asc" },
  });
}
