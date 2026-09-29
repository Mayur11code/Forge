// src/app/api/agent/session/[sessionId]/executions/[executionId]/confirm/route.ts
//
// Confirm a proposed agent tool execution.
//
// Takes NO request body by design. A confirm carries only the ids in the path.
// The arguments that execute are the ones already persisted on the
// AgentToolExecution row, so this endpoint cannot be used to substitute,
// augment or regenerate what the user was shown.
//
// Idempotent: confirming an already-confirmed execution returns 200 and does
// not re-dispatch it, even after the session has moved on. The dispatch itself
// is a compare-and-set from PENDING_CONFIRMATION, so concurrent confirms queue
// exactly one execution.

import { auth } from "@/lib/auth/auth";
import {
  decideConfirmation,
  loadConfirmationTarget,
} from "@/lib/ai/agent/services/confirmation-service";
import { confirmToolExecution } from "@/lib/ai/agent/services/tool-execution-service";
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
      action: "confirm",
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
      // Already past the gate. Report the real state; never re-dispatch.
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

    // The transition and the intent to dispatch now commit together inside
    // confirmToolExecution, so this route no longer publishes. That removes the
    // window where the row was confirmed but the process died before the
    // dispatch was ever requested.
    const confirmed = await confirmToolExecution({
      executionId: execution.id,
      sessionId: session.id,
      orgId: session.orgId,
      expectedStep: session.currentStep,
    });

    if (!confirmed) {
      // Lost a race with a concurrent request. Report current truth rather
      // than retrying, so the client can reconcile from the response.
      return Response.json(
        {
          error:
            "Execution was already dispatched and is no longer awaiting approval.",
          code: "ALREADY_DISPATCHED",
          executionId: execution.id,
          status: "CONFLICT",
        },
        { status: 409 },
      );
    }

    await publishAgentStatus(session.id, {
      type: "TOOL_CONFIRMED",
      executionId: execution.id,
      toolName: execution.toolName,
    });

    return Response.json(
      {
        executionId: execution.id,
        toolName: execution.toolName,
        status: "PENDING",
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[AGENT TOOL CONFIRM]", error);

    return Response.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
