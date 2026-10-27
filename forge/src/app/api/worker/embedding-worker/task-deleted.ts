import "server-only";
// src/app/api/worker/embedding-worker/task-deleted.ts
import { db } from "@/lib/prisma/db";
import { getTenantVectorStore } from "@/lib/vector/client";
import { WorkerEventEnvelope } from "@/lib/events/worker";
import { DomainOutboxStatus } from "@prisma/client";

/**
 * Mask an identifier for secure, non-disclosing audit logging.
 */
function redactId(id: string): string {
  if (!id) return "[empty]";
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/**
 * Asynchronous worker handler for TASK_DELETED events.
 *
 * Responsibilities:
 * 1. Validates that the event carries required routing parameters (orgId, taskId).
 * 2. Cross-tenant validation: If projectId is present and the project still exists
 *    in the database, verifies that the project's orgId matches event.orgId. If
 *    there is a mismatch, rejects without mutating any namespace.
 * 3. Deduplication with authoritative transactional outbox:
 *    If an authoritative DomainOutboxEvent exists for this task (PENDING, DISPATCHED,
 *    or COMPLETED), skips vector deletion to prevent redundant duplicate Pinecone calls.
 * 4. Fallback legacy vector deletion: If no authoritative outbox event exists,
 *    safely and idempotently wipes vectors indexed for the task and child attachments.
 * 5. Re-throws external vector store failures so QStash retries according to policy.
 */
export async function taskDeletedWorkerHandler({
  event,
}: {
  event: WorkerEventEnvelope<"TASK_DELETED">;
}): Promise<void> {
  const { orgId, taskId, projectId, attachmentIds } = event.data;

  if (!orgId || !taskId) {
    console.error("❌ [TASK_DELETED_WORKER] Missing required routing parameters", event.data);
    return;
  }

  // Cross-tenant verification:
  // If projectId is provided and project still exists, verify it belongs to event.orgId.
  if (projectId) {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, orgId: true },
    });

    if (project && project.orgId !== orgId) {
      console.warn(
        JSON.stringify({
          securityEvent: "CROSS_TENANT_RESOURCE_REFERENCE_REJECTED",
          subsystem: "embedding-worker",
          resourceType: "TASK_DELETED",
          entityId: redactId(taskId),
          eventOrgId: redactId(orgId),
          actualOrgId: redactId(project.orgId),
          action: "REJECTED_WITHOUT_VECTOR_MUTATION",
        }),
      );
      return;
    }
  }

  // Deduplication check: Has this task been claimed or processed by the transactional outbox?
  // MUST respect EVERY outbox state (PENDING, DISPATCHED, COMPLETED, FAILED).
  // Under no circumstances may a FAILED outbox record fall through to legacy partial cleanup.
  const outboxRecord =
    typeof db.domainOutboxEvent?.findFirst === "function"
      ? await db.domainOutboxEvent.findFirst({
          where: {
            resourceType: "TASK",
            resourceId: taskId,
          },
          select: { id: true, status: true },
        })
      : null;

  if (outboxRecord) {
    if (outboxRecord.status === DomainOutboxStatus.FAILED) {
      console.warn(
        `[TASK_DELETED_WORKER] Authoritative domain outbox event (${outboxRecord.id}) is in FAILED status for task ${taskId}. Legacy worker will not bypass authoritative failure state. Operator redrive required.`
      );
    } else {
      console.log(
        `[TASK_DELETED_WORKER] Authoritative domain outbox event found (${outboxRecord.id}, status: ${outboxRecord.status}) for task ${taskId}. Skipping legacy vector cleanup to avoid redundant deletions.`
      );
    }
    return;
  }

  const vectorStore = getTenantVectorStore(orgId);

  // 1. Wipe vectors for the deleted task itself
  console.log(`[DELETION_CLEANUP] Wiping vectors for deleted task ${taskId} in tenant ${orgId}`);
  await vectorStore.deleteByTask(taskId);

  // 2. Wipe vectors for child attachments associated with this task
  if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
    console.log(
      `[DELETION_CLEANUP] Wiping vectors for ${attachmentIds.length} child attachment(s) of task ${taskId} in tenant ${orgId}`,
    );
    for (const attachmentId of attachmentIds) {
      if (attachmentId) {
        await vectorStore.deleteByTask(attachmentId);
      }
    }
  }

  console.log(`✅ [DELETION_CLEANUP] Successfully cleaned up vectors for task ${taskId} in tenant ${orgId}`);
}
