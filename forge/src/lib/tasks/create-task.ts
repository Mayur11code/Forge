// src/lib/tasks/create-task.ts
//
// CANONICAL task creation business operation.
//
// Every caller (UI server action, workflow action, agent tool executor) must
// funnel through this function. There is exactly one `prisma.task.create`
// for task creation in the codebase, and it lives here.
//
// Security contract:
// - `orgId` / `userId` are TRUSTED and must be supplied by the caller from a
//   server-side source of truth (NextAuth session, persisted Workflow row, or
//   persisted AgentSession row). They are NEVER read from LLM input or from a
//   queue payload.
// - The `projectId` is UNTRUSTED. It is always verified to belong to the
//   trusted org before the write happens.
//
// Worker safety:
// - No `auth()`, no `notFound()`, no `revalidatePath()`, no `next/*` imports.
// - Uses the EXTENDED Prisma client so the `TASK_CREATED` CDC fires exactly
//   as it does for the UI path.

import { prisma } from "@/lib/prisma/extended";
import { createTaskSchema } from "@/core/domain";
import type { Task } from "@prisma/client";

/**
 * Trusted actor identity. Supplied by the caller, never by the model.
 *
 * `orgId` is REQUIRED and is the authorization boundary.
 * `userId` is optional because a WorkflowRun has no interactive user. `Task`
 * currently has no creator column, so it is accepted for future attribution
 * and must not be used to widen authorization.
 */
export type CreateTaskActor = {
  orgId: string;
  userId?: string;
};

export type CreateTaskFailureCode =
  | "INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "ASSIGNEE_NOT_FOUND"
  | "CREATE_FAILED";

/**
 * The full created Task row (scalars only, no relations). The UI server action
 * hands this straight back to `TaskBox`, so it must stay the complete shape.
 * The agent executor projects this down to a compact JSON summary.
 */
export type CreatedTask = Task;

export type CreateTaskResult =
  | { success: true; task: CreatedTask }
  | { success: false; error: string; code: CreateTaskFailureCode };

/**
 * Create a task inside a trusted organization.
 *
 * This is the single business operation for task creation. It:
 *  1. validates the untrusted payload with the shared `createTaskSchema`
 *  2. asserts the project belongs to the trusted org
 *  3. asserts the assignee (when present) is a member of the trusted org
 *  4. writes through the extended Prisma client so CDC events fire
 *
 * It never throws for expected failures; it returns a discriminated result so
 * every caller (including the agent executor) can decide how to surface it.
 */
export async function createTaskInOrg(
  input: unknown,
  actor: CreateTaskActor,
): Promise<CreateTaskResult> {
  // 1. Zod barrier. `createTaskSchema` is the shared contract used by the UI.
  const parsed = createTaskSchema.safeParse(input);

  if (!parsed.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      error: "Invalid task input.",
    };
  }

  const data = parsed.data;

  // 2. Project ownership boundary.
  //    `projectId` came from an untrusted source (form, workflow node config,
  //    or LLM output). The org is trusted, so we assert the project is inside
  //    it. A cross-org projectId resolves to null here and never reaches the
  //    write.
  const project = await prisma.project.findFirst({
    where: {
      id: data.projectId,
      orgId: actor.orgId,
    },
    select: { id: true, name: true },
  });

  if (!project) {
    return {
      success: false,
      code: "PROJECT_NOT_FOUND",
      error: "Project not found in this organization.",
    };
  }

  // 3. Assignee membership boundary.
  //    An untrusted `assigneeId` must not be able to attach a task to a user
  //    who does not belong to the organization.
  if (data.assigneeId) {
    const membership = await prisma.membership.findFirst({
      where: {
        userId: data.assigneeId,
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

  // 4. The single canonical write.
  //    `prisma` (extended) -> fires TASK_CREATED CDC on task.create.
  try {
    const task = await prisma.task.create({
      data: {
        title: data.title,
        projectId: project.id,
        description: data.description ?? null,
        priority: data.priority,
        assigneeId: data.assigneeId ?? null,
      },
    });

    return { success: true, task };
  } catch (error) {
    return {
      success: false,
      code: "CREATE_FAILED",
      error:
        error instanceof Error
          ? error.message
          : "Task could not be created.",
    };
  }
}
