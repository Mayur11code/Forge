import { db } from "@/lib/prisma/db";
import { getAction } from "@/lib/workflow-types/action-registry";
import { appendStepOutputToContext } from "./state";
import { ActionContext } from "@/lib/workflow-types/type";
import type { JsonValue } from "@/lib/workflow-types/type";
import type { StepExecutionStatus } from "@prisma/client";
import { Redis } from '@upstash/redis';
import { pusherServer } from "@/lib/pusher/pusher-server";


export const redis = Redis.fromEnv();

/**
 * How many times a single step may be attempted before it fails for good.
 *
 * Exported because the stale-run sweeper has to respect the same ceiling: it
 * re-drives `RETRYING` steps whose broker retries were exhausted, and a sweeper
 * that re-drove past this cap would restart a counter the wrapper is already
 * advancing, turning a bounded retry policy into an unbounded one. A second
 * literal `3` here would be the same rule stated twice, and the two would drift
 * the first time either was edited.
 */
export const MAX_RETRIES = 3;

/**
 * Push a step's status to the browser.
 *
 * Awaited, and the failure swallowed, on purpose. A status broadcast is a
 * convenience for a live dashboard, not part of the run's state machine: if
 * Pusher is unreachable, the step must still be recorded in Postgres and the
 * run must still advance. Awaiting it keeps the broadcast ordered relative to
 * the database write it reports, which a fire-and-forget call would not.
 *
 * The channel name matches the frontend hook: `private-workflow-${runId}`.
 */
const broadcastStatus = async (runId: string, stepId: string, status: string) => {
  await pusherServer
    .trigger(`private-workflow-${runId}`, "STEP_STATE_CHANGE", {
      stepId,
      status,
      timestamp: Date.now(),
    })
    .catch((err) =>
      console.error(`[PUSHER] Failed to broadcast status for ${stepId}:`, err),
    );
};

export async function wrapStepOperation(
  runId: string,
  stepId: string,
  actionId: string,
  kind: "TRIGGER" | "ACTION",
  // Optional: Only provided during EXECUTE. Compensate pulls from the DB.
  resolvedInputs?: Record<string, any>,
  operation: "EXECUTE" | "COMPENSATE" = "EXECUTE"
) {
  // 1. FETCH THE STEP STATE
  const stepRun = await db.stepRun.findFirst({
    where: { runId, stepId },
    include: { run: true }
  });

  if (!stepRun) {
    throw new Error(`CRITICAL: StepRun ${stepId} not found for Run ${runId}`);
  }
  console.log(kind, "kind");


  console.log(`[${new Date().toISOString()}] 🔍 Worker: Attempting to claim step ${stepId} for ${operation}`);


  if (
    kind ===
    "TRIGGER"
  ) {


    
    console.log(
      `[TRIGGER] Auto-completing ${stepId} since it's a trigger.`

    );


    await db.stepRun.update({
      where: {
        id: stepRun.id,
      },
      data: {
        status: "SUCCESS",
        completedAt:
          new Date(),
      },
    });

    await broadcastStatus(runId, stepRun.stepId, "SUCCESS");
    return { success: true };
  }
  // 2. PRE-FLIGHT: Atomic Claim
  //
  // The claim is a compare-and-set over a SET of statuses rather than one
  // status, because a redelivery does not arrive in the state the first
  // delivery left it in. QStash retries when this route answers 500, and a
  // retriable action failure parks the step in RETRYING - so a forward claim has
  // to accept PENDING (never attempted) and RETRYING (attempted, will be tried
  // again). Claiming only PENDING made every retry fail its own claim and report
  // success, stranding the step in RETRYING forever.
  //
  // The compensation side has the identical shape for the identical reason:
  // COMPENSATING is a retriable compensation failure, and SUCCESS is a forward
  // success that has not been reversed yet.
  const claimableFrom: StepExecutionStatus[] =
    operation === "EXECUTE" ? ["PENDING", "RETRYING"] : ["SUCCESS", "COMPENSATING"];

  const runningStatus = operation === "EXECUTE" ? "RUNNING" : "COMPENSATING";

  const claimResult = await db.stepRun.updateMany({
    where: { id: stepRun.id, status: { in: claimableFrom } },
    data: {
      status: runningStatus,
      startedAt: stepRun.startedAt || new Date(),
      // Only overwrite inputs if we are executing forward
      ...(operation === "EXECUTE" && resolvedInputs ? { inputs: resolvedInputs } : {})
    },
  });

  if (claimResult.count === 0) {
    console.warn(`[WRAPPER] Step ${stepId} is already claimed. Aborting ghost execution.`);
    return { success: true };
  }



  // 🔊 BROADCAST: Step has started
  await broadcastStatus(runId, stepRun.stepId, runningStatus);



  // Audit Log
  await db.executionAuditLog.create({
    data: {
      runId,
      stepId: stepRun.id,
      logLevel: "INFO",
      eventType: operation === "EXECUTE" ? "STEP_STARTED" : "COMPENSATION_STARTED",
      message: `Began ${operation} of action: ${actionId} (Attempt ${stepRun.attempts + 1})`,
      payload: operation === "EXECUTE" ? resolvedInputs || {} : { inputs: stepRun.inputs, outputs: stepRun.outputs },
    }
  });



  // 3. ACTION LOOKUP
  const action = getAction(actionId);
  if (!action) {
    return await handleFailure(stepRun, operation, "Action not found in registry", false);
  }

  // 4. EXECUTION SANDBOX
  const startTime = Date.now();
  try {
    let result;

    if (operation === "EXECUTE") {
      const context: ActionContext = {
        workflowId: stepRun.run.workflowId,
        runId,
        stepId,
        inputs: resolvedInputs || {},
      };
      result = await action.execute(context);
    }
    else {
      // THE SAGA PATH
      if (!action.compensate) {
        // If an action doesn't define a compensate function, it trivially succeeds.
        result = { success: true, data: { status: "no_compensation_required" } };
      } else {
        const context = {
          workflowId: stepRun.run.workflowId,
          runId,
          stepId,
          // JSONB read boundary. These blobs are whatever the resolver wrote and
          // whatever the forward step returned, so they are re-typed at the
          // point of deserialisation rather than trusted as a shape.
          inputs: stepRun.inputs as Record<string, JsonValue>,
          outputs: stepRun.outputs as JsonValue, // Historical outputs!
        };
        result = await action.compensate(context);
      }
    }

    const latencyMs = Date.now() - startTime;

    // 5A. POST-FLIGHT: ACTION RETURNED CONTROLLED FAILURE
    if (!result.success) {
      return await handleFailure(stepRun, operation, result.error || "Unknown Action Error", result.isRetriable, latencyMs);
    }

    // 5B. POST-FLIGHT: SUCCESS
    if (operation === "EXECUTE") {
      // Forward path writes to global context
      await appendStepOutputToContext(runId, stepId, result.data || {});

      await db.stepRun.update({
        where: { id: stepRun.id },
        data: { status: "SUCCESS", completedAt: new Date(), outputs: result.data || {} },
      });

      // 🔊 BROADCAST: Forward execution succeeded
      await broadcastStatus(runId, stepRun.stepId, "SUCCESS");
    } else {
      // Reverse path does NOT write to global context, it just marks as COMPENSATED
      await db.stepRun.update({
        where: { id: stepRun.id },
        data: { status: "COMPENSATED" },
      });

      // 🔊 BROADCAST: Rollback execution succeeded
      await broadcastStatus(runId, stepRun.stepId, "COMPENSATED");
    }

    await db.executionAuditLog.create({
      data: {
        runId,
        stepId: stepRun.id,
        logLevel: "INFO",
        eventType: operation === "EXECUTE" ? "STEP_SUCCESS" : "COMPENSATION_SUCCESS",
        message: `Action ${operation} completed successfully in ${latencyMs}ms`,
        payload: result.data || {},
        latencyMs,
      }
    });

    return { success: true };

  } catch (uncaughtError: any) {
    // 5C. POST-FLIGHT: UNCAUGHT CRASH
    const latencyMs = Date.now() - startTime;
    return await handleFailure(stepRun, operation, uncaughtError.message, true, latencyMs);
  }
}

/**
 * Helper utility to manage the complex math of retries and failure states
 */
async function handleFailure(
  stepRun: any,
  operation: "EXECUTE" | "COMPENSATE",
  errorMessage: string,
  isRetriable: boolean = false,
  latencyMs: number = 0
) {
  // Fix 6: Isolate the counters
  const currentAttempts = operation === "EXECUTE" ? stepRun.attempts : stepRun.compensationAttempts;
  const newAttempts = currentAttempts + 1;
  const shouldRetry = isRetriable && newAttempts < MAX_RETRIES;

  // Fix 1: Proper TypeScript let + union type
  let finalStatus: "RETRYING" | "FAILED" | "COMPENSATING" | "COMPENSATION_FAILED";

  if (operation === "EXECUTE") {
    finalStatus = shouldRetry ? "RETRYING" : "FAILED";
  } else {
    finalStatus = shouldRetry ? "COMPENSATING" : "COMPENSATION_FAILED";
  }

  await db.$transaction([
    db.stepRun.update({
      where: { id: stepRun.id },
      data: {
        status: finalStatus,
        error: errorMessage,
        // Update the correct counter column
        ...(operation === "EXECUTE" ? { attempts: newAttempts } : { compensationAttempts: newAttempts }),
        ...(finalStatus === "FAILED" ? { completedAt: new Date() } : {})
      },
    }),
    db.executionAuditLog.create({
      data: {
        runId: stepRun.runId,
        stepId: stepRun.id,
        logLevel: shouldRetry ? "WARN" : "FATAL",
        eventType: operation === "EXECUTE" ?
          (shouldRetry ? "STEP_RETRYING" : "STEP_FAILED") :
          (shouldRetry ? "COMPENSATION_RETRYING" : "COMPENSATION_FAILED"),
        message: errorMessage,
        latencyMs,
      }
    })
  ]);

  // 🔊 BROADCAST: Failure or Retry state
  await broadcastStatus(stepRun.runId, stepRun.stepId, finalStatus);

  return { success: false, status: finalStatus, error: errorMessage };
}