// src/lib/workflow/maintenance.ts
//
// Stale workflow run recovery.
//
// A run gets stuck when a delivery is lost rather than failed: QStash exhausts
// its retries while the step sits in `RETRYING`, or a worker claims a step and
// then dies before recording an outcome. Neither is visible from the run row,
// which still reads `RUNNING` and still has no terminal state. The evaluator's
// backstop re-entry will keep visiting such a run and keep finding nothing it
// can legally do.
//
// This pass is the recovery duty for that case, and it is deliberately split
// into two behaviours that must never be confused with each other:
//
//   RE-DRIVE  steps that provably have no external side effect yet. A step
//             still `PENDING` with no `startedAt` was never claimed, so its
//             action never ran; re-publishing it is safe. A step in `RETRYING`
//             whose action explicitly reported a retriable failure is safe for
//             the same reason, and stays bounded by the wrapper's own attempt
//             cap, so it eventually fails out instead of looping.
//
//   SURFACE   steps claimed and then abandoned (`RUNNING`, `COMPENSATING`).
//             The action may or may not have happened, and nothing in the
//             system can tell us. Re-running it risks a duplicate external
//             effect, so it is never re-run. The step is failed with an
//             explicit "outcome unknown" reason instead, which is a claim we
//             can actually support, and it lets the run converge: a critical
//             step rolls the saga back, a non-critical one lets the run finish
//             as FAILED. Either way a human sees it.
//
// The distinction is the whole point of this file. A sweeper that "recovers" by
// re-dispatching anything it finds stale is indistinguishable from one that
// silently duplicates payments and emails.

import { db } from "@/lib/prisma/db";
import { publishEvent } from "@/lib/events/queue";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { MAX_RETRIES } from "@/lib/workflow/execution/wrapper";

/**
 * How long a run may go without making progress before it is swept.
 *
 * Generous on purpose, because the sweep's ambiguous-case handling FAILEDs a
 * step. A workflow step is one action call - the only registered action is a
 * single insert - so a step that has held `RUNNING` for this long did not
 * execute slowly, its worker died. Matches the order of magnitude used for the
 * agent's stalled-session threshold so the two recovery duties agree on what
 * "long" means, and sits well under the five-minute maintenance interval.
 */
export const WORKFLOW_STALE_RUN_AGE_MS = 10 * 60_000;

/**
 * Rows one pass will touch.
 *
 * Every query is bounded and ordered so a pass is cheap, repeatable, and safe
 * to run concurrently with itself. Anything still stale afterwards is simply
 * picked up next tick.
 */
export const WORKFLOW_SWEEP_BATCH_SIZE = 100;

/**
 * Step statuses that mean the run is still in flight.
 */
const ACTIVE_RUN_STATUSES = ["PENDING", "RUNNING", "ROLLING_BACK"] as const;

export type SweepOutcome = {
  runId: string;
  stepId: string;
  stepStatus: string;
  action: "REDRIVEN" | "SURFACED";
  reason: string;
};

/**
 * Find runs that should still be moving and have not.
 *
 * `lastAdvancedAt` rather than `startedAt`, because a long-running workflow and
 * a dead one are indistinguishable from `startedAt` alone. `completedAt IS NULL`
 * is the terminal-state guard: a finished run is not stuck, and sweeping one
 * would resurrect it.
 *
 * The `OR` covers runs that never advanced at all. A run created and then
 * orphaned before its first pass commits has a NULL `lastAdvancedAt`, and
 * `NULL < cutoff` is not true in SQL - so the `lt` predicate alone silently
 * excludes exactly the runs that have made the least progress. Those rows fall
 * back to `startedAt` for their age, which is the only clock they have.
 */
async function findStaleRuns(now: Date, limit: number) {
  const cutoff = new Date(now.getTime() - WORKFLOW_STALE_RUN_AGE_MS);

  return db.workflowRun.findMany({
    where: {
      status: { in: [...ACTIVE_RUN_STATUSES] },
      completedAt: null,
      OR: [
        { lastAdvancedAt: { lt: cutoff } },
        { lastAdvancedAt: null, startedAt: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      status: true,
      stepRuns: {
        select: {
          id: true,
          stepId: true,
          status: true,
          attempts: true,
          startedAt: true,
        },
      },
    },
    orderBy: { lastAdvancedAt: "asc" },
    take: limit,
  });
}

export async function sweepStaleWorkflowRuns({
  now = new Date(),
  limit = WORKFLOW_SWEEP_BATCH_SIZE,
}: {
  now?: Date;
  limit?: number;
} = {}): Promise<SweepOutcome[]> {
  const staleRuns = await findStaleRuns(now, limit);
  const outcomes: SweepOutcome[] = [];

  for (const run of staleRuns) {
    for (const step of run.stepRuns) {
      // --- Already settled; the run is lagging, not stuck. ---
      if (
        step.status === "SUCCESS" ||
        step.status === "FAILED" ||
        step.status === "CANCELLED" ||
        step.status === "SKIPPED" ||
        step.status === "COMPENSATED" ||
        step.status === "COMPENSATION_FAILED"
      ) {
        continue;
      }

      // --- Safe to re-drive: never claimed, so no action ever ran. ---
      if (step.status === "PENDING" && step.startedAt === null) {
        await publishEvent("EXECUTE_WORKFLOW_NODE", {
          runId: run.id,
          stepRunId: step.id,
          kind: "ACTION",
        });

        outcomes.push({
          runId: run.id,
          stepId: step.stepId,
          stepStatus: step.status,
          action: "REDRIVEN",
          reason: "Step was never claimed; its delivery was lost.",
        });
        continue;
      }

      // --- Safe to re-drive: the action itself reported a retriable failure. ---
      // The cap is the wrapper's own, imported rather than restated: a sweeper
      // that re-drove past it would restart a counter the wrapper is already
      // advancing. A step that has already used its attempts falls through to the
      // ambiguous branch below and is surfaced instead of retried.
      if (step.status === "RETRYING" && step.attempts < MAX_RETRIES) {
        await publishEvent("EXECUTE_WORKFLOW_NODE", {
          runId: run.id,
          stepRunId: step.id,
          kind: "ACTION",
        });

        outcomes.push({
          runId: run.id,
          stepId: step.stepId,
          stepStatus: step.status,
          action: "REDRIVEN",
          reason: `Retriable failure at attempt ${step.attempts}; broker retries were exhausted.`,
        });
        continue;
      }

      // --- Ambiguous: claimed, then abandoned. Never re-run. ---
      // `COMPENSATION_FAILED` is absent because the terminal check above already
      // excluded it; the only in-flight compensation status left is this one.
      const isCompensation = step.status === "COMPENSATING";

      const reason =
        `Step was abandoned in ${step.status}. Its action may or may not have ` +
        `taken effect and nothing can determine which, so it was not re-run.`;

      await db.$transaction([
        db.stepRun.update({
          where: { id: step.id },
          data: {
            status: isCompensation ? "COMPENSATION_FAILED" : "FAILED",
            error: reason,
            completedAt: new Date(),
          },
        }),
        db.executionAuditLog.create({
          data: {
            runId: run.id,
            stepId: step.id,
            logLevel: "FATAL",
            eventType: isCompensation
              ? "COMPENSATION_FAILED"
              : "STEP_STALLED_UNKNOWN_OUTCOME",
            message: reason,
          },
        }),
      ]);

      outcomes.push({
        runId: run.id,
        stepId: step.stepId,
        stepStatus: step.status,
        action: "SURFACED",
        reason,
      });
    }

    // Either way the run has been dealt with, so the evaluator is asked to look
    // again. It will pick up the cascade: a newly FAILED critical step pivots
    // into a rollback, and an otherwise-finished run converges.
    await advanceWorkflow(run.id);
  }

  return outcomes;
}
