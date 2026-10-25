import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { validateTriggerContext } from "@/lib/workflow/execution/trigger-context";
import type { JsonValue } from "@/lib/workflow-types/type";
import {
  checkRateLimit,
  createRateLimitResponse,
  RATE_LIMIT_POLICIES,
} from "@/lib/security/rate-limit";

interface RouteContext {
  params: Promise<{
    workflowId: string;
  }>;
}

// I6 — TENANT SCOPE. This route is publicly reachable and, unlike the canvas
// action, carries no organization in its path. The tenant is therefore derived
// server-side from the session: the workflow is looked up with a predicate that
// requires the caller to be a member of its owning organization. A workflow
// owned by another tenant then matches nothing, which is the SAME response as a
// workflow that does not exist — so a non-member cannot use this endpoint as an
// existence oracle, and `startWorkflow` still receives a verified `orgId`.
//
// H4.1 — RUNTIME-INPUT BOUNDARY. The previous implementation hardcoded a
// development project ID ('cmnj8u44p0003a0gcvqgt25dv') on every run. That
// fabrication broke test runs for any non-default organization. The trigger
// context is now optional and validated: if a projectId is supplied, it MUST
// belong to the verified workflow organization. Otherwise, an empty context
// is passed to startWorkflow.
export async function POST(
  req: Request,
  context: RouteContext
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workflowId } = await context.params;

    const workflow = await db.workflow.findFirst({
      where: {
        id: workflowId,
        organization: { memberships: { some: { userId } } },
      },
      select: { id: true, orgId: true },
    });

    if (!workflow) {
      return Response.json(
        { error: `Cannot start workflow: ${workflowId} not found.` },
        { status: 404 }
      );
    }

    // Rate Limiting (Sliding Window): REQUEST_WORKFLOW_TEST_RUN
    // Protects workflow execution engine against rapid automated re-triggering.
    // Fail-closed on Redis timeout/error to prevent execution queue flooding.
    const rateLimitResult = await checkRateLimit({
      policy: RATE_LIMIT_POLICIES.REQUEST_WORKFLOW_TEST_RUN,
      userId,
      orgId: workflow.orgId,
    });

    if (!rateLimitResult.allowed) {
      return createRateLimitResponse(rateLimitResult);
    }

    // Parse and validate optional trigger context from request body
    let triggerData: Record<string, JsonValue> = {};

    try {
      const text = await req.text();
      if (text && text.trim().length > 0) {
        const body = JSON.parse(text);
        const rawPayload =
          body && typeof body === "object" && "triggerPayload" in body
            ? (body as { triggerPayload: unknown }).triggerPayload
            : body;

        const validated = validateTriggerContext(rawPayload);
        if (!validated.ok) {
          return Response.json(
            { error: "Invalid trigger data." },
            { status: 400 },
          );
        }

        // Project ownership boundary: if a projectId is explicitly provided in
        // the trigger data, assert it belongs to this workflow's organization.
        if (typeof validated.value.projectId === "string") {
          const project = await db.project.findFirst({
            where: {
              id: validated.value.projectId,
              orgId: workflow.orgId,
            },
            select: { id: true },
          });

          if (!project) {
            return Response.json(
              { error: "Project not found in this organization." },
              { status: 404 },
            );
          }
        }

        triggerData = validated.value;
      }
    } catch {
      return Response.json(
        { error: "Invalid JSON request body." },
        { status: 400 },
      );
    }

    const run = await startWorkflow(workflow.orgId, workflowId, triggerData);

    return Response.json({
      runId: run.id,
      redirectTo: `/org/${workflow.orgId}/runs/${run.id}`,
    }, {
      status: 200,
      headers: rateLimitResult.headers,
    });
  } catch (error) {
    // S8 (security) — log the detail server-side, return a generic message. The
    // previous body echoed `error.message` and (in development) `error.stack` to
    // the caller, disclosing internals.
    console.error("TEST RUN ERROR", error);

    return Response.json(
      { error: "Failed to start workflow." },
      { status: 500 }
    );
  }
}
