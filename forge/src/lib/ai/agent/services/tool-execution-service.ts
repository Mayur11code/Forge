// src/lib/ai/agent/services/tool-execution-service.ts

import {
  AgentToolExecutionStatus,
  type Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma/extended";
import { JsonValue } from "../types";

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
}

export async function createToolExecution({
  sessionId,
  toolCallId,
  toolName,
  input,
  requiresConfirmation,
}: CreateToolExecutionInput) {
  return prisma.agentToolExecution.create({
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
    },
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
 */
export async function confirmToolExecution({
  executionId,
  sessionId,
}: {
  executionId: string;
  sessionId: string;
}): Promise<boolean> {
  const { count } =
    await prisma.agentToolExecution.updateMany({
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

  return count === 1;
}

/**
 * PENDING_CONFIRMATION -> CANCELLED: the user declined.
 *
 * Terminal. The CAS means a cancel can never overwrite a RUNNING or COMPLETED
 * execution, and a cancelled row can never return to PENDING.
 */
export async function cancelToolExecution({
  executionId,
  sessionId,
}: {
  executionId: string;
  sessionId: string;
}): Promise<boolean> {
  const { count } =
    await prisma.agentToolExecution.updateMany({
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

  return count === 1;
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
