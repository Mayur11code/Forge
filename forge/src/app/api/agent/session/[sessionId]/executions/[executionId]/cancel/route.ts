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
import { cancelToolExecution } from "@/lib/ai/agent/services/tool-execution-service";
import { createMessage } from "@/lib/ai/agent/services/message-service";
import { publishEvent } from "@/lib/events/queue";
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

    const cancelled = await cancelToolExecution({
      executionId: execution.id,
      sessionId: session.id,
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

    // Close the tool call in the transcript. The loop treats a tool result
    // like any other, so the model can acknowledge the decline and continue
    // rather than being left waiting on a call that will never resolve.
    await createMessage({
      sessionId: session.id,
      step: session.currentStep,
      toolCallId: execution.toolCallId,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: execution.toolCallId,
            toolName: execution.toolName,
            output: {
              type: "json",
              value: {
                ok: false,
                code: "CANCELLED",
                error:
                  "The user declined this action. Do not retry it " +
                  "and do not attempt to achieve the same result " +
                  "by another means.",
              },
            },
          },
        ],
      },
    });

    await publishAgentStatus(session.id, {
      type: "TOOL_CANCELLED",
      executionId: execution.id,
      toolName: execution.toolName,
    });

    await publishEvent("AGENT_LOOP_REQUESTED", {
      orgId: session.orgId,
      sessionId: session.id,
      expectedStep: session.currentStep,
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
