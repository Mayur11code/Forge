import "server-only";
import crypto from "crypto";
import { Prisma, VectorEntityType, VectorOutboxStatus } from "@prisma/client";
import { PIPELINE_CONTRACT_VERSION } from "./provenance";

export interface RecordVectorSyncIntentParams {
  tx: Prisma.TransactionClient;
  orgId: string;
  entityType: VectorEntityType;
  entityId: string;
  contentHash: string;
  pipelineVersion?: string;
  parentTaskVersion?: string | null;
}

export interface RecordVectorSyncIntentResult {
  outboxEventId: string;
  sourceRevision: number;
  headId: string;
}

/**
 * Atomically records vector synchronization intent inside an interactive transaction.
 *
 * Invariants Enforced:
 * 1. Monotonic Revision: Atomically upserts `VectorEntityHead` and increments `latestRevision += 1`.
 * 2. Non-Blocking Coalescing: If a row exists with status 'PENDING', updates it in-place with latest revision/hash.
 *    If an older row is 'CLAIMED' or 'DISPATCHED', inserts a new 'PENDING' row cleanly without blocking.
 */
export async function recordVectorSyncIntent({
  tx,
  orgId,
  entityType,
  entityId,
  contentHash,
  pipelineVersion = PIPELINE_CONTRACT_VERSION,
  parentTaskVersion = null,
}: RecordVectorSyncIntentParams): Promise<RecordVectorSyncIntentResult> {
  const newHeadId = crypto.randomUUID();

  // 1. Atomically upsert VectorEntityHead to increment latestRevision strictly monotonically
  const headRows = await tx.$queryRaw<Array<{ id: string; latestRevision: number }>>`
    INSERT INTO "VectorEntityHead" ("id", "orgId", "entityType", "entityId", "latestRevision", "createdAt", "updatedAt")
    VALUES (${newHeadId}, ${orgId}, ${entityType}::"VectorEntityType", ${entityId}, 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT ("orgId", "entityType", "entityId")
    DO UPDATE SET "latestRevision" = "VectorEntityHead"."latestRevision" + 1, "updatedAt" = clock_timestamp()
    RETURNING "id", "latestRevision";
  `;

  if (!headRows || headRows.length === 0) {
    throw new Error(`Failed to upsert VectorEntityHead for ${entityType}:${entityId}`);
  }

  const { id: headId, latestRevision: sourceRevision } = headRows[0];
  const newOutboxId = crypto.randomUUID();

  // 2. Insert or coalesce VectorOutboxEvent
  // Partial unique index ON ("entityType", "entityId") WHERE "status" = 'PENDING'
  // DO UPDATE sets latest revision and hash when a pending row exists.
  const outboxRows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "VectorOutboxEvent" (
      "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash",
      "pipelineVersion", "parentTaskVersion", "status", "createdAt", "updatedAt"
    ) VALUES (
      ${newOutboxId}, ${orgId}, ${entityType}::"VectorEntityType", ${entityId},
      ${sourceRevision}, ${contentHash}, ${pipelineVersion}, ${parentTaskVersion},
      'PENDING'::"VectorOutboxStatus", clock_timestamp(), clock_timestamp()
    )
    ON CONFLICT ("entityType", "entityId") WHERE "status" = 'PENDING'
    DO UPDATE SET
      "sourceRevision" = EXCLUDED."sourceRevision",
      "contentHash" = EXCLUDED."contentHash",
      "pipelineVersion" = EXCLUDED."pipelineVersion",
      "parentTaskVersion" = EXCLUDED."parentTaskVersion",
      "updatedAt" = clock_timestamp()
    RETURNING "id";
  `;

  if (!outboxRows || outboxRows.length === 0) {
    throw new Error(`Failed to record VectorOutboxEvent for ${entityType}:${entityId}`);
  }

  return {
    outboxEventId: outboxRows[0].id,
    sourceRevision,
    headId,
  };
}

export interface ClaimOutboxBatchParams {
  db: Prisma.TransactionClient;
  batchSize?: number;
  leaseSeconds?: number;
  claimToken?: string;
}

export interface ClaimedOutboxRow {
  id: string;
  orgId: string;
  entityType: VectorEntityType;
  entityId: string;
  sourceRevision: number;
  contentHash: string;
  pipelineVersion: string;
  parentTaskVersion: string | null;
  dispatchAttempts: number;
}

/**
 * Claims a batch of outbox rows for asynchronous dispatch using SKIP LOCKED.
 * Reclaims expired CLAIMED rows where dispatcher crashed before publishing.
 */
export async function claimVectorOutboxBatch({
  db,
  batchSize = 25,
  leaseSeconds = 60,
  claimToken = crypto.randomUUID(),
}: ClaimOutboxBatchParams): Promise<{ rows: ClaimedOutboxRow[]; claimToken: string }> {
  const claimed = await db.$queryRaw<ClaimedOutboxRow[]>`
    WITH candidates AS (
      SELECT id
      FROM "VectorOutboxEvent"
      WHERE ("status" = 'PENDING'::"VectorOutboxStatus" AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= clock_timestamp()))
         OR ("status" = 'CLAIMED'::"VectorOutboxStatus" AND "dispatchLeaseExpiresAt" < clock_timestamp())
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "VectorOutboxEvent" o
    SET "status" = 'CLAIMED'::"VectorOutboxStatus",
        "dispatchClaimToken" = ${claimToken},
        "dispatchLeaseExpiresAt" = clock_timestamp() + (${leaseSeconds} || ' seconds')::interval,
        "updatedAt" = clock_timestamp()
    FROM candidates c
    WHERE o.id = c.id
    RETURNING o.id, o."orgId", o."entityType", o."entityId", o."sourceRevision", o."contentHash", o."pipelineVersion", o."parentTaskVersion", o."dispatchAttempts";
  `;

  return { rows: claimed, claimToken };
}

export interface MarkDispatchedParams {
  db: Prisma.TransactionClient;
  outboxEventId: string;
  dispatchClaimToken: string;
  leaseSeconds?: number;
}

export type MarkDispatchedResult =
  | { ok: true; status: "DISPATCHED" }
  | { ok: true; status: "COMPLETED"; reason: "ALREADY_COMPLETED_BY_FAST_WORKER" }
  | { ok: false; reason: "CLAIM_LOST_OR_EXPIRED" };

/**
 * Compare-And-Set (CAS) transition to DISPATCHED guarded by claimToken.
 * Prevents publish-before-mark race from regressing a row already COMPLETED by a fast worker.
 */
export async function markVectorOutboxDispatched({
  db,
  outboxEventId,
  dispatchClaimToken,
  leaseSeconds = 600,
}: MarkDispatchedParams): Promise<MarkDispatchedResult> {
  const updated = await db.$queryRaw<Array<{ id: string; status: VectorOutboxStatus }>>`
    UPDATE "VectorOutboxEvent"
    SET "status" = 'DISPATCHED'::"VectorOutboxStatus",
        "dispatchLeaseExpiresAt" = clock_timestamp() + (${leaseSeconds} || ' seconds')::interval,
        "lastDispatchedAt" = clock_timestamp(),
        "dispatchAttempts" = "dispatchAttempts" + 1,
        "updatedAt" = clock_timestamp()
    WHERE id = ${outboxEventId}
      AND "status" = 'CLAIMED'::"VectorOutboxStatus"
      AND "dispatchClaimToken" = ${dispatchClaimToken}
    RETURNING id, "status";
  `;

  if (updated.length > 0) {
    return { ok: true, status: "DISPATCHED" };
  }

  // CAS affected 0 rows. Check current row status
  const current = await db.$queryRaw<Array<{ status: VectorOutboxStatus }>>`
    SELECT "status" FROM "VectorOutboxEvent" WHERE id = ${outboxEventId} LIMIT 1;
  `;

  if (current.length > 0 && current[0].status === "COMPLETED") {
    return { ok: true, status: "COMPLETED", reason: "ALREADY_COMPLETED_BY_FAST_WORKER" };
  }

  return { ok: false, reason: "CLAIM_LOST_OR_EXPIRED" };
}

export interface CompleteOutboxParams {
  db: Prisma.TransactionClient;
  outboxEventId: string;
}

/**
 * Marks outbox row COMPLETED inside the activation transaction.
 */
export async function completeVectorOutboxEvent({
  db,
  outboxEventId,
}: CompleteOutboxParams): Promise<boolean> {
  const updated = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "VectorOutboxEvent"
    SET "status" = 'COMPLETED'::"VectorOutboxStatus",
        "updatedAt" = clock_timestamp()
    WHERE id = ${outboxEventId}
    RETURNING id;
  `;

  return updated.length > 0;
}

export interface DispatchVectorOutboxResult {
  claimed: number;
  dispatched: number;
  failed: number;
}

/**
 * Sweeper batch dispatcher for VectorOutboxEvent.
 * Claims pending or expired outbox events with SKIP LOCKED, publishes to QStash,
 * and marks them DISPATCHED with CAS on claimToken.
 */
export async function dispatchVectorOutboxBatch(
  limit: number = 50,
  sweeperName: string = "vector-outbox-sweeper"
): Promise<DispatchVectorOutboxResult> {
  const claimToken = `${sweeperName}_${crypto.randomUUID()}`;
  const { db } = await import("@/lib/prisma/db");
  const { publishEvent } = await import("@/lib/events/queue");

  const { rows } = await claimVectorOutboxBatch({
    db,
    batchSize: limit,
    leaseSeconds: 60,
    claimToken,
  });

  let dispatched = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await publishEvent(
        "EMBEDDING_REQUESTED",
        {
          outboxEventId: row.id,
          orgId: row.orgId,
          type: row.entityType,
          entityId: row.entityId,
          sourceRevision: row.sourceRevision,
          contentHash: row.contentHash,
          pipelineVersion: row.pipelineVersion,
          parentTaskVersion: row.parentTaskVersion,
        },
        undefined,
        {
          messageId: row.id,
          deduplicationId: `dedup_${row.id}_${row.sourceRevision}`,
        }
      );

      const res = await markVectorOutboxDispatched({
        db,
        outboxEventId: row.id,
        dispatchClaimToken: claimToken,
        leaseSeconds: 600,
      });

      if (res.ok) {
        dispatched++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return { claimed: rows.length, dispatched, failed };
}

