// src/lib/workflow/execution/evaluator.ts
//
// The workflow evaluator: one pass of "look at the run, do whatever is now
// possible, stop".
//
// Three properties this file is responsible for, all of which the previous
// version got wrong in ways that were individually invisible and collectively
// fatal:
//
//   1. NO LOST WAKEUP. A pass that cannot take the run lock must leave a
//      durable, idempotent trace that re-enters later. It is not enough to
//      "try again" inside the loser, because the loser is the process that lost
//      the race; the wakeup has to outlive the request that dropped it.
//
//   2. ERRORS PROPAGATE. A swallowed exception means a graph that is stuck and a
//      QStash message that was acknowledged anyway. The only thing this file
//      treats as non-error is lock contention, and that is handled explicitly
//      and separately.
//
//   3. THE LOCK IS HELD FOR AS LONG AS THE WORK. Dispatching N steps is N
//      network round trips; a flat TTL would lapse mid-fan-out and a second
//      evaluator would start concurrently.
//
// Re-entry is durable (a delayed QStash publish), not in-process. This engine
// runs on serverless, so there is nothing to `queueMicrotask` into: the process
// that loses a wakeup is frequently a container that is about to be frozen and
// destroyed, and anything scheduled on its event loop dies with it.

import crypto from "crypto";

import { db } from "@/lib/prisma/db";
import { publishEvent, type PublishDelay } from "@/lib/events/queue";
import { acquireLock, releaseLock, startRunLockHeartbeat } from "./mutex";
import { WorkflowDefinitionSchema } from "@/lib/workflow-types/workflow";

/**
 * Whether a thrown value is Prisma's unique-constraint violation.
 *
 * The evaluator only cares about one specific code. Narrowing on `unknown` rather
 * than annotating the catch as `any` keeps the check honest: a Prisma error
 * arrives as an object carrying `code`, and anything else reaching here is a real
 * fault that must propagate.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

/**
 * Reads the branch label a conditional step published.
 *
 * `StepRun.outputs` is a JSONB column holding whatever the action returned, so
 * the read has to be a check rather than a property access. Returning undefined
 * for a non-object or a missing key is deliberate: a parent that produced no
 * branch satisfies no condition, which sends its dependants down the skip path
 * instead of running them on undefined.
 */
function readBranch(outputs: unknown): string | undefined {
  if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
    return undefined;
  }

  const branch = (outputs as Record<string, unknown>).branch;

  return typeof branch === "string" ? branch : undefined;
}

/**
 * How many times one `advanceWorkflow` call will re-read the run and act again
 * while still holding the lock.
 *
 * Some transitions cascade: marking a step CANCELLED can make its dependants
 * SKIPPED, which can make theirs CANCELLED. The old code handled that with
 * `queueMicrotask`, which is both unawaitable and process-local. Looping in-lock
 * fixes both, but an unbounded loop is its own hazard - a cycle in the persisted
 * graph (which Phase 7 now rejects at write time, but historical rows predate
 * that) would spin until the TTL lapsed. So it is bounded, and the bound is
 * asserted by a test rather than assumed.
 */
const MAX_EVALUATION_PASSES = 25;

/**
 * Re-entry delay after losing the run lock.
 *
 * A holder is inside at most a few dispatch round trips, and the lock TTL is 5s,
 * so waiting longer than that mostly adds latency to a run that is about to
 * progress on its own. This is the same magnitude as the second rung of the
 * agent outbox backoff (`AGENT_OUTBOX_BACKOFF_MS`, `[1s, 5s, 15s, 60s, 300s]`)
 * rather than a number invented here: short enough to be unnoticeable, long
 * enough that the winner is very likely finished.
 */
const CONTENTION_REENTRY_DELAY: PublishDelay = "5s";

/**
 * Backstop re-entry delay for a run that is still waiting on dispatched steps.
 *
 * This is the safety net, not the main path, so it must be long enough that a
 * healthy run never trips it: a step is a QStash delivery plus one action call,
 * and if the normal wakeups are working this publish is always deduplicated away
 * before it fires. 30s sits above a normal step and far below the five-minute
 * maintenance interval, so a genuinely stuck run is noticed long before the
 * stale sweeper in `maintenance.ts` has to own it.
 */
const BACKSTOP_REENTRY_DELAY: PublishDelay = "30s";

export type AdvanceOutcome =
  /** Did at least one useful thing. */
  | "ADVANCED"
  /** Nothing to do, and nothing outstanding. The run is settled. */
  | "TERMINAL"
  /** Another worker owns the run; a durable re-entry has been scheduled. */
  | "CONTENDED"
  /** The lock lapsed mid-pass. No new work was scheduled from here. */
  | "LOCK_LOST";

/**
 * Deterministic QStash `deduplicationId` for one logical re-entry.
 *
 * Hashed and prefixed for the same reason the agent outbox's version is: the raw
 * value is a run id and a status signature, and QStash rejects some characters
 * outright while accepting others inconsistently across SDK versions. A hash has
 * neither problem.
 */
function buildAdvanceDeduplicationId(runId: string, fingerprint: string) {
  return `workflow-advance-${crypto
    .createHash("sha256")
    .update(`${runId}:${fingerprint}`)
    .digest("hex")}`;
}

/**
 * A stable description of everything the evaluator would look at next time.
 *
 * The backstop publish is keyed on this, which is what makes the safety net
 * cheap instead of a second scheduler: if the graph has not moved, the
 * fingerprint is identical, the broker drops the duplicate, and a run that is
 * merely waiting does not accumulate a publish per pass. When the graph does
 * move, the fingerprint changes and a fresh backstop is armed.
 */
function fingerprintStepRuns(stepRuns: Array<{ stepId: string; status: string }>) {
  return stepRuns
    .map((row) => `${row.stepId}:${row.status}`)
    .sort()
    .join("|");
}

async function scheduleReentry(
  runId: string,
  fingerprint: string,
  delay: PublishDelay,
) {
  await publishEvent("ADVANCE_WORKFLOW", { runId }, delay, {
    deduplicationId: buildAdvanceDeduplicationId(runId, fingerprint),
  });
}

type PassResult = {
  /** Whether another in-lock pass could usefully do something. */
  progressed: boolean;
  /**
   * Whether this pass durably changed the run.
   *
   * Distinct from `progressed`, and the distinction matters: dispatching a step
   * changes state without warranting another read (the step completes via its
   * own webhook), while cancelling a skipped node both changes state and makes
   * its dependants re-examinable. The stale-run sweeper keys off this one -
   * touching `lastAdvancedAt` on a pass that merely observed a run waiting for
   * a slow step would let the backstop keep a genuinely stuck run looking
   * healthy forever.
   */
  changed: boolean;
  /** Whether the run is settled and should not be re-armed. */
  terminal: boolean;
  /** Status signature of the step runs as last observed. */
  fingerprint: string;
};

/**
 * One pass over the run.
 *
 * Reads its own snapshot every call, so a loop that acts twice in a row cannot
 * decide from stale state - which is precisely the bug that made the original
 * single-pass version drop wakeups.
 */
async function evaluateOnce(runId: string): Promise<PassResult> {
  const run = await db.workflowRun.findUnique({
    where: { id: runId },
    include: {
      workflow: true,
      stepRuns: true,
    },
  });

  if (!run) {
    // Not contention and not "nothing to do": the run this message refers to is
    // gone. Throwing keeps it visible instead of being acknowledged as done.
    throw new Error(`WorkflowRun not found: ${runId}`);
  }

  const fingerprint = fingerprintStepRuns(run.stepRuns);

  if (
    run.status !== "RUNNING" &&
    run.status !== "PENDING" &&
    run.status !== "ROLLING_BACK"
  ) {
    // Settled already. Nothing is written, so this pass must not count as
    // progress - otherwise a stale-run sweep would keep re-arming a finished
    // run's progress timestamp on every re-entry delivery.
    return { progressed: false, changed: false, terminal: true, fingerprint };
  }

  // The definition is the one input every decision below depends on, so it is
  // validated at the read boundary rather than cast. A malformed definition used
  // to yield a run that simply never advanced - no dispatch, no error, no
  // terminal state, and nothing in the logs to explain it. Phase 7 rejects bad
  // graphs at write time, so this mostly catches rows that predate it; for those,
  // a named failure is strictly better than a silent hang.
  const parsedDefinition = WorkflowDefinitionSchema.safeParse(run.workflow.definition);

  if (!parsedDefinition.success) {
    throw new Error(
      `Workflow ${run.workflow.id} has an invalid definition: ${parsedDefinition.error.issues
        .map((issue) => `${issue.path.join(".") || "definition"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const steps = parsedDefinition.data.steps;
  const existingStepRuns = run.stepRuns;

  // ====================================================================
  // --- SAGA PIVOT (interception) ---
  // ====================================================================
  if (run.status === "RUNNING") {
    const hasCriticalFailure = existingStepRuns.some(
      (stepRun) =>
        stepRun.status === "FAILED" && steps[stepRun.stepId]?.isCritical,
    );

    if (hasCriticalFailure) {
      console.warn(`[SAGA] Critical failure detected in run ${runId}. Initiating rollback.`);

      await db.workflowRun.update({
        where: { id: runId },
        data: { status: "ROLLING_BACK" },
      });

      // Re-read and do the reverse math in this same locked pass. The previous
      // version released the lock and re-entered via `queueMicrotask`, which
      // meant the continuation existed only on an event loop that a serverless
      // freeze could take with it.
      return { progressed: true, changed: true, terminal: false, fingerprint };
    }
  }

  // ====================================================================
  // --- REVERSE TOPOLOGICAL MATH (the rollback pass) ---
  // ====================================================================
  if (run.status === "ROLLING_BACK") {
    // Parent step id -> child step ids.
    const childMap = new Map<string, string[]>();

    for (const [stepId, node] of Object.entries(steps)) {
      const dependencies = node.dependsOn;

      for (const parentId of dependencies) {
        if (!childMap.has(parentId)) {
          childMap.set(parentId, []);
        }
        childMap.get(parentId)!.push(stepId);
      }
    }

    const stepRunByStepId = new Map(existingStepRuns.map((sr) => [sr.stepId, sr]));

    const readyToCompensateIds: string[] = [];
    const readyToCancelIds: string[] = [];

    for (const stepRun of existingStepRuns) {
      // Only SUCCESS nodes have anything to compensate. FAILED nodes are
      // already dead and SKIPPED nodes never ran.
      if (stepRun.status !== "SUCCESS") {
        if (stepRun.status === "SKIPPED") readyToCancelIds.push(stepRun.stepId);
        continue;
      }

      // A node can only be reversed once everything downstream of it is dead.
      // A dependant that never started cannot block us; a dependant that is
      // mid-compensation can, because reversing its parent out from under it
      // would undo the very state its compensation is reading.
      let isReadyToReverse = true;

      for (const childId of childMap.get(stepRun.stepId) || []) {
        const childRun = stepRunByStepId.get(childId);
        if (!childRun) continue;

        if (
          childRun.status === "SUCCESS" ||
          childRun.status === "RUNNING" ||
          childRun.status === "COMPENSATING"
        ) {
          isReadyToReverse = false;
          break;
        }
      }

      if (isReadyToReverse) {
        readyToCompensateIds.push(stepRun.stepId);
      }
    }

    if (readyToCancelIds.length > 0) {
      await db.stepRun.updateMany({
        where: { runId, stepId: { in: readyToCancelIds } },
        data: { status: "CANCELLED" },
      });

      // Cancelling skipped nodes can make their dependants cancel in turn, so
      // this is a cascading transition and another in-lock pass is worthwhile.
      return { progressed: true, changed: true, terminal: false, fingerprint };
    }

    if (readyToCompensateIds.length > 0) {
      console.log(
        `[SAGA] Pushing ${readyToCompensateIds.length} nodes to compensate:`,
        readyToCompensateIds,
      );

      await Promise.all(
        readyToCompensateIds.map(async (stepId) => {
          const stepRun = stepRunByStepId.get(stepId);
          if (!stepRun) return;

          // The wrapper claims a compensation by its persisted status rather
          // than being told which operation to run, so nothing here has to
          // transition the row first.
          await publishEvent("EXECUTE_WORKFLOW_NODE", {
            runId,
            stepRunId: stepRun.id,
            kind: steps[stepId].kind || "ACTION",
          });
        }),
      );

      // The compensations are now external work in flight. Looping again would
      // only re-read the same state.
      return { progressed: false, changed: false, terminal: false, fingerprint };
    }

    // --- TERMINAL CONVERGENCE (the clean exit) ---
    const allDone = existingStepRuns.every(
      (s) =>
        s.status === "COMPENSATED" ||
        s.status === "CANCELLED" ||
        s.status === "FAILED" ||
        s.status === "COMPENSATION_FAILED",
    );

    if (allDone) {
      // A failed compensation is a dead letter: something with an external side
      // effect could not be undone and a human has to look at it.
      const hasDeadLetters = existingStepRuns.some(
        (s) => s.status === "COMPENSATION_FAILED",
      );

      await db.workflowRun.update({
        where: { id: runId },
        data: {
          status: hasDeadLetters ? "REQUIRES_INTERVENTION" : "ROLLED_BACK",
          completedAt: new Date(),
        },
      });

      return { progressed: false, changed: true, terminal: true, fingerprint };
    }

    return { progressed: false, changed: false, terminal: false, fingerprint };
  }

  // ====================================================================
  // --- FORWARD PASS ---
  // ====================================================================
  const stepRunMap = new Map(existingStepRuns.map((sr) => [sr.stepId, sr]));

  const readyStepIds: string[] = [];
  const cancelledStepIds: string[] = [];
  const skippedStepIds: string[] = [];

  for (const [stepId, node] of Object.entries(steps)) {
    // A step that already has a row has been decided. This is the single check
    // that makes the evaluator safe to run concurrently: it is the only place a
    // step can be "created", and the database's unique (runId, stepId) is the
    // backstop underneath it.
    if (stepRunMap.get(stepId)) continue;

    const dependencies = node.dependsOn;

    let shouldCancel = false;
    let shouldSkip = false;
    let successCount = 0;
    let skippedCount = 0;
    let isReady = true;

    for (const depId of dependencies) {
      const parentStatus = stepRunMap.get(depId)?.status;

      if (parentStatus === "FAILED" || parentStatus === "CANCELLED") {
        shouldCancel = true;
        isReady = false;
        break;
      }

      if (parentStatus === "SKIPPED") {
        skippedCount++;
        continue;
      }

      if (parentStatus === "SUCCESS") {
        // Conditional branches: a dependant only runs if the parent produced
        // the branch it asked for.
        const requiredBranch = node.routingConditions?.[depId];
        const actualBranch = readBranch(stepRunMap.get(depId)?.outputs);

        if (requiredBranch && actualBranch !== requiredBranch) {
          shouldSkip = true;
          isReady = false;
          break;
        }

        successCount++;
        continue;
      }

      isReady = false;
    }

    if (shouldCancel) {
      cancelledStepIds.push(stepId);
    } else if (
      shouldSkip ||
      (dependencies.length > 0 && skippedCount === dependencies.length)
    ) {
      skippedStepIds.push(stepId);
    } else if (isReady && (successCount > 0 || dependencies.length === 0)) {
      readyStepIds.push(stepId);
    }
  }

  if (cancelledStepIds.length > 0 || skippedStepIds.length > 0) {
    // These cascade: a skipped node can make its dependants skipped. The old
    // code released the lock here and hopped back in on a microtask; this is
    // the same cascade resolved inside the pass that already holds the lock.
    if (cancelledStepIds.length > 0) {
      await db.stepRun.createMany({
        data: cancelledStepIds.map((stepId) => ({
          runId,
          stepId,
          status: "CANCELLED",
        })),
      });
    }

    if (skippedStepIds.length > 0) {
      await db.stepRun.createMany({
        data: skippedStepIds.map((stepId) => ({
          runId,
          stepId,
          status: "SKIPPED",
        })),
      });
    }

    return { progressed: true, changed: true, terminal: false, fingerprint };
  }

  if (readyStepIds.length > 0) {
    console.log(`[EVALUATOR] Run ${runId} dispatching ${readyStepIds.length} steps.`);

    await Promise.all(
      readyStepIds.map(async (stepId) => {
        try {
          const stepRun = await db.stepRun.create({
            data: { runId, stepId, status: "PENDING" },
          });

          await publishEvent("EXECUTE_WORKFLOW_NODE", {
            runId,
            stepRunId: stepRun.id,
            kind: steps[stepId].kind || "ACTION",
          });
        } catch (error: unknown) {
          // P2002 is the unique (runId, stepId) constraint doing its job: a
          // concurrent evaluator already created this step. That is a success
          // for us, not a failure. Anything else is a real fault and must
          // propagate - swallowing it leaves a step that exists and will never
          // be dispatched, because the row is PENDING and nothing owns it.
          if (isUniqueConstraintViolation(error)) {
            console.warn(
              `[EVALUATOR] Step ${stepId} already exists for run ${runId}; concurrent pass won.`,
            );
            return;
          }

          throw error;
        }
      }),
    );

    // Real work was started, and it completes via its own webhook. A backstop is
    // still armed, keyed on the state we just left behind, so a lost completion
    // webhook is recoverable.
    return { progressed: false, changed: false, terminal: false, fingerprint };
  }

  // Nothing left to dispatch. Re-read before declaring the run done: the
  // snapshot above may predate a step that another pass has just finished, and
  // concluding "done" from a stale read is how a run gets closed with work
  // still in it.
  const latestStepRuns = await db.stepRun.findMany({ where: { runId } });
  const latestMap = new Map(latestStepRuns.map((sr) => [sr.stepId, sr]));

  const allDone = Object.keys(steps).every((stepId) => {
    const status = latestMap.get(stepId)?.status;
    return (
      status === "SUCCESS" ||
      status === "CANCELLED" ||
      status === "FAILED" ||
      status === "SKIPPED"
    );
  });

  if (allDone) {
    await db.workflowRun.update({
      where: { id: runId },
      data: {
        status: latestStepRuns.some((s) => s.status === "FAILED")
          ? "FAILED"
          : "COMPLETED",
        completedAt: new Date(),
      },
    });

    return { progressed: false, changed: true, terminal: true, fingerprint };
  }

  return { progressed: false, changed: false, terminal: false, fingerprint };
}

/**
 * Advance a run as far as it can go right now.
 *
 * Contention resolves to a scheduled re-entry and a normal return. Everything
 * else throws. Callers use that distinction directly: a throw means the caller
 * should return a 5xx so the delivery is retried, whereas contention means the
 * work is already accounted for and retrying would only add to the pile-up.
 */
export async function advanceWorkflow(runId: string): Promise<AdvanceOutcome> {
  let token: string | null;

  try {
    token = await acquireLock(runId);
  } catch (error) {
    // Deliberately not folded into the contention path below. A Redis fault
    // means no lock was taken AND no re-entry was scheduled, so reporting it as
    // contention would claim the run was being looked after when in fact
    // nothing has been arranged at all.
    throw new Error(`Failed to acquire the run lock for workflow run ${runId}`, {
      cause: error,
    });
  }

  if (token === null) {
    // Someone else owns this run. Their pass may have started before the work
    // that made it worth waking for, so scheduling the re-entry is the whole
    // point - the loser is the only party that knows a wakeup is needed.
    console.log(
      `[EVALUATOR] Run ${runId} is locked by another worker; scheduling re-entry.`,
    );

    await scheduleReentry(runId, "contended", CONTENTION_REENTRY_DELAY);

    return "CONTENDED";
  }

  const heartbeat = startRunLockHeartbeat(runId, token);
  let released = false;

  const safeRelease = async () => {
    if (released) return;
    released = true;
    await releaseLock(runId, token);
  };

  try {
    let result: PassResult = {
      progressed: false,
      changed: false,
      terminal: true,
      fingerprint: "",
    };
    let changed = false;

    for (let pass = 0; pass < MAX_EVALUATION_PASSES; pass++) {
      // A lapsed lock means a second evaluator is live on this run. Continuing
      // to fan out would mean two of them both believing they own it, so the
      // pass stops here and leaves the backstop to the winner.
      if (heartbeat.hasLostOwnership()) {
        console.error(
          `[EVALUATOR] Lost the lock for run ${runId} mid-pass; not scheduling further work.`,
        );
        return "LOCK_LOST";
      }

      result = await evaluateOnce(runId);
      changed = changed || result.changed;

      if (!result.progressed) break;
    }

    if (heartbeat.hasLostOwnership()) {
      return "LOCK_LOST";
    }

    // Record that this run moved, and when. This is the only signal the stale
    // sweep has, and it has to be written from inside the run lock: a timestamp
    // updated outside it could be interleaved with a second evaluator's writes
    // and describe a state that never existed.
    //
    // Only when something actually changed. A pass that found a healthy run
    // waiting on an in-flight step is evidence of life, not of progress, and
    // treating it as progress would let the backstop keep a wedged run looking
    // fresh indefinitely.
    if (changed) {
      await db.workflowRun.update({
        where: { id: runId },
        data: { lastAdvancedAt: new Date() },
      });
    }

    if (!result.terminal) {
      // The run is mid-flight, so arm the backstop. Keyed on the current
      // signature: identical state deduplicates, moved state re-arms.
      await scheduleReentry(runId, result.fingerprint, BACKSTOP_REENTRY_DELAY);
    }

    return "ADVANCED";
  } finally {
    heartbeat.stop();
    await safeRelease();
  }
}
