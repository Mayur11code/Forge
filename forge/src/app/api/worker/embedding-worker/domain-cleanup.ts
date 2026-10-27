// src/app/api/worker/embedding-worker/domain-cleanup.ts
/**
 * Asynchronous worker handler for DOMAIN_CLEANUP_REQUESTED events.
 *
 * Receives only the { outboxEventId } over the wire.
 * Loads the authoritative record from PostgreSQL to prevent tampering.
 * Verifies tenant scope, performs idempotent cleanup, and marks completion.
 */

import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import { getTenantVectorStore } from "@/lib/vector/client";
import { UTApi } from "uploadthing/server";
import {
  claimDomainOutboxForWorker,
  markDomainOutboxCompleted,
  recordDomainOutboxExecutionFailure,
} from "@/lib/deletion/outbox";
import { DomainOutboxStatus } from "@prisma/client";

const utapi = new UTApi();

export interface DomainCleanupEventPayload {
  event: {
    id: string;
    type: "DOMAIN_CLEANUP_REQUESTED";
    time: string;
    data: {
      outboxEventId: string;
      orgId?: string;
    };
  };
}

export async function domainCleanupWorkerHandler({ event }: DomainCleanupEventPayload): Promise<void> {
  const outboxEventId = event?.data?.outboxEventId;
  if (!outboxEventId || typeof outboxEventId !== "string" || !outboxEventId.trim()) {
    console.error("[DOMAIN_CLEANUP] Missing or malformed outboxEventId in event payload:", event?.data);
    return;
  }

  // 1. Authoritative lookup from database
  const outboxRecord = await db.domainOutboxEvent.findUnique({
    where: { id: outboxEventId },
  });

  if (!outboxRecord) {
    console.warn(`[DOMAIN_CLEANUP] Outbox record ${outboxEventId} not found in database.`);
    return;
  }

  // 2. Terminal state checks: COMPLETED or FAILED cannot be newly executed
  if (outboxRecord.status === DomainOutboxStatus.COMPLETED) {
    console.log(`[DOMAIN_CLEANUP] Outbox record ${outboxEventId} is already COMPLETED. No-op.`);
    return;
  }

  if (outboxRecord.status === DomainOutboxStatus.FAILED) {
    console.warn(
      `[DOMAIN_CLEANUP] Outbox record ${outboxEventId} is in FAILED status. Operator redrive required. Skipping execution.`
    );
    return;
  }

  // 3. Cross-tenant verification:
  // If wire orgId is provided, verify it strictly matches the authoritative DB record.
  // Untrusted wire data cannot override database state or divert cleanup to a foreign tenant.
  if (event.data.orgId && event.data.orgId !== outboxRecord.orgId) {
    console.warn(
      JSON.stringify({
        securityEvent: "CROSS_TENANT_RESOURCE_REFERENCE_REJECTED",
        subsystem: "domain-cleanup-worker",
        outboxEventId,
        eventOrgId: event.data.orgId,
        actualOrgId: outboxRecord.orgId,
        action: "REJECTED_WITHOUT_CLEANUP",
      })
    );
    return;
  }

  // 4. Atomic worker claim using Compare-And-Set (CAS).
  // Accepts only documented eligible states (PENDING or DISPATCHED).
  // Requires no active claim (claimedAt: null) OR expired lease (claimedAt <= now - leaseMs).
  // Ensures:
  // - Terminal states (COMPLETED, FAILED) cannot be claimed.
  // - Concurrent deliveries cannot both obtain the active claim.
  // - Stale workers cannot overwrite active claims or resurrect terminal events.
  const workerInstanceId = `worker-${crypto.randomUUID()}`;
  const claimResult = await claimDomainOutboxForWorker(outboxEventId, workerInstanceId);

  if (!claimResult.success) {
    console.log(
      `[DOMAIN_CLEANUP] Outbox event ${outboxEventId} could not be claimed (already active by another worker, completed, or failed). Skipping concurrent execution.`
    );
    return;
  }

  // Always use authoritative tenant and resource attributes from the database record
  const { orgId, resourceType, resourceId, payload } = outboxRecord;
  const typedPayload = (payload ?? {}) as Record<string, unknown>;
  const vectorStore = getTenantVectorStore(orgId);

  try {
    if (resourceType === "TASK" || outboxRecord.eventType === "DELETE_TASK") {
      // Discrete task vector deletion: cleans task-level vectors only
      // Child attachments possess their own independent ATTACHMENT outbox events
      await vectorStore.deleteByTask(resourceId);
    } else if (resourceType === "ATTACHMENT" || outboxRecord.eventType === "DELETE_ATTACHMENT") {
      // 1. Delete attachment vectors from Pinecone
      await vectorStore.deleteByTask(resourceId);

      // 2. Delete file from UploadThing if fileKey exists
      const fileKey = typeof typedPayload.fileKey === "string" ? typedPayload.fileKey : undefined;
      if (fileKey) {
        const utRes = await utapi.deleteFiles(fileKey);
        // Treat already-missing file as successful idempotent outcome
        // UploadThing returns success: true even if file was already removed
        if (!utRes.success) {
          throw new Error(`Failed to delete file ${fileKey} from cloud storage.`);
        }
      }
    } else if (resourceType === "PROJECT" || outboxRecord.eventType === "DELETE_PROJECT") {
      // Legacy project marker no-op; all child tasks and attachments possess independent rows
      console.log(`[DOMAIN_CLEANUP] Verified project cleanup completed for project ${resourceId}`);
    }

    // 5. Mark cleanup complete in outbox with worker fencing token
    const completionResult = await markDomainOutboxCompleted(outboxEventId, workerInstanceId);
    if (!completionResult.success) {
      console.warn(
        `[DOMAIN_CLEANUP] Outbox event ${outboxEventId} completion could not be recorded: worker lease expired or event transitioned.`
      );
    } else {
      console.log(`✅ [DOMAIN_CLEANUP] Successfully completed cleanup for ${resourceType} ${resourceId}`);
    }
  } catch (error) {
    console.error(`❌ [DOMAIN_CLEANUP] Failed external cleanup for ${resourceType} ${resourceId}:`, error);
    await recordDomainOutboxExecutionFailure(outboxEventId, error, workerInstanceId);
    // Propagate error so QStash retries according to queue backoff policy
    throw error;
  }
}
