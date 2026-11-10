import { db } from "@/lib/prisma/db";
import { getAction } from "@/lib/workflow-types/action-registry";
import { appendStepOutputToContext } from "./state";
import { ActionContext } from "@/lib/workflow-types/type";
import type { JsonValue } from "@/lib/workflow-types/type";
import type { Prisma, StepExecutionStatus } from "@prisma/client";
import { Redis } from '@upstash/redis';
import { pusherServer } from "@/lib/pusher/pusher-server";
import { workflowChannelName } from "@/lib/pusher/workflow-channel";
import {
  claimCompensationAttempt,
  completeCompensationAttempt,
  failCompensationAttempt,
} from "./compensation-claim";


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
 * Renders a caught value as the message stored on the step run and audit log.
 *
 * Anything can be thrown, not just an Error. Reading `.message` off it directly
 * stored `undefined` into StepRun.error for a thrown string, which is the one
 * field an operator has when diagnosing a failed step. The `message` property is
 * still honoured for non-Error throwables that carry one, because Prisma and
 * several SDKs throw that shape.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return String(error);
}

/**
 * Safely extract business object identifiers (e.g. taskId, id, fileId) from step outputs.
 */
function extractBusinessObjectIdentifiers(outputs: unknown): Record<string, JsonValue> {
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    return {};
  }
  const obj = outputs as Record<string, unknown>;
  const identifiers: Record<string, JsonValue> = {};

  const knownKeys = ["taskId", "id", "reportId", "fileId", "entityId", "userId", "orgId"];
  for (const key of knownKeys) {
    const val = obj[key];
    if (val !== undefined && val !== null) {
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        identifiers[key] = val;
      }
    }
  }

  return identifiers;
}

const SENSITIVE_KEY_PATTERN = /password|secret|token|apikey|authorization|auth|privatekey/i;

/**
 * Deeply redact sensitive fields from inputs and outputs before writing to audit logs.
 */
function redactSensitiveData(data: unknown, depth = 0): JsonValue {
  if (depth > 5 || data === undefined || data === null) return null;
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, depth + 1));
  }

  if (typeof data === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSensitiveData(val, depth + 1);
      }
    }
    return result;
  }

  return String(data);
}

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
    .trigger(workflowChannelName(runId), "STEP_STATE_CHANGE", {
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
  resolvedInputs?: Record<string, JsonValue>,
  operation: "EXECUTE" | "COMPENSATE" = "EXECUTE",
  actionVersion?: string,
) {
  // 1. FETCH THE STEP STATE
  const stepRun = await db.stepRun.findFirst({
    where: { runId, stepId },
    include: { run: true }
  });

  if (!stepRun) {
    throw new Error(`CRITICAL: StepRun ${stepId} not found for Run ${runId}`);
  }

  if (kind === "TRIGGER") {
    if (operation === "COMPENSATE") {
      await db.stepRun.update({
        where: { id: stepRun.id },
        data: {
          status: "COMPENSATED",
          completedAt: new Date(),
        },
      });
      await broadcastStatus(runId, stepRun.stepId, "COMPENSATED");
      return { success: true };
    }

    await db.stepRun.update({
      where: {
        id: stepRun.id,
      },
      data: {
        status: "SUCCESS",
        completedAt: new Date(),
      },
    });

    await broadcastStatus(runId, stepRun.stepId, "SUCCESS");
    return { success: true };
  }

  // 2. PRE-FLIGHT: Atomic Claim
  let claimToken: string | undefined;
  let compensationAttempts = stepRun.compensationAttempts;

  if (operation === "COMPENSATE") {
    const claim = await claimCompensationAttempt({
      stepRunId: stepRun.id,
      runId,
    });
    if (!claim.acquired) {
      console.warn(
        `[WRAPPER] Step ${stepId} compensation claim refused (${claim.reason}). Aborting ghost/duplicate execution.`
      );
      return { success: true };
    }
    claimToken = claim.claimToken;
    compensationAttempts = claim.compensationAttempts;
  } else {
    const claimableFrom: StepExecutionStatus[] = ["PENDING", "RETRYING"];
    const claimResult = await db.stepRun.updateMany({
      where: { id: stepRun.id, status: { in: claimableFrom } },
      data: {
        status: "RUNNING",
        startedAt: stepRun.startedAt || new Date(),
        ...(resolvedInputs ? { inputs: resolvedInputs } : {}),
      },
    });

    if (claimResult.count === 0) {
      console.warn(`[WRAPPER] Step ${stepId} is already claimed. Aborting ghost execution.`);
      return { success: true };
    }
  }

  const runningStatus = operation === "EXECUTE" ? "RUNNING" : "COMPENSATING";

  // 🔊 BROADCAST: Step has started
  await broadcastStatus(runId, stepRun.stepId, runningStatus);

  // Audit Log
  await db.executionAuditLog.create({
    data: {
      runId,
      stepId: stepRun.id,
      logLevel: "INFO",
      eventType: operation === "EXECUTE" ? "STEP_STARTED" : "COMPENSATION_STARTED",
      message: `Began ${operation} of action: ${actionId} (Attempt ${
        operation === "EXECUTE" ? stepRun.attempts + 1 : compensationAttempts
      })`,
      payload:
        operation === "EXECUTE"
          ? resolvedInputs || {}
          : { inputs: stepRun.inputs, outputs: stepRun.outputs },
    },
  });

  // 3. ACTION LOOKUP (F-03: Exact version pinning)
  let effectiveVersion = actionVersion;
  if (!effectiveVersion && stepRun.run?.definitionSnapshot) {
    const rawSnapshot = stepRun.run.definitionSnapshot as Record<string, unknown>;
    const manifest = Array.isArray(rawSnapshot?.actionManifest)
      ? (rawSnapshot.actionManifest as Array<{ stepId: string; actionVersion: string }>)
      : [];
    const entry = manifest.find((m) => m.stepId === stepId);
    if (entry?.actionVersion) {
      effectiveVersion = entry.actionVersion;
    }
  }

  const action = effectiveVersion ? getAction(actionId, effectiveVersion) : undefined;
  if (!action) {
    const errorMsg = effectiveVersion
      ? `Action ${actionId}@${effectiveVersion} not found in registry`
      : `Action ${actionId} has no pinned version`;
    if (operation === "COMPENSATE") {
      const failRes = await failCompensationAttempt({
        stepRunId: stepRun.id,
        runId,
        stepId,
        claimToken: claimToken!,
        errorMessage: errorMsg,
        isRetriable: false,
        currentAttempts: compensationAttempts,
        payload: {
          actionId,
          actionVersion: effectiveVersion ?? null,
          stepRunId: stepRun.id,
          stepId: stepRun.stepId,
          runId,
          reason: "ACTION_NOT_IN_REGISTRY",
          inputs: redactSensitiveData(stepRun.inputs),
          outputs: redactSensitiveData(stepRun.outputs),
          businessObject: extractBusinessObjectIdentifiers(stepRun.outputs),
        } as unknown as Prisma.InputJsonValue,
      });
      await broadcastStatus(runId, stepRun.stepId, failRes.status);
      return { success: false, status: failRes.status, error: errorMsg };
    }
    return await handleFailure(stepRun, operation, errorMsg, false);
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
        // Missing compensator on an action with side effects.
        // Truthful failure: cannot reverse persistent business side effects automatically.
        const latencyMs = Date.now() - startTime;
        const errorMessage = `Action ${actionId} has no compensator; side effect cannot be reversed automatically`;

        const failRes = await failCompensationAttempt({
          stepRunId: stepRun.id,
          runId,
          stepId: stepRun.stepId,
          claimToken: claimToken!,
          errorMessage,
          isRetriable: false,
          currentAttempts: compensationAttempts,
          latencyMs,
          payload: {
            actionId,
            stepRunId: stepRun.id,
            stepId: stepRun.stepId,
            runId,
            reason: "UNCOMPENSATED_ACTION",
            inputs: redactSensitiveData(stepRun.inputs),
            outputs: redactSensitiveData(stepRun.outputs),
            businessObject: extractBusinessObjectIdentifiers(stepRun.outputs),
          } as unknown as Prisma.InputJsonValue,
        });

        await broadcastStatus(runId, stepRun.stepId, failRes.status);
        return {
          success: false,
          status: failRes.status,
          error: errorMessage,
        };
      }

      // Real compensator exists
      const context = {
        workflowId: stepRun.run.workflowId,
        runId,
        stepId,
        stepRunId: stepRun.id,
        // JSONB read boundary. These blobs are whatever the resolver wrote and
        // whatever the forward step returned, so they are re-typed at the
        // point of deserialisation rather than trusted as a shape.
        inputs: stepRun.inputs as Record<string, JsonValue>,
        outputs: stepRun.outputs as JsonValue, // Historical outputs!
      };
      result = await action.compensate(context);
    }

    const latencyMs = Date.now() - startTime;

    // 5A. POST-FLIGHT: ACTION RETURNED CONTROLLED FAILURE
    if (!result.success) {
      if (operation === "COMPENSATE") {
        const failRes = await failCompensationAttempt({
          stepRunId: stepRun.id,
          runId,
          stepId,
          claimToken: claimToken!,
          errorMessage: result.error || "Unknown Action Error",
          isRetriable: Boolean(result.isRetriable),
          currentAttempts: compensationAttempts,
          latencyMs,
          payload: {
            actionId,
            stepRunId: stepRun.id,
            stepId: stepRun.stepId,
            runId,
            reason: "COMPENSATION_EXECUTION_FAILED",
            inputs: redactSensitiveData(stepRun.inputs),
            outputs: redactSensitiveData(stepRun.outputs),
            businessObject: extractBusinessObjectIdentifiers(stepRun.outputs),
            error: result.error,
          } as unknown as Prisma.InputJsonValue,
        });
        await broadcastStatus(runId, stepRun.stepId, failRes.status);
        return {
          success: false,
          status: failRes.status,
          error: result.error || "Unknown Action Error",
        };
      }
      return await handleFailure(
        stepRun,
        operation,
        result.error || "Unknown Action Error",
        result.isRetriable,
        latencyMs
      );
    }

    // 5B. POST-FLIGHT: SUCCESS
    if (operation === "EXECUTE") {
      // Forward path writes to global context. Internal execution snapshots
      // (like taskSnapshot) are preserved on StepRun.outputs for compensation,
      // but omitted from the global DAG data bus to keep interpolations clean.
      const contextData = { ...((result.data as Record<string, JsonValue>) || {}) };
      delete contextData.taskSnapshot;

      await appendStepOutputToContext(runId, stepId, contextData);

      await db.stepRun.update({
        where: { id: stepRun.id },
        data: { status: "SUCCESS", completedAt: new Date(), outputs: result.data || {} },
      });

      // 🔊 BROADCAST: Forward execution succeeded
      await broadcastStatus(runId, stepRun.stepId, "SUCCESS");
    } else {
      // Reverse path does NOT write to global context, it just marks as COMPENSATED
      const completion = await completeCompensationAttempt({
        stepRunId: stepRun.id,
        runId,
        claimToken: claimToken!,
      });

      if (!completion.completed) {
        console.warn(
          `[WRAPPER] Compensation for step ${stepId} completed, but worker was fenced out by newer claim or expired lease.`
        );
        return { success: false, error: "Compensation fenced out" };
      }

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

  } catch (uncaughtError: unknown) {
    // 5C. POST-FLIGHT: UNCAUGHT CRASH
    const latencyMs = Date.now() - startTime;
    const errorMsg = describeError(uncaughtError);
    if (operation === "COMPENSATE") {
      const failRes = await failCompensationAttempt({
        stepRunId: stepRun.id,
        runId,
        stepId,
        claimToken: claimToken!,
        errorMessage: errorMsg,
        isRetriable: true,
        currentAttempts: compensationAttempts,
        latencyMs,
        payload: {
          actionId,
          stepRunId: stepRun.id,
          stepId: stepRun.stepId,
          runId,
          reason: "COMPENSATION_CRASH",
          inputs: redactSensitiveData(stepRun.inputs),
          outputs: redactSensitiveData(stepRun.outputs),
          businessObject: extractBusinessObjectIdentifiers(stepRun.outputs),
          error: errorMsg,
        } as unknown as Prisma.InputJsonValue,
      });
      await broadcastStatus(runId, stepRun.stepId, failRes.status);
      return { success: false, status: failRes.status, error: errorMsg };
    }
    return await handleFailure(stepRun, operation, errorMsg, true, latencyMs);
  }
}

/**
 * Helper utility to manage the complex math of retries and failure states
 */
/**
 * The fields `handleFailure` needs from a step run.
 *
 * Declared structurally rather than as the full Prisma payload because only these
 * five are read. A structural type also keeps the helper honest about what it
 * depends on, and means the caller's query can change without silently widening
 * this signature.
 */
type FailureContext = {
  id: string;
  runId: string;
  stepId: string;
  attempts: number;
  compensationAttempts: number;
};

async function handleFailure(
  stepRun: FailureContext,
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
  let finalStatus: "RETRYING" | "FAILED" | "COMPENSATION_RETRYING" | "COMPENSATION_FAILED";

  if (operation === "EXECUTE") {
    finalStatus = shouldRetry ? "RETRYING" : "FAILED";
  } else {
    finalStatus = shouldRetry ? "COMPENSATION_RETRYING" : "COMPENSATION_FAILED";
  }

  await db.$transaction([
    db.stepRun.update({
      where: { id: stepRun.id },
      data: {
        status: finalStatus,
        error: errorMessage,
        // Update the correct counter column
        ...(operation === "EXECUTE" ? { attempts: newAttempts } : { compensationAttempts: newAttempts }),
        ...(finalStatus === "FAILED" || finalStatus === "COMPENSATION_FAILED" ? { completedAt: new Date() } : {})
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