// src/app/api/agent/session/[sessionId]/clarification/route.ts
//
// Human answer ingress for the missing-input protocol.
//
// Without this endpoint a `NEEDS_USER_INPUT` result is a dead end: the worker
// halts the loop, records no continuation, and there is no production caller
// that can release it. This is that caller.
//
// Authorization mirrors the confirm route: the caller must be authenticated and
// the persisted AgentSession.userId must match. The session id in the URL is a
// lookup key, never authorization.
//
// The body carries both identity handles:
//   - `interactionId` is the durable AgentToolExecution id the worker stamped
//     onto the request. It is what binds the answer to the exact pending ask.
//   - `correlationId` is the proposal-revision fingerprint, a secondary check.
// A stale answer for a superseded request is rejected by the service rather
// than silently satisfying whatever is pending now.

import { z } from "zod";

import { auth } from "@/lib/auth/auth";
import { submitClarificationAnswer } from "@/lib/ai/agent/services/clarification-service";

const requestSchema = z.object({
  interactionId: z.string().min(1),
  correlationId: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
});

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(
  req: Request,
  { params }: RouteContext,
) {
  try {
    const userId = (await auth())?.user?.id;

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await params;

    if (!sessionId) {
      return Response.json(
        { error: "Invalid session id" },
        { status: 400 },
      );
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

    const { interactionId, correlationId, answers } = parsed.data;

    const result = await submitClarificationAnswer({
      sessionId,
      userId,
      interactionId,
      correlationId,
      answers,
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
    console.error("[AGENT CLARIFICATION ANSWER]", error);

    return Response.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
