// src/app/api/workflow/wf.ts
//
// The workflow engine's event handler.
//
// WHY THIS IS A SEPARATE MODULE
// ------------------------------
// These two events - EXECUTE_WORKFLOW_NODE and ADVANCE_WORKFLOW - are the
// engine's only way of making progress, and they are published to the single
// "events" QStash topic. With USE_MULTI_TOPICS=false that topic has exactly
// one endpoint, and on the free tier that endpoint is /api/worker.
//
// The handlers used to live only in src/app/api/workflow/route.ts, so they
// were reachable only at /api/workflow - a URL that nothing publishes to.
// Every delivery therefore landed on /api/worker, which had no case for these
// two event types, and the dispatcher answered 500 "No handler configured for
// known event". QStash retried three times, the message died, and the run sat
// at RUNNING with its step PENDING for ever.
//
// That is a live, blocking defect: no workflow could ever execute a single
// step, however it was started.
//
// The handlers now live here so that BOTH routes can serve them:
//   * /api/workflow keeps its own dedicated endpoint, and
//   * /api/worker dispatches the two event types to the same code.
//
// The status codes are load-bearing and are preserved exactly as they were.
// QStash deletes a message on 2xx and retries it on 5xx, so returning 200 for
// something that did not happen is the same as dropping it: a step that was
// never executed and a run that will never be re-evaluated both look identical
// to the broker from a "success" response. The rule this file follows is that
// 2xx means the work is either done or durably scheduled, and 5xx means
// neither, and only the second case retries.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma/db";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import { wrapStepOperation } from "@/lib/workflow/execution/wrapper";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { verifyWorkflowSnapshotIntegrity } from "@/lib/workflow/validation/canonical-hash";
import type { JsonValue } from "@/lib/workflow-types/type";
import type { StepExecutionStatus } from "@prisma/client";

type CloudEventWrapper = {
  type: string;
  data:
    | { runId: string; stepRunId: string; kind: string }
    | { runId: string };
};

/**
 * Re-evaluate a run and report the outcome honestly.
 *
 * `advanceWorkflow` resolves normally for both real progress and for lock
 * contention - in the contention case it has already scheduled a durable
 * re-entry - so a 2xx here means the run is accounted for. A throw means it is
 * not, and QStash must redeliver.
 */
async function handleAdvanceWorkflow(runId: string) {
  try {
    const outcome = await advanceWorkflow(runId);
    return new NextResponse(`Advanced run ${runId}: ${outcome}`, { status: 200 });
  } catch (error) {
    // Not swallowed, and not logged on the way out to a 200. This is the case
    // the previous `.catch(console.error)` silently converted into an
    // acknowledged message, leaving a run that nothing would ever revisit.
    console.error(
      `[WORKER] Evaluator failed for run ${runId}; asking QStash to redeliver.`,
      error,
    );
    return new NextResponse("Evaluator failed", { status: 500 });
  }
}

async function handleExecuteWorkflowNode(
  stepRunId: string,
  runId: string,
  kind: string,
) {
  const stepRun = await db.stepRun.findUnique({
    where: { id: stepRunId },
    include: {
      run: {
        include: {
          workflow: true, // We need the DAG definition!
        },
      },
    },
  });

  if (!stepRun) {
    console.error(`[WORKER] StepRun ${stepRunId} not found.`);
    // 404 tells QStash to drop the message. Retrying cannot conjure a row that
    // does not exist, and a run that referenced a deleted step is a retention
    // problem, not a delivery problem.
    return new NextResponse("Not Found", { status: 404 });
  }

  // --- Phase-specific idempotency and operation derivation (F-01) ---
  let operation: "EXECUTE" | "COMPENSATE";

  if (stepRun.run.status === "ROLLING_BACK") {
    // 1. Ghost buster: A run rolling back while a forward step was queued
    // means the step must never run forward.
    if (stepRun.status === "PENDING" || stepRun.status === "RETRYING") {
      console.log(`[WORKER] Ghost busted. Cancelling step ${stepRunId}.`);
      await db.stepRun.update({
        where: { id: stepRunId },
        data: { status: "CANCELLED" },
      });
      await handleAdvanceWorkflow(runId);
      return new NextResponse("Ghost Cancelled", { status: 200 });
    }

    // 2. Rollback terminal statuses: already completed or never ran forward
    const ROLLBACK_TERMINAL_STATUSES: StepExecutionStatus[] = [
      "COMPENSATED",
      "COMPENSATION_FAILED",
      "CANCELLED",
      "SKIPPED",
      "FAILED",
    ];

    if (ROLLBACK_TERMINAL_STATUSES.includes(stepRun.status)) {
      console.log(
        `[WORKER] StepRun ${stepRunId} is already ${stepRun.status} during rollback. Skipping.`,
      );
      return new NextResponse("Already processed", { status: 200 });
    }

    // 3. In-flight compensation: owned by another delivery
    if (stepRun.status === "COMPENSATING") {
      console.log(
        `[WORKER] StepRun ${stepRunId} is COMPENSATING, owned by another delivery. Skipping.`,
      );
      return new NextResponse("In progress", { status: 200 });
    }

    // 4. In-flight forward execution: wait for forward execution to settle
    if (stepRun.status === "RUNNING") {
      console.log(
        `[WORKER] StepRun ${stepRunId} is still RUNNING from forward execution during rollback. Skipping.`,
      );
      return new NextResponse("In progress", { status: 200 });
    }

    // 5. Eligible for compensation
    if (stepRun.status === "SUCCESS" || stepRun.status === "COMPENSATION_RETRYING") {
      operation = "COMPENSATE";
    } else {
      console.log(
        `[WORKER] StepRun ${stepRunId} status ${stepRun.status} unhandled during rollback. Skipping.`,
      );
      return new NextResponse("Already processed", { status: 200 });
    }
  } else if (stepRun.run.status === "RUNNING" || stepRun.run.status === "PENDING") {
    // --- Forward execution phase ---
    const FORWARD_TERMINAL_STATUSES: StepExecutionStatus[] = [
      "SUCCESS",
      "FAILED",
      "CANCELLED",
      "SKIPPED",
      "COMPENSATED",
      "COMPENSATION_FAILED",
    ];

    if (FORWARD_TERMINAL_STATUSES.includes(stepRun.status)) {
      console.log(
        `[WORKER] StepRun ${stepRunId} is already ${stepRun.status}. Skipping.`,
      );
      return new NextResponse("Already processed", { status: 200 });
    }

    if (stepRun.status === "RUNNING") {
      console.log(
        `[WORKER] StepRun ${stepRunId} is RUNNING, owned by another delivery. Skipping.`,
      );
      return new NextResponse("In progress", { status: 200 });
    }

    if (stepRun.status === "COMPENSATING" || stepRun.status === "COMPENSATION_RETRYING") {
      console.log(
        `[WORKER] StepRun ${stepRunId} is in rollback status ${stepRun.status} during forward execution. Skipping.`,
      );
      return new NextResponse("Already processed", { status: 200 });
    }

    if (stepRun.status === "PENDING" || stepRun.status === "RETRYING") {
      operation = "EXECUTE";
    } else {
      return new NextResponse("Already processed", { status: 200 });
    }
  } else {
    // Run is in a terminal state: COMPLETED, ROLLED_BACK, REQUIRES_INTERVENTION, FAILED
    console.log(
      `[WORKER] WorkflowRun ${runId} is terminal (${stepRun.run.status}). StepRun ${stepRunId} (${stepRun.status}) skipped.`,
    );
    return new NextResponse("Already processed", { status: 200 });
  }

  // F-03: Resolve node definition and action version exclusively from immutable snapshot
  const verification = verifyWorkflowSnapshotIntegrity(
    stepRun.run.definitionSnapshot,
    stepRun.run.definitionHash,
  );

  if (!verification.valid) {
    console.error(
      `[WORKER] Snapshot integrity failure for StepRun ${stepRunId} (run: ${stepRun.runId}): ${verification.error}`,
    );
    await db.stepRun.update({
      where: { id: stepRunId },
      data: {
        status: "FAILED",
        error: `Snapshot integrity check failed: ${verification.error}`,
        completedAt: new Date(),
      },
    }).catch((err) => console.warn("[WORKER] Could not update stepRun on integrity failure:", err));
    return new NextResponse(`Snapshot invalid: ${verification.error}`, { status: 400 });
  }

  const snapshot = verification.snapshot;
  const workflowDefinition = snapshot.definition;
  const nodeDefinition = workflowDefinition.steps[stepRun.stepId];

  if (!nodeDefinition) {
    console.error(
      `[WORKER] Node definition missing for StepRun ${stepRunId} (step: ${stepRun.stepId}) in snapshot`,
    );
    await db.stepRun.update({
      where: { id: stepRunId },
      data: {
        status: "FAILED",
        error: "Node definition missing from execution snapshot",
        completedAt: new Date(),
      },
    }).catch((err) => console.warn("[WORKER] Could not update stepRun on missing node:", err));
    return new NextResponse("Node definition missing from execution snapshot", { status: 400 });
  }

  const actionId = nodeDefinition.action;
  const manifestEntry = snapshot.actionManifest.find((m) => m.stepId === stepRun.stepId);
  const actionVersion = manifestEntry?.actionVersion;

  // --- Resolve the `{{...}}` pointers ---
  let resolvedInputs: Record<string, JsonValue> | undefined;
  if (operation === "EXECUTE") {
    const rawInputs = nodeDefinition.config || {};
    // JSONB read boundary. Prisma's Json type is wider than the resolver's, so
    // the context is re-typed at the point of deserialisation rather than cast
    // through `any`. `?? {}` rather than `|| {}`: a falsy-but-valid context is
    // still a context.
    const globalContext = (stepRun.run.context as Record<string, JsonValue>) ?? {};
    resolvedInputs = resolveInputs(rawInputs, globalContext);
  }

  const result = await wrapStepOperation(
    stepRun.runId,
    stepRun.stepId,
    actionId,
    kind as "TRIGGER" | "ACTION",
    resolvedInputs,
    operation,
    actionVersion,
  );

  // --- Dead letter / retry signalling ---
  if (!result.success && "status" in result) {
    if (result.status === "RETRYING" || result.status === "COMPENSATION_RETRYING") {
      console.warn(
        `[WORKER] Step ${stepRun.stepId} failed ${operation}. Triggering QStash retry.`,
      );
      // The step is parked in a retriable state with its attempt counter
      // incremented, so 500 hands the retry to the broker rather than
      // acknowledging a step nobody will finish.
      return new NextResponse("Retrying", { status: 500 });
    }
    // FAILED / COMPENSATION_FAILED are terminal, so fall through and return 200
    // to acknowledge the message. The evaluator picks the run up from there.
  }

  // --- Chain reaction ---
  // Awaited on purpose. The alternative is a `queueMicrotask`, which on a
  // serverless runtime is a continuation that may never run: the response can
  // be written and the container frozen before the microtask is serviced, and
  // then the graph has no wakeup at all. `advanceWorkflow` is one run-lock
  // round trip plus the work it decides to do, and the 200 below is only correct
  // once the evaluator has either advanced the run or scheduled its re-entry.
  console.log(
    `[WORKER] Step ${stepRun.stepId} finished. Triggering engine evaluator...`,
  );
  const advanceResponse = await handleAdvanceWorkflow(runId);

  if (advanceResponse.status === 500) {
    return advanceResponse;
  }

  return new NextResponse("Execution Complete", { status: 200 });
}

/**
 * The handler for both workflow engine events.
 *
 * It is deliberately NOT wrapped in `createWorker`. That wrapper acknowledges
 * the message with a 200 once the handler resolves, which is the right
 * contract for the agent's at-most-once jobs but the wrong one here: the
 * engine's status codes ARE its control channel. A retriable step failure must
 * answer 500 so QStash redelivers it, and `createWorker` would have swallowed
 * that into a 200 and the step would never be retried.
 */
export async function handleWorkflowEvent(req: NextRequest) {
  try {
    const body = (await req.json()) as CloudEventWrapper;

    if (body.type === "ADVANCE_WORKFLOW") {
      return await handleAdvanceWorkflow(body.data.runId);
    }

    if (body.type === "EXECUTE_WORKFLOW_NODE") {
      const { stepRunId, runId, kind } = body.data as {
        runId: string;
        stepRunId: string;
        kind: string;
      };
      return await handleExecuteWorkflowNode(stepRunId, runId, kind);
    }

    console.error(`[WORKER] Unexpected cloud event type: ${body.type}`);
    return new NextResponse("Unsupported event type", { status: 400 });
  } catch (error: unknown) {
    console.error("[WORKER] Unhandled fatal error:", error);
    // 500 so the message is not lost. The step's persisted status is what makes
    // the redelivery safe: the wrapper's claim is a compare-and-set, so a repeat
    // delivery cannot run the action twice.
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
