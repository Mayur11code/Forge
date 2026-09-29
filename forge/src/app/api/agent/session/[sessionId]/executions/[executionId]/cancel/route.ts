// src/app/api/agent/session/[sessionId]/executions/[executionId]/cancel/route.ts
//
// Decline a proposed agent tool execution.
//
// Like confirm, this takes NO request body: declining needs no arguments, and
// accepting any would only widen the attack surface.
//
// CANCELLED is terminal. A cancelled execution is never dispatched, so a
// cancel that races a confirm always resolves to one unambiguous outcome: if
// the confirm's compare-and-set won, this returns 409 and the tool runs; if
// this one's won, the tool cannot run.
//
// The loop is re-driven after a cancel so the model receives a tool result
// telling it the action was declined. Without that, the transcript would carry
// an unanswered tool call and the next turn would be malformed.

import { auth } from "@/lib/auth/auth";
import {
  decideConfirmation,
  loadConfirmationTarget,
} from "@/lib/ai/agent/services/confirmation-service";
import { cancelToolExecutionAndContinue } from "@/lib/ai/agent/services/tool-execution-service";
import { publishAgentStatus } from "@/lib/ai/agent/status";

type RouteContext = {
  params: Promise<{ sessionId: string; executionId: string }>;
};

export async function POST(
  _req: Request,
  { params }: RouteContext,
) {
  try {
    const userId = (await auth())?.user?.id;

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId, executionId } = await params;

    if (!sessionId || !executionId) {
      return Response.json(
        { error: "Invalid session or execution id" },
        { status: 400 },
      );
    }

    const target = await loadConfirmationTarget({
      sessionId,
      executionId,
      userId,
    });

    if (!target.ok) {
      return Response.json(
        { error: target.error, code: target.code },
        { status: target.httpStatus },
      );
    }

    const { session, execution } = target;

    const decision = decideConfirmation({
      action: "cancel",
      executionStatus: execution.status,
      sessionStatus: session.status,
    });

    if (decision.kind === "CONFLICT") {
      return Response.json(
        {
          error: decision.error,
          code: decision.code,
          executionId: execution.id,
          status: execution.status,
        },
        { status: decision.httpStatus },
      );
    }

    if (decision.kind === "IDEMPOTENT") {
      // Already cancelled. Report the real state; do not re-drive the loop.
      return Response.json(
        {
          executionId: execution.id,
          toolName: execution.toolName,
          status: execution.status,
          idempotent: true,
        },
        { status: 200 },
      );
    }

    // CAS the cancellation, close the tool call in the transcript, and record
    // the intent to re-drive the loop, in ONE transaction.
    //
    // An unanswered tool call would leave the next turn malformed, and the model
    // would be guessing at the outcome rather than being told it. Doing those
    // three things separately left a window in which a crash produced a
    // permanently dangling transcript with no recovery path.
    const cancelled = await cancelToolExecutionAndContinue({
      executionId: execution.id,
      sessionId: session.id,
      orgId: session.orgId,
      expectedStep: session.currentStep,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
    });

    if (!cancelled) {
      return Response.json(
        {
          error:
            "Execution was already dispatched and can no longer be cancelled.",
          code: "ALREADY_DISPATCHED",
          executionId: execution.id,
          status: "CONFLICT",
        },
        { status: 409 },
      );
    }

    // A UI signal only, so it stays outside the transaction: a failure here
    // cannot strand the work, because the decline and the continuation intent
    // have already committed.
    await publishAgentStatus(session.id, {
      type: "TOOL_CANCELLED",
      executionId: execution.id,
      toolName: execution.toolName,
    });

    return Response.json(
      {
        executionId: execution.id,
        toolName: execution.toolName,
        status: "CANCELLED",
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[AGENT TOOL CANCEL]", error);

    return Response.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
