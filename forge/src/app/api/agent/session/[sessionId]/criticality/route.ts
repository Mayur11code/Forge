// src/app/api/agent/session/[sessionId]/criticality/route.ts
//
// ASSIGNMENT 37.7 — CRITICALITY DECISION INGRESS.
//
// The only way a human decision about workflow-step criticality enters the
// system. Authorization mirrors the other agent routes: the caller must be
// authenticated and the persisted AgentSession.userId must match. The session
// id in the URL is a lookup key, never authorization.
//
// The body is minimal on purpose:
//   - `interactionId` is the durable AgentToolExecution id of the proposal the
//     decision is about. It is the ONLY client-supplied identity, and the
//     service re-checks it against the session and the persisted result.
//   - `decisions` is one boolean per step.
//
// The schema is STRICT and closed. There is no `correlationId`, no `userId`, no
// `isCritical` and no status field that a client could set: an attempt to
// smuggle any of them is a 400, not something the service has to remember to
// ignore. `isCritical` in particular is backend-owned and may only be authored
// here, through a validated human decision.

import { z } from "zod";

import { auth } from "@/lib/auth/auth";
import { submitCriticalityDecision } from "@/lib/ai/agent/services/criticality-service";

const requestSchema = z
  .object({
    interactionId: z.string().min(1),
    decisions: z.record(z.string(), z.boolean()),
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

    const { interactionId, decisions } = parsed.data;

    const result = await submitCriticalityDecision({
      sessionId,
      userId,
      interactionId,
      decisions,
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
        status: "ACCEPTED",
        ...(result.idempotent ? { idempotent: true } : {}),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[AGENT CRITICALITY DECISION]", error);

    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
