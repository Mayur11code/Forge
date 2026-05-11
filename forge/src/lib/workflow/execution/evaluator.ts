// src/lib/workflow/execution/evaluator.ts
import { db } from "@/lib/prisma/db";
import { acquireLock, releaseLock } from "./mutex";
import { publishEvent } from "@/lib/events/queue";

export async function advanceWorkflow(runId: string) {

  const token = await acquireLock(runId);
  if (!token) {
    console.log(`[EVALUATOR] Run ${runId} is currently locked by another worker. Yielding.`);
    return; // Safely die, the other worker will handle the evaluation
  }

  try {
    // 2. FETCH THE FULL STATE
    const run = await db.workflowRun.findUnique({
      where: { id: runId },
      include: {
        workflow: true,
        stepRuns: true, // We need to know the status of every node that has run
      }
    });

    if (!run) throw new Error("WorkflowRun not found");

    // If the workflow is already finished or cancelled, stop evaluating.
    if (run.status !== "RUNNING" && run.status !== "PENDING") return;

    const definition = run.workflow.definition as any;
    const steps = definition.steps; // The compiled Adjacency List from React Flow
    const existingStepRuns = run.stepRuns;

    // 3. THE TOPOLOGICAL MATH
    const readyStepIds: string[] = [];
    const cancelledStepIds: string[] = [];

    // Loop through every single node in the visual blueprint
    for (const [stepId, nodeConfig] of Object.entries(steps)) {
      const node = nodeConfig as any;

      // A. Has this node already been queued or executed?
      const hasRun = existingStepRuns.find((s) => s.stepId === stepId);
      if (hasRun) continue; // If it's already in the DB, ignore it.

      // B. Check Dependencies (The Diamond Problem solved)
      const dependencies = (node.dependsOn || []) as string[];

      // If it has no dependencies (like a Trigger), it is instantly ready.
      let isReady = true;
      let shouldCancel = false;

      if (dependencies.length > 0) {
        for (const depId of dependencies) {
          const parentStepRun = existingStepRuns.find((s) => s.stepId === depId);

          const status = parentStepRun?.status;

          if (status === "FAILED" || status === "CANCELLED") {
            shouldCancel = true;
            isReady = false;
            break;
          } else if (status !== "SUCCESS") {
            // 2. Merged: If status is undefined (not queued), PENDING, or RUNNING
            isReady = false;
          }
        }
      }

      // Push to the correct bucket based on the outcome
      if (shouldCancel) {
        cancelledStepIds.push(stepId);
      } else if (isReady) {
        readyStepIds.push(stepId);
      }
    }

    if (cancelledStepIds.length > 0) {
      // 1. Batch insert the CANCELLED status in the database
      await db.stepRun.createMany({
        data: cancelledStepIds.map((stepId) => ({
          runId: runId,
          stepId: stepId,
          status: "CANCELLED",
        }))
      });

      // 2. Release the Redis lock early
      await releaseLock(runId, token);

      // 3. Immediately evaluate again! (Recursion)
      return advanceWorkflow(runId);
    }

    // 4. DISPATCH THE WORKERS
    if (readyStepIds.length > 0) {
      console.log(`[EVALUATOR] Run ${runId} pushing ${readyStepIds.length} steps to QStash:`, readyStepIds);

      // We create the PENDING rows in the DB *before* calling QStash 
      // so the Evaluator doesn't accidentally queue them twice on the next loop
      await db.stepRun.createMany({
        data: readyStepIds.map((stepId) => ({
          runId: runId,
          stepId: stepId,
          status: "PENDING",
        }))
      });

      for (const stepId of readyStepIds) {
        await publishEvent("EXECUTE_WORKFLOW_NODE", {
          runId: runId,
          stepRunId: stepId,
        });
      }
    } else {
      // 5. TERMINAL CONVERGENCE (The end of the line)
      // If nothing is ready, check if everything is finished.
      const allDone = Object.keys(steps).every((stepId) => {
        const s = existingStepRuns.find((sr) => sr.stepId === stepId);
        return s?.status === "SUCCESS" || s?.status === "CANCELLED" || s?.status === "FAILED";
      });

      if (allDone) {
        // Inspect the wreckage: Are there any FAILED steps in the history?
        const hasFailures = existingStepRuns.some(s => s.status === "FAILED");
        const finalStatus = hasFailures ? "FAILED" : "COMPLETED";

        await db.workflowRun.update({
          where: { id: runId },
          data: { status: finalStatus, completedAt: new Date() }
        });
      }
    }

  } catch (error) {
    console.error(`[EVALUATOR] Fatal error evaluating run ${runId}:`, error);
  } finally {
    // 6. RELEASE THE LOCK
    // This runs no matter what, even if the math crashes, preventing infinite deadlocks.
    await releaseLock(runId, token);
  }
}