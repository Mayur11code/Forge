// src/lib/comments/create-comment.ts
//
// CANONICAL comment creation and compensation operations for background worker safety.
//
// Worker safety invariants:
// - No `auth()`, no session cookies, no `getOrgAccess()`.
// - No `notFound()`, no `redirect()`, no `revalidatePath()`, no `next/*` imports.
// - Organization boundary is TRUSTED and supplied by actor context.
// - Target task is strictly scoped to the trusted organization via project.orgId.

import { db } from "@/lib/prisma/db";
import type { Comment } from "@prisma/client";

export type CreateCommentActor = {
  orgId: string;
  userId?: string;
};

export type CreateCommentInput = {
  taskId: string;
  content: string;
  userId?: string;
};

export type CreateCommentResult =
  | { success: true; comment: Comment }
  | { success: false; error: string; code: "TASK_NOT_FOUND" | "INVALID_INPUT" | "AUTHOR_NOT_FOUND" | "CREATE_FAILED" };

export type DeleteCommentResult =
  | { success: true; deletedCommentId: string }
  | { success: false; error: string; code: "COMMENT_NOT_FOUND" | "DELETE_FAILED" };

export type TombstoneCommentResult =
  | { success: true; comment: Comment; tombstoneAppended: boolean }
  | { success: false; error: string; code: "COMMENT_NOT_FOUND" | "UPDATE_FAILED" };

/**
 * Creates a comment on a task within a trusted organization.
 */
export async function createCommentInOrg(
  input: CreateCommentInput,
  actor: CreateCommentActor,
): Promise<CreateCommentResult> {
  const content = input.content ? input.content.trim() : "";
  if (!content) {
    return { success: false, code: "INVALID_INPUT", error: "Comment content cannot be empty." };
  }
  if (!input.taskId || typeof input.taskId !== "string") {
    return { success: false, code: "INVALID_INPUT", error: "Valid taskId is required." };
  }

  // 1. Verify task exists within the trusted organization
  const task = await db.task.findFirst({
    where: {
      id: input.taskId,
      project: { orgId: actor.orgId },
    },
    select: { id: true, projectId: true, assigneeId: true },
  });

  if (!task) {
    return { success: false, code: "TASK_NOT_FOUND", error: "Task not found in this organization." };
  }

  // 2. Resolve author identity
  // Comment.userId has an absolute foreign key requirement to User.id.
  let authorUserId = input.userId || actor.userId;

  if (authorUserId) {
    // Validate author belongs to the trusted org
    const member = await db.membership.findFirst({
      where: { orgId: actor.orgId, userId: authorUserId },
      select: { userId: true },
    });
    if (!member) {
      authorUserId = undefined;
    }
  }

  if (!authorUserId) {
    // Resolve organization admin / any member as system-bot fallback
    const firstMember = await db.membership.findFirst({
      where: { orgId: actor.orgId },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    authorUserId = firstMember?.userId;
  }

  if (!authorUserId) {
    return {
      success: false,
      code: "AUTHOR_NOT_FOUND",
      error: "No eligible organization member found to attribute automated comment.",
    };
  }

  try {
    const comment = await db.comment.create({
      data: {
        content,
        taskId: input.taskId,
        userId: authorUserId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });

    return { success: true, comment };
  } catch (err) {
    return {
      success: false,
      code: "CREATE_FAILED",
      error: err instanceof Error ? err.message : "Failed to create comment in database.",
    };
  }
}

/**
 * Safe hard deletion of a comment during saga compensation.
 */
export async function deleteCommentInOrg(
  commentId: string,
  actor: CreateCommentActor,
): Promise<DeleteCommentResult> {
  const comment = await db.comment.findFirst({
    where: {
      id: commentId,
      task: { project: { orgId: actor.orgId } },
    },
    select: { id: true },
  });

  if (!comment) {
    return { success: false, code: "COMMENT_NOT_FOUND", error: "Comment not found in this organization." };
  }

  try {
    await db.comment.delete({
      where: { id: commentId },
    });
    return { success: true, deletedCommentId: commentId };
  } catch (err) {
    return {
      success: false,
      code: "DELETE_FAILED",
      error: err instanceof Error ? err.message : "Failed to delete comment.",
    };
  }
}

/**
 * Appends a compensation tombstone notice to an existing comment.
 * Idempotent: will not duplicate the tombstone note if already appended.
 */
export async function appendTombstoneCommentInOrg(
  commentId: string,
  actor: CreateCommentActor,
  reason = "Workflow compensation rollback",
): Promise<TombstoneCommentResult> {
  const comment = await db.comment.findFirst({
    where: {
      id: commentId,
      task: { project: { orgId: actor.orgId } },
    },
  });

  if (!comment) {
    return { success: false, code: "COMMENT_NOT_FOUND", error: "Comment not found in this organization." };
  }

  const tombstoneTag = `[ROLLED BACK: ${reason}]`;
  if (comment.content.includes(tombstoneTag)) {
    return { success: true, comment, tombstoneAppended: false };
  }

  try {
    const updated = await db.comment.update({
      where: { id: commentId },
      data: {
        content: `${comment.content}\n\n*${tombstoneTag}*`,
      },
    });
    return { success: true, comment: updated, tombstoneAppended: true };
  } catch (err) {
    return {
      success: false,
      code: "UPDATE_FAILED",
      error: err instanceof Error ? err.message : "Failed to append compensation tombstone to comment.",
    };
  }
}
