// src/app/api/agent/session/[sessionId]/proposal-materialize/route.ts
//
// ASSIGNMENT 37.11 — PROPOSAL MATERIALIZATION INGRESS.
//
// The only way a human turns an APPROVED workflow proposal into a persisted
// Forge `Workflow`. This is MATERIALIZATION ONLY: it never executes the
// workflow, never creates a `WorkflowRun`, never enqueues a QStash job, and never
// restarts the model loop. Dispatching a materialized workflow is 37.12.
//
// Authorization mirrors the other agent routes: the caller must be authenticated
// and the persisted `AgentSession.userId` must match. The session id in the URL
// is a lookup key, never authorization. The organization scope is derived
// server-side from the persisted session; a client cannot name an org.
//
// The body is minimal and STRICT on purpose: `interactionId` is the durable
// `AgentToolExecution.id` of the approved proposal, and it is the ONLY
// client-supplied identity. There is no `orgId`, no `workflowId`, no proposal
// content, no graph, no fingerprint and no criticality field a client could set:
// an attempt to smuggle any of them is a 400, not something the service has to
// remember to ignore.

import { z } from "zod";

import { auth } from "@/lib/auth/auth";
import { materializeProposal } from "@/lib/ai/agent/services/proposal-materialization-service";

const requestSchema = z
  .object({
    interactionId: z.string().min(1),
  })
  .strict();

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(req: Request, { params }: RouteContext) {
  try {
    const userId = (await auth())?.user?.id;

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await params;

    if (!sessionId) {
      return Response.json({ error: "Invalid session id" }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid request body",
          code: "INVALID_REQUEST",
          issues: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const result = await materializeProposal({
      sessionId,
      userId,
      interactionId: parsed.data.interactionId,
    });

    if (!result.ok) {
      return Response.json(
        { error: result.error, code: result.code },
        { status: result.httpStatus },
      );
    }

    return Response.json(
      {
        sessionId: result.sessionId,
        workflowId: result.workflowId,
        state: result.state,
        status: "MATERIALIZED",
        ...(result.idempotent ? { idempotent: true } : {}),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[AGENT PROPOSAL MATERIALIZE]", error);

    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
