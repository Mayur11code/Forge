import { z } from "zod";
import { publishEvent } from "@/lib/events/queue";
import { createAgentSession } from "@/lib/ai/agent/session-service";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { startAgentSession } from "@/lib/ai/agent/orchestrator";

const requestSchema = z.object({
  orgSlug: z.string().min(1),
  message: z.string().trim().min(1).max(5000),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid request body",
          issues: parsed.error.flatten(),
        },
        {
          status: 400,
        },
      );
    }

    const { orgSlug, message } = parsed.data;

    /*
     * Browser supplied orgSlug is NOT authorization.
     * getOrgAccess validates:
     * - authenticated user
     * - membership
     * - returns trusted organization id
     */
    const orgAccess = await getOrgAccess(orgSlug);

    if (!orgAccess) {
      return Response.json(
        {
          error: "Forbidden",
        },
        {
          status: 403,
        },
      );
    }

    const session = await startAgentSession({
      orgId: orgAccess.organization.id,
      userId: orgAccess.userId,
      initialMessage: {
        role: "user",
        content: message,
      },
    });



    return Response.json(
      {
        sessionId: session.id,
        status: session.status,
      },
      {
        status: 202,
      },
    );
  } catch (error) {
    console.error("[AGENT INIT]", error);

    return Response.json(
      {
        error: "Internal Server Error",
      },
      {
        status: 500,
      },
    );
  }
}

