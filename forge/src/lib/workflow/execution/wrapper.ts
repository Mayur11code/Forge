// src/lib/workflow/execution/wrapper.ts
import { db } from "@/lib/prisma/db";
import { getAction } from "@/lib/workflow-types/action-registry";
import { appendStepOutputToContext } from "./state";
import { ActionContext } from "@/lib/workflow-types/type";

const MAX_RETRIES = 3;

export async function wrapStepExecution(
  runId: string,
  stepId: string,
  actionId: string,
  resolvedInputs: Record<string, any>
) {
  // 1. FETCH THE STEP STATE
  const stepRun = await db.stepRun.findFirst({
    where: { runId, stepId },
    include: { run: true } // Include the parent run to access workflowId
  });

  if (!stepRun) {
    throw new Error(`CRITICAL: StepRun ${stepId} not found for Run ${runId}`);
  }

  // 2. PRE-FLIGHT: Update state to RUNNING and log it
  await db.$transaction([
    db.stepRun.update({
      where: { id: stepRun.id },
      data: { 
        status: "RUNNING", 
        startedAt: stepRun.startedAt || new Date(), // Don't overwrite if this is a retry
        inputs: resolvedInputs 
      },
    }),
    db.executionAuditLog.create({
      data: {
        runId,
        stepId,
        logLevel: "INFO",
        eventType: "STEP_STARTED",
        message: `Began execution of action: ${actionId} (Attempt ${stepRun.attempts + 1})`,
        payload: resolvedInputs,
      }
    })
  ]);

  // 3. ACTION LOOKUP
  const action = getAction(actionId);
  if (!action) {
    // If the developer deleted an action from the registry but an old workflow uses it
    return await handleFailure(stepRun.id, runId, stepId, "Action not found in registry", false);
  }

  // 4. EXECUTION SANDBOX
  const startTime = Date.now();
  try {
    const context: ActionContext = {
      workflowId: stepRun.run.workflowId, // Assuming you included the relation, otherwise pass this in
      runId,
      stepId,
      inputs: resolvedInputs,
    };

    // The actual execution!
    const result = await action.execute(context);
    const latencyMs = Date.now() - startTime;

    // 5A. POST-FLIGHT: ACTION RETURNED CONTROLLED FAILURE
    if (!result.success) {
      return await handleFailure(stepRun.id, runId, stepId, result.error || "Unknown Action Error", result.isRetriable, latencyMs, stepRun.attempts);
    }

    // 5B. POST-FLIGHT: SUCCESS
    // Merge outputs to Global Context (Phase 3)
    await appendStepOutputToContext(runId, stepId, result.data || {});

    // Update StepRun and Audit Log
    await db.$transaction([
      db.stepRun.update({
        where: { id: stepRun.id },
        data: {
          status: "SUCCESS",
          completedAt: new Date(),
          outputs: result.data || {},
        },
      }),
      db.executionAuditLog.create({
        data: {
          runId,
          stepId,
          logLevel: "INFO",
          eventType: "STEP_SUCCESS",
          message: `Action executed successfully in ${latencyMs}ms`,
          payload: result.data || {},
          latencyMs,
        }
      })
    ]);

    return { success: true };

  } catch (uncaughtError: any) {
    // 5C. POST-FLIGHT: UNCAUGHT CRASH (e.g., Syntax error, Out of Memory)
    const latencyMs = Date.now() - startTime;
    return await handleFailure(stepRun.id, runId, stepId, uncaughtError.message, true, latencyMs, stepRun.attempts);
  }
}

/**
 * Helper utility to manage the complex math of retries and failure states
 */
async function handleFailure(
  stepRunId: string,
  runId: string, 
  stepId: string, 
  errorMessage: string, 
  isRetriable: boolean = false,
  latencyMs: number = 0,
  currentAttempts: number = 0
) {
  const newAttempts = currentAttempts + 1;
  // It is only retriable if the Action explicitly says so, AND we haven't hit the limit
  const shouldRetry = isRetriable && newAttempts < MAX_RETRIES;
  const finalStatus = shouldRetry ? "RETRYING" : "FAILED";

  await db.$transaction([
    db.stepRun.update({
      where: { id: stepRunId },
      data: {
        status: finalStatus,
        error: errorMessage,
        attempts: newAttempts,
        ...(finalStatus === "FAILED" ? { completedAt: new Date() } : {}) // Only mark complete if we are giving up
      },
    }),
    db.executionAuditLog.create({
      data: {
        runId,
        stepId,
        logLevel: finalStatus === "FAILED" ? "FATAL" : "WARN",
        eventType: finalStatus === "FAILED" ? "STEP_FAILED" : "STEP_RETRYING",
        message: errorMessage,
        latencyMs,
      }
    })
  ]);

  return { success: false, status: finalStatus, error: errorMessage };
}