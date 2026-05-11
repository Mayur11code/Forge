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
    const skippedStepIds: string[] = [];

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
      let shouldSkip = false;

      let successCount = 0;
      let skippedCount = 0;

      if (dependencies.length > 0) {
        for (const depId of dependencies) {
          const parentStepRun = existingStepRuns.find((s) => s.stepId === depId);

          const status = parentStepRun?.status;

          if (status === "FAILED" || status === "CANCELLED") {
            // 1. HARD FAILURE CASCADE (Deadly)
            shouldCancel = true;
            isReady = false;
            break;
          } else if (status === "SKIPPED") {
            // 2. SAFE BYPASS (Harmless)
            skippedCount++;
          } else if (status === "SUCCESS") {
            // 3. ROUTING CONDITION CHECK
            const routingConditions = node.routingConditions || {};
            const requiredBranch = routingConditions[depId];
            const parentOutputs = (parentStepRun?.outputs as Record<string, any>) || {};
            const actualBranch = parentOutputs?.branch;

            if (requiredBranch && actualBranch !== requiredBranch) {
              // The parent succeeded, but we are on the WRONG side of the branch!
              shouldSkip = true;
              isReady = false;
              break;
            }
            successCount++;
          } else {
            // 4. WAITING (Parent is PENDING, RUNNING, or undefined)
            isReady = false;
          }



        }


      }

      // --- EVALUATE THE NODE'S FATE ---
      if (shouldCancel) {
        cancelledStepIds.push(stepId);
      } else if (shouldSkip || (dependencies.length > 0 && skippedCount === dependencies.length)) {
        // Cascade the skip: If it failed routing, OR if ALL its parents were skipped!
        skippedStepIds.push(stepId);
      } else if (isReady && (successCount > 0 || dependencies.length === 0)) {
        // Safe Merge Logic: If it has parents, at least ONE must be a success. 
        // The rest can be SKIPPED.
        readyStepIds.push(stepId);
      }
    }

    // 2. PROCESS PRUNING & RECURSE
    if (cancelledStepIds.length > 0 || skippedStepIds.length > 0) {

      if (cancelledStepIds.length > 0) {
        await db.stepRun.createMany({
          data: cancelledStepIds.map(id => ({ runId, stepId: id, status: "CANCELLED" }))
        });
      }

      if (skippedStepIds.length > 0) {
        await db.stepRun.createMany({
          data: skippedStepIds.map(id => ({ runId, stepId: id, status: "SKIPPED" }))
        });
      }

      // The Graph shape changed! Release lock and recurse immediately.
      await releaseLock(runId, token);
      return advanceWorkflow(runId);
    }

    // 4. DISPATCH THE WORKERS
    if (readyStepIds.length > 0) {
      console.log(`[EVALUATOR] Run ${runId} pushing ${readyStepIds.length} steps to QStash:`, readyStepIds);

      for (const stepId of readyStepIds) {
        const stepRun = await db.stepRun.create({
          data: {
            runId,
            stepId,
            status: "PENDING",
          }
        });

        await publishEvent("EXECUTE_WORKFLOW_NODE", {
          runId,
          stepRunId: stepRun.id,
        });
      }
    } else {
      // 5. TERMINAL CONVERGENCE (The end of the line)
      // If nothing is ready, check if everything is finished.
      const allDone = Object.keys(steps).every((stepId) => {
        const s = existingStepRuns.find((sr) => sr.stepId === stepId);
        return s?.status === "SUCCESS" || s?.status === "CANCELLED" || s?.status === "FAILED" || s?.status === "SKIPPED";
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