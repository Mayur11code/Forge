// src/lib/workflow/execution/trigger.ts
import { db } from "@/lib/prisma/db";
import { advanceWorkflow } from "./evaluator";
import type { JsonValue } from "@/lib/workflow-types/type";



// Type-only. triggerData becomes WorkflowRun.context, a JSONB column, so
// JsonValue is the honest bound: anything wider would be silently mangled on
// write.
//
// I6 — TENANT SCOPE. `orgId` is REQUIRED and is the organization the caller was
// *verified* against at the boundary (a server-derived id, never a value lifted
// from the request body). The lookup below carries `orgId` in its predicate, so
// a workflow belonging to another tenant is indistinguishable from a missing
// one and can never be started. The parameter is deliberately not optional:
// there is no unscoped call shape left for a future caller to reach for, and
// adding one would not compile.
export async function startWorkflow(
  orgId: string,
  workflowId: string,
  triggerData: Record<string, JsonValue> = {},
) {
  const workflow = await db.workflow.findFirst({
    where: { id: workflowId, orgId },
  });

  if (!workflow) {
    throw new Error(`Cannot start workflow: ${workflowId} not found.`);
  }



  // 2. INITIALIZE THE GLOBAL CONTEXT
  // We mock a "trigger" step output so that Node 1 can use {{trigger.outputs.userId}}
  const initialContext = {
    trigger: {
      outputs: triggerData,
    },
  };

  // 3. CREATE THE RUN RECORD
  const run = await db.workflowRun.create({
    data: {
      workflowId: workflow.id,
      status: "RUNNING",
      context: initialContext, // The data bus is primed!
    },
  });

  console.log(`[IGNITION] Started WorkflowRun ${run.id} for Workflow ${workflow.name}`);

  // 4. PUSH THE FIRST DOMINO
  // We call advanceWorkflow, which will instantly find the nodes that have 
  // no dependencies and push them to the QStash queue.
  await advanceWorkflow(run.id);

  return run;
}