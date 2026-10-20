"use server";

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { toPublicError } from "@/lib/security/public-error";
import type { JsonValue } from "@/lib/workflow-types/type";

// I6 — TENANT SCOPE. This server action is publicly reachable (it is called from
// the canvas Run button), so it must authenticate AND authorize before anything
// is executed. `orgslug` is the `[orgId]` URL segment, which the router fills
// with the organization *slug*; `getOrgAccess` resolves it against the session
// and returns the real organization id only for a member. The client cannot
// override the tenant: the id passed to `startWorkflow` comes from the verified
// access record, and a forged/foreign slug yields `null` and stops here with no
// side effects.
export async function triggerWorkflowRun(
  workflowId: string,
  orgslug: string,
  // Becomes WorkflowRun.context, a JSONB column. JsonValue states what the
  // column already enforced at runtime.
  triggerPayload: Record<string, JsonValue> = {}, // The dynamic payload
) {
  const access = await getOrgAccess(orgslug);
  if (!access) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const run = await startWorkflow(
      access.organization.id,
      workflowId,
      triggerPayload,
    );

    return {
      success: true,
      runId: run.id,
      redirectTo: `/org/${orgslug}/runs/${run.id}`,
    };
  } catch (error: unknown) {
    console.error("[ACTION ERROR] Failed to start workflow:", error);
    // S5 (security) — do not hand an arbitrary `error.message` back to the
    // client. Only authored, allowlisted messages survive; anything else
    // (database, provider, stack) becomes a generic message.
    return {
      success: false,
      error:
        toPublicError(error instanceof Error ? error.message : null) ??
        "Failed to initialize execution engine",
    };
  }
}