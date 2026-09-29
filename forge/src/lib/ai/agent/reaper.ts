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
// The RAW client for the redelivery sweep's transactional intent write. The
// outbox is infrastructure, and routing that write through the extended
// client's `task` interceptors would be wrong.
import { db } from "@/lib/prisma/db";
import { recordAgentEvent } from "./outbox";
import { publishAgentStatus } from "./status";
import { AGENT_ORPHANED_EXECUTION_AGE_MS, AGENT_MAINTENANCE_BATCH_SIZE } from "./constants";
import {
  expireToolExecution,
  expireToolExecutionAndContinue,
  findDueApprovalCandidates,
  getToolExecutionForWorker,
} from "./services/tool-execution-service";
import { getAgentSessionForWorker } from "./session-service";

export type ReapResult = {
  swept: number;
  sessionIds: string[];
};

export type ExpireStaleApprovalsResult = {
  /** Proposals actually transitioned to EXPIRED by the CAS. */
  expired: number;
  /** Sessions re-driven so the model can report the timeout. */
  continued: number;
  /** Expired, but the session was already terminal so the loop was not touched. */
  skipped: number;
  scanned: number;
  durationMs: number;
  errors: string[];
};

function isTerminalSessionStatus(status: AgentSessionStatus): boolean {
  return (
    status === AgentSessionStatus.COMPLETED ||
    status === AgentSessionStatus.FAILED ||
    status === AgentSessionStatus.CANCELLED
  );
}

/**
 * Fail sessions stranded by an execution that stopped heartbeating.
 *
 * Returns the affected session ids so a caller can drive them forward or alert
 * on them. Safe to run repeatedly: the row transitions to CANCELLED and the
 * session to FAILED exactly once, and neither is matched a second time.
 */
/**
 * PENDING_CONFIRMATION -> EXPIRED for every proposal whose window closed, and
 * tells the agent so it can close the turn honestly.
 *
 * This is the third maintenance duty, and the one the reaper could not cover: a
 * proposal awaiting a human is not orphaned, it is parked exactly where the
 * system put it, so no amount of RUNNING-expiry sweeping would ever release it.
 * A user who never answers would otherwise hold their session indefinitely.
 *
 * Unlike CANCELLED, an expiry is the SYSTEM giving up, not the user declining.
 * The model is told APPROVAL_TIMEOUT rather than a cancellation so it reports
 * "the approval window closed" and never claims the user refused something they
 * were never asked about.
 *
 * Bounded and repeatable: candidates are capped, ordered by deadline, and every
 * transition is a CAS, so overlapping passes and a partially completed pass both
 * behave correctly.
 *
 * The session check is the important subtlety. An expiry still closes the
 * execution, but a TERMINAL session must not be resurrected by the continuation
 * that normally follows - there is no turn left to continue.
 */
export async function expireStaleApprovals({
  limit = AGENT_MAINTENANCE_BATCH_SIZE,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
} = {}): Promise<ExpireStaleApprovalsResult> {
  const startedAt = Date.now();

  const candidates = await findDueApprovalCandidates(limit, now);

  let expired = 0;
  let continued = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const execution = await getToolExecutionForWorker(candidate.id);
      const session = execution
        ? await getAgentSessionForWorker(candidate.sessionId)
        : null;

      if (!execution || !session) {
        // The execution is still closed, even though there is no session to
        // continue: leaving it PENDING_CONFIRMATION would hold it open forever,
        // and no transcript write is possible or needed for a session that does
        // not exist. A missing session is treated exactly like a terminal one.
        if (await expireToolExecution(candidate.id, now)) {
          expired += 1;
        }
        skipped += 1;
        continue;
      }

      if (isTerminalSessionStatus(session.status)) {
        // The session already settled, so there is no turn left to continue.
        // The proposal is still closed - leaving it PENDING_CONFIRMATION would
        // hold the execution open forever - but nothing is published.
        //
        // This deliberately does NOT record a continuation event. A terminal
        // session has no step to claim, and re-driving it would either be a
        // no-op at the consumer or, worse, a contradiction of the recorded
        // terminal reason.
        if (await expireToolExecution(candidate.id, now)) {
          expired += 1;
        }
        skipped += 1;
        continue;
      }

      // The authoritative path: CAS to EXPIRED, close the transcript, and record
      // the continuation intent in ONE transaction. A false return means the user
      // confirmed or cancelled between the scan and here - their decision wins
      // that race, which is a no-op rather than an error.
      const didExpire = await expireToolExecutionAndContinue({
        executionId: candidate.id,
        sessionId: session.id,
        orgId: session.orgId,
        expectedStep: session.currentStep,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        now,
      });

      if (!didExpire) {
        continue;
      }

      expired += 1;
      continued += 1;

      // Status is a UI signal, not domain state, so it stays outside the
      // transaction. A failure here cannot strand the work: the tool result and
      // the continuation intent have already committed.
      await publishAgentStatus(session.id, {
        type: "TOOL_EXPIRED",
        executionId: candidate.id,
        toolName: execution.toolName,
      });
    } catch (error) {
      // One bad candidate must not abandon the rest of the batch. Because the
      // expiry is now transactional, a failure here leaves the proposal
      // PENDING_CONFIRMATION and it is retried on the next tick - the worst
      // case is a repeated attempt, not a stranded session.
      errors.push(
        `${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    expired,
    continued,
    skipped,
    scanned: candidates.length,
    durationMs: Date.now() - startedAt,
    errors,
  };
}

export async function reapOrphanedToolExecutions({
  olderThanMs = AGENT_ORPHANED_EXECUTION_AGE_MS,
  limit = AGENT_MAINTENANCE_BATCH_SIZE,
  now = new Date(),
}: {
  olderThanMs?: number;
  limit?: number;
  now?: Date;
} = {}): Promise<ReapResult> {
  const cutoff = new Date(now.getTime() - olderThanMs);

  const staleWhere = {
    status: AgentToolExecutionStatus.RUNNING,
    updatedAt: { lt: cutoff },
  };

  // Bounded and ordered. The `take` keeps a pass cheap once many rows have
  // gone stale at once, and ordering by the heartbeat timestamp means a pass
  // always drains the oldest first rather than starving the same rows.
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
    orderBy: { updatedAt: "asc" },
    take: limit,
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
 * Re-drive confirmed-but-undelivered executions by re-recording their intent.
 *
 * In normal operation this is a no-op: `confirmToolExecution` already recorded
 * the `AGENT_TOOL_EXECUTION_REQUESTED` intent in the same transaction as the
 * PENDING transition, so the outbox dispatcher owns delivery and this sweep has
 * nothing to add. The unique `idempotencyKey` collapses the re-record onto the
 * existing row rather than queueing a second event, and the row is NOT reset to
 * PENDING - an already-delivered event is not resurrected.
 *
 * It exists for the two cases the normal path cannot cover:
 *   - the intent was recorded but the dispatcher has not drained it yet, in which
 *     case this makes no change and the dispatcher finishes the job;
 *   - the outbox row is genuinely missing (manual intervention, a restore from
 *     an older backup), where re-recording repairs the gap instead of leaving a
 *     PENDING row that nothing will ever claim.
 *
 * This re-records intent rather than publishing directly. A direct publish here
 * would be a crash-window shortcut: the sweep would be doing the dispatcher's
 * job without the durability, and reintroducing exactly the gap the outbox
 * exists to close.
 */
export async function redeliverStalledConfirmedExecutions({
  olderThanMs = AGENT_ORPHANED_EXECUTION_AGE_MS,
  limit = AGENT_MAINTENANCE_BATCH_SIZE,
  now = new Date(),
}: {
  olderThanMs?: number;
  limit?: number;
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
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  const redelivered: string[] = [];

  for (const execution of stalled) {
    await db.$transaction(async (tx) => {
      await recordAgentEvent({
        tx,
        eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
        sessionId: execution.sessionId,
        executionId: execution.id,
        aggregateId: execution.id,
        payload: {
          orgId: execution.session.orgId,
          sessionId: execution.sessionId,
          executionId: execution.id,
          expectedStep: execution.session.currentStep,
        },
      });
    });

    redelivered.push(execution.id);
  }

  return redelivered;
}
