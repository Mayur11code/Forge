// src/app/api/worker/workflow-maintenance/wm.ts
//
// The scheduled stale-run sweep for the workflow engine.
//
// Same delivery shape as the agent maintenance pass and for the same reason: it
// arrives through the single /api/worker dispatcher, so it is signed by QStash
// and recorded like every other job, and a crash is retried by the broker
// instead of lost. A separate cron route would need a second authentication
// scheme and a second scheduler.
//
// Deliberately a SEPARATE event and a SEPARATE schedule from
// `AGENT_MAINTENANCE_REQUESTED`. The agent sweep's worst action is failing a
// session whose worker demonstrably died. This one's worst action is failing a
// workflow step whose external side effect cannot be determined. Those are not
// the same risk, and tying them together would mean you cannot switch off the
// risky duty without also losing the harmless one.
//
// A sweep that is written but never scheduled is the same as no sweep at all, so
// this handler exists to be pointed at by a QStash schedule. It is not wired to
// one here: that is an operational change against live infrastructure.

import { sweepStaleWorkflowRuns } from "@/lib/workflow/maintenance";
import type { EventPayloadMap } from "@/lib/events/schema";

type WorkflowMaintenanceWorkerEvent = {
  event: {
    data: EventPayloadMap["WORKFLOW_MAINTENANCE_REQUESTED"];
  };
};

export type WorkflowMaintenanceSummary = {
  ok: boolean;
  durationMs: number;
  redriven: number;
  surfaced: number;
  runIds: string[];
  errors: string[];
};

export async function handleWorkflowMaintenance({
  event,
}: WorkflowMaintenanceWorkerEvent): Promise<void> {
  const summary = await runWorkflowMaintenance({ limit: event.data.limit });

  // Fail after the pass has run, never instead of running it. Returning normally
  // would let the broker record the tick as delivered while part of the sweep
  // never happened, and the next tick is five minutes away. Throwing is safe to
  // retry: every step of the sweep is idempotent, and a redelivery re-drives
  // only steps that are still in a re-drivable state.
  if (!summary.ok) {
    throw new Error(
      `Workflow maintenance completed partially: ${summary.errors.join("; ")}`,
    );
  }
}

/**
 * The pass itself, returning its summary.
 *
 * Split out from the handler because the worker contract is `Promise<void>` -
 * the dispatcher owns the response - while a test needs the result to assert on.
 */
export async function runWorkflowMaintenance({
  limit,
}: {
  limit?: number;
} = {}): Promise<WorkflowMaintenanceSummary> {
  const startedAt = Date.now();

  try {
    const outcomes = await sweepStaleWorkflowRuns(limit === undefined ? {} : { limit });

    const summary: WorkflowMaintenanceSummary = {
      ok: true,
      durationMs: Date.now() - startedAt,
      redriven: outcomes.filter((o) => o.action === "REDRIVEN").length,
      surfaced: outcomes.filter((o) => o.action === "SURFACED").length,
      runIds: [...new Set(outcomes.map((o) => o.runId))],
      errors: [],
    };

    // Counts, not identifiers. Run ids are tenant data and the log line exists
    // only to answer "did the sweep run and what did it find".
    console.log(
      "[WORKFLOW MAINTENANCE]",
      JSON.stringify({
        ok: summary.ok,
        durationMs: summary.durationMs,
        redriven: summary.redriven,
        surfaced: summary.surfaced,
        runs: summary.runIds.length,
      }),
    );

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error("[WORKFLOW MAINTENANCE] sweep failed:", error);

    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      redriven: 0,
      surfaced: 0,
      runIds: [],
      errors: [message],
    };
  }
}
