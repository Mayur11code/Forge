import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { startWorkflow } from "@/lib/workflow/execution/trigger";

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
export async function POST(
  _req: Request,
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

    const run = await startWorkflow(workflow.orgId, workflowId, {
      projectId: "cmnj8u44p0003a0gcvqgt25dv",
    });

    return Response.json({
      runId: run.id,
      redirectTo: `/org/${workflow.orgId}/runs/${run.id}`,
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
}}