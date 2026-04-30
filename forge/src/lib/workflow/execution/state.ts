// src/lib/workflow/execution/state.ts
import { db } from "@/lib/prisma/db";

/**
 * Appends the output of a successful step to the Global Context.
 * Namespaces the data by stepId to prevent variable collisions.
 */
export async function appendStepOutputToContext(
  runId: string,
  stepId: string,
  outputData: Record<string, any>
) {
  // 1. Fetch the current global context
  const run = await db.workflowRun.findUnique({
    where: { id: runId },
    select: { context: true },
  });

  if (!run) {
    throw new Error(`CRITICAL: WorkflowRun ${runId} not found during context merge.`);
  }

  // 2. Safely parse the existing JSON state
  const currentContext = (run.context as Record<string, any>) || {};

  // 3. Inject the new data under the specific step's ID
  currentContext[stepId] = {
    outputs: outputData,
  };

  // 4. Persist the updated state back to Postgres
  await db.workflowRun.update({
    where: { id: runId },
    data: {
      context: currentContext,
    },
  });

  return currentContext;
}