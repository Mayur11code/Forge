// src/app/api/agent/session/[sessionId]/proposal-approval/route.ts
//
// ASSIGNMENT 37.9 — PROPOSAL APPROVAL INGRESS.
//
// The only way a human approves a generated workflow proposal. This is a
// proposal-specific ingress on purpose (owner decision A): the 35/36 tool
// confirmation gate answers "may a not-yet-run tool execute?" and cannot express
// "the model ran and produced this proposal; approve it", because the proposal's
// execution is already COMPLETED.
//
// Authorization mirrors the other agent routes: the caller must be authenticated
// and the persisted AgentSession.userId must match. The session id in the URL is
// a lookup key, never authorization.
//
// The body is minimal on purpose: `interactionId` is the durable
// AgentToolExecution id of the proposal, and it is the ONLY client-supplied
// identity. The service re-checks it against the session, the persisted result
// and the backend-owned fingerprint, so a client cannot name a different
// proposal revision to approve.
//
// The schema is STRICT and closed. There is no `fingerprint`, no `revision`, no
// `name`, no status field and no org/user field a client could set: an attempt
// to smuggle any of them is a 400, not something the service has to remember to
// ignore.

import { z } from "zod";

import { auth } from "@/lib/auth/auth";
import { submitProposalDecision } from "@/lib/ai/agent/services/proposal-decision-service";

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

    const result = await submitProposalDecision({
      sessionId,
      userId,
      interactionId: parsed.data.interactionId,
      decision: "APPROVED",
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
        step: result.step,
        state: result.state,
        status: "ACCEPTED",
        ...(result.idempotent ? { idempotent: true } : {}),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[AGENT PROPOSAL APPROVAL]", error);

    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
