// src/app/api/agent/rate-limit/route.ts
//
// Authenticated read-only rate limit status endpoint.
// Uses Upstash's non-mutating getRemaining() to check remaining quota
// without consuming any tokens.

import { auth } from "@/lib/auth/auth";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import {
  getRateLimitStatus,
  RATE_LIMIT_POLICIES,
  RateLimitPolicyConfig,
} from "@/lib/security/rate-limit";

export async function GET(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const orgSlug = searchParams.get("orgSlug");
    const operationParam = searchParams.get("operation") || "agent_init";

    if (!orgSlug) {
      return Response.json(
        { error: "orgSlug query parameter is required" },
        { status: 400 }
      );
    }

    // Verify authorized organization membership
    const orgAccess = await getOrgAccess(orgSlug);
    if (!orgAccess) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let policy: RateLimitPolicyConfig;
    switch (operationParam.toLowerCase()) {
      case "chat":
        policy = RATE_LIMIT_POLICIES.AI_ADMISSION_CHAT;
        break;
      case "triage":
        policy = RATE_LIMIT_POLICIES.AI_ADMISSION_TRIAGE;
        break;
      case "task_create":
        policy = RATE_LIMIT_POLICIES.REQUEST_TASK_CREATE;
        break;
      case "agent_init":
      default:
        policy = RATE_LIMIT_POLICIES.AI_ADMISSION_AGENT_INIT;
        break;
    }

    // Inspect quota using getRemaining() without incrementing or mutating Redis
    const status = await getRateLimitStatus({
      policy,
      userId: orgAccess.userId,
      orgId: orgAccess.organization.id,
    });

    return Response.json(
      {
        operation: policy.name,
        available: status.available,
        limit: status.limit,
        remaining: status.remaining,
        reset: status.reset,
        retryAfterSeconds: status.retryAfterSeconds,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  } catch (error) {
    console.error("[RATE LIMIT STATUS ERROR]", error);
    return Response.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
