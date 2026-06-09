"use server";

import { startWorkflow } from "@/lib/workflow/execution/trigger";

export async function triggerWorkflowRun(
  workflowId: string,
  orgId: string,
  triggerPayload: Record<string, any> = {} // The dynamic payload
) {
  try {
  
    const run = await startWorkflow(workflowId, triggerPayload);

    return {
      success: true,
      runId: run.id,
      redirectTo: `/org/${orgId}/runs/${run.id}`,
    };
  } catch (error: any) {
    console.error("[ACTION ERROR] Failed to start workflow:", error);
    return {
      success: false,
      error: error.message || "Failed to initialize execution engine",
    };
  }
}