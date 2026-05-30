// src/app/api/workflow/worker/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/prisma/db";
import { resolveInputs } from "@/lib/workflow/execution/resolver";
import { wrapStepOperation } from "@/lib/workflow/execution/wrapper";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";

// QStash now sends your custom CloudEvent envelope from queue.ts
type CloudEventWrapper = {
    type: string;
    data: {
        runId: string;
        stepRunId: string;
        kind :string;
    }
};

async function handler(req: NextRequest) {
    try {
        const body = await req.json() as CloudEventWrapper;

        // 1. UNPACK THE CLOUD EVENT
        const { stepRunId, runId, kind } = body.data;
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
        if (stepRun.status === "SUCCESS" || stepRun.status === "FAILED" || stepRun.status === "CANCELLED" || stepRun.status === "SKIPPED" || stepRun.status === "COMPENSATED" || stepRun.status === "COMPENSATION_FAILED") {
            console.log(`[WORKER] StepRun ${stepRunId} is already ${stepRun.status}. Skipping.`);
            return new NextResponse("Already processed", { status: 200 });
        }


        // CHANGE 2: THE GHOST BUSTER
        if (stepRun.run.status === "ROLLING_BACK" && stepRun.status === "PENDING") {
            console.log(`[WORKER] Ghost busted. Cancelling pending step ${stepRunId}.`);
            await db.stepRun.update({
                where: { id: stepRunId },
                data: { status: "CANCELLED" }
            });
            // Wake up the evaluator to continue the rollback
            await advanceWorkflow(runId).catch(console.error);
            return new NextResponse("Ghost Cancelled", { status: 200 });
        }


        // CHANGE 3: THE FORK IN THE ROAD
        const operation = stepRun.status === "PENDING" ? "EXECUTE" : "COMPENSATE";

        // 4. EXTRACT RAW CONFIGURATION (The {{...}} strings)
        // stepRun.stepId is the React Flow node ID (e.g., "node_abc123")
        const workflowDefinition = stepRun.run.workflow.definition as any;
        const nodeDefinition = workflowDefinition.steps[stepRun.stepId];

        if (!nodeDefinition) {
            return new NextResponse("Node definition missing", { status: 400 });
        }

        const actionId = nodeDefinition.action; // e.g., "task.create"

        // 5. RESOLVE THE POINTERS (Phase 3 Magic)
        let resolvedInputs: Record<string, any> | undefined = undefined;
        if (operation === "EXECUTE") {
            const rawInputs = nodeDefinition.config || {};
            const globalContext = stepRun.run.context as Record<string, any>;
            resolvedInputs = resolveInputs(rawInputs, globalContext);
            console.log(`[WORKER] Resolved inputs for step ${stepRunId}:`, resolvedInputs);
        }


        // CHANGE 5: THE UNIFIED SANDBOX
        const result = await wrapStepOperation(
            stepRun.runId,
            stepRun.stepId,
            actionId,
            body.data.kind as "TRIGGER" | "ACTION", // Pass the kind from the CloudEvent
            resolvedInputs,
            operation

        );

        // CHANGE 6: THE DEAD LETTER HTTP MATH
        if (!result.success && "status" in result) {
            if (result.status === "RETRYING" || result.status === "COMPENSATING") {
                console.warn(`[WORKER] Step ${stepRun.stepId} failed ${operation}. Triggering QStash retry.`);
                return new NextResponse("Retrying", { status: 500 });
            }
            // If status is FAILED or COMPENSATION_FAILED, we fall through to return 200 OK
            // so QStash deletes the message and the Evaluator takes over.
        }

        // --- PHASE 5: THE CHAIN REACTION ---
        // If we reach here, the step either SUCCEEDED, or FAILED permanently.
        // We must trigger the Engine Evaluator to process downstream nodes or close the workflow.
        console.log(`[WORKER] Step ${stepRun.stepId} finished. Triggering Engine Evaluator...`);

        // Note: We don't await this because we want to return 200 OK to QStash immediately.
        // The evaluator runs independently in the background.
        await advanceWorkflow(runId).catch(err => {
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