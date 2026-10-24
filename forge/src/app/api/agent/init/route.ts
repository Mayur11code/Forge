import { z } from "zod";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { startAgentSession } from "@/lib/ai/agent/orchestrator";
import {
  checkRateLimit,
  createRateLimitResponse,
  RATE_LIMIT_POLICIES,
} from "@/lib/security/rate-limit";

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

    // AI Admission Control (Token Bucket)
    // Consumes exactly one admission token per new agent workflow session.
    // Internal loop steps and QStash worker redeliveries do not touch this route.
    const rateLimitResult = await checkRateLimit({
      policy: RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT,
      userId: orgAccess.userId,
      orgId: orgAccess.organization.id,
    });

    if (!rateLimitResult.allowed) {
      return createRateLimitResponse(rateLimitResult);
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
        headers: rateLimitResult.headers,
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
