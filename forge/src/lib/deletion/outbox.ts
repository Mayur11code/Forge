// src/lib/deletion/outbox.ts
/**
 * Transactional domain outbox for reliable, recoverable resource deletions.
 *
 * Pattern:
 * 1. Atomically record domain deletion intent in DomainOutboxEvent inside
 *    the caller's database transaction along with the deletion.
 * 2. Background dispatcher (or fast post-commit trigger) claims batches
 *    using lease-based concurrency control and publishes the event ID to QStash.
 * 3. The asynchronous worker loads the authoritative payload from the database,
 *    verifies tenant scope, and performs external cleanup (Pinecone, UploadThing).
 * 4. Cleanup status is marked COMPLETED only when external cleanup operations succeed.
 */

import { DomainOutboxStatus, Prisma, PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import { publishEvent } from "@/lib/events/queue";

export const DOMAIN_OUTBOX_CLAIM_LEASE_MS = 60_000;
export const DOMAIN_OUTBOX_DISPATCH_TIMEOUT_MS = 120_000;
export const DOMAIN_OUTBOX_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000, 300_000];
export const MAX_DOMAIN_OUTBOX_ATTEMPTS = 5;

export type DomainOutboxResourceType = "TASK" | "ATTACHMENT" | "PROJECT";
export type DomainOutboxEventType = "DELETE_TASK" | "DELETE_ATTACHMENT" | "DELETE_PROJECT";

export interface RecordDomainDeletionInput {
  tx: Omit<
    PrismaClient,
    "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
  >;
  orgId: string;
  resourceType: DomainOutboxResourceType;
  resourceId: string;
  eventType: DomainOutboxEventType;
  payload: Record<string, unknown>;
}

export function buildDomainOutboxIdempotencyKey(
  resourceType: string,
  resourceId: string
): string {
  return `DELETE_${resourceType}:${resourceId}`;
}

export function buildDomainOutboxDeduplicationId(
  idempotencyKey: string,
  attempt: number
): string {
  return `domain-outbox-${crypto
    .createHash("sha256")
    .update(`${idempotencyKey}#${attempt}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function backoffFor(attempts: number): number {
  const table = DOMAIN_OUTBOX_BACKOFF_MS;
  const index = Math.min(Math.max(attempts - 1, 0), table.length - 1);
  return table[index];
}

/**
 * Inserts the durable deletion intent inside the caller's transaction.
 * Idempotent: repeated calls collapse onto the same outbox row.
 */
export async function recordDomainDeletionIntent({
  tx,
  orgId,
  resourceType,
  resourceId,
  eventType,
  payload,
}: RecordDomainDeletionInput): Promise<{ id: string; created: boolean }> {
  const idempotencyKey = buildDomainOutboxIdempotencyKey(resourceType, resourceId);

  const existing = await tx.domainOutboxEvent.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });

  const row = await tx.domainOutboxEvent.upsert({
    where: { idempotencyKey },
    create: {
      idempotencyKey,
      eventType,
      orgId,
      resourceType,
      resourceId,
      payload: payload as unknown as Prisma.InputJsonValue,
      status: DomainOutboxStatus.PENDING,
      maxAttempts: MAX_DOMAIN_OUTBOX_ATTEMPTS,
    },
    update: {}, // Never overwrite or resurrect an existing intent
    select: { id: true },
  });

  return { id: row.id, created: existing === null };
}

export interface DomainOutboxRow {
  id: string;
  idempotencyKey: string;
  eventType: string;
  orgId: string;
  resourceType: string;
  resourceId: string;
  payload: unknown;
  status: DomainOutboxStatus;
  attempts: number;
  maxAttempts: number;
}

/**
 * Claims a bounded batch of due outbox records using lease-based compare-and-set.
 * Safe for concurrent dispatchers.
 */
export async function claimDomainOutboxBatch(
  limit: number,
  workerId: string = "default-dispatcher"
): Promise<DomainOutboxRow[]> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + DOMAIN_OUTBOX_CLAIM_LEASE_MS);
  const leaseExpiredBefore = new Date(now.getTime() - DOMAIN_OUTBOX_CLAIM_LEASE_MS);

  const due = (await db.domainOutboxEvent.findMany({
    where: {
      status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.DISPATCHED] },
      availableAt: { lte: now },
      OR: [
        { claimedAt: null },
        { claimedAt: { lte: leaseExpiredBefore } },
      ],
    },
    orderBy: { availableAt: "asc" },
    take: limit,
  })) || [];

  const claimed: DomainOutboxRow[] = [];

  for (const row of due) {
    if (row.attempts >= row.maxAttempts) {
      await db.domainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: DomainOutboxStatus.FAILED,
          claimedAt: null,
          claimedBy: null,
          lastError: `Max attempts (${row.maxAttempts}) exhausted before dispatch.`,
        },
      });
      continue;
    }

    const { count } = await db.domainOutboxEvent.updateMany({
      where: {
        id: row.id,
        status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.DISPATCHED] },
        availableAt: { lte: now },
        OR: [
          { claimedAt: null },
          { claimedAt: { lte: leaseExpiredBefore } },
        ],
      },
      data: {
        claimedAt: now,
        claimedBy: workerId,
        attempts: { increment: 1 },
        availableAt: leaseUntil,
      },
    });

    if (count === 1) {
      claimed.push({
        ...row,
        attempts: row.attempts + 1,
        status: row.status,
      });
    }
  }

  return claimed;
}

/**
 * Atomically claims a specific outbox event for execution by a worker.
 *
 * Concurrency & Fencing Guarantees:
 * 1. State restriction: Accepts only non-terminal eligible states (PENDING or DISPATCHED).
 * 2. Active claim prevention: Matches ONLY if claimedAt is null (unclaimed) OR
 *    claimedAt <= now - leaseMs (prior worker lease expired).
 * 3. CAS token update: Sets status=DISPATCHED, claimedAt=now, claimedBy=workerId.
 *    Any concurrent worker attempting to claim the same event will fail because
 *    claimedAt is now non-null and within the active lease window.
 * 4. Recovery: If a worker dies, after leaseMs expires another worker can claim it.
 */
export async function claimDomainOutboxForWorker(
  id: string,
  workerId: string,
  leaseMs: number = DOMAIN_OUTBOX_CLAIM_LEASE_MS
): Promise<{ success: boolean; event?: DomainOutboxRow }> {
  const now = new Date();
  const leaseExpiredBefore = new Date(now.getTime() - leaseMs);

  const { count } = await db.domainOutboxEvent.updateMany({
    where: {
      id,
      status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.DISPATCHED] },
      OR: [
        { claimedAt: null },
        { claimedAt: { lte: leaseExpiredBefore } },
      ],
    },
    data: {
      status: DomainOutboxStatus.DISPATCHED,
      claimedAt: now,
      claimedBy: workerId,
    },
  });

  if (count === 0) {
    return { success: false };
  }

  const event = await db.domainOutboxEvent.findUnique({
    where: { id },
  });

  return { success: true, event: event ?? undefined };
}

export interface DomainDispatchResult {
  claimed: number;
  published: number;
  failed: number;
  durationMs: number;
}

/**
 * Dispatches one batch of claimed outbox events to QStash.
 */
export async function dispatchDomainOutboxBatch(
  limit: number,
  workerId: string = "default-dispatcher"
): Promise<DomainDispatchResult> {
  const startedAt = Date.now();
  const boundedLimit = Math.min(Math.max(1, Number.isInteger(limit) ? limit : 50), 500);
  const claimed = await claimDomainOutboxBatch(boundedLimit, workerId);

  let published = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      await publishEvent(
        "DOMAIN_CLEANUP_REQUESTED",
        {
          outboxEventId: row.id,
          orgId: row.orgId,
        },
        undefined,
        {
          deduplicationId: buildDomainOutboxDeduplicationId(row.idempotencyKey, row.attempts),
        }
      );

      await db.domainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: DomainOutboxStatus.DISPATCHED,
          publishedAt: new Date(),
          availableAt: new Date(Date.now() + DOMAIN_OUTBOX_DISPATCH_TIMEOUT_MS),
          claimedAt: null,
          claimedBy: null,
          lastError: null,
        },
      });

      published += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const isExhausted = row.attempts >= row.maxAttempts;

      await db.domainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: isExhausted ? DomainOutboxStatus.FAILED : DomainOutboxStatus.PENDING,
          availableAt: new Date(Date.now() + backoffFor(row.attempts)),
          claimedAt: null,
          claimedBy: null,
          lastError: `Dispatch error: ${message.slice(0, 500)}`,
        },
      });
    }
  }

  return {
    claimed: claimed.length,
    published,
    failed,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Applies a worker-fenced outbox transition atomically.
 *
 * An explicit `FOR UPDATE` lock is acquired before the final predicate runs, so
 * any row-lock wait completes first. The lease is then evaluated with
 * `clock_timestamp()` (actual database wall clock, not transaction start time)
 * inside the UPDATE itself, not with an application timestamp computed before
 * the statement is issued. If the UPDATE waits past lease expiry, it re-checks
 * the predicate after the wait and rejects the stale worker.
 */
async function updateWorkerFencedOutboxEvent(
  id: string,
  workerId: string,
  set: Prisma.Sql
): Promise<boolean> {
  const affectedRows = await db.$executeRaw(
    Prisma.sql`
      WITH "locked" AS (
        SELECT "id"
        FROM "DomainOutboxEvent"
        WHERE "id" = ${id}
        FOR UPDATE
      )
      UPDATE "DomainOutboxEvent" AS "outbox"
      SET ${set},
          "updatedAt" = clock_timestamp()
      FROM "locked"
      WHERE "outbox"."id" = "locked"."id"
        AND "outbox"."status" IN (${DomainOutboxStatus.PENDING}::"DomainOutboxStatus", ${DomainOutboxStatus.DISPATCHED}::"DomainOutboxStatus")
        AND "outbox"."claimedBy" = ${workerId}
        AND "outbox"."claimedAt" > clock_timestamp() - (${DOMAIN_OUTBOX_CLAIM_LEASE_MS}::int * INTERVAL '1 millisecond')
    `
  );

  return affectedRows > 0;
}

/**
 * Marks outbox event as COMPLETED when external cleanup operations succeed.
 * Uses atomic CAS fencing: only updates if the event is in an active state
 * (PENDING or DISPATCHED), still owned by the calling worker, and the worker's
 * lease is unexpired according to the database clock at update execution.
 * Prevents stale workers from overwriting a newer claim or resurrecting a terminal event.
 */
export async function markDomainOutboxCompleted(
  id: string,
  workerId?: string
): Promise<{ success: boolean }> {
  if (workerId) {
    // Background worker completion: the token and DB-side lease predicate are
    // part of the same atomic UPDATE, so an expired worker cannot complete a
    // row before or after a replacement claim.
    const completed = await updateWorkerFencedOutboxEvent(
      id,
      workerId,
      Prisma.sql`
        "status" = ${DomainOutboxStatus.COMPLETED}::"DomainOutboxStatus",
        "completedAt" = ${new Date()},
        "claimedAt" = NULL,
        "claimedBy" = NULL,
        "lastError" = NULL
      `
    );
    return { success: completed };
  }

  // Legitimate synchronous completion: only unclaimed events or expired leases can be completed.
  // Unfenced calls cannot stomp on or steal an actively claimed event from a running worker.
  const leaseExpiredBefore = new Date(Date.now() - DOMAIN_OUTBOX_CLAIM_LEASE_MS);
  const { count } = await db.domainOutboxEvent.updateMany({
    where: {
      id,
      status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.DISPATCHED] },
      OR: [
        { claimedAt: null },
        { claimedAt: { lte: leaseExpiredBefore } },
      ],
    },
    data: {
      status: DomainOutboxStatus.COMPLETED,
      completedAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      lastError: null,
    },
  });

  return { success: count > 0 };
}

/**
 * Records an execution error for an outbox event.
 * Re-schedules retry with backoff or transitions to FAILED if attempts exhausted.
 * Uses worker fencing to ensure a stale worker whose claim has expired cannot
 * overwrite a newer active claim or alter a terminal state. The final conditional
 * update requires both the fencing token and an unexpired lease.
 */
export async function recordDomainOutboxExecutionFailure(
  id: string,
  error: unknown,
  workerId?: string
): Promise<{ success: boolean }> {
  const message = error instanceof Error ? error.message : String(error);
  const row = await db.domainOutboxEvent.findUnique({
    where: { id },
    select: { attempts: true, maxAttempts: true, claimedBy: true, claimedAt: true, status: true },
  });

  if (!row) return { success: false };

  // Fencing check 1: cannot transition an already COMPLETED or FAILED event
  if (row.status === DomainOutboxStatus.COMPLETED || row.status === DomainOutboxStatus.FAILED) {
    console.warn(
      `[OUTBOX] Outbox event ${id} is already in terminal state ${row.status}. Skipping execution failure recording.`
    );
    return { success: false };
  }

  const now = new Date();
  const leaseExpiredBefore = new Date(now.getTime() - DOMAIN_OUTBOX_CLAIM_LEASE_MS);
  const isLeaseActive = row.claimedAt && row.claimedAt > leaseExpiredBefore;

  // Fencing check 2: if a specific workerId was provided, verify it still owns the claim
  if (workerId) {
    if (row.claimedBy && row.claimedBy !== workerId) {
      console.warn(
        `[OUTBOX] Stale worker ${workerId} attempted to record failure for outbox event ${id}, but claim was lost (currently claimedBy=${row.claimedBy}). Skipping.`
      );
      return { success: false };
    }
  } else {
    // If workerId was NOT provided (synchronous failure), it cannot overwrite an active worker's claim
    if (isLeaseActive && row.claimedBy) {
      console.warn(
        `[OUTBOX] Unfenced failure recording attempted on outbox event ${id} while active worker ${row.claimedBy} holds lease. Skipping.`
      );
      return { success: false };
    }
  }

  const attempts = row?.attempts ?? 1;
  const maxAttempts = row?.maxAttempts ?? MAX_DOMAIN_OUTBOX_ATTEMPTS;
  const isExhausted = attempts >= maxAttempts;

  if (workerId) {
    // Worker failure recording uses the same atomic DB-side fencing predicate
    // as completion: the token must still match AND the lease must be unexpired
    // at the instant PostgreSQL executes the UPDATE.
    const recorded = await updateWorkerFencedOutboxEvent(
      id,
      workerId,
      Prisma.sql`
        "status" = ${isExhausted ? DomainOutboxStatus.FAILED : DomainOutboxStatus.DISPATCHED}::"DomainOutboxStatus",
        "availableAt" = ${new Date(Date.now() + backoffFor(attempts))},
        "claimedAt" = NULL,
        "claimedBy" = NULL,
        "lastError" = ${`Worker execution error: ${message.slice(0, 500)}`}
      `
    );
    return { success: recorded };
  }

  const where: Prisma.DomainOutboxEventWhereInput = {
    id,
    status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.DISPATCHED] },
    OR: [
      { claimedAt: null },
      { claimedAt: { lte: leaseExpiredBefore } },
    ],
  };

  const { count } = await db.domainOutboxEvent.updateMany({
    where,
    data: {
      status: isExhausted ? DomainOutboxStatus.FAILED : DomainOutboxStatus.DISPATCHED,
      availableAt: new Date(Date.now() + backoffFor(attempts)),
      claimedAt: null,
      claimedBy: null,
      lastError: `Worker execution error: ${message.slice(0, 500)}`,
    },
  });

  return { success: count > 0 };
}

/**
 * Operator redrive procedure:
 * Safely resets failed outbox events back to PENDING with zeroed attempts
 * and immediate availability, allowing background dispatchers to re-process them.
 */
export async function redriveFailedDomainOutboxEvents(options?: {
  orgId?: string;
  limit?: number;
}): Promise<{ resetCount: number }> {
  const where: Prisma.DomainOutboxEventWhereInput = {
    status: DomainOutboxStatus.FAILED,
  };
  if (options?.orgId) {
    where.orgId = options.orgId;
  }

  const result = await db.domainOutboxEvent.updateMany({
    where,
    data: {
      status: DomainOutboxStatus.PENDING,
      attempts: 0,
      availableAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      lastError: null,
    },
  });

  return { resetCount: result.count };
}
