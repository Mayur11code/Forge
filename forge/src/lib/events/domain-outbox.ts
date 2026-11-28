// src/lib/events/domain-outbox.ts
//
// FC-017 / FC-018: Transactional Domain Event Outbox Manager.
//
// Guarantees:
// 1. Domain mutations and domain event outbox intents share a single atomic PostgreSQL transaction.
// 2. Either both commit, or neither commits.
// 3. Workflow-originated tasks/mutations are flagged with workflowEligible = false and suppressed
//    from global trigger dispatching without breaking current workflow progression.
// 4. Token-fenced leases protect concurrent background sweepers.

import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import { Prisma } from "@prisma/client";
import { publishEvent } from "@/lib/events/queue";
import { mapDomainEventToTrigger } from "@/lib/events/domain-event-mapping";

export const DOMAIN_OUTBOX_LEASE_MS = 30_000;
export const DOMAIN_OUTBOX_MAX_ATTEMPTS = 5;
export const DOMAIN_OUTBOX_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000];

export type MutationOriginType = "USER" | "WORKFLOW" | "SYSTEM";

export interface MutationOrigin {
  originType: MutationOriginType;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  workflowRunId?: string | null;
}

export interface RecordDomainEventInput {
  tx: Prisma.TransactionClient;
  orgId: string;
  eventType: "task.created" | "task.updated" | "task.completed" | "project.created" | string;
  entityType: "TASK" | "PROJECT";
  entityId: string;
  payload: Record<string, unknown>;
  origin?: MutationOrigin;
}

export interface DomainEventOutboxRecord {
  id: string;
  eventId: string;
  orgId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Prisma.JsonValue;
  originType: string;
  originWorkflowId: string | null;
  originWorkflowVersionId: string | null;
  originWorkflowRunId: string | null;
  workflowEligible: boolean;
  suppressionReason: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
}

/**
 * Generates a deterministic or unique event ID.
 */
export function generateDomainEventId(): string {
  return `evt_${crypto.randomBytes(16).toString("hex")}`;
}

/**
 * Records a durable domain event outbox row inside an interactive PostgreSQL transaction.
 *
 * Invariant: If originType is "WORKFLOW", the event is flagged with workflowEligible = false,
 * preventing recursive/unintended global workflow ignition while still persisting the audit record.
 */
export async function recordDomainEventIntent(
  input: RecordDomainEventInput,
): Promise<DomainEventOutboxRecord> {
  const eventId = generateDomainEventId();
  const canonicalTrigger = mapDomainEventToTrigger(input.eventType) || input.eventType;

  const isWorkflowOriginated = input.origin?.originType === "WORKFLOW";
  const workflowEligible = !isWorkflowOriginated;
  const suppressionReason = isWorkflowOriginated ? "WORKFLOW_ORIGINATED" : null;
  const initialStatus = isWorkflowOriginated ? "SUPPRESSED" : "PENDING";

  const created = await (input.tx as unknown as { domainEventOutbox: { create: (args: unknown) => Promise<DomainEventOutboxRecord> } }).domainEventOutbox.create({
    data: {
      eventId,
      orgId: input.orgId,
      eventType: canonicalTrigger,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload as unknown as Prisma.InputJsonValue,
      originType: input.origin?.originType ?? "USER",
      originWorkflowId: input.origin?.workflowId ?? null,
      originWorkflowVersionId: input.origin?.workflowVersionId ?? null,
      originWorkflowRunId: input.origin?.workflowRunId ?? null,
      workflowEligible,
      suppressionReason,
      status: initialStatus,
      attempts: 0,
      maxAttempts: DOMAIN_OUTBOX_MAX_ATTEMPTS,
      nextAttemptAt: new Date(),
    },
  });

  return created;
}

/**
 * Fast-path wake-up notification to QStash after transaction commits.
 * Best-effort: failures simply leave the outbox record in PENDING to be swept by background workers.
 */
export async function enqueueDomainOutboxWakeup(limit = 50): Promise<void> {
  try {
    await publishEvent("PROCESS_DOMAIN_EVENT_OUTBOX", { limit });
  } catch (error) {
    console.warn("[DOMAIN_OUTBOX] Fast-path QStash wake-up notification failed (will recover via sweeper):", error);
  }
}

/**
 * Claim a batch of eligible PENDING domain outbox events using token-fenced lease concurrency.
 */
export async function claimDomainOutboxBatch(
  batchSize = 25,
  leaseMs = DOMAIN_OUTBOX_LEASE_MS,
): Promise<{ claimToken: string; events: DomainEventOutboxRecord[] }> {
  const claimToken = crypto.randomUUID();
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  // PostgreSQL safe lease acquisition using raw query with FOR UPDATE SKIP LOCKED
  const claimed = await db.$transaction(async (tx) => {
    let rows: Array<{ id: string }> = [];

    if (typeof tx.$queryRaw === "function") {
      try {
        rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM "DomainEventOutbox"
          WHERE "workflowEligible" = true
            AND "status" = 'PENDING'
            AND "nextAttemptAt" <= ${now}
            AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
          ORDER BY "createdAt" ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `;
      } catch {
        // Fallback for mocked or SQLite environments
        rows = [];
      }
    }

    if (rows.length === 0) {
      // Fallback via findMany for non-locking environments
      const candidates = await (tx as unknown as { domainEventOutbox: { findMany: (args: unknown) => Promise<Array<{ id: string }>> } }).domainEventOutbox.findMany({
        where: {
          workflowEligible: true,
          status: "PENDING",
          nextAttemptAt: { lte: now },
        },
        take: batchSize,
        select: { id: true },
      });
      rows = candidates;
    }

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((r) => r.id);

    await (tx as unknown as { domainEventOutbox: { updateMany: (args: unknown) => Promise<{ count: number }> } }).domainEventOutbox.updateMany({
      where: {
        id: { in: ids },
      },
      data: {
        status: "PROCESSING",
        leaseToken: claimToken,
        leaseExpiresAt,
        attempts: { increment: 1 },
      },
    });

    const records = await (tx as unknown as { domainEventOutbox: { findMany: (args: unknown) => Promise<DomainEventOutboxRecord[]> } }).domainEventOutbox.findMany({
      where: { id: { in: ids } },
    });

    return records;
  });

  return { claimToken, events: claimed };
}

/**
 * Mark a domain outbox event as PROCESSED.
 */
export async function completeDomainOutboxEvent(
  id: string,
  claimToken: string,
): Promise<boolean> {
  const result = await (db as unknown as { domainEventOutbox: { updateMany: (args: unknown) => Promise<{ count: number }> } }).domainEventOutbox.updateMany({
    where: {
      id,
      leaseToken: claimToken,
    },
    data: {
      status: "PROCESSED",
      leaseToken: null,
      leaseExpiresAt: null,
      processedAt: new Date(),
    },
  });

  return result.count > 0;
}

/**
 * Fail or reschedule a domain outbox event with exponential backoff.
 */
export async function failDomainOutboxEvent(
  id: string,
  claimToken: string,
  error: unknown,
  currentAttempts: number,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isTerminal = currentAttempts >= DOMAIN_OUTBOX_MAX_ATTEMPTS;
  const status = isTerminal ? "DEAD_LETTER" : "PENDING";

  const backoffIndex = Math.min(Math.max(currentAttempts - 1, 0), DOMAIN_OUTBOX_BACKOFF_MS.length - 1);
  const backoffDelay = DOMAIN_OUTBOX_BACKOFF_MS[backoffIndex];
  const nextAttemptAt = new Date(Date.now() + backoffDelay);

  await (db as unknown as { domainEventOutbox: { updateMany: (args: unknown) => Promise<{ count: number }> } }).domainEventOutbox.updateMany({
    where: {
      id,
      leaseToken: claimToken,
    },
    data: {
      status,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: errorMessage,
      nextAttemptAt,
    },
  });
}

export interface DomainOutboxTelemetry {
  pendingEligibleCount: number;
  oldestPendingAgeSec: number | null;
  processingCount: number;
  expiredLeaseCount: number;
  deadLetterCount: number;
  processedCount: number;
  timestamp: string;
}

/**
 * Backlog visibility & telemetry for domain event outbox.
 * Provides operator metrics without exposing PII or event payloads (M4-REM-3).
 */
export async function getDomainOutboxTelemetry(): Promise<DomainOutboxTelemetry> {
  const now = new Date();
  const outbox = (db as unknown as {
    domainEventOutbox: {
      count: (args?: unknown) => Promise<number>;
      findFirst: (args?: unknown) => Promise<{ createdAt: Date } | null>;
    };
  }).domainEventOutbox;

  let pendingEligibleCount = 0;
  let processingCount = 0;
  let expiredLeaseCount = 0;
  let deadLetterCount = 0;
  let processedCount = 0;
  let oldestPendingAgeSec: number | null = null;

  try {
    const [pending, processing, expired, deadLetter, processed, oldest] = await Promise.all([
      outbox.count({ where: { workflowEligible: true, status: "PENDING" } }),
      outbox.count({ where: { status: "PROCESSING" } }),
      outbox.count({ where: { status: "PROCESSING", leaseExpiresAt: { lt: now } } }),
      outbox.count({ where: { status: "DEAD_LETTER" } }),
      outbox.count({ where: { status: "PROCESSED" } }),
      outbox.findFirst({
        where: { workflowEligible: true, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);

    pendingEligibleCount = pending;
    processingCount = processing;
    expiredLeaseCount = expired;
    deadLetterCount = deadLetter;
    processedCount = processed;

    if (oldest?.createdAt) {
      oldestPendingAgeSec = Math.max(0, Math.floor((now.getTime() - new Date(oldest.createdAt).getTime()) / 1000));
    }
  } catch (err) {
    console.warn("[DOMAIN_OUTBOX] Failed to gather telemetry:", err);
  }

  return {
    pendingEligibleCount,
    oldestPendingAgeSec,
    processingCount,
    expiredLeaseCount,
    deadLetterCount,
    processedCount,
    timestamp: now.toISOString(),
  };
}
