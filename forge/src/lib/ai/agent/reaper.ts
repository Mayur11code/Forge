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
import {
  buildOutboxIdempotencyKey,
  recordAgentEvent,
  rearmOutboxEvent,
} from "./outbox";
import { publishAgentStatus } from "./status";
import { withAgentSessionLock } from "./locks";
import { sessionSelect } from "./session-service";
import type { AgentTerminalReason } from "./types";
import {
  AGENT_ORPHANED_EXECUTION_AGE_MS,
  AGENT_STALLED_SESSION_AGE_MS,
  AGENT_STALLED_SESSION_MAX_REDRIVES,
  AGENT_MAINTENANCE_BATCH_SIZE,
} from "./constants";
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

// src/lib/ai/agent/reaper.ts (continued)
//
// Stalled SESSION recovery.
//
// The duties above both need a tool execution row to have gotten far enough to
// be stranded. This one covers the earlier, quieter failure: a session that is
// RUNNING, has no execution at all, and is not going to get one because the
// AGENT_LOOP_REQUESTED that should have started it was published and then lost -
// the worker was killed mid-turn, or the turn died before it produced a tool
// call. Nothing above can see that session: it is not an orphaned execution, it
// is not a parked approval, and it never terminates. It just hangs.

export type RedriveStalledSessionsResult = {
  /** Recovery actions taken: a first queue, plus any re-arms. */
  redriven: number;
  /** Re-drives queued for the first time. */
  queued: number;
  /** Re-drives that had already been delivered and were queued again. */
  rearmed: number;
  /** Sessions given up on and failed, because the re-drive was never acted on. */
  exhausted: number;
  /** Candidates skipped because a worker held the session lock. Live work. */
  skippedLocked: number;
  /** Candidates skipped because the re-read under the lock disagreed. */
  skippedStale: number;
  scanned: number;
  durationMs: number;
  sessionIds: string[];
  /** The subset of sessionIds that were failed rather than re-driven. */
  failedSessionIds: string[];
};

/**
 * Execution states that mean "something is already responsible for this
 * session". A session holding one of these is never re-driven: the tool duty, the
 * approval sweep, or a live worker owns it.
 *
 * PENDING_CONFIRMATION is in this set deliberately and is the subtle one. A
 * session waiting for a human is still status RUNNING - the loop parks instead of
 * transitioning - so a predicate written as "no PENDING or RUNNING execution"
 * would happily re-drive a session that is politely waiting to be confirmed, and
 * the model would be asked to continue a turn the user has not approved. Excluding
 * every non-terminal state is the conservative reading: re-drive only when there
 * is provably nothing in flight.
 */
const IN_FLIGHT_EXECUTION_STATUSES: AgentToolExecutionStatus[] = [
  AgentToolExecutionStatus.PENDING,
  AgentToolExecutionStatus.RUNNING,
  AgentToolExecutionStatus.PENDING_CONFIRMATION,
];

/**
 * The re-drive idempotency key for a session at a given step.
 *
 * `AGENT_LOOP_REQUESTED:<sessionId>` was already consumed at session creation and
 * its outbox row is PUBLISHED, and `recordAgentEvent` deliberately does not
 * resurrect a published row - re-recording that exact key would collapse onto the
 * dead row and change nothing. So recovery uses a distinct aggregate id that still
 * contains the same event type and payload, making the key unique per
 * (session, step).
 *
 * Per-step, not per-session, is what makes repeats safe: while the session is
 * stuck at step N every sweep targets the same row, so the duty is idempotent
 * rather than queueing a new turn every five minutes; once the loop claims N and
 * moves to N+1, recovery has a new key and is free to act again. A session that
 * legitimately stalls on three different steps gets three separate repairs rather
 * than one.
 */
function buildStalledSessionRedriveId(sessionId: string, step: number) {
  return `${sessionId}#redrive#${step}`;
}

/**
 * Re-drive RUNNING sessions that are stale and provably have nothing in flight.
 *
 * Staleness is decided in two stages, and the first stage is deliberately not
 * trusted on its own:
 *
 *   1. `updatedAt < cutoff` bounds the work - it is a cheap indexed pre-filter
 *      over the table, nothing more. `updatedAt` moves only when a step is
 *      claimed, so a healthy worker in the middle of a long Gemini turn is
 *      indistinguishable from a dead one at this point. Treating the timestamp as
 *      the answer would mean racing healthy sessions.
 *   2. The session lock is the authoritative liveness signal. A worker in a turn
 *      holds `agent_session_lock:<id>` for the entire turn and renews it every
 *      10s, so failing to acquire it means a live worker, full stop. Acquiring it
 *      means nobody is mid-turn, and while holding it the session is re-read to
 *      confirm it is still RUNNING, still stale, and still has no in-flight
 *      execution.
 *
 * Recovery then records an AGENT_LOOP_REQUESTED intent through the ordinary
 * outbox, so the re-driven turn is delivered by the same dispatcher, claimed by
 * the same `claimNextAgentStep` CAS, and serialised by the same lock as any other
 * turn. There is no direct publish and no second execution path: the worst case
 * of getting this wrong is a duplicate delivery, which the existing CAS already
 * turns into a no-op.
 *
 * Bounded twice over. A sweep that keeps finding the same stuck session re-arms
 * the one re-drive row rather than adding rows, and the row's own attempt count
 * caps how many deliveries it can ever get. When that cap is reached the session
 * is failed with an explicit reason instead of being re-driven forever - a
 * spinner that never resolves is a worse outcome than a legible failure.
 */
export async function redriveStalledSessions({
  olderThanMs = AGENT_STALLED_SESSION_AGE_MS,
  limit = AGENT_MAINTENANCE_BATCH_SIZE,
  maxAttempts = AGENT_STALLED_SESSION_MAX_REDRIVES,
  now = new Date(),
}: {
  olderThanMs?: number;
  limit?: number;
  maxAttempts?: number;
  now?: Date;
} = {}): Promise<RedriveStalledSessionsResult> {
  const startedAt = Date.now();
  const cutoff = new Date(now.getTime() - olderThanMs);

  const candidates = await prisma.agentSession.findMany({
    where: {
      status: AgentSessionStatus.RUNNING,
      updatedAt: { lt: cutoff },
      toolExecutions: {
        none: { status: { in: IN_FLIGHT_EXECUTION_STATUSES } },
      },
    },
    select: { id: true, currentStep: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  const sessionIds: string[] = [];
  const failedSessionIds: string[] = [];
  let queued = 0;
  let rearmed = 0;
  let exhausted = 0;
  let skippedLocked = 0;
  let skippedStale = 0;

  for (const candidate of candidates) {
    // A null return is the lock telling us a worker is mid-turn. That is the
    // answer, not an error: skipping is the entire point of taking the lock.
    const outcome = await withAgentSessionLock(candidate.id, async () => {
      const session = await prisma.agentSession.findUnique({
        where: { id: candidate.id },
        select: sessionSelect,
      });

      if (!session || session.status !== AgentSessionStatus.RUNNING) {
        return "stale" as const;
      }

      // Re-check staleness under the lock. The window between the scan and here
      // is exactly where a worker could have claimed a step, and re-driving on
      // the pre-lock read would race that turn.
      if (session.updatedAt >= cutoff) {
        return "stale" as const;
      }

      // Re-check the executions under the lock too. A worker can have finished
      // its tool call and written the execution after the scan.
      const inFlight = await prisma.agentToolExecution.count({
        where: {
          sessionId: candidate.id,
          status: { in: IN_FLIGHT_EXECUTION_STATUSES },
        },
      });

      if (inFlight > 0) {
        return "stale" as const;
      }

      const redriveId = buildStalledSessionRedriveId(
        candidate.id,
        session.currentStep,
      );

      // Record first, re-arm second. The intent has to exist durably before
      // anything is asked of it, and `recordAgentEvent` is the only thing that
      // creates the row. On a repeat sweep it collapses onto the row the previous
      // one made, which is exactly the idempotency being relied on.
      await db.$transaction(async (tx) => {
        await recordAgentEvent({
          tx,
          eventType: "AGENT_LOOP_REQUESTED",
          sessionId: candidate.id,
          aggregateId: redriveId,
          payload: {
            orgId: session.orgId,
            sessionId: candidate.id,
            expectedStep: session.currentStep,
          },
        });
      });

      const rearm = await rearmOutboxEvent({
        idempotencyKey: buildOutboxIdempotencyKey(
          "AGENT_LOOP_REQUESTED",
          redriveId,
        ),
        maxAttempts,
        now,
      });

      if (rearm.state === "exhausted") {
        // Every delivery of this re-drive was either never delivered or refused
        // by the consumer, and the session is still sitting at the same step with
        // nothing in flight. Re-driving is not going to change that, so the
        // honest ending is a failure the user can see rather than an indefinite
        // spinner. Same shape as the execution reaper: terminate, do not spin.
        const reason =
          `Agent session ${candidate.id} stalled at step ${session.currentStep} and ` +
          `did not advance after ${rearm.attempts} recovery attempt(s).`;

        const { count } = await prisma.agentSession.updateMany({
          where: {
            id: candidate.id,
            status: AgentSessionStatus.RUNNING,
          },
          data: {
            status: AgentSessionStatus.FAILED,
            errorMessage: reason,
            terminalReason: "ERROR" satisfies AgentTerminalReason,
            updatedAt: now,
          },
        });

        if (count === 1) {
          await publishAgentStatus(candidate.id, {
            type: "FAILED",
            reason: "ERROR",
            message: reason,
          });
        }

        return "exhausted" as const;
      }

      return rearm.state === "rearmed" ? "rearmed" : "queued";
    });

    if (outcome === null) {
      skippedLocked += 1;
      continue;
    }

    if (outcome === "stale") {
      skippedStale += 1;
      continue;
    }

    if (outcome === "exhausted") {
      exhausted += 1;
      failedSessionIds.push(candidate.id);
      continue;
    }

    if (outcome === "rearmed") {
      rearmed += 1;
    } else {
      queued += 1;
    }

    sessionIds.push(candidate.id);
  }

  return {
    redriven: queued + rearmed,
    queued,
    rearmed,
    exhausted,
    skippedLocked,
    skippedStale,
    scanned: candidates.length,
    durationMs: Date.now() - startedAt,
    sessionIds,
    failedSessionIds,
  };
}
