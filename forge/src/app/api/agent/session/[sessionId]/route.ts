// src/app/api/agent/session/[sessionId]/route.ts
//
// Session recovery / read endpoint.
//
// Lets a client reconstruct agent state after a page refresh without relying
// on live Pusher traffic, which is transport-only and lossy by nature.
//
// Authorization: the caller must be authenticated, and the persisted
// AgentSession.userId must match. The session id in the URL is NOT
// authorization; it is only a lookup key. Ownership is enforced by the
// existing session service rather than an inline query.

import { auth } from "@/lib/auth/auth";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { getMessages } from "@/lib/ai/agent/services/message-service";
import { getToolExecutionsForSession } from "@/lib/ai/agent/services/tool-execution-service";
import { describeToolProposal } from "@/lib/ai/agent/tools/registry";
import { AgentToolExecutionStatus } from "@prisma/client";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

/**
 * Stable response shape. Clients should branch on `status` and
 * `terminalReason`, never on the presence of `finalResponse`.
 */
export async function GET(
  _req: Request,
  { params }: RouteContext,
) {
  try {
    const userId = (await auth())?.user?.id;

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await params;

    if (!sessionId) {
      return Response.json({ error: "Invalid session id" }, { status: 400 });
    }

    const session = await getAgentSessionForUser({ sessionId, userId });

    // Unknown session and someone else's session are deliberately
    // indistinguishable, so the endpoint cannot be used to probe for valid
    // session ids.
    if (!session) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const [messages, toolExecutions] = await Promise.all([
      getMessages(session.id),
      getToolExecutionsForSession(session.id),
    ]);

    return Response.json(
      {
        sessionId: session.id,
        orgId: session.orgId,
        status: session.status,
        currentStep: session.currentStep,
        finalResponse: session.finalResponse,
        error: session.errorMessage,
        terminalReason: session.terminalReason,
        promptVersion: session.promptVersion,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: messages.map((message) => ({
          id: message.id,
          step: message.step,
          toolCallId: message.toolCallId,
          message: message.message,
          createdAt: message.createdAt,
        })),
        toolExecutions: toolExecutions.map((execution) => ({
          id: execution.id,
          toolCallId: execution.toolCallId,
          toolName: execution.toolName,
          input: execution.input,
          status: execution.status,
          error: execution.error,
          confirmedAt: execution.confirmedAt,
          cancelledAt: execution.cancelledAt,
          createdAt: execution.createdAt,
          updatedAt: execution.updatedAt,
          /**
           * Server-rendered description of the PERSISTED arguments, attached
           * only while the proposal is still actionable. This is what lets a
           * client rebuild a pending confirmation card after a refresh instead
           * of showing an approve button for an action it cannot display.
           */
          proposal:
            execution.status ===
            AgentToolExecutionStatus.PENDING_CONFIRMATION
              ? describeToolProposal(execution.toolName, execution.input)
              : null,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[AGENT SESSION GET]", error);

    return Response.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
