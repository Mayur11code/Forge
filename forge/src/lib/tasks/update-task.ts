// src/lib/tasks/update-task.ts
//
// CANONICAL task update business operation.
//
// Like create-task.ts, every caller (UI server action, workflow action, agent
// tool executor) funnels through one function, and there is exactly one
// `prisma.task.update` for task mutation in the codebase.
//
// Security contract:
// - `orgId` is TRUSTED and supplied by the caller. Never model input.
// - `taskId` is UNTRUSTED and always re-scoped to the trusted org before the
//   write. Task has no orgId column, so the check goes through the project
//   relation.
// - An untrusted `assigneeId` must be a member of the trusted org; assigning
//   to a non-member is a cross-tenant leak of work, not a cosmetic error.
//
// Worker safety:
// - No `auth()`, no `notFound()`, no `revalidatePath()`, no `next/*` imports.

import { prisma } from "@/lib/prisma/extended";
import { updateTaskSchema } from "@/core/domain";
import type { Prisma, Task } from "@prisma/client";

export type UpdateTaskActor = {
  orgId: string;
  userId?: string;
};

export type UpdateTaskFailureCode =
  | "INVALID_INPUT"
  | "TASK_NOT_FOUND"
  | "ASSIGNEE_NOT_FOUND"
  | "NO_CHANGES"
  | "UPDATE_FAILED";

export type UpdateTaskResult =
  | { success: true; task: Task }
  | { success: false; error: string; code: UpdateTaskFailureCode };

/**
 * Update a task inside a trusted organization.
 *
 * Rejects a payload that changes nothing rather than issuing a no-op update,
 * so the caller gets an explicit signal instead of a silent success that looks
 * like the change landed.
 */
export async function updateTaskInOrg(
  input: unknown,
  actor: UpdateTaskActor,
): Promise<UpdateTaskResult> {
  // 1. Zod barrier, shared with the UI path.
  const parsed = updateTaskSchema.safeParse(input);

  if (!parsed.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      error: "Invalid task update.",
    };
  }

  const { taskId, ...changes } = parsed.data;

  // 2. Ownership boundary. Resolved BEFORE the write, and a task owned by
  //    another org is indistinguishable from one that does not exist.
  const existing = await prisma.task.findFirst({
    where: { id: taskId, project: { orgId: actor.orgId } },
    select: { id: true },
  });

  if (!existing) {
    return {
      success: false,
      code: "TASK_NOT_FOUND",
      error: "Task not found in this organization.",
    };
  }

  // 3. Assignee membership boundary.
  if (changes.assigneeId) {
    const membership = await prisma.membership.findFirst({
      where: {
        userId: changes.assigneeId,
        orgId: actor.orgId,
      },
      select: { userId: true },
    });

    if (!membership) {
      return {
        success: false,
        code: "ASSIGNEE_NOT_FOUND",
        error: "Assignee is not a member of this organization.",
      };
    }
  }

  // 4. Build the update. Only fields the caller actually supplied are set, so
  //    an omitted field is left untouched rather than nulled.
  const data: Prisma.TaskUpdateInput = {};

  if (changes.title !== undefined) {
    data.title = changes.title;
  }

  if (changes.status !== undefined) {
    data.status = changes.status;
  }

  if (changes.priority !== undefined) {
    data.priority = changes.priority;
  }

  if (changes.assigneeId !== undefined) {
    // A present null is meaningful: it unassigns. An absent key is not set at
    // all, which is why the `in` operator is used rather than a truthiness
    // check.
    data.assignee = changes.assigneeId
      ? { connect: { id: changes.assigneeId } }
      : { disconnect: true };
  }

  if (Object.keys(data).length === 0) {
    return {
      success: false,
      code: "NO_CHANGES",
      error: "No supported fields were provided to update.",
    };
  }

  // 5. The single canonical write.
  try {
    const task = await prisma.task.update({
      where: { id: taskId },
      data,
    });

    return { success: true, task };
  } catch (error) {
    return {
      success: false,
      code: "UPDATE_FAILED",
      error:
        error instanceof Error ? error.message : "Task could not be updated.",
    };
  }
}
