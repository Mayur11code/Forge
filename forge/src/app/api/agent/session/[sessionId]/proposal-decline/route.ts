// src/app/api/agent/session/[sessionId]/proposal-decline/route.ts
//
// ASSIGNMENT 37.9 — PROPOSAL DECLINE INGRESS.
//
// The human's explicit refusal of a generated workflow proposal. DECLINED is a
// distinct terminal state (owner decision B), never conflated with EXPIRED: a
// refusal is a decision the human made, an expiry is the system giving up.
//
// This route shares its service, authorization and schema with the approval
// ingress; only the fixed decision differs. It is a separate endpoint because
// the two are different intents with different failure semantics on repeat (a
// second decline of a declined proposal is idempotent; a decline of an approved
// proposal is a conflict), and because a single endpoint with a `decision` body
// field would let a client flip the outcome in a way the review card cannot.
//
// Declining never materializes a `Workflow`, never executes an action, and never
// re-enters the model.

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
      decision: "DECLINED",
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
    console.error("[AGENT PROPOSAL DECLINE]", error);

    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
