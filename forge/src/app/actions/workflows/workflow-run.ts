"use server";

import { startWorkflow } from "@/lib/workflow/execution/trigger";
import type { JsonValue } from "@/lib/workflow-types/type";

export async function triggerWorkflowRun(
  workflowId: string,
  orgId: string,
  // Becomes WorkflowRun.context, a JSONB column. JsonValue states what the
  // column already enforced at runtime.
  triggerPayload: Record<string, JsonValue> = {}, // The dynamic payload
) {
  try {
    const run = await startWorkflow(workflowId, triggerPayload);

    return {
      success: true,
      runId: run.id,
      redirectTo: `/org/${orgId}/runs/${run.id}`,
    };
  } catch (error: unknown) {
    console.error("[ACTION ERROR] Failed to start workflow:", error);
    return {
      success: false,
      error: error instanceof Error
        ? error.message
        : "Failed to initialize execution engine",
    };
  }
}