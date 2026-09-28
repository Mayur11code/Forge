// src/lib/ai/agent/reaper.ts
//
// Recovery for executions whose worker died mid-flight.
//
// A tool execution row is claimed with a durable CAS (PENDING -> RUNNING)
// before any side effect happens. That is what makes execution exactly-once
// for the QUEUE, but it means a worker that crashes after claiming leaves a
// row that is RUNNING forever: the event was acknowledged, so QStash will
// never redeliver it, and the session never terminates.
//
// This module closes that gap. It is deliberately a narrow, idempotent sweep
// rather than a general-purpose scheduler:
//   - it only touches RUNNING rows that have stopped heartbeating,
//   - it only touches sessions that are still RUNNING, so it never revives
//     work for a session that already ended,
//   - it terminates the session with an explicit terminal reason, so the
//     failure is legible instead of hanging.
//
// Liveness is a heartbeat, not a timestamp. While a worker executes, it
// refreshes the row's updatedAt (see AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS).
// That is what makes "stale" mean "nobody is working on this" rather than "this
// is taking a while": the row's updatedAt is otherwise pinned at the moment of
// the claim, so without the heartbeat a slow but perfectly healthy execution
// would be indistinguishable from a dead worker, and cancelling it would kill
// a side effect that was about to succeed. The Redis lock heartbeat cannot
// substitute for this - it is process-local state this sweep cannot observe.

import { AgentSessionStatus, AgentToolExecutionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma/extended";
import { publishEvent } from "@/lib/events/queue";
import { publishAgentStatus } from "./status";
import { AGENT_ORPHANED_EXECUTION_AGE_MS } from "./constants";

export type ReapResult = {
  swept: number;
  sessionIds: string[];
};

/**
 * Fail sessions stranded by an execution that stopped heartbeating.
 *
 * Returns the affected session ids so a caller can drive them forward or alert
 * on them. Safe to run repeatedly: the row transitions to CANCELLED and the
 * session to FAILED exactly once, and neither is matched a second time.
 */
export async function reapOrphanedToolExecutions({
  olderThanMs = AGENT_ORPHANED_EXECUTION_AGE_MS,
  now = new Date(),
}: {
  olderThanMs?: number;
  now?: Date;
} = {}): Promise<ReapResult> {
  const cutoff = new Date(now.getTime() - olderThanMs);

  const staleWhere = {
    status: AgentToolExecutionStatus.RUNNING,
    updatedAt: { lt: cutoff },
  };

  const stranded = await prisma.agentToolExecution.findMany({
    where: {
      ...staleWhere,
      session: { status: AgentSessionStatus.RUNNING },
    },
    select: {
      id: true,
      sessionId: true,
      session: {
        select: { id: true, currentStep: true, status: true },
      },
    },
    take: 50,
  });

  const sessionIds: string[] = [];
  let cancelled = 0;

  for (const execution of stranded) {
    const reason =
      `Tool execution ${execution.id} was abandoned mid-flight.`;

    // The staleness predicate is repeated in the compare-and-set, not just in
    // the read. Without it, a heartbeat that landed between the two calls would
    // be overwritten and live work cancelled - the read-then-write gap is
    // exactly the window this sweep is most likely to run in.
    const { count } = await prisma.agentToolExecution.updateMany({
      where: { id: execution.id, ...staleWhere },
      data: {
        status: AgentToolExecutionStatus.CANCELLED,
        cancelledAt: now,
        error: reason,
      },
    });

    if (count !== 1) {
      continue;
    }

    cancelled += 1;

    const { count: failed } = await prisma.agentSession.updateMany({
      where: {
        id: execution.sessionId,
        status: AgentSessionStatus.RUNNING,
      },
      data: {
        status: AgentSessionStatus.FAILED,
        errorMessage: reason,
        terminalReason: "ERROR",
        updatedAt: now,
      },
    });

    if (failed === 1) {
      await publishAgentStatus(execution.sessionId, {
        type: "FAILED",
        reason: "ERROR",
        message: reason,
      });

      sessionIds.push(execution.sessionId);
    }
  }

  return { swept: cancelled, sessionIds };
}

/**
 * Re-drive sessions that are RUNNING with a confirmed but undelivered
 * execution.
 *
 * A confirmed execution sitting in PENDING means the queue accepted the
 * dispatch but the tool worker never ran it. Re-publishing is safe precisely
 * because the worker claims with a CAS: the second delivery is a no-op if the
 * first one already started.
 */
export async function redeliverStalledConfirmedExecutions({
  olderThanMs = AGENT_ORPHANED_EXECUTION_AGE_MS,
  now = new Date(),
}: {
  olderThanMs?: number;
  now?: Date;
} = {}): Promise<string[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);

  const stalled = await prisma.agentToolExecution.findMany({
    where: {
      status: AgentToolExecutionStatus.PENDING,
      updatedAt: { lt: cutoff },
      session: { status: AgentSessionStatus.RUNNING },
    },
    select: {
      id: true,
      sessionId: true,
      session: { select: { orgId: true, currentStep: true } },
    },
    take: 50,
  });

  const redelivered: string[] = [];

  for (const execution of stalled) {
    await publishEvent("AGENT_TOOL_EXECUTION_REQUESTED", {
      orgId: execution.session.orgId,
      sessionId: execution.sessionId,
      executionId: execution.id,
      expectedStep: execution.session.currentStep,
    });

    redelivered.push(execution.id);
  }

  return redelivered;
}
