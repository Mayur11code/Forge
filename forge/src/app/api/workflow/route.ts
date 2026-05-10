// src/app/api/workflow/worker/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/prisma/db";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import { wrapStepExecution } from "@/lib/workflow/execution/wrapper";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator"; 

// QStash now sends your custom CloudEvent envelope from queue.ts
type CloudEventWrapper = {
    type: string;
    data: {
        runId: string;
        stepRunId: string;
    }
};

async function handler(req: NextRequest) {
    try {
        const body = await req.json() as CloudEventWrapper;
        
        // 1. UNPACK THE CLOUD EVENT
        const { stepRunId, runId } = body.data;

        // 2. FETCH THE ENTIRE TREE (StepRun -> WorkflowRun -> Workflow)
        const stepRun = await db.stepRun.findUnique({
            where: { id: stepRunId },
            include: {
                run: {
                    include: {
                        workflow: true, // We need the DAG definition!
                    }
                }
            }
        });

        if (!stepRun) {
            console.error(`[WORKER] StepRun ${stepRunId} not found.`);
            return new NextResponse("Not Found", { status: 404 }); // 404 tells QStash to drop the message
        }

        // 3. IDEMPOTENCY GUARD
        // If QStash accidentally sends this twice, or if a previous run succeeded but 
        // the network dropped the 200 OK response, we do NOT run it again.
        if (stepRun.status === "SUCCESS" || stepRun.status === "FAILED" || stepRun.status === "CANCELLED") {
            console.log(`[WORKER] StepRun ${stepRunId} is already ${stepRun.status}. Skipping.`);
            return new NextResponse("Already processed", { status: 200 });
        }

        // 4. EXTRACT RAW CONFIGURATION (The {{...}} strings)
        // stepRun.stepId is the React Flow node ID (e.g., "node_abc123")
        const workflowDefinition = stepRun.run.workflow.definition as any;
        const nodeDefinition = workflowDefinition.steps[stepRun.stepId];

        if (!nodeDefinition) {
            return new NextResponse("Node definition missing", { status: 400 });
        }

        const rawInputs = nodeDefinition.config || {};
        const actionId = nodeDefinition.action; // e.g., "task.create"

        // 5. RESOLVE THE POINTERS (Phase 3 Magic)
        const globalContext = stepRun.run.context as Record<string, any>;
        const resolvedInputs = resolveInputs(rawInputs, globalContext);

        // 6. ENTER THE SANDBOX (Phase 4, Step 10)
        const result = await wrapStepExecution(
            stepRun.runId,
            stepRun.stepId, // The React Flow ID
            actionId,
            resolvedInputs
        );

        // 7. THE HTTP MATH (Step 12: Step-Level Retries)
        if (!result.success && "status" in result) {
            if (result.status === "RETRYING") {
                // Returning a 5xx status tells QStash: "I failed, but please use 
                // your exponential backoff algorithm and send this EXACT request to me again later."
                console.warn(`[WORKER] Step ${stepRun.stepId} failed. Triggering QStash retry.`);
                return new NextResponse("Retrying", { status: 500 });
            }
        }

        // --- PHASE 5: THE CHAIN REACTION ---
        // If we reach here, the step either SUCCEEDED, or FAILED permanently.
        // We must trigger the Engine Evaluator to process downstream nodes or close the workflow.
        console.log(`[WORKER] Step ${stepRun.stepId} finished. Triggering Engine Evaluator...`);
        
        // Note: We don't await this because we want to return 200 OK to QStash immediately.
        // The evaluator runs independently in the background.
        advanceWorkflow(runId).catch(err => {
            console.error(`[WORKER] Evaluator failed for run ${runId}:`, err);
        });

        return new NextResponse("Execution Complete", { status: 200 });

    } catch (error: any) {
        console.error("[WORKER] Unhandled Fatal Error:", error);
        // An absolute catastrophic failure. We return 500 to ensure the message isn't lost.
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}

// Security: Wrap the handler with Upstash's signature verification
export const POST = verifySignatureAppRouter(handler);