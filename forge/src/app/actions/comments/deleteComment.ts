"use server";

import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { revalidatePath } from "next/cache";

export interface DeleteCommentResult {
  success: boolean;
  error?: string;
  deletedCommentId?: string;
}

/**
 * Server action to delete a comment.
 *
 * Enforces strict authorization and tenant isolation:
 * 1. Verifies caller has valid access to the organization.
 * 2. Scopes comment lookup through task -> project -> organization.
 * 3. Authorizes deletion ONLY if caller is the comment author OR an organization ADMIN.
 */
export async function deleteComment({
  orgSlug,
  commentId,
}: {
  orgSlug: string;
  commentId: string;
}): Promise<DeleteCommentResult> {
  try {
    const access = await getOrgAccess(orgSlug);

    if (!access) {
      return { success: false, error: "Unauthorized" };
    }

    const orgId = access.organization.id;
    const currentUserId = access.userId;
    const currentUserRole = access.membership.role;

    // Look up comment scoped strictly to caller's organization
    const comment = await db.comment.findFirst({
      where: {
        id: commentId,
        task: {
          project: {
            orgId,
          },
        },
      },
      select: {
        id: true,
        userId: true,
        taskId: true,
        task: {
          select: {
            projectId: true,
          },
        },
      },
    });

    if (!comment) {
      return { success: false, error: "Comment not found in this organization" };
    }

    // Authorization check: Must be the author or an ADMIN
    const isAuthor = comment.userId === currentUserId;
    const isAdmin = currentUserRole === "ADMIN";

    if (!isAuthor && !isAdmin) {
      return {
        success: false,
        error: "Forbidden: Only the comment author or an organization administrator can delete this comment",
      };
    }

    await db.comment.delete({
      where: { id: commentId },
    });

    revalidatePath(
      `/org/${orgSlug}/projects/${comment.task.projectId}/tasks/${comment.taskId}`
    );

    return { success: true, deletedCommentId: commentId };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete comment",
    };
  }
}
