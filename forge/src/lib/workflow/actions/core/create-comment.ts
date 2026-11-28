// src/lib/workflow/actions/core/create-comment.ts
//
// Thin worker-safe adapter for the `comment.create` workflow action.
//
// Invariants:
// - Trusted org resolved from persisted Workflow row.
// - Calls canonical worker-safe `createCommentInOrg`.
// - In backward saga compensation, appends an idempotent rollback tombstone
//   preserving audit history without destroying the initial comment record.

import {
  ExecuteFunction,
  CompensateFunction,
  WorkflowAction,
} from "../../../workflow-types/type";
import { db } from "@/lib/prisma/db";
import type { Prisma } from "@prisma/client";
import {
  createCommentInOrg,
  appendTombstoneCommentInOrg,
} from "@/lib/comments/create-comment";

const execute: ExecuteFunction = async (ctx) => {
  try {
    const { taskId, content, userId } = ctx.inputs;

    if (!taskId || typeof taskId !== "string") {
      return {
        success: false,
        error: "Missing required field: taskId is required",
        isRetriable: false,
      };
    }

    if (!content || typeof content !== "string" || !content.trim()) {
      return {
        success: false,
        error: "Missing required field: content cannot be empty",
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

    // 2. Create comment via canonical worker-safe service
    const result = await createCommentInOrg(
      {
        taskId,
        content: content.trim(),
        userId: typeof userId === "string" ? userId : undefined,
      },
      {
        orgId: trustedOrgId,
      },
    );

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        isRetriable: result.code === "CREATE_FAILED",
      };
    }

    return {
      success: true,
      data: {
        commentId: result.comment.id,
        taskId: result.comment.taskId,
        content: result.comment.content,
        userId: result.comment.userId,
        createdAt: result.comment.createdAt instanceof Date ? result.comment.createdAt.toISOString() : String(result.comment.createdAt),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create comment",
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
        error: "StepRun outputs missing; cannot determine comment to compensate",
        isRetriable: false,
      };
    }

    const commentId = outputs.commentId as string | undefined;
    if (!commentId) {
      return {
        success: false,
        error: "StepRun outputs missing commentId",
        isRetriable: false,
      };
    }

    // 1. Idempotency Check (Duplicate Delivery Protection):
    const existingAudit = await db.executionAuditLog.findFirst({
      where: {
        runId: ctx.runId,
        stepId: ctx.stepRunId ?? ctx.stepId,
        eventType: "COMPENSATION_COMMENT_TOMBSTONED",
      },
    });
    if (existingAudit) {
      return {
        success: true,
        data: {
          commentId,
          alreadyCompensated: true,
          tombstoneAppended: false,
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

    // 2. Append idempotent compensation tombstone note
    const tombstoneResult = await appendTombstoneCommentInOrg(
      commentId,
      { orgId: trustedOrgId },
      "Automated action rolled back due to downstream workflow failure",
    );

    if (!tombstoneResult.success) {
      return {
        success: false,
        error: tombstoneResult.error,
        isRetriable: tombstoneResult.code === "UPDATE_FAILED",
      };
    }

    // 3. Commit durable compensation receipt in ExecutionAuditLog
    await db.executionAuditLog.create({
      data: {
        runId: ctx.runId,
        stepId: ctx.stepRunId ?? ctx.stepId,
        logLevel: "INFO",
        eventType: "COMPENSATION_COMMENT_TOMBSTONED",
        message: `Comment ${commentId} marked with rollback tombstone`,
        payload: {
          commentId,
          taskId: typeof outputs.taskId === "string" ? outputs.taskId : null,
          tombstoneAppended: tombstoneResult.tombstoneAppended,
          compensatedAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      success: true,
      data: {
        commentId,
        tombstoneAppended: tombstoneResult.tombstoneAppended,
        alreadyCompensated: false,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Fatal error during comment compensation",
      isRetriable: true,
    };
  }
};

export const createCommentAction: WorkflowAction = {
  id: "comment.create",
  version: "1.0.0",
  execute,
  compensate,
};
