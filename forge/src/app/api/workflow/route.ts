// src/app/api/workflow/route.ts
//
// The workflow worker. Handles two cloud events:
//
//   EXECUTE_WORKFLOW_NODE - run one step's action (or its compensation).
//   ADVANCE_WORKFLOW      - re-evaluate a run from a fresh read.
//
// Both are signed by QStash, so an unauthenticated caller cannot drive either.
//
// The status codes here are load-bearing. QStash deletes a message on 2xx and
// retries it on 5xx, so returning 200 for something that did not happen is the
// same as dropping it: a step that was never executed and a run that will never
// be re-evaluated both look identical to the broker from a "success" response.
// The rule this file follows is that 2xx means the work is either done or
// durably scheduled, and 5xx means neither, and only the second case retries.

import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/prisma/db";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import { wrapStepOperation } from "@/lib/workflow/execution/wrapper";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import type { WorkflowDefinition } from "@/lib/workflow-types/workflow";
import type { JsonValue } from "@/lib/workflow-types/type";
import type { StepExecutionStatus } from "@prisma/client";

/**
 * Which operation a delivery should perform, derived from the step's persisted
 * status.
 *
 * This is a lookup rather than a ternary on purpose. The previous form was
 * `status === "PENDING" ? "EXECUTE" : "COMPENSATE"`, which routes every status
 * that is not PENDING into compensation - including `RETRYING` and `RUNNING`.
 *
 * That is not a cosmetic mix-up. A retriable failure puts a step in `RETRYING`
 * and the worker answers 500, so QStash redelivers it. The old ternary read
 * `RETRYING` as "compensate this", and compensation claims by `status: SUCCESS`,
 * which a `RETRYING` row is not - so the claim matched nothing, the wrapper
 * reported success, the step stayed `RETRYING` forever, and the evaluator
 * skipped it on every subsequent pass. The retry path did not work at all, and
 * it did so silently.
 */
const OPERATION_FOR_STATUS: Partial<
  Record<StepExecutionStatus, "EXECUTE" | "COMPENSATE">
> = {
  // Forward: a fresh dispatch, or a redelivery of one that failed retriably.
  PENDING: "EXECUTE",
  RETRYING: "EXECUTE",
  // Reverse: only a step that actually succeeded has anything to compensate, and
  // a retriable compensation failure comes back here too.
  SUCCESS: "COMPENSATE",
  COMPENSATING: "COMPENSATE",
};

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

  // --- Idempotency guard ---
  // QStash is at-least-once. A redelivery of a step that already reached a
  // terminal state must not run the action again.
  const TERMINAL_STATUSES: StepExecutionStatus[] = [
    "SUCCESS",
    "FAILED",
    "CANCELLED",
    "SKIPPED",
    "COMPENSATED",
    "COMPENSATION_FAILED",
  ];

  if (TERMINAL_STATUSES.includes(stepRun.status)) {
    console.log(
      `[WORKER] StepRun ${stepRunId} is already ${stepRun.status}. Skipping.`,
    );
    return new NextResponse("Already processed", { status: 200 });
  }

  const operation = OPERATION_FOR_STATUS[stepRun.status];

  if (!operation) {
    // RUNNING or COMPENSATING: another delivery of this same step owns it. The
    // wrapper's compare-and-set would refuse the claim anyway; returning early
    // says so honestly instead of letting it look like a successful no-op, and
    // crucially does not hand a RUNNING step to the compensation path.
    console.log(
      `[WORKER] StepRun ${stepRunId} is ${stepRun.status}, owned by another delivery. Skipping.`,
    );
    return new NextResponse("In progress", { status: 200 });
  }

  // --- Ghost buster ---
  // A run that started rolling back while this step was still queued means the
  // step must never run. `RETRYING` belongs here for the same reason it belongs
  // in the forward path above: it is a forward step that has not succeeded, and
  // a rollback must not leave it live.
  if (
    stepRun.run.status === "ROLLING_BACK" &&
    (stepRun.status === "PENDING" || stepRun.status === "RETRYING")
  ) {
    console.log(`[WORKER] Ghost busted. Cancelling step ${stepRunId}.`);
    await db.stepRun.update({
      where: { id: stepRunId },
      data: { status: "CANCELLED" },
    });
    await handleAdvanceWorkflow(runId);
    return new NextResponse("Ghost Cancelled", { status: 200 });
  }

  // The definition is validated on write, so it is already a `WorkflowDefinition`
  // as far as the engine is concerned. The cast to `any` that used to be here
  // was hiding the one mistake this code could make - reading a step that is not
  // in the graph - behind a type error at the first property access instead.
  const workflowDefinition = stepRun.run.workflow.definition as WorkflowDefinition;
  const nodeDefinition = workflowDefinition.steps[stepRun.stepId];

  if (!nodeDefinition) {
    return new NextResponse("Node definition missing", { status: 400 });
  }

  const actionId = nodeDefinition.action;

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
    console.log(`[WORKER] Resolved inputs for step ${stepRunId}:`, resolvedInputs);
  }

  const result = await wrapStepOperation(
    stepRun.runId,
    stepRun.stepId,
    actionId,
    kind as "TRIGGER" | "ACTION",
    resolvedInputs,
    operation,
  );

  // --- Dead letter / retry signalling ---
  if (!result.success && "status" in result) {
    if (result.status === "RETRYING" || result.status === "COMPENSATING") {
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

async function handler(req: NextRequest) {
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

// Security: Wrap the handler with Upstash's signature verification
export const POST = verifySignatureAppRouter(handler);
