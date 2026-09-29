// src/lib/ai/agent/outbox.ts

/**
 * Transactional outbox for critical agent events.
 *
 * The problem this solves: the agent persisted domain state and then published
 * to QStash as two independent steps. A crash in between left the database
 * asserting that work was required while the event was gone permanently, and
 * the session hung until the reaper eventually noticed. This was the largest
 * remaining durability gap in Assignment 36.
 *
 * The pattern:
 *   1. write domain state AND the publish intent in ONE transaction
 *      (recordAgentEvent, always called with a tx client)
 *   2. a dispatcher later moves rows PENDING -> PUBLISHED
 *
 * Delivery guarantee, stated precisely and not oversold:
 *   - durable intent         yes: the row commits with the domain state
 *   - at-least-once delivery yes: a crash after send but before marking
 *                                 PUBLISHED causes a redelivery
 *   - idempotent consumers   yes: see `idempotency` note below
 *   - exactly-once           NO, and never claimed
 *
 * On idempotency: the agent's two critical consumers are guarded by
 * compare-and-set, not by EventLog. The tool worker only claims rows still in
 * PENDING, and the loop handler only advances a session whose step it already
 * holds. A duplicate publish therefore finds the work gone and no-ops. EventLog
 * remains as an additional guard for the generic event worker, and the
 * deterministic QStash deduplicationId below makes the broker drop obvious
 * repeats as a second layer. None of these rely on the publish happening
 * exactly once.
 */

import { AgentOutboxStatus, Prisma, PrismaClient } from "@prisma/client";
import crypto from "crypto";

import { prisma } from "@/lib/prisma/extended";
import { publishEvent } from "@/lib/events/queue";
import type { EventType, EventPayloadMap } from "@/lib/events/schema";
import { AGENT_OUTBOX_BACKOFF_MS, AGENT_OUTBOX_CLAIM_LEASE_MS } from "./constants";

/**
 * Deterministic idempotency key for an event.
 *
 * `AGENT_TOOL_EXECUTION_REQUESTED:<executionId>` yields exactly one logical
 * outbox record no matter how many times the producing code path runs, because
 * the column is uniquely indexed. That is what stops a retried transaction or a
 * double-submitted request from fanning out into two publishes.
 */
export function buildOutboxIdempotencyKey(
  eventType: EventType,
  aggregateId: string,
): string {
  return `${eventType}:${aggregateId}`;
}

function buildDeterministicMessageId(
  idempotencyKey: string,
  attempt: number,
): string {
  return `agent-outbox-${crypto
    .createHash("sha256")
    .update(`${idempotencyKey}#${attempt}`)
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * The transaction client this module writes through.
 *
 * Typed against the raw `PrismaClient` rather than
 * `Prisma.TransactionClient`: this project's client is extended with query
 * interceptors, and the transaction client derived from that extended type is
 * not assignable to the base `TransactionClient`. A raw-client transaction is
 * also the *correct* dependency here, not a compromise - the outbox is
 * infrastructure, and routing an infrastructure write through the application's
 * domain event interceptors would be wrong regardless of types.
 *
 * `tx` is required at every call site, so a caller cannot record an outbox
 * intent outside a transaction without saying so explicitly.
 */
export type AgentOutboxTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface RecordAgentEventResult {
  id: string;
  /**
   * False when an equivalent row already existed, i.e. this call was a
   * duplicate and no new event was scheduled. Callers use this for logging
   * only; correctness never depends on it, because the row is guaranteed to
   * exist either way.
   */
  deduped: boolean;
}

export interface RecordAgentEventInput<K extends EventType> {
  /** Must be a Prisma transaction client. Not optional, by design. */
  tx: AgentOutboxTx;
  eventType: K;
  sessionId?: string;
  executionId?: string;
  /** The id the event is about. Drives the idempotency key. */
  aggregateId: string;
  payload: EventPayloadMap[K];
}

/**
 * Records the intent to publish, inside the caller's transaction.
 *
 * `tx` is a required parameter rather than an optional convenience. The entire
 * value of an outbox is that the intent and the domain state share a
 * transaction, so an outbox writer that could be called outside one would be a
 * way to silently reintroduce the exact bug this module exists to remove.
 *
 * Duplicate-safe: the unique idempotencyKey means a repeated call is a no-op
 * rather than an error, so callers do not have to pre-check.
 */
export async function recordAgentEvent<K extends EventType>({
  tx,
  eventType,
  sessionId,
  executionId,
  aggregateId,
  payload,
}: RecordAgentEventInput<K>): Promise<RecordAgentEventResult> {
  const idempotencyKey = buildOutboxIdempotencyKey(eventType, aggregateId);

  // `upsert` rather than find-then-create. A read followed by a create is a
  // race: two callers can both read "absent" and both insert, and the loser
  // would take a unique-violation that ABORTS the surrounding transaction,
  // rolling back the domain write this outbox row exists to protect. `upsert`
  // resolves to a single atomic statement, so a repeat call is a no-op instead
  // of a transaction-killing error.
  // A separate cheap read tells us whether this call was the one that created
  // the row, purely for logging. It is not used to decide anything, and the
  // upsert below is still the thing that guarantees correctness.
  const existedBefore = await tx.agentOutboxEvent.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });

  const row = await tx.agentOutboxEvent.upsert({
    where: { idempotencyKey },
    create: {
      idempotencyKey,
      eventType,
      messageId: buildDeterministicMessageId(idempotencyKey, 0),
      sessionId,
      executionId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
    // Never rewrites an existing row's payload or resets it to PENDING. A
    // duplicate call must not resurrect a row the dispatcher already published.
    update: {},
    select: { id: true },
  });

  return { id: row.id, deduped: existedBefore !== null };
}

interface OutboxRow {
  id: string;
  eventType: string;
  messageId: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
}

/**
 * Claims a bounded batch of due events.
 *
 * Exclusivity is real mutual exclusion, not a status check. A predicate of
 * `status = PENDING` alone cannot work: the claim does not change status, so an
 * overlapping pass reads PENDING again and "wins" too, publishing the same event
 * twice from inside the app.
 *
 * The claim therefore pushes `availableAt` forward to a lease deadline, and the
 * predicate requires the row to still be DUE against a single `now` captured
 * once for the whole batch. That is a genuine CAS, because the claim mutates
 * the very field the predicate tests on:
 *
 *   pass 1  matches availableAt <= now  ->  sets availableAt = now + LEASE
 *   pass 2  reads availableAt = now+LEASE -> not due -> matches nothing
 *
 * Using `attempts` as an optimistic-concurrency version instead would NOT work.
 * A later pass reads the already-incremented value and its predicate matches
 * again, so it claims the row a second time. Comparing a field back to the value
 * just read only excludes writers that raced before the read.
 *
 * A crash mid-publish strands the row until the lease expires, which is the
 * intended trade: a duplicate publish is made safe by the consumers' CAS and by
 * the deterministic `deduplicationId`, whereas a lost event is never made safe.
 * The lease is therefore short relative to the five-minute maintenance tick.
 */
export async function claimOutboxBatch(limit: number): Promise<OutboxRow[]> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + AGENT_OUTBOX_CLAIM_LEASE_MS);

  const due = await prisma.agentOutboxEvent.findMany({
    where: {
      status: AgentOutboxStatus.PENDING,
      availableAt: { lte: now },
    },
    orderBy: { availableAt: "asc" },
    take: limit,
    select: {
      id: true,
      eventType: true,
      messageId: true,
      idempotencyKey: true,
      payload: true,
      attempts: true,
    },
  });

  const claimed: OutboxRow[] = [];

  for (const row of due) {
    const { count } = await prisma.agentOutboxEvent.updateMany({
      where: {
        id: row.id,
        status: AgentOutboxStatus.PENDING,
        // Still due as of the same `now`. Whichever pass gets here first
        // moves the deadline and every later pass fails this predicate.
        availableAt: { lte: now },
      },
      data: {
        attempts: { increment: 1 },
        availableAt: leaseUntil,
      },
    });

    if (count === 1) {
      claimed.push({ ...row, attempts: row.attempts + 1 });
    }
  }

  return claimed;
}

function backoffFor(attempts: number): number {
  const table = AGENT_OUTBOX_BACKOFF_MS;
  const index = Math.min(Math.max(attempts - 1, 0), table.length - 1);
  return table[index];
}

export interface DispatchResult {
  claimed: number;
  published: number;
  failed: number;
  durationMs: number;
}

/**
 * Publishes one claimed batch.
 *
 * Failure handling is the important part: a failed publish NEVER deletes or
 * marks the row. It goes back to PENDING with attempts incremented and
 * availableAt pushed into the future, so the event stays durable and retries
 * with backoff. Dropping the row on a transient QStash error would turn the
 * outbox into exactly the lossy queue it replaced.
 */
export async function dispatchOutboxBatch(
  limit: number,
): Promise<DispatchResult> {
  const startedAt = Date.now();
  const claimed = await claimOutboxBatch(limit);

  let published = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      await publishEvent(
        row.eventType as EventType,
        row.payload as EventPayloadMap[EventType],
        undefined,
        {
          messageId: row.messageId,
          // Deterministic per logical event: QStash drops a genuine repeat
          // publish inside its dedup window, before it ever reaches a consumer.
          deduplicationId: row.idempotencyKey,
        },
      );

      await prisma.agentOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: AgentOutboxStatus.PUBLISHED,
          publishedAt: new Date(),
          lastError: null,
        },
      });

      published += 1;
    } catch (error) {
      failed += 1;

      const message =
        error instanceof Error ? error.message : String(error);

      await prisma.agentOutboxEvent.update({
        where: { id: row.id },
        data: {
          // Stays PENDING: the intent is still owed.
          status: AgentOutboxStatus.PENDING,
          availableAt: new Date(Date.now() + backoffFor(row.attempts)),
          lastError: message.slice(0, 500),
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

/** Pending depth, for operations visibility. Does not count published rows. */
export async function countPendingOutboxEvents(): Promise<number> {
  return prisma.agentOutboxEvent.count({
    where: { status: AgentOutboxStatus.PENDING },
  });
}
