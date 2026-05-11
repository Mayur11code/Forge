// src/lib/workflow/execution/evaluator.ts
import { db } from "@/lib/prisma/db";
import { acquireLock, releaseLock } from "./mutex";
import { publishEvent } from "@/lib/events/queue";

export async function advanceWorkflow(runId: string) {
  const token = await acquireLock(runId);
  if (!token) {
    console.log(`[EVALUATOR] Run ${runId} is currently locked by another worker. Yielding.`);
    return;
  }

  // 1. SAFE LOCK PATTERN
  // Tracks release state to prevent double-releasing in the finally block
  let lockReleased = false;
  const safeReleaseLock = async () => {
    if (!lockReleased) {
      await releaseLock(runId, token);
      lockReleased = true;
    }
  };

  try {
    const run = await db.workflowRun.findUnique({
      where: { id: runId },
      include: {
        workflow: true,
        stepRuns: true,
      }
    });

    if (!run) throw new Error("WorkflowRun not found");
    if (run.status !== "RUNNING" && run.status !== "PENDING") return;

    const definition = run.workflow.definition as any;
    const steps = definition.steps;
    const existingStepRuns = run.stepRuns;

    // 2. O(1) LOOKUP OPTIMIZATION (Fixing the N+1 problem)
    const stepRunMap = new Map(existingStepRuns.map(sr => [sr.stepId, sr]));

    const readyStepIds: string[] = [];
    const cancelledStepIds: string[] = [];
    const skippedStepIds: string[] = [];

    for (const [stepId, nodeConfig] of Object.entries(steps)) {
      const node = nodeConfig as any;

      // O(1) Map Lookup
      const hasRun = stepRunMap.get(stepId);
      if (hasRun) continue;

      const dependencies = (node.dependsOn || []) as string[];

      let isReady = true;
      let shouldCancel = false;
      let shouldSkip = false;

      let successCount = 0;
      let skippedCount = 0;

      if (dependencies.length > 0) {
        for (const depId of dependencies) {
          // O(1) Map Lookup
          const parentStepRun = stepRunMap.get(depId);
          const status = parentStepRun?.status;

          if (status === "FAILED" || status === "CANCELLED") {
            shouldCancel = true;
            isReady = false;
            break;
          } else if (status === "SKIPPED") {
            skippedCount++;
          } else if (status === "SUCCESS") {
            const routingConditions = node.routingConditions || {};
            const requiredBranch = routingConditions[depId];
            const parentOutputs = (parentStepRun?.outputs as Record<string, any>) || {};
            const actualBranch = parentOutputs?.branch;

            if (requiredBranch && actualBranch !== requiredBranch) {
              shouldSkip = true;
              isReady = false;
              break;
            }
            successCount++;
          } else {
            isReady = false;
          }
        }
      }

      if (shouldCancel) {
        cancelledStepIds.push(stepId);
      } else if (shouldSkip || (dependencies.length > 0 && skippedCount === dependencies.length)) {
        skippedStepIds.push(stepId);
      } else if (isReady && (successCount > 0 || dependencies.length === 0)) {
        readyStepIds.push(stepId);
      }
    }

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

      await safeReleaseLock();

      // 3. FLATTEN THE CALL STACK (Preventing infinite recursion depth)
      queueMicrotask(() => advanceWorkflow(runId));
      return;
    }

    // 4. DISPATCH THE WORKERS
    if (readyStepIds.length > 0) {
      console.log(`[EVALUATOR] Run ${runId} pushing ${readyStepIds.length} steps to QStash...`);

      // Parallelize the database writes and webhook firing for maximum speed
      await Promise.all(
        readyStepIds.map(async (stepId) => {
          try {
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

          } catch (error: any) {
            // P2002 means the DB physically blocked a duplicate from being created.
            // Another worker won the race. We safely ignore this and move on.
            if (error.code === "P2002") {
              console.warn(`[EVALUATOR] Step ${stepId} already exists for run ${runId}. Ghost worker neutralized.`);
            } else {
              // If it's a real database error (e.g., connection lost), we MUST throw it.
              throw error;
            }
          }
        })
      );
    } else {
      // 4. FIXING THE STALE STATE READ
      // We must fetch fresh data here to ensure nodes we just pruned or executed aren't missing
      const latestStepRuns = await db.stepRun.findMany({ where: { runId } });
      const latestMap = new Map(latestStepRuns.map(sr => [sr.stepId, sr]));

      const allDone = Object.keys(steps).every((stepId) => {
        const s = latestMap.get(stepId);
        return s?.status === "SUCCESS" || s?.status === "CANCELLED" || s?.status === "FAILED" || s?.status === "SKIPPED";
      });

      if (allDone) {
        const hasFailures = latestStepRuns.some(s => s.status === "FAILED");
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
    await safeReleaseLock();
  }
}