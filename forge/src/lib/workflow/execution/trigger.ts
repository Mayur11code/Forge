// src/lib/workflow/execution/trigger.ts
import { db } from "@/lib/prisma/db";
import { advanceWorkflow } from "./evaluator";



export async function startWorkflow(workflowId: string, triggerData: Record<string, any> = {}) {
  const workflow = await db.workflow.findUnique({
    where: { id: workflowId },
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