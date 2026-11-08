import "server-only";
import crypto from "crypto";
import { Prisma, VectorEntityType, VectorOutboxStatus } from "@prisma/client";
export { VectorEntityType, VectorOutboxStatus };
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

export interface RenewOutboxClaimParams {
  db: Prisma.TransactionClient;
  outboxEventId: string;
  dispatchClaimToken: string;
  extensionSeconds?: number;
}

/**
 * Extends the dispatch claim lease on the database clock.
 * Fails closed if the claim was stolen or lease expired.
 */
export async function renewVectorOutboxClaimLease({
  db,
  outboxEventId,
  dispatchClaimToken,
  extensionSeconds = 60,
}: RenewOutboxClaimParams): Promise<boolean> {
  const updated = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "VectorOutboxEvent"
    SET "dispatchLeaseExpiresAt" = clock_timestamp() + (${extensionSeconds} || ' seconds')::interval,
        "updatedAt" = clock_timestamp()
    WHERE id = ${outboxEventId}
      AND "status" = 'CLAIMED'::"VectorOutboxStatus"
      AND "dispatchClaimToken" = ${dispatchClaimToken}
      AND "dispatchLeaseExpiresAt" > clock_timestamp()
    RETURNING id;
  `;
  return updated.length > 0;
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
 * Compare-And-Set (CAS) transition to DISPATCHED guarded by claimToken and DB-clock lease.
 * Prevents publish-before-mark race from regressing a row already COMPLETED by a fast worker.
 * Successful publication does not increment failure attempts.
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
        "updatedAt" = clock_timestamp()
    WHERE id = ${outboxEventId}
      AND "status" = 'CLAIMED'::"VectorOutboxStatus"
      AND "dispatchClaimToken" = ${dispatchClaimToken}
      AND "dispatchLeaseExpiresAt" > clock_timestamp()
    RETURNING id, "status";
  `;

  if (updated.length > 0) {
    return { ok: true, status: "DISPATCHED" };
  }

  // CAS affected 0 rows. Check current row status
  const current = await db.$queryRaw<Array<{ status: VectorOutboxStatus }>>`
    SELECT "status" FROM "VectorOutboxEvent" WHERE id = ${outboxEventId} LIMIT 1;
  `;

  if (Array.isArray(current) && current.length > 0 && current[0]?.status === "COMPLETED") {
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
 * Clears claim token and lease expiration.
 */
export async function completeVectorOutboxEvent({
  db,
  outboxEventId,
}: CompleteOutboxParams): Promise<boolean> {
  const updated = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "VectorOutboxEvent"
    SET "status" = 'COMPLETED'::"VectorOutboxStatus",
        "dispatchClaimToken" = NULL,
        "dispatchLeaseExpiresAt" = NULL,
        "updatedAt" = clock_timestamp()
    WHERE id = ${outboxEventId}
      AND "status" != 'COMPLETED'::"VectorOutboxStatus"
    RETURNING id;
  `;

  return updated.length > 0;
}

export interface DispatchVectorOutboxResult {
  claimed: number;
  dispatched: number;
  failed: number;
}

export interface HandlePublishFailureParams {
  db: Prisma.TransactionClient;
  outboxEventId: string;
  dispatchClaimToken: string;
  error: unknown;
  maxAttempts?: number;
}

export type HandlePublishFailureResult =
  | { status: "RETRY_SCHEDULED"; attempts?: number; nextRetryAt?: Date }
  | { status: "FAILED_TERMINAL"; attempts?: number }
  | { status: "SUPERSEDED" }
  | { status: "ALREADY_COMPLETED" }
  | { status: "CLAIM_LOST"; reason: string };

/**
 * Persists dispatcher publish failure, records error, enforces exponential backoff (5s, 10s, 20s, 40s),
 * and handles supersession when a strictly newer PENDING row already exists (Area C & D).
 * Fully fenced by claimToken, status, and PostgreSQL clock_timestamp().
 */
export async function handleVectorOutboxPublishFailure({
  db,
  outboxEventId,
  dispatchClaimToken,
  error,
  maxAttempts = 5,
}: HandlePublishFailureParams): Promise<HandlePublishFailureResult> {
  const errMsg = error instanceof Error ? error.message : String(error);

  // 1. Fetch current row ensuring active claim ownership and valid DB-clock lease (Area C1)
  const rows = await db.$queryRaw<Array<{
    id: string;
    entityType: VectorEntityType;
    entityId: string;
    sourceRevision: number;
    dispatchAttempts: number;
  }>>`
    SELECT id, "entityType", "entityId", "sourceRevision", "dispatchAttempts"
    FROM "VectorOutboxEvent"
    WHERE id = ${outboxEventId}
      AND "status" = 'CLAIMED'::"VectorOutboxStatus"
      AND "dispatchClaimToken" = ${dispatchClaimToken}
      AND "dispatchLeaseExpiresAt" > clock_timestamp()
    LIMIT 1;
  `;

  if (rows.length === 0) {
    // 0 rows matched active claim predicate. Check if already completed by downstream worker (Area B3)
    const current = await db.$queryRaw<Array<{ status: VectorOutboxStatus }>>`
      SELECT "status" FROM "VectorOutboxEvent" WHERE id = ${outboxEventId} LIMIT 1;
    `;
    if (Array.isArray(current) && current.length > 0 && current[0]?.status === "COMPLETED") {
      return { status: "ALREADY_COMPLETED" };
    }
    return { status: "CLAIM_LOST", reason: "NOT_CLAIMED_OR_LEASE_EXPIRED" };
  }

  const row = rows[0];
  const sourceRev = typeof row.sourceRevision === "number" ? row.sourceRevision : 0;

  // 2. Supersession Check (Area D3): Check if a strictly newer revision exists for this entity
  const newerPending = await db.$queryRaw<Array<{ id: string; sourceRevision: number }>>`
    SELECT id, "sourceRevision"
    FROM "VectorOutboxEvent"
    WHERE "entityType" = ${row.entityType}::"VectorEntityType"
      AND "entityId" = ${row.entityId}
      AND "status" = 'PENDING'::"VectorOutboxStatus"
      AND id != ${outboxEventId}
      AND "sourceRevision" > ${sourceRev}
    ORDER BY "sourceRevision" DESC
    LIMIT 1;
  `;

  if (newerPending.length > 0) {
    const newerId = newerPending[0].id;
    const newerRev = newerPending[0].sourceRevision;
    const superseded = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE "VectorOutboxEvent"
      SET "status" = 'FAILED'::"VectorOutboxStatus",
          "dispatchClaimToken" = NULL,
          "dispatchLeaseExpiresAt" = NULL,
          "terminalError" = ${'Superseded by newer pending outbox event ' + newerId + (newerRev ? ' (rev ' + newerRev + ')' : '')},
          "updatedAt" = clock_timestamp()
      WHERE id = ${outboxEventId}
        AND "status" = 'CLAIMED'::"VectorOutboxStatus"
        AND "dispatchClaimToken" = ${dispatchClaimToken}
        AND "dispatchLeaseExpiresAt" > clock_timestamp()
      RETURNING id;
    `;
    if (superseded.length > 0) {
      return { status: "SUPERSEDED" };
    }
    const current = await db.$queryRaw<Array<{ status: VectorOutboxStatus }>>`
      SELECT "status" FROM "VectorOutboxEvent" WHERE id = ${outboxEventId} LIMIT 1;
    `;
    if (Array.isArray(current) && current.length > 0 && current[0]?.status === "COMPLETED") {
      return { status: "ALREADY_COMPLETED" };
    }
    return { status: "CLAIM_LOST", reason: "CLAIM_LOST_DURING_SUPERSEDING" };
  }

  const newAttempts = row.dispatchAttempts + 1;

  // 3. Terminal Failure (Area C3): When maxAttempts reached or exceeded
  if (newAttempts >= maxAttempts) {
    const failedRows = await db.$queryRaw<Array<{ id: string; dispatchAttempts: number }>>`
      UPDATE "VectorOutboxEvent"
      SET "status" = 'FAILED'::"VectorOutboxStatus",
          "dispatchClaimToken" = NULL,
          "dispatchLeaseExpiresAt" = NULL,
          "dispatchAttempts" = ${newAttempts},
          "terminalError" = ${errMsg},
          "updatedAt" = clock_timestamp()
      WHERE id = ${outboxEventId}
        AND "status" = 'CLAIMED'::"VectorOutboxStatus"
        AND "dispatchClaimToken" = ${dispatchClaimToken}
        AND "dispatchLeaseExpiresAt" > clock_timestamp()
      RETURNING id, "dispatchAttempts";
    `;
    if (failedRows.length > 0) {
      return { status: "FAILED_TERMINAL", attempts: failedRows[0].dispatchAttempts };
    }
    const current = await db.$queryRaw<Array<{ status: VectorOutboxStatus }>>`
      SELECT "status" FROM "VectorOutboxEvent" WHERE id = ${outboxEventId} LIMIT 1;
    `;
    if (Array.isArray(current) && current.length > 0 && current[0]?.status === "COMPLETED") {
      return { status: "ALREADY_COMPLETED" };
    }
    return { status: "CLAIM_LOST", reason: "CLAIM_LOST_DURING_TERMINAL_FAIL" };
  }

  // 4. Retry Scheduling with Exact Canonical Backoff: 5s, 10s, 20s, 40s (Area C2)
  // Progression: 5 * 2^(dispatchAttempts) seconds clamped to 300s
  const backoffSeconds = Math.min(300, 5 * Math.pow(2, row.dispatchAttempts));

  const retryRows = await db.$queryRaw<Array<{ id: string; dispatchAttempts: number; nextRetryAt: Date }>>`
    UPDATE "VectorOutboxEvent"
    SET "status" = 'PENDING'::"VectorOutboxStatus",
        "dispatchClaimToken" = NULL,
        "dispatchLeaseExpiresAt" = NULL,
        "dispatchAttempts" = ${newAttempts},
        "nextRetryAt" = clock_timestamp() + (${backoffSeconds} || ' seconds')::interval,
        "terminalError" = ${errMsg},
        "updatedAt" = clock_timestamp()
    WHERE id = ${outboxEventId}
      AND "status" = 'CLAIMED'::"VectorOutboxStatus"
      AND "dispatchClaimToken" = ${dispatchClaimToken}
      AND "dispatchLeaseExpiresAt" > clock_timestamp()
    RETURNING id, "dispatchAttempts", "nextRetryAt";
  `;

  if (retryRows.length > 0) {
    return {
      status: "RETRY_SCHEDULED",
      attempts: retryRows[0].dispatchAttempts,
      nextRetryAt: retryRows[0].nextRetryAt,
    };
  }

  const current = await db.$queryRaw<Array<{ status: VectorOutboxStatus }>>`
    SELECT "status" FROM "VectorOutboxEvent" WHERE id = ${outboxEventId} LIMIT 1;
  `;
  if (Array.isArray(current) && current.length > 0 && current[0]?.status === "COMPLETED") {
    return { status: "ALREADY_COMPLETED" };
  }
  return { status: "CLAIM_LOST", reason: "CLAIM_LOST_DURING_RETRY" };
}

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
        await handleVectorOutboxPublishFailure({
          db,
          outboxEventId: row.id,
          dispatchClaimToken: claimToken,
          error: new Error(`Mark dispatched failed: ${res.reason}`),
        });
      }
    } catch (publishErr) {
      failed++;
      await handleVectorOutboxPublishFailure({
        db,
        outboxEventId: row.id,
        dispatchClaimToken: claimToken,
        error: publishErr,
      });
    }
  }

  return { claimed: rows.length, dispatched, failed };
}

