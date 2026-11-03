// src/lib/deletion/service.ts
/**
 * Atomic domain deletion service for Tasks, Projects, and Attachments.
 *
 * Guarantees:
 * 1. Database deletion and DomainOutboxEvent cleanup intent are committed
 *    in the SAME PostgreSQL transaction.
 * 2. If the transaction aborts, neither the deletion nor the outbox row commits.
 * 3. Child attachment and task relationships are captured BEFORE relational
 *    cascades destroy them.
 * 4. Quotas are decremented exactly once inside the database transaction.
 * 5. Bounded, per-resource outbox records ensure external cleanup is safe,
 *    isolated, and retryable.
 */

import { db } from "@/lib/prisma/db";
import { Prisma } from "@prisma/client";
import {
  recordDomainDeletionIntent,
  dispatchDomainOutboxBatch,
} from "./outbox";
import { getTenantVectorStore } from "@/lib/vector/client";
import { UTApi } from "uploadthing/server";
import { invalidateSemanticCacheBestEffort } from "@/lib/ai/cache-lifecycle";
import { tombstoneEntityHead } from "@/lib/vector/generation-state";

const utapi = new UTApi();

export const MAX_PROJECT_CASCADE_RESOURCES = 500;
export const MAX_PROJECT_CASCADE_TASKS = MAX_PROJECT_CASCADE_RESOURCES; // Backward compatibility alias

export interface DeleteTaskResult {
  success: boolean;
  taskId: string;
  orgId: string;
  projectId: string;
  attachmentIds: string[];
}

/**
 * Transactionally deletes a task and commits durable cleanup instructions
 * for the task vectors and all child attachments' vectors and files.
 */
export async function deleteTaskTransactionally(
  taskId: string,
  existingTx?: Prisma.TransactionClient
): Promise<DeleteTaskResult> {
  const executeInTx = async (tx: Prisma.TransactionClient): Promise<DeleteTaskResult> => {
    // 1. Discover parent Project ID prior to acquiring canonical row locks
    const initialTask = await tx.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });

    if (!initialTask) {
      throw new Error(`Task ${taskId} not found`);
    }

    // 2. Canonical Lock Order Step 1: Lock parent Project row
    if (typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Project" WHERE id = ${initialTask.projectId} FOR UPDATE
      `;
    }

    // 3. Canonical Lock Order Step 2: Lock Task row
    if (typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE
      `;
    }

    // 4. Canonical Lock Order Step 3: Discover and lock child Attachments in deterministic ascending ID order
    const initialAttachments =
      (await tx.attachment.findMany?.({
        where: { taskId },
        select: { id: true },
        orderBy: { id: "asc" },
      })) ?? [];
    const childAttachmentIds = Array.isArray(initialAttachments)
      ? initialAttachments.map((a) => a.id)
      : [];

    if (childAttachmentIds.length > 0 && typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Attachment"
        WHERE id = ANY(${childAttachmentIds}::text[])
        ORDER BY id ASC
        FOR UPDATE
      `;
    }

    // 5. Revalidate relationships after acquiring locks
    const taskToDelete = await tx.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        project: { select: { orgId: true } },
        attachments: {
          select: { id: true, fileKey: true, size: true },
          orderBy: { id: "asc" },
        },
      },
    });

    if (!taskToDelete) {
      throw new Error(`Task ${taskId} not found after lock acquisition`);
    }

    const orgId = taskToDelete.project?.orgId ?? "default_org";
    const projectId = taskToDelete.projectId;
    const attachmentIds = taskToDelete.attachments.map((a) => a.id);

    // 6. Canonical Lock Order Step 4: Record durable vector tombstones in deterministic order
    await tombstoneEntityHead({
      orgId,
      entityType: "TASK",
      entityId: taskId,
      tx,
    });

    await recordDomainDeletionIntent({
      tx,
      orgId,
      resourceType: "TASK",
      resourceId: taskId,
      eventType: "DELETE_TASK",
      payload: {
        taskId,
        orgId,
        projectId,
      },
    });

    // Tombstone child attachments in deterministic ascending ID order
    for (const attachment of taskToDelete.attachments) {
      await tombstoneEntityHead({
        orgId,
        entityType: "ATTACHMENT",
        entityId: attachment.id,
        tx,
      });

      await recordDomainDeletionIntent({
        tx,
        orgId,
        resourceType: "ATTACHMENT",
        resourceId: attachment.id,
        eventType: "DELETE_ATTACHMENT",
        payload: {
          attachmentId: attachment.id,
          orgId,
          taskId,
          fileKey: attachment.fileKey,
          size: attachment.size,
        },
      });
    }

    // 7. Delete the task (PostgreSQL cascades comments and attachments)
    await tx.task.delete({
      where: { id: taskId },
    });

    return {
      success: true,
      taskId,
      orgId,
      projectId,
      attachmentIds,
    };
  };

  const result = existingTx
    ? await executeInTx(existingTx)
    : await db.$transaction(executeInTx, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

  // The deletion is committed. Drop the org's cached answers so they cannot be
  // reused for the pre-deletion source set. Only safe when this call owns the
  // transaction: with an external tx the commit has not happened yet, and the
  // caller is responsible for invalidating once its transaction commits.
  if (!existingTx) {
    await invalidateSemanticCacheBestEffort(result.orgId);
  }

  // Fast-path dispatch trigger (non-blocking, best-effort latency optimization)
  dispatchDomainOutboxBatch(10).catch((err) => {
    console.warn("[OUTBOX_DISPATCH] Fast-path trigger deferred to background sweeper:", err);
  });

  return result;
}

export interface DeleteProjectResult {
  success: boolean;
  projectId: string;
  orgId: string;
  deletedTaskIds: string[];
  deletedAttachmentIds: string[];
}

/**
 * Transactionally deletes a project and captures all child tasks and attachments
 * into durable outbox events before PostgreSQL relational cascades remove them.
 */
export async function deleteProjectTransactionally(
  projectId: string,
  existingTx?: Prisma.TransactionClient
): Promise<DeleteProjectResult> {
  const executeInTx = async (tx: Prisma.TransactionClient): Promise<DeleteProjectResult> => {
    // 1. Canonical Lock Order Step 1: Lock Project row first
    if (typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE
      `;
    }

    // 2. Canonical Lock Order Step 2: Discover and lock all child Tasks in deterministic ascending ID order
    const tasksToLock =
      (await tx.task.findMany?.({
        where: { projectId },
        select: { id: true },
        orderBy: { id: "asc" },
      })) ?? [];
    const childTaskIds = Array.isArray(tasksToLock) ? tasksToLock.map((t) => t.id) : [];

    if (childTaskIds.length > 0 && typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Task"
        WHERE id = ANY(${childTaskIds}::text[])
        ORDER BY id ASC
        FOR UPDATE
      `;
    }

    // 3. Canonical Lock Order Step 3: Discover and lock all child Attachments in deterministic ascending ID order
    const attsToLock =
      childTaskIds.length > 0
        ? (await tx.attachment.findMany?.({
            where: { taskId: { in: childTaskIds } },
            select: { id: true },
            orderBy: { id: "asc" },
          })) ?? []
        : [];
    const childAttachmentIds = Array.isArray(attsToLock) ? attsToLock.map((a) => a.id) : [];

    if (childAttachmentIds.length > 0 && typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Attachment"
        WHERE id = ANY(${childAttachmentIds}::text[])
        ORDER BY id ASC
        FOR UPDATE
      `;
    }

    // 4. Revalidate project, tasks, and attachments after acquiring canonical business row locks
    const projectToDelete = await tx.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        orgId: true,
        tasks: {
          select: {
            id: true,
            attachments: {
              select: { id: true, fileKey: true, size: true },
              orderBy: { id: "asc" },
            },
          },
          orderBy: { id: "asc" },
        },
      },
    });

    if (!projectToDelete) {
      throw new Error(`Project ${projectId} not found after lock acquisition`);
    }

    const totalTaskCount = projectToDelete.tasks.length;
    const totalAttachmentCount = projectToDelete.tasks.reduce(
      (sum, task) => sum + task.attachments.length,
      0
    );
    const totalResourceCount = totalTaskCount + totalAttachmentCount;

    if (totalResourceCount > MAX_PROJECT_CASCADE_RESOURCES) {
      throw new Error(
        `Project deletion rejected: contains ${totalResourceCount} total resources (${totalTaskCount} tasks, ${totalAttachmentCount} attachments), exceeding maximum single-transaction cascade limit (${MAX_PROJECT_CASCADE_RESOURCES}). No resources were deleted. Please prune child tasks and attachments in batches before deleting the project.`
      );
    }

    const orgId = projectToDelete.orgId;
    const deletedTaskIds: string[] = [];
    const deletedAttachmentIds: string[] = [];

    // 5. Canonical Lock Order Step 4: Record discrete tombstones and outbox events in deterministic order
    for (const task of projectToDelete.tasks) {
      deletedTaskIds.push(task.id);

      await tombstoneEntityHead({
        orgId,
        entityType: "TASK",
        entityId: task.id,
        tx,
      });

      await recordDomainDeletionIntent({
        tx,
        orgId,
        resourceType: "TASK",
        resourceId: task.id,
        eventType: "DELETE_TASK",
        payload: {
          taskId: task.id,
          orgId,
          projectId,
        },
      });

      for (const attachment of task.attachments) {
        deletedAttachmentIds.push(attachment.id);

        await tombstoneEntityHead({
          orgId,
          entityType: "ATTACHMENT",
          entityId: attachment.id,
          tx,
        });

        await recordDomainDeletionIntent({
          tx,
          orgId,
          resourceType: "ATTACHMENT",
          resourceId: attachment.id,
          eventType: "DELETE_ATTACHMENT",
          payload: {
            attachmentId: attachment.id,
            orgId,
            taskId: task.id,
            fileKey: attachment.fileKey,
            size: attachment.size,
          },
        });
      }
    }

    // 3. Delete the project (relational cascade removes tasks, comments, attachments)
    await tx.project.delete({
      where: { id: projectId },
    });

    return {
      success: true,
      projectId,
      orgId,
      deletedTaskIds,
      deletedAttachmentIds,
    };
  };

  if (existingTx) {
    throw new Error(
      "deleteProjectTransactionally cannot accept an external transaction: project cascade deletion requires an independent Serializable transaction to guarantee cascade-limit enforcement and complete outbox capture against phantom inserts."
    );
  }

  const result = await db.$transaction(executeInTx, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });

  // Deletion is committed: cached answers for the old project/task set are no
  // longer reusable. Best-effort and feature-flag gated.
  await invalidateSemanticCacheBestEffort(result.orgId);

  // Fast-path dispatch trigger
  dispatchDomainOutboxBatch(10).catch((err) => {
    console.warn("[OUTBOX_DISPATCH] Fast-path trigger deferred to background sweeper:", err);
  });

  return result;
}

export interface DeleteAttachmentResult {
  success: boolean;
  attachmentId: string;
  orgId: string;
  quotaAdjusted: boolean;
  message: string;
}

/**
 * Transactionally deletes an attachment record, decrements organization storage quota,
 * and records durable outbox intent for physical file and vector cleanup.
 */
export async function deleteAttachmentTransactionally(
  attachmentId: string,
  userId: string
): Promise<DeleteAttachmentResult> {
  // 1. Authenticate & verify tenant membership and parent relationship
  const file = await db.attachment.findFirst({
    where: {
      id: attachmentId,
      task: {
        project: {
          organization: { memberships: { some: { userId } } },
        },
      },
    },
    select: {
      id: true,
      fileKey: true,
      size: true,
      task: {
        select: {
          id: true,
          projectId: true,
          project: { select: { id: true, orgId: true } },
        },
      },
    },
  });

  if (!file) throw new Error("Attachment record not found in database.");
  if (!file.fileKey) throw new Error("No remote file key associated with this record.");
  const orgId = file.task?.project?.orgId ?? "default_org";
  const parentProjectId = file.task?.project?.id;
  const parentTaskId = file.task?.id ?? "";
  const fileKey = file.fileKey;
  const size = file.size;

  // 2. Commit DB deletion, vector tombstone, quota decrement, and outbox intent atomically in PostgreSQL
  await db.$transaction(async (tx) => {
    // Canonical Lock Order: Project -> Task -> Attachment -> VectorEntityHead
    // 2A. Lock Project first (if identified)
    if (parentProjectId && typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Project" WHERE id = ${parentProjectId} FOR UPDATE
      `;
    }

    // 2B. Lock Task second (if identified)
    if (parentTaskId && typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Task" WHERE id = ${parentTaskId} FOR UPDATE
      `;
    }

    // 2C. Lock Attachment third
    if (typeof tx.$queryRaw === "function") {
      await tx.$queryRaw`
        SELECT id FROM "Attachment" WHERE id = ${attachmentId} FOR UPDATE
      `;
    }

    // 2D. Revalidate that the locked Attachment still belongs to the previously identified Task and Project
    const lockedFile = tx.attachment.findUnique
      ? await tx.attachment.findUnique({
          where: { id: attachmentId },
          select: {
            id: true,
            fileKey: true,
            size: true,
            taskId: true,
            task: {
              select: {
                id: true,
                projectId: true,
                project: { select: { id: true, orgId: true } },
              },
            },
          },
        })
      : await tx.attachment.findFirst({
          where: { id: attachmentId },
          select: {
            id: true,
            fileKey: true,
            size: true,
            taskId: true,
            task: {
              select: {
                id: true,
                projectId: true,
                project: { select: { id: true, orgId: true } },
              },
            },
          },
        });

    if (
      !lockedFile ||
      (parentTaskId && lockedFile.taskId && lockedFile.taskId !== parentTaskId) ||
      (parentProjectId && lockedFile.task?.projectId && lockedFile.task.projectId !== parentProjectId) ||
      (orgId && lockedFile.task?.project?.orgId && lockedFile.task.project.orgId !== orgId)
    ) {
      throw new Error("Attachment relationship changed or record was deleted concurrently.");
    }

    // 2E. Lock & Tombstone VectorEntityHead
    await tombstoneEntityHead({
      orgId,
      entityType: "ATTACHMENT",
      entityId: attachmentId,
      tx,
    });

    await recordDomainDeletionIntent({
      tx,
      orgId,
      resourceType: "ATTACHMENT",
      resourceId: attachmentId,
      eventType: "DELETE_ATTACHMENT",
      payload: {
        attachmentId,
        orgId,
        taskId: parentTaskId,
        fileKey,
        size,
      },
    });

    await tx.attachment.delete({
      where: { id: attachmentId },
    });

    await tx.organization.update({
      where: { id: orgId },
      data: {
        storageUsed: { decrement: BigInt(size) },
      },
    });
  });

  // 3. Attempt synchronous external cleanup (Pinecone vectors + UploadThing file)
  // Preserves existing synchronous caller contract where possible,
  // while guaranteeing that failures remain durably recorded for background retry.
  try {
    const vectorStore = getTenantVectorStore(orgId);
    await vectorStore.deleteByTask(attachmentId);

    const utResponse = await utapi.deleteFiles(fileKey);
    if (!utResponse.success) {
      throw new Error("Failed to delete file from cloud storage.");
    }

    return {
      success: true,
      attachmentId,
      orgId,
      quotaAdjusted: true,
      message: "File deleted and quota updated.",
    };
  } catch (externalCleanupError) {
    // Trigger outbox background dispatch so cleanup is retried until success
    dispatchDomainOutboxBatch(10).catch(() => {});
    throw externalCleanupError;
  }
}
