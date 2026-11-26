"use server";

import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/prisma/extended";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { revalidatePath } from "next/cache";
import { updateTaskInOrg, UpdateTaskResult } from "@/lib/tasks/update-task";
import { updateTaskSchema } from "@/core/domain";

/**
 * Server action to update task attributes (status, priority, assignee, title).
 *
 * Enforces strict tenant boundaries:
 * 1. Resolves caller's authenticated session.
 * 2. Re-resolves the task's project organization at the server boundary.
 * 3. Asserts the caller is an active member of the owning organization.
 * 4. Calls the canonical updateTaskInOrg business operation.
 */
export async function updateTaskInOrgAction(
  input: unknown
): Promise<UpdateTaskResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      success: false,
      code: "INVALID_INPUT",
      error: "Unauthorized: Active session required.",
    };
  }

  const parsed = updateTaskSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      error: "Invalid task update payload.",
    };
  }

  // 1. Resolve task's parent project and organization
  const taskRecord = await prisma.task.findUnique({
    where: { id: parsed.data.taskId },
    select: {
      id: true,
      projectId: true,
      project: {
        select: {
          orgId: true,
          organization: {
            select: {
              id: true,
              slug: true,
            },
          },
        },
      },
    },
  });

  if (!taskRecord || !taskRecord.project?.organization) {
    return {
      success: false,
      code: "TASK_NOT_FOUND",
      error: "Task not found in this organization.",
    };
  }

  const orgSlug = taskRecord.project.organization.slug;
  const orgId = taskRecord.project.organization.id;

  // 2. Authoritative tenant membership check
  const access = await getOrgAccess(orgSlug);
  if (!access || access.organization.id !== orgId) {
    return {
      success: false,
      code: "TASK_NOT_FOUND",
      error: "Forbidden: Cross-tenant access denied.",
    };
  }

  // 3. Invoke canonical domain update
  const result = await updateTaskInOrg(parsed.data, {
    orgId,
    userId: session.user.id,
  });

  if (result.success) {
    revalidatePath(`/org/${orgSlug}/projects/${taskRecord.projectId}/tasks/${taskRecord.id}`);
    revalidatePath(`/org/${orgSlug}/projects/${taskRecord.projectId}`);
    revalidatePath(`/org/${orgSlug}/tasks`);
    revalidatePath(`/org/${orgSlug}/Tasks`);
  }

  return result;
}
