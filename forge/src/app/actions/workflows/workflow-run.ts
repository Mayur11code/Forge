"use server";

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { toPublicError } from "@/lib/security/public-error";
import {
  validateTriggerContext,
  type TriggerContextValidationResult,
} from "@/lib/workflow/execution/trigger-context";

// I6 — TENANT SCOPE. This server action is publicly reachable (it is called from
// the canvas Run button), so it must authenticate AND authorize before anything
// is executed. `orgslug` is the `[orgId]` URL segment, which the router fills
// with the organization *slug*; `getOrgAccess` resolves it against the session
// and returns the real organization id only for a member. The client cannot
// override the tenant: the id passed to `startWorkflow` comes from the verified
// access record, and a forged/foreign slug yields `null` and stops here with no
// side effects.
//
// 37.12 — RUNTIME-INPUT TRUST BOUNDARY. `triggerPayload` is OPTIONAL and is no
// longer an unconstrained blob: it is validated by `validateTriggerContext`
// before it becomes `WorkflowRun.context.trigger.outputs`. A generated,
// validator-clean workflow references no `trigger.outputs.*` field at all
// (workflow-proposal-references.ts:119-132), so the correct call for one omits
// the payload entirely; the previous canvas behaviour fabricated a `projectId`
// that had nothing to do with the workflow, and that fabrication is gone. For a
// manually authored workflow that genuinely reads `{{trigger.outputs.*}}`, the
// supplied context is bounded and cannot carry tenant/identity authority.
//
// This is a DATA boundary, not an authorization one: `orgId` is always the
// verified `access.organization.id`, never a payload value.
export async function triggerWorkflowRun(
  workflowId: string,
  orgslug: string,
  triggerPayload?: unknown,
): Promise<
  | { success: true; runId: string; redirectTo: string }
  | { success: false; error: string }
> {
  const access = await getOrgAccess(orgslug);
  if (!access) {
    return { success: false, error: "Unauthorized" };
  }

  const validated: TriggerContextValidationResult =
    validateTriggerContext(triggerPayload);
  if (!validated.ok) {
    // The reason is authored server-side for diagnostics; the client gets a
    // fixed, non-disclosing message. A rejected payload must not reach the
    // engine, so this returns before any run is created or work dispatched.
    console.error("[ACTION] Rejected trigger context:", validated.reason);
    return { success: false, error: "Invalid trigger data." };
  }

  try {
    const run = await startWorkflow(
      access.organization.id,
      workflowId,
      validated.value,
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