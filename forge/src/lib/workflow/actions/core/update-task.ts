// src/lib/workflow/actions/core/update-task.ts
//
// Thin worker-safe adapter for the `task.update` workflow action.
//
// Trust model:
// - Trusted org resolved from persisted Workflow row, never from ctx.inputs.
// - `taskId` arrives from node inputs and is re-scoped to trusted org.
// - Captures atomic pre-state snapshot for safe backward saga compensation.
// - In compensation, verifies current status has not moved past the forward update
//   (concurrent human protection) before restoring prior state.

import {
  ExecuteFunction,
  CompensateFunction,
  WorkflowAction,
  JsonValue,
} from "../../../workflow-types/type";
import { db } from "@/lib/prisma/db";
import { updateTaskInOrg } from "@/lib/tasks/update-task";
import type { Prisma } from "@prisma/client";

const execute: ExecuteFunction = async (ctx) => {
  try {
    const { taskId, title, status, priority, description, assigneeId } = ctx.inputs;

    if (!taskId || typeof taskId !== "string") {
      return {
        success: false,
        error: "Missing required field: taskId is required",
        isRetriable: false,
      };
    }

    // 1. Resolve trusted org boundary from persisted Workflow
    const workflow = await db.workflow.findUnique({
      where: { id: ctx.workflowId },
      select: { orgId: true },
    });

    if (!workflow) {
      return {
        success: false,
        error: "Workflow not found",
        isRetriable: false,
      };
    }
    const trustedOrgId = workflow.orgId;

    // 2. Fetch current task state under lock to capture pre-state snapshot
    const existing = await db.task.findFirst({
      where: {
        id: taskId,
        project: { orgId: trustedOrgId },
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        description: true,
        assigneeId: true,
      },
    });

    if (!existing) {
      return {
        success: false,
        error: `Task ${taskId} not found in this organization`,
        isRetriable: false,
      };
    }

    const previousState = {
      status: existing.status,
      priority: existing.priority,
      title: existing.title,
      description: existing.description,
      assigneeId: existing.assigneeId,
    };

    // 3. Invoke canonical task update with WORKFLOW origin metadata
    const result = await updateTaskInOrg(
      {
        taskId,
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(assigneeId !== undefined ? { assigneeId } : {}),
      },
      {
        orgId: trustedOrgId,
        origin: {
          originType: "WORKFLOW",
          workflowId: ctx.workflowId,
          workflowRunId: ctx.runId,
        },
      },
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        isRetriable: result.code === "UPDATE_FAILED",
      };
    }

    const appliedChanges: Record<string, JsonValue> = {};
    if (title !== undefined) appliedChanges.title = title;
    if (status !== undefined) appliedChanges.status = status;
    if (priority !== undefined) appliedChanges.priority = priority;
    if (description !== undefined) appliedChanges.description = description;
    if (assigneeId !== undefined) appliedChanges.assigneeId = assigneeId;

    return {
      success: true,
      data: {
        taskId: result.task.id,
        title: result.task.title,
        status: result.task.status,
        priority: result.task.priority,
        assigneeId: result.task.assigneeId,
        appliedChanges,
        previousState: previousState as unknown as JsonValue,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to update task",
      isRetriable: true,
    };
  }
};

const compensate: CompensateFunction = async (ctx) => {
  try {
    const outputs = ctx.outputs as Record<string, unknown> | null;
    if (!outputs || typeof outputs !== "object") {
      return {
        success: false,
        error: "StepRun outputs missing; cannot determine task to compensate",
        isRetriable: false,
      };
    }

    const taskId = outputs.taskId as string | undefined;
    const previousState = outputs.previousState as {
      status?: string;
      priority?: string;
      title?: string;
      description?: string | null;
      assigneeId?: string | null;
    } | undefined;
    const appliedChanges = (outputs.appliedChanges as Record<string, unknown> | undefined) || {};

    if (!taskId || !previousState) {
      return {
        success: false,
        error: "StepRun outputs missing taskId or previousState snapshot",
        isRetriable: false,
      };
    }

    // 1. Idempotency Check (Duplicate Delivery Protection):
    // If this stepRun was already compensated, return success immediately without re-evaluating.
    const existingAudit = await db.executionAuditLog.findFirst({
      where: {
        runId: ctx.runId,
        stepId: ctx.stepRunId ?? ctx.stepId,
        eventType: "COMPENSATION_TASK_UPDATED",
      },
    });
    if (existingAudit) {
      return {
        success: true,
        data: {
          taskId,
          alreadyCompensated: true,
          restored: false,
          restoredState: previousState as unknown as JsonValue,
        },
      };
    }

    // 2. Resolve trusted organization boundary
    const workflow = await db.workflow.findUnique({
      where: { id: ctx.workflowId },
      select: { orgId: true },
    });

    if (!workflow) {
      return {
        success: false,
        error: "Workflow not found; authorization boundary cannot be verified",
        isRetriable: false,
      };
    }
    const trustedOrgId = workflow.orgId;

    // 3. Fetch current task state to verify pre-conditions
    const currentTask = await db.task.findFirst({
      where: {
        id: taskId,
        project: { orgId: trustedOrgId },
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        description: true,
        assigneeId: true,
      },
    });

    if (!currentTask) {
      return {
        success: false,
        error: `Task ${taskId} not found in this organization during compensation`,
        isRetriable: false,
      };
    }

    // 4. Duplicate / In-Place Idempotency Verification:
    // If every applied field already matches previousState, the task is already restored.
    const appliedKeys = Object.keys(appliedChanges);
    if (appliedKeys.length > 0) {
      const alreadyRestored = appliedKeys.every((field) => {
        const curVal = (currentTask as Record<string, unknown>)[field] ?? null;
        const prevVal = (previousState as Record<string, unknown>)[field] ?? null;
        return curVal === prevVal;
      });
      if (alreadyRestored) {
        return {
          success: true,
          data: {
            taskId,
            alreadyCompensated: true,
            restored: false,
            restoredState: previousState as unknown as JsonValue,
          },
        };
      }
    }

    // 5. Exhaustive Multi-Field Concurrency Conflict Check:
    // Compare every field modified by the forward step against the currently persisted value.
    // If ANY field has diverged, abort the entire compensation without clobbering human intent.
    const divergences: string[] = [];
    for (const [field, appliedVal] of Object.entries(appliedChanges)) {
      if (appliedVal !== undefined) {
        const currentVal = (currentTask as Record<string, unknown>)[field] ?? null;
        const expectedVal = appliedVal ?? null;
        if (currentVal !== expectedVal) {
          divergences.push(`${field} diverged (expected '${expectedVal}', found '${currentVal}')`);
        }
      }
    }

    if (divergences.length > 0) {
      const errorMsg = `Task ${taskId} was concurrently modified during workflow run. Refusing to clobber human intent during compensation. Divergent fields: ${divergences.join("; ")}`;

      await db.executionAuditLog.create({
        data: {
          runId: ctx.runId,
          stepId: ctx.stepRunId ?? ctx.stepId,
          logLevel: "WARN",
          eventType: "COMPENSATION_CONFLICT_DETECTED",
          message: errorMsg,
          payload: {
            taskId,
            divergences,
            appliedChanges,
            conflictDetectedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return {
        success: false,
        error: errorMsg,
        isRetriable: false,
      };
    }

    // 6. Build the selective restore payload:
    // Strictly restore ONLY the fields that were modified by this action.
    const restoreChanges: Record<string, unknown> = { taskId };
    for (const field of appliedKeys) {
      if (field in previousState) {
        restoreChanges[field] = (previousState as Record<string, unknown>)[field];
      }
    }

    // 7. Atomic Restoration with Lock-Protected CAS:
    // Pass expectedState to updateTaskInOrg so that comparison and write execute
    // under row-level lock within the canonical update transaction.
    const restoreResult = await updateTaskInOrg(
      restoreChanges,
      {
        orgId: trustedOrgId,
        origin: {
          originType: "WORKFLOW",
          workflowId: ctx.workflowId,
          workflowRunId: ctx.runId,
        },
        expectedState: appliedChanges,
      },
    );

    if (!restoreResult.success) {
      return {
        success: false,
        error: `Failed to restore task ${taskId} to prior state: ${restoreResult.error}`,
        isRetriable: false,
      };
    }

    // 8. Commit durable compensation receipt in ExecutionAuditLog
    await db.executionAuditLog.create({
      data: {
        runId: ctx.runId,
        stepId: ctx.stepRunId ?? ctx.stepId,
        logLevel: "INFO",
        eventType: "COMPENSATION_TASK_UPDATED",
        message: `Task ${taskId} restored to prior state during saga rollback`,
        payload: {
          taskId,
          restoredState: previousState,
          revertedChanges: appliedChanges,
          compensatedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      success: true,
      data: {
        taskId,
        alreadyCompensated: false,
        restored: true,
        restoredState: previousState as unknown as JsonValue,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Fatal error during task update compensation",
      isRetriable: false,
    };
  }
};

export const updateTaskAction: WorkflowAction = {
  id: "task.update",
  version: "1.0.0",
  execute,
  compensate,
};
