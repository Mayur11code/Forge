// src/lib/workflow/execution/outbox.ts
//
// F-04: Transactional Workflow Outbox, Reliable Queue Dispatch & Delivery Recovery.
//
// Guarantees:
// 1. StepRun creation and dispatch intent share a single atomic PostgreSQL transaction.
// 2. Either both commit, or neither commits.
// 3. Dispatch to QStash is performed by a dedicated dispatcher outside database transactions.
// 4. Token-fenced leases protect concurrent dispatchers from duplicate delivery.
// 5. Bounded retries with exponential backoff and jitter; retries exhausted transition to DEAD_LETTERED.
// 6. Authorized run- and tenant-scoped re-drive.
// 7. Stale lease recovery and legacy pending step reconciliation.

import crypto from "crypto";
import { WorkflowOutboxStatus, type Prisma, type WorkflowOutbox } from "@prisma/client";
import { db } from "@/lib/prisma/db";
import { publishEvent } from "@/lib/events/queue";
import type { EventPayloadMap } from "@/lib/events/schema";

export const WORKFLOW_OUTBOX_CLAIM_LEASE_MS = 30_000; // 30 seconds lease
export const WORKFLOW_OUTBOX_MAX_ATTEMPTS = 5;
export const WORKFLOW_OUTBOX_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export type WorkflowOutboxTx = {
  workflowOutbox: {
    create: (args: Prisma.WorkflowOutboxCreateArgs) => Promise<WorkflowOutbox>;
    upsert: (args: Prisma.WorkflowOutboxUpsertArgs) => Promise<WorkflowOutbox>;
    findUnique: (args: Prisma.WorkflowOutboxFindUniqueArgs) => Promise<WorkflowOutbox | null>;
  };
  stepRun: {
    create: (args: Prisma.StepRunCreateArgs) => Promise<{ id: string; runId: string; stepId: string; status: string }>;
  };
  [key: string]: unknown;
};

/**
 * Builds a deterministic unique deduplication key for a workflow dispatch intent.
 * Format: `${runId}:${stepRunId}:${actionType}:gen-${generation}`
 */
export function buildWorkflowOutboxDedupeKey(params: {
  runId: string;
  stepRunId: string;
  actionType: "EXECUTE" | "COMPENSATE";
  generation: number;
}): string {
  return `${params.runId}:${params.stepRunId}:${params.actionType}:gen-${params.generation}`;
}

/**
 * Builds a QStash-compliant deduplication ID.
 * QStash rejects ':' in deduplicationId; this hashes the dedupeKey into a fixed alphanumeric format.
 */
export function buildWorkflowOutboxQStashDedupId(dedupeKey: string): string {
  return `wf-outbox-${crypto.createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32)}`;
}

/**
 * Builds a deterministic message ID for cloud events.
 */
export function buildWorkflowOutboxMessageId(dedupeKey: string, attempt: number): string {
  return `wf-outbox-${crypto.createHash("sha256").update(`${dedupeKey}#${attempt}`).digest("hex").slice(0, 32)}`;
}

export interface RecordWorkflowDispatchIntentInput {
  tx: WorkflowOutboxTx;
  orgId: string;
  runId: string;
  stepRunId: string;
  stepId: string;
  eventType: "EXECUTE_WORKFLOW_NODE";
  actionType: "EXECUTE" | "COMPENSATE";
  generation?: number;
  payload: EventPayloadMap["EXECUTE_WORKFLOW_NODE"];
}

/**
 * Records a durable workflow dispatch intent inside the caller's PostgreSQL transaction.
 * Fails atomically if dedupeKey collides or if the transaction aborts.
 */
export async function recordWorkflowDispatchIntent(
  input: RecordWorkflowDispatchIntentInput,
): Promise<WorkflowOutbox> {
  const generation = input.generation ?? 1;
  const dedupeKey = buildWorkflowOutboxDedupeKey({
    runId: input.runId,
    stepRunId: input.stepRunId,
    actionType: input.actionType,
    generation,
  });

  return input.tx.workflowOutbox.create({
    data: {
      orgId: input.orgId,
      runId: input.runId,
      stepRunId: input.stepRunId,
      stepId: input.stepId,
      eventType: input.eventType,
      payload: input.payload as unknown as Prisma.InputJsonValue,
      dedupeKey,
      status: WorkflowOutboxStatus.PENDING,
      dispatchGeneration: generation,
      nextAttemptAt: new Date(),
    },
  });
}

/**
 * Atomically claims a batch of due workflow outbox events using a lease token and lease expiry.
 * Recovers expired PROCESSING leases automatically.
 * Guarantees mutual exclusion between concurrent dispatchers.
 */
export async function claimWorkflowOutboxBatch({
  orgId,
  limit = 20,
  leaseDurationMs = WORKFLOW_OUTBOX_CLAIM_LEASE_MS,
  now = new Date(),
}: {
  orgId?: string;
  limit?: number;
  leaseDurationMs?: number;
  now?: Date;
} = {}): Promise<WorkflowOutbox[]> {
  const due = await db.workflowOutbox.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      OR: [
        {
          status: { in: [WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING] },
          nextAttemptAt: { lte: now },
        },
        {
          status: WorkflowOutboxStatus.PROCESSING,
          leaseExpiresAt: { lte: now }, // Stale lease recovery
        },
      ],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

  const claimed: WorkflowOutbox[] = [];

  for (const row of due) {
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const { count } = await db.workflowOutbox.updateMany({
      where: {
        id: row.id,
        ...(orgId ? { orgId } : {}),
        OR: [
          {
            status: { in: [WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING] },
            nextAttemptAt: { lte: now },
          },
          {
            status: WorkflowOutboxStatus.PROCESSING,
            leaseExpiresAt: { lte: now },
          },
        ],
      },
      data: {
        status: WorkflowOutboxStatus.PROCESSING,
        leaseToken,
        leaseExpiresAt,
        lastAttemptAt: now,
        attempts: { increment: 1 },
      },
    });

    if (count === 1) {
      claimed.push({
        ...row,
        status: WorkflowOutboxStatus.PROCESSING,
        leaseToken,
        leaseExpiresAt,
        lastAttemptAt: now,
        attempts: row.attempts + 1,
      });
    }
  }

  return claimed;
}

export interface WorkflowOutboxDispatchSummary {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
  durationMs: number;
}

/**
 * Dispatches one batch of claimed outbox events to QStash outside database transactions.
 * Uses token fencing to prevent stale dispatchers from completing after lease takeover.
 */
export async function dispatchWorkflowOutboxBatch({
  orgId,
  limit = 20,
  leaseDurationMs = WORKFLOW_OUTBOX_CLAIM_LEASE_MS,
  now = new Date(),
  throwOnError = false,
}: {
  orgId?: string;
  limit?: number;
  leaseDurationMs?: number;
  now?: Date;
  throwOnError?: boolean;
} = {}): Promise<WorkflowOutboxDispatchSummary> {
  const startedAt = Date.now();
  const claimed = await claimWorkflowOutboxBatch({ orgId, limit, leaseDurationMs, now });

  let published = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const row of claimed) {
    const qstashDedupId = buildWorkflowOutboxQStashDedupId(row.dedupeKey);
    const messageId = buildWorkflowOutboxMessageId(row.dedupeKey, row.attempts);

    try {
      await publishEvent(
        row.eventType as "EXECUTE_WORKFLOW_NODE",
        row.payload as EventPayloadMap["EXECUTE_WORKFLOW_NODE"],
        undefined,
        {
          messageId,
          deduplicationId: qstashDedupId,
        },
      );

      // Token-fenced completion: only the current lease holder can mark the row PUBLISHED
      const { count } = await db.workflowOutbox.updateMany({
        where: {
          id: row.id,
          leaseToken: row.leaseToken,
          status: WorkflowOutboxStatus.PROCESSING,
        },
        data: {
          status: WorkflowOutboxStatus.PUBLISHED,
          publishedAt: new Date(),
          leaseToken: null,
          lastError: null,
        },
      });

      if (count === 1) {
        published += 1;

        // Structured progress audit log
        if (row.stepRunId) {
          await db.executionAuditLog.create({
            data: {
              runId: row.runId,
              stepId: row.stepRunId,
              logLevel: "INFO",
              eventType: "STEP_DISPATCHED",
              message: `Outbox event ${row.id} published to QStash (attempt ${row.attempts})`,
              payload: {
                outboxId: row.id,
                runId: row.runId,
                stepRunId: row.stepRunId,
                orgId: row.orgId,
                attempts: row.attempts,
                dispatchGeneration: row.dispatchGeneration,
              },
            },
          }).catch(() => {});
        }
      } else {
        console.warn(
          `[OUTBOX] Token fence rejected stale completion for event ${row.id} (lease token expired or taken over)`,
        );
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (row.attempts < row.maxAttempts) {
        const backoffTable = WORKFLOW_OUTBOX_BACKOFF_MS;
        const baseDelay = backoffTable[Math.min(row.attempts - 1, backoffTable.length - 1)];
        const jitter = Math.floor(Math.random() * 200);
        const delayMs = baseDelay + jitter;
        const nextAttemptAt = new Date(Date.now() + delayMs);

        await db.workflowOutbox.updateMany({
          where: {
            id: row.id,
            leaseToken: row.leaseToken,
          },
          data: {
            status: WorkflowOutboxStatus.RETRYING,
            nextAttemptAt,
            leaseToken: null,
            lastError: errorMessage.slice(0, 1000),
          },
        });

        console.warn(
          `[OUTBOX] Event ${row.id} publish failed (attempt ${row.attempts}/${row.maxAttempts}); retrying in ${delayMs}ms: ${errorMessage}`,
        );
      } else {
        // Retries exhausted -> DEAD_LETTERED
        deadLettered += 1;
        await db.workflowOutbox.updateMany({
          where: {
            id: row.id,
            leaseToken: row.leaseToken,
          },
          data: {
            status: WorkflowOutboxStatus.DEAD_LETTERED,
            deadLetteredAt: new Date(),
            leaseToken: null,
            lastError: `Exhausted ${row.attempts} attempts: ${errorMessage.slice(0, 1000)}`,
          },
        });

        console.error(
          `[OUTBOX] Event ${row.id} for StepRun ${row.stepRunId} exhausted retries. Marked DEAD_LETTERED.`,
        );

        await db.executionAuditLog.create({
          data: {
            runId: row.runId,
            stepId: row.stepRunId,
            logLevel: "ERROR",
            eventType: "EXECUTION_HALTED",
            message: `Outbox event ${row.id} dead-lettered after ${row.attempts} failed dispatch attempts`,
            payload: {
              outboxId: row.id,
              runId: row.runId,
              stepRunId: row.stepRunId,
              orgId: row.orgId,
              attempts: row.attempts,
              error: errorMessage,
            },
          },
        }).catch(() => {});
      }

      if (throwOnError) {
        throw error;
      }
    }
  }

  return {
    claimed: claimed.length,
    published,
    failed,
    deadLettered,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Re-drives a DEAD_LETTERED workflow outbox event.
 * Enforces strict organization tenant scope.
 */
export async function redriveWorkflowOutboxEvent({
  outboxId,
  orgId,
  userId,
}: {
  outboxId: string;
  orgId: string;
  userId?: string;
}): Promise<{ success: boolean; event?: WorkflowOutbox; error?: string }> {
  const existing = await db.workflowOutbox.findUnique({
    where: { id: outboxId },
    include: {
      run: {
        select: {
          id: true,
          workflow: { select: { orgId: true } },
        },
      },
    },
  });

  if (!existing) {
    return { success: false, error: "Outbox event not found" };
  }

  // Tenant boundary enforcement across both outbox and parent workflow run
  if (existing.orgId !== orgId || (existing.run?.workflow?.orgId && existing.run.workflow.orgId !== orgId)) {
    return { success: false, error: "Unauthorized: tenant boundary mismatch" };
  }

  // Operator authorization check when caller identity is provided
  if (userId) {
    const membership = await db.membership.findFirst({
      where: { userId, orgId },
    });

    if (!membership || membership.role !== "ADMIN") {
      return { success: false, error: "Forbidden: operator role required" };
    }
  }

  if (existing.status !== WorkflowOutboxStatus.DEAD_LETTERED) {
    return {
      success: false,
      error: `Cannot re-drive event in status ${existing.status} (only DEAD_LETTERED allowed)`,
    };
  }

  const updated = await db.workflowOutbox.update({
    where: { id: outboxId },
    data: {
      status: WorkflowOutboxStatus.PENDING,
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseToken: null,
      deadLetteredAt: null,
      lastError: null,
      dispatchGeneration: existing.dispatchGeneration + 1,
    },
  });

  await db.executionAuditLog.create({
    data: {
      runId: existing.runId,
      stepId: existing.stepRunId,
      logLevel: "INFO",
      eventType: "STEP_STARTED",
      message: `Outbox event ${outboxId} re-driven by operator${userId ? ` (${userId})` : ""} (generation ${updated.dispatchGeneration})`,
      payload: {
        outboxId,
        runId: existing.runId,
        stepRunId: existing.stepRunId,
        orgId,
        userId: userId ?? null,
        generation: updated.dispatchGeneration,
      },
    },
  }).catch(() => {});

  return { success: true, event: updated };
}

/**
 * Reconciles legacy PENDING StepRuns that have no outbox record.
 * Generates an outbox record with a deterministic legacy dedupe key.
 */
export async function reconcileLegacyPendingStepRuns({
  limit = 50,
}: {
  limit?: number;
} = {}): Promise<number> {
  const pendingStepRuns = await db.stepRun.findMany({
    where: {
      status: "PENDING",
      startedAt: null,
      outboxEvents: { none: {} },
    },
    include: {
      run: {
        select: {
          id: true,
          status: true,
          workflow: { select: { orgId: true } },
        },
      },
    },
    take: limit,
  });

  let reconciled = 0;

  for (const stepRun of pendingStepRuns) {
    if (stepRun.run.status !== "RUNNING" && stepRun.run.status !== "PENDING") {
      continue;
    }

    const dedupeKey = `legacy:${stepRun.runId}:${stepRun.id}:gen-1`;
    try {
      await db.workflowOutbox.upsert({
        where: { dedupeKey },
        create: {
          orgId: stepRun.run.workflow.orgId,
          runId: stepRun.runId,
          stepRunId: stepRun.id,
          stepId: stepRun.stepId,
          eventType: "EXECUTE_WORKFLOW_NODE",
          payload: {
            runId: stepRun.runId,
            stepRunId: stepRun.id,
            kind: "ACTION",
          },
          dedupeKey,
          status: WorkflowOutboxStatus.PENDING,
          dispatchGeneration: 1,
          nextAttemptAt: new Date(),
        },
        update: {},
      });
      reconciled += 1;

      await db.executionAuditLog.create({
        data: {
          runId: stepRun.runId,
          stepId: stepRun.id,
          logLevel: "INFO",
          eventType: "STEP_DISPATCHED",
          message: `Legacy pending step ${stepRun.id} reconciled into transactional outbox`,
          payload: {
            runId: stepRun.runId,
            stepRunId: stepRun.id,
            orgId: stepRun.run.workflow.orgId,
            dedupeKey,
          },
        },
      }).catch(() => {});
    } catch {
      // Collision or racing pass handled
    }
  }

  return reconciled;
}

/**
 * Bounded drain loop: continuously dispatches claimed batches until the outbox is clear or maxBatches is reached.
 */
export async function drainWorkflowOutbox({
  orgId,
  maxBatches = 5,
  limit = 20,
  throwOnError = false,
  now,
}: {
  orgId?: string;
  maxBatches?: number;
  limit?: number;
  throwOnError?: boolean;
  now?: Date;
} = {}): Promise<{ totalClaimed: number; totalPublished: number; totalFailed: number }> {
  let totalClaimed = 0;
  let totalPublished = 0;
  let totalFailed = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const res = await dispatchWorkflowOutboxBatch({ orgId, limit, throwOnError, now });
    totalClaimed += res.claimed;
    totalPublished += res.published;
    totalFailed += res.failed;

    if (res.claimed < limit) {
      break; // Outbox drained
    }
  }

  return { totalClaimed, totalPublished, totalFailed };
}
