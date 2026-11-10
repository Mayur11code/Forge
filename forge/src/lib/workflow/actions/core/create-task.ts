// src/lib/workflow/actions/core/create-task.ts
//
// Thin worker-safe adapter for the `task.create` workflow action.
//
// Trust model:
// - The trusted org is resolved from the PERSISTED Workflow row, never from
//   `ctx.inputs`. A workflow can therefore only ever create tasks inside its
//   own organization.
// - `projectId` arrives from resolved workflow node config and is still
//   UNTRUSTED: the canonical operation re-verifies that it belongs to the
//   workflow's org before writing.
// - A WorkflowRun has no interactive user, so no userId is supplied.
//
// The write goes through the canonical operation, so this path uses the
// EXTENDED Prisma client and fires the TASK_CREATED CDC exactly like the UI
// and agent paths. It must not call `db.task.create` directly.

import {
  ExecuteFunction,
  CompensateFunction,
  WorkflowAction,
} from "../../../workflow-types/type";
import { db } from "@/lib/prisma/db";
import { createTaskInOrg } from "@/lib/tasks/create-task";
import { tombstoneEntityHead } from "@/lib/vector/generation-state";
import { VectorEntityType } from "@prisma/client";

const execute: ExecuteFunction = async (ctx) => {
  try {
    // 1. Inputs were already resolved by the engine (pointers replaced).
    const { title, projectId, description, priority, assigneeId } = ctx.inputs;

    if (!title || !projectId) {
      return {
        success: false,
        error: "Missing required fields: title or projectId",
        isRetriable: false, // Bad user config, retrying won't fix this
      };
    }

    // 2. Trusted org: read from the persisted Workflow record.
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

    // 3. Canonical business operation.
    const result = await createTaskInOrg(
      { title, projectId, description, priority, assigneeId },
      { orgId: workflow.orgId },
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        isRetriable: result.code === "CREATE_FAILED",
      };
    }

    // 4. Return the exact standardized payload with immutable task snapshot
    return {
      success: true,
      data: {
        taskId: result.task.id,
        title: result.task.title,
        taskSnapshot: {
          id: result.task.id,
          title: result.task.title,
          description: result.task.description,
          status: result.task.status,
          priority: result.task.priority,
          projectId: result.task.projectId,
          assigneeId: result.task.assigneeId,
          createdAt:
            result.task.createdAt instanceof Date
              ? result.task.createdAt.toISOString()
              : String(result.task.createdAt),
        },
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Database connection failed",
      isRetriable: true, // Database timeout? Let QStash try again.
    };
  }
};

const compensate: CompensateFunction = async (ctx) => {
  try {
    // 1. Outputs validation & taskId extraction
    const outputs = ctx.outputs;
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
      return {
        success: false,
        error: "StepRun outputs missing or invalid; cannot determine task to compensate",
        isRetriable: false,
      };
    }

    const taskId = (outputs as Record<string, unknown>).taskId;
    if (typeof taskId !== "string" || !taskId) {
      return {
        success: false,
        error: "StepRun outputs missing valid taskId",
        isRetriable: false,
      };
    }

    // 2. Resolve trusted organization boundary from persisted Workflow
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

    // 3. Transactional safe deletion, vector cleanup, and durable receipt
    const deletionResult = await db.$transaction(async (tx) => {
      // Step 3A: Lock task row and verify project & org ownership
      let lockedTask: {
        id: string;
        title: string;
        description: string | null;
        status: string;
        priority: string;
        projectId: string;
        assigneeId: string | null;
        createdAt: Date;
        updatedAt: Date;
        orgId: string;
      } | null = null;

      if (typeof tx.$queryRaw === "function") {
        const rows = await tx.$queryRaw<Array<{
          id: string;
          title: string;
          description: string | null;
          status: string;
          priority: string;
          projectId: string;
          assigneeId: string | null;
          createdAt: Date;
          updatedAt: Date;
          orgId: string;
        }>>`
          SELECT t.id, t.title, t.description, t.status::text, t.priority::text,
                 t."projectId", t."assigneeId", t."createdAt", t."updatedAt", p."orgId"
          FROM "Task" t
          JOIN "Project" p ON t."projectId" = p.id
          WHERE t.id = ${taskId}
          FOR UPDATE OF t;
        `;
        if (rows && rows.length > 0) {
          lockedTask = rows[0];
        }
      } else {
        // Fallback for test doubles without raw SQL
        const t = await tx.task.findUnique({
          where: { id: taskId },
          include: { project: { select: { orgId: true } } },
        });
        if (t) {
          lockedTask = {
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            priority: t.priority,
            projectId: t.projectId,
            assigneeId: t.assigneeId,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            orgId: (t as { project?: { orgId?: string } | null }).project?.orgId ?? trustedOrgId,
          };
        }
      }

      // Step 3B: Crash-after-delete gap check
      if (!lockedTask) {
        const receipt = await tx.executionAuditLog.findFirst({
          where: {
            runId: ctx.runId,
            stepId: ctx.stepRunId ?? ctx.stepId,
            eventType: "COMPENSATION_TASK_DELETED",
          },
        });

        if (receipt) {
          const payload = receipt.payload as Record<string, unknown> | null;
          if (payload && payload.taskId === taskId) {
            // Durable receipt confirms this exact step already safely deleted the task
            return {
              success: true as const,
              alreadyCompensated: true,
              projectId: (payload.projectId as string) ?? null,
            };
          }
        }

        // Missing without receipt: do NOT assume success!
        return {
          success: false as const,
          error: `Task ${taskId} not found and no compensation receipt exists; cannot verify deletion`,
          isRetriable: false,
        };
      }

      // Step 3C: Tenant isolation check
      if (lockedTask.orgId !== trustedOrgId) {
        return {
          success: false as const,
          error: `Tenant mismatch: task ${taskId} belongs to org ${lockedTask.orgId}, not ${trustedOrgId}`,
          isRetriable: false,
        };
      }

      // Step 3D: Precondition check — status must be TODO
      if (lockedTask.status !== "TODO") {
        return {
          success: false as const,
          error: `Task ${taskId} status has changed to ${lockedTask.status}; cannot safely delete`,
          isRetriable: false,
        };
      }

      // Step 3E: Inbound relations check — comments & attachments
      const commentCount = await tx.comment.count({ where: { taskId } });
      if (commentCount > 0) {
        return {
          success: false as const,
          error: `Task ${taskId} has ${commentCount} user comment(s); cannot safely delete without destroying user data`,
          isRetriable: false,
        };
      }

      const attachmentCount = await tx.attachment.count({ where: { taskId } });
      if (attachmentCount > 0) {
        return {
          success: false as const,
          error: `Task ${taskId} has ${attachmentCount} user attachment(s); cannot safely delete without destroying user data`,
          isRetriable: false,
        };
      }

      // Step 3F: Task field modification check
      const snapshot = (outputs as Record<string, unknown>).taskSnapshot as Record<string, unknown> | undefined;
      const expectedTitle = snapshot ? snapshot.title : ctx.inputs?.title;
      const expectedDesc = snapshot ? (snapshot.description ?? null) : (ctx.inputs?.description ?? null);
      const expectedPriority = snapshot ? snapshot.priority : (ctx.inputs?.priority ?? "MEDIUM");
      const expectedAssignee = snapshot ? (snapshot.assigneeId ?? null) : (ctx.inputs?.assigneeId ?? null);
      const expectedProject = snapshot ? snapshot.projectId : ctx.inputs?.projectId;

      if (expectedTitle !== undefined && lockedTask.title !== expectedTitle) {
        return {
          success: false as const,
          error: `Task ${taskId} title has been modified since creation; cannot safely delete`,
          isRetriable: false,
        };
      }
      if (expectedDesc !== undefined && (lockedTask.description ?? null) !== expectedDesc) {
        return {
          success: false as const,
          error: `Task ${taskId} description has been modified since creation; cannot safely delete`,
          isRetriable: false,
        };
      }
      if (expectedPriority !== undefined && lockedTask.priority !== expectedPriority) {
        return {
          success: false as const,
          error: `Task ${taskId} priority has been modified since creation; cannot safely delete`,
          isRetriable: false,
        };
      }
      if (expectedAssignee !== undefined && (lockedTask.assigneeId ?? null) !== expectedAssignee) {
        return {
          success: false as const,
          error: `Task ${taskId} assignee has been modified since creation; cannot safely delete`,
          isRetriable: false,
        };
      }
      if (expectedProject !== undefined && lockedTask.projectId !== expectedProject) {
        return {
          success: false as const,
          error: `Task ${taskId} projectId has been modified since creation; cannot safely delete`,
          isRetriable: false,
        };
      }

      // Step 3G: Vector cleanup & tombstoning
      if (typeof tx.$executeRaw === "function") {
        await tx.$executeRaw`
          UPDATE "VectorOutboxEvent"
          SET "status" = 'FAILED'::"VectorOutboxStatus",
              "terminalError" = 'Task deleted by workflow compensation',
              "updatedAt" = clock_timestamp()
          WHERE "orgId" = ${trustedOrgId}
            AND "entityType" = 'TASK'::"VectorEntityType"
            AND "entityId" = ${taskId}
            AND "status" IN ('PENDING'::"VectorOutboxStatus", 'CLAIMED'::"VectorOutboxStatus");
        `;
      }

      await tombstoneEntityHead({
        orgId: trustedOrgId,
        entityType: VectorEntityType.TASK,
        entityId: taskId,
        tx,
      });

      // Step 3H: Delete the task row
      await tx.task.delete({
        where: { id: taskId },
      });

      // Step 3I: Commit durable compensation receipt in ExecutionAuditLog
      await tx.executionAuditLog.create({
        data: {
          runId: ctx.runId,
          stepId: ctx.stepRunId ?? ctx.stepId,
          logLevel: "INFO",
          eventType: "COMPENSATION_TASK_DELETED",
          message: `Task ${taskId} safely deleted and vector tombstoned during saga rollback`,
          payload: {
            taskId,
            title: lockedTask.title,
            projectId: lockedTask.projectId,
            orgId: trustedOrgId,
            runId: ctx.runId,
            stepId: ctx.stepId,
            stepRunId: ctx.stepRunId,
            deletedAt: new Date().toISOString(),
          },
        },
      });

      return {
        success: true as const,
        deleted: true,
        projectId: lockedTask.projectId,
      };
    });

    if (!deletionResult.success) {
      return {
        success: false,
        error: deletionResult.error,
        isRetriable: deletionResult.isRetriable,
      };
    }

    // Step 4: Best-effort CDC notification dispatch
    try {
      const { dispatchEvent } = await import("@/lib/events/event-bus");
      await dispatchEvent("TASK_DELETED", {
        taskId,
        orgId: trustedOrgId,
        projectId:
          typeof (outputs as Record<string, unknown>).projectId === "string"
            ? ((outputs as Record<string, unknown>).projectId as string)
            : (deletionResult.projectId ?? "unknown"),
        userId: "system-saga",
        subject: "Task Deleted by Rollback",
        body: `Task ${taskId} was deleted during workflow saga rollback.`,
      });
    } catch (cdcErr) {
      console.warn("[CDC] Best-effort TASK_DELETED event dispatch failed:", cdcErr);
    }

    return {
      success: true,
      data: {
        taskId,
        deleted: true,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Compensation failed due to unexpected error",
      isRetriable: true,
    };
  }
};

// Export the fully formed action object
export const createTaskAction: WorkflowAction = {
  id: "task.create",
  version: "1.0.0",
  execute,
  compensate,
};
