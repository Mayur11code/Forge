import { db } from "@/lib/prisma/db";
import { getAction } from "@/lib/workflow-types/action-registry";
import { appendStepOutputToContext } from "./state";
import { ActionContext } from "@/lib/workflow-types/type";

const MAX_RETRIES = 3;

export async function wrapStepOperation(
  runId: string,
  stepId: string,
  actionId: string,
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

  console.log(`[${new Date().toISOString()}] 🔍 Worker: Attempting to claim step ${stepId} for ${operation}`);

  // 2. PRE-FLIGHT: Atomic Claim
  // We use different target statuses based on the operation
  const targetStatus = operation === "EXECUTE" ? "PENDING" : "COMPENSATING";
  const runningStatus = operation === "EXECUTE" ? "RUNNING" : "COMPENSATING"; // Assuming we don't have a COMPENSATING_RUNNING state

  const claimResult = await db.stepRun.updateMany({
    where: { id: stepRun.id, status: targetStatus },
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
          inputs: stepRun.inputs as Record<string, any>,
          outputs: stepRun.outputs as Record<string, any> // Historical outputs!
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
    } else {
      // Reverse path does NOT write to global context, it just marks as COMPENSATED
      await db.stepRun.update({
        where: { id: stepRun.id },
        data: { status: "COMPENSATED" },
      });
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
  const newAttempts = stepRun.attempts + 1;
  const shouldRetry = isRetriable && newAttempts < MAX_RETRIES;

  // Decide the final status based on the operation
  let finalStatus:
    | "RETRYING"
    | "FAILED"
    | "COMPENSATING"
    | "COMPENSATION_FAILED";

    
  if (operation === "EXECUTE") {
    finalStatus = shouldRetry ? "RETRYING" : "FAILED";
  } else {
    // We agreed on Option B: Database tracking for dead letters
    finalStatus = shouldRetry ? "COMPENSATING" : "COMPENSATION_FAILED";
  }

  await db.$transaction([
    db.stepRun.update({
      where: { id: stepRun.id },
      data: {
        status: finalStatus,
        error: errorMessage,
        attempts: newAttempts,
        // Only mark completedAt if it's a hard forward failure
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

  return { success: false, status: finalStatus, error: errorMessage };
}