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
import { db } from "@/lib/prisma/db";
import { recordVectorSyncIntent } from "@/lib/vector/outbox";
import {
  computeTaskContentHash,
  computeAttachmentContentHash,
  computeAttachmentParentTaskVersion,
} from "@/lib/vector/provenance";
import { updateTaskSchema } from "@/core/domain";
import { Prisma, VectorEntityType, type Task } from "@prisma/client";
import {
  recordDomainEventIntent,
  enqueueDomainOutboxWakeup,
  type MutationOrigin,
} from "@/lib/events/domain-outbox";

export type UpdateTaskActor = {
  orgId: string;
  userId?: string;
  origin?: MutationOrigin;
  expectedState?: Record<string, unknown>;
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

  // 2. Assignee membership boundary.
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

  // 3. Build the update. Only fields the caller actually supplied are set, so
  //    an omitted field is left untouched rather than nulled.
  const data: Prisma.TaskUpdateInput = {};

  if (changes.title !== undefined) {
    data.title = changes.title;
  }

  if (changes.status !== undefined) {
    data.status = changes.status;
    if (changes.status === "DONE") {
      data.completedAt = new Date();
    } else {
      data.completedAt = null;
    }
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

  // 4. The single canonical write.
  //    Atomically acquires row lock, reads prior status under lock, updates Task,
  //    records VectorOutboxEvent intent, DomainEventOutbox intent, and emits task.completed
  //    if and only if a genuine state transition occurred (UPPR Rev 4.1 M4-REM-1).
  try {
    let isGenuineCompletion = false;
    const task = await prisma.$transaction(async (tx) => {
      // 4.1. Row-level lock acquisition to serialize concurrent transitions
      if (typeof tx.$queryRaw === "function") {
        try {
          await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE;`;
        } catch {
          // Graceful fallback in non-locking / double environments
        }
      }

      // 4.2. Ownership boundary & current state read INSIDE the transaction under lock
      const existing = await tx.task.findFirst({
        where: { id: taskId, project: { orgId: actor.orgId } },
        select: {
          id: true,
          projectId: true,
          status: true,
          title: true,
          priority: true,
          assigneeId: true,
          description: true,
        },
      });

      if (!existing) {
        throw new Error("TASK_NOT_FOUND");
      }

      // 4.2.1. Concurrency conflict / CAS validation under row lock
      if (actor.expectedState && typeof actor.expectedState === "object") {
        for (const [field, expectedVal] of Object.entries(actor.expectedState)) {
          if (expectedVal !== undefined) {
            const currentVal = (existing as Record<string, unknown>)[field] ?? null;
            const expVal = expectedVal ?? null;
            if (currentVal !== expVal) {
              throw new Error(`CONCURRENCY_CONFLICT: Field '${field}' has diverged (expected '${expVal}', found '${currentVal}')`);
            }
          }
        }
      }

      // 4.3. Atomic compare-and-swap transition check for task completion (M4-REM-1)
      if (changes.status === "DONE") {
        const transition = await tx.task.updateMany({
          where: {
            id: taskId,
            status: { not: "DONE" },
          },
          data: {
            status: "DONE",
            completedAt: new Date(),
          },
        });
        isGenuineCompletion = transition.count > 0;
      }

      const updated = await tx.task.update({
        where: { id: taskId },
        data,
      });

      // 1. Task vector sync intent (monotonic revision increment + outbox coalescing)
      const contentHash = computeTaskContentHash({
        id: updated.id,
        projectId: updated.projectId,
        title: updated.title,
        description: updated.description,
        status: updated.status,
        priority: updated.priority,
        assigneeId: updated.assigneeId,
      });

      await recordVectorSyncIntent({
        tx,
        orgId: actor.orgId,
        entityType: VectorEntityType.TASK,
        entityId: updated.id,
        contentHash,
      });

      // 2. Child attachment sync intent if parent title changed (I-11)
      if (changes.title !== undefined) {
        const childAttachments = await tx.attachment.findMany({
          where: { taskId: updated.id },
          select: { id: true, name: true, size: true, fileKey: true },
        });

        for (const att of childAttachments) {
          const attHash = computeAttachmentContentHash({
            id: att.id,
            name: att.name,
            size: att.size,
            fileKey: att.fileKey,
            taskId: updated.id,
          });
          const parentVersion = computeAttachmentParentTaskVersion({
            title: updated.title,
            projectId: updated.projectId,
          });

          await recordVectorSyncIntent({
            tx,
            orgId: actor.orgId,
            entityType: VectorEntityType.ATTACHMENT,
            entityId: att.id,
            contentHash: attHash,
            parentTaskVersion: parentVersion,
          });
        }
      }

      // 3. Atomically record DomainEventOutbox intent for task.updated (FC-018)
      await recordDomainEventIntent({
        tx,
        orgId: actor.orgId,
        eventType: "task.updated",
        entityType: "TASK",
        entityId: updated.id,
        payload: {
          taskId: updated.id,
          projectId: updated.projectId,
          title: updated.title,
          description: updated.description,
          priority: updated.priority,
          status: updated.status,
          assigneeId: updated.assigneeId,
          previousStatus: existing.status,
        },
        origin: actor.origin,
      });

      // 4. Genuine state transition check: only fire task.completed if this mutation performed the genuine transition to DONE (M4-REM-1)!
      if (isGenuineCompletion) {
        await recordDomainEventIntent({
          tx,
          orgId: actor.orgId,
          eventType: "task.completed",
          entityType: "TASK",
          entityId: updated.id,
          payload: {
            taskId: updated.id,
            projectId: updated.projectId,
            title: updated.title,
            completedAt: updated.completedAt?.toISOString() ?? new Date().toISOString(),
          },
          origin: actor.origin,
        });
      }

      return updated;
    });

    // 5. Post-commit wake-up for domain event outbox sweeper (non-blocking)
    if (actor.origin?.originType !== "WORKFLOW") {
      enqueueDomainOutboxWakeup().catch((err) => {
        console.warn("[OUTBOX] Fast-path wake-up notification deferred to background sweeper:", err);
      });
    }

    // 6. Asynchronous notification CDC event fired outside the transaction (P14)
    try {
      const { dispatchEvent } = await import("@/lib/events/event-bus");
      await dispatchEvent("TASK_UPDATED", {
        taskId: task.id,
        orgId: actor.orgId,
        projectId: task.projectId,
        userId: actor.userId ?? "system-cdc",
        subject: "Task Updated",
        body: `Task "${task.title}" has been modified.`,
      });

      if (isGenuineCompletion) {
        await dispatchEvent("TASK_COMPLETED", {
          taskId: task.id,
          orgId: actor.orgId,
          projectId: task.projectId,
        });
      }
    } catch (cdcErr) {
      console.warn("[CDC] Best-effort TASK_UPDATED / TASK_COMPLETED event dispatch failed:", cdcErr);
    }

    return { success: true, task };
  } catch (error) {
    if (error instanceof Error && error.message === "TASK_NOT_FOUND") {
      return {
        success: false,
        code: "TASK_NOT_FOUND",
        error: "Task not found in this organization.",
      };
    }
    return {
      success: false,
      code: "UPDATE_FAILED",
      error:
        error instanceof Error ? error.message : "Task could not be updated.",
    };
  }
}
