// src/app/api/worker/agent-maintenance/am.ts
//
// The scheduled upkeep pass for the whole agent subsystem, delivered as a queue
// message rather than as an HTTP cron request.
//
// Why a queue event and not a cron route: maintenance is exactly the same shape
// of work as every other asynchronous job here. It arrives through the single
// /api/worker dispatcher, so it inherits the one property that makes this
// system survivable - QStash signs the delivery, the EventLog records it, and a
// crash is retried by the broker rather than lost. A separate cron route would
// have needed a second authentication scheme, a second scheduler, and a second
// place to look when one of them silently stops running.
//
// It exists at all because all three recovery duties previously had zero
// callers: the reaper functions were written and tested, and nothing in the
// running system ever invoked them, so an orphaned execution would sit RUNNING
// forever. Writing the sweep and never scheduling it is the same as not having
// written it.
//
// One handler, five duties, deliberately. Five separate schedules would mean five
// schedules to keep alive and five places to look when one of them silently
// stops - and the failure mode of a missing sweeper is a session that hangs
// forever, which is exactly the kind of thing that goes unnoticed.
//
// Every duty is bounded and idempotent, so a pass is safe to run concurrently
// with itself and safe to repeat after a partial failure. Nothing here is
// destructive to user data: the worst case is closing a proposal whose approval
// window closed, or failing a session whose worker demonstrably died.

import {
  expireStaleApprovals,
  reapOrphanedToolExecutions,
  redeliverStalledConfirmedExecutions,
  redriveStalledSessions,
} from "@/lib/ai/agent/reaper";
import { dispatchOutboxBatch } from "@/lib/ai/agent/outbox";
import { AGENT_MAINTENANCE_BATCH_SIZE } from "@/lib/ai/agent/constants";
import type { EventPayloadMap } from "@/lib/events/schema";

type AgentMaintenanceWorkerEvent = {
  event: {
    data: EventPayloadMap["AGENT_MAINTENANCE_REQUESTED"];
  };
};

export type MaintenanceDutyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export type MaintenanceSummary = {
  ok: boolean;
  durationMs: number;
  expired: unknown | null;
  orphaned: unknown | null;
  redelivered: unknown | null;
  stalled: unknown | null;
  outbox: unknown | null;
  errors: string[];
};

/**
 * Run one duty without letting it take the others down with it.
 *
 * Isolation is the point. A broken reaper must not also cost the approval sweep,
 * because the failure mode of a silently incomplete maintenance pass is a
 * session that hangs for hours and nobody notices, because the *other* duties
 * still report success.
 */
async function settle(
  label: string,
  fn: () => Promise<unknown>,
): Promise<MaintenanceDutyResult> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return {
      ok: false,
      error: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function handleAgentMaintenance({
  event,
}: AgentMaintenanceWorkerEvent): Promise<void> {
  // The payload's `limit` is validated by the event schema before this runs, so
  // it is already an integer within bounds. The fallback covers a direct call
  // from a test that bypasses the dispatcher.
  const summary = await runAgentMaintenance({ limit: event.data.limit });

  // Fail AFTER every duty has run, never instead of running them.
  //
  // Returning normally here would let the broker record the tick as delivered
  // while part of the sweep never happened, and the tick is the only thing that
  // drives this subsystem. The next tick is five minutes away and the next
  // recovery of a hung session is the user's abandoned afternoon, so "try again
  // later" is not an acceptable substitute for reporting the failure.
  //
  // Throwing is safe to retry because every duty is idempotent, and the retry
  // actually reaches the handler: the dispatcher keys idempotency on the QStash
  // message id and re-arms a `FAILED` row rather than treating it as processed.
  if (!summary.ok) {
    throw new Error(
      `Agent maintenance completed partially: ${summary.errors.join("; ")}`,
    );
  }
}

/**
 * The pass itself, returning its summary.
 *
 * Split out from `handleAgentMaintenance` because the worker contract is
 * `Promise<void>` - the dispatcher owns the response - while a caller that needs
 * to assert on what a pass did (tests, a future manual trigger) needs the result.
 * Returning it from the handler too would not typecheck against that contract.
 */
export async function runAgentMaintenance({
  limit = AGENT_MAINTENANCE_BATCH_SIZE,
}: {
  limit?: number;
} = {}): Promise<MaintenanceSummary> {
  const startedAt = Date.now();

  const [expired, orphaned, redelivered, stalled, outbox] = await Promise.all([
    settle("expireStaleApprovals", () => expireStaleApprovals({ limit })),
    settle("reapOrphanedToolExecutions", () =>
      reapOrphanedToolExecutions({ limit }),
    ),
    settle("redeliverStalledConfirmedExecutions", () =>
      redeliverStalledConfirmedExecutions({ limit }),
    ),
    // Runs concurrently with the reaper on purpose. The two duties are
    // disjoint by predicate - a session with an in-flight execution belongs to
    // the reaper and is excluded here - so serialising them would only make the
    // pass slower, and the outbox drain below picks up whatever both recorded
    // in the same tick.
    settle("redriveStalledSessions", () => redriveStalledSessions({ limit })),
    // The outbox is drained here too, and it is not optional.
    //
    // Every critical agent event is written to AgentOutboxEvent instead of being
    // published directly, precisely so that a crash cannot lose it. A row that is
    // written and never published is not durable, it is deferred: the session is
    // still stuck, it is just stuck in a table instead of on the floor. Without a
    // dispatcher on a schedule the entire outbox is inert, and it would look like
    // durability in every document and every code review.
    settle("dispatchOutboxBatch", () => dispatchOutboxBatch(limit)),
  ]);

  const errors = [expired, orphaned, redelivered, stalled, outbox]
    .filter((r): r is { ok: false; error: string } => !r.ok)
    .map((r) => r.error);

  const summary: MaintenanceSummary = {
    ok: errors.length === 0,
    durationMs: Date.now() - startedAt,
    expired: expired.ok ? expired.value : null,
    orphaned: orphaned.ok ? orphaned.value : null,
    redelivered: redelivered.ok ? redelivered.value : null,
    stalled: stalled.ok ? stalled.value : null,
    outbox: outbox.ok ? outbox.value : null,
    errors,
  };

  console.log("[AGENT MAINTENANCE]", JSON.stringify(toLoggableSummary(summary)));

  return summary;
}

/**
 * The counts, without the identifiers.
 *
 * `ReapResult.sessionIds` and the `redeliverStalledConfirmedExecutions` return
 * value are arrays of session and execution ids. Dumping the raw summary here
 * would put tenant identifiers into worker logs, which are shipped, retained and
 * readable by anyone with log access - and the ids are useless for answering
 * "did the sweeper run", which is the only question this line exists to answer.
 *
 * The full summary is still returned to the caller, so a test or a future manual
 * trigger can assert on it. Only the log line is narrowed.
 */
function toLoggableSummary(summary: MaintenanceSummary) {
  const count = (value: unknown, key: string): number | null => {
    if (value === null || typeof value !== "object") return null;
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === "number" ? raw : null;
  };

  return {
    ok: summary.ok,
    durationMs: summary.durationMs,
    expired: {
      expired: count(summary.expired, "expired"),
      continued: count(summary.expired, "continued"),
      skipped: count(summary.expired, "skipped"),
      scanned: count(summary.expired, "scanned"),
    },
    orphaned: { swept: count(summary.orphaned, "swept") },
    redelivered: {
      count: Array.isArray(summary.redelivered)
        ? summary.redelivered.length
        : null,
    },
    stalled: {
      redriven: count(summary.stalled, "redriven"),
      queued: count(summary.stalled, "queued"),
      rearmed: count(summary.stalled, "rearmed"),
      exhausted: count(summary.stalled, "exhausted"),
      skippedLocked: count(summary.stalled, "skippedLocked"),
      skippedStale: count(summary.stalled, "skippedStale"),
      scanned: count(summary.stalled, "scanned"),
    },
    outbox: {
      claimed: count(summary.outbox, "claimed"),
      published: count(summary.outbox, "published"),
      failed: count(summary.outbox, "failed"),
    },
    errors: summary.errors,
  };
}
