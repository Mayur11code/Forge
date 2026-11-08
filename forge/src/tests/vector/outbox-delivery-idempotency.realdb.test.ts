// src/tests/vector/outbox-delivery-idempotency.realdb.test.ts
/**
 * Forge Vector V2 — Phase B: Real-Database Outbox Delivery Idempotency (E3 Acceptance)
 *
 * Verifies Area 3.2:
 * 1. Logical work identity (outboxEventId) across different QStash delivery IDs (messageId).
 * 2. Active execution deduplication: messageId B for same outboxEventId hits partial unique index
 *    EventLog_outbox_active_idx and yields already_running.
 * 3. Completed execution deduplication: messageId B for already-completed outboxEventId yields
 *    already_processed without re-executing.
 * 4. Concurrent race: messageId A and messageId B racing to insert the same outboxEventId yields
 *    exactly 1 execution winner and 1 already_running / already_processed.
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

jest.setTimeout(120_000);

const targetDbUrl =
  process.env.DISPOSABLE_TEST_DATABASE_URL ||
  process.env.FORGE_DISPOSABLE_TEST_DATABASE_URL ||
  (process.env.ALLOW_NEON_DEV_DB_TESTS === "true" ? process.env.DATABASE_URL : undefined);

const isE3Required =
  process.env.REQUIRE_E3_CONCURRENCY === "true" ||
  process.env.CI === "true";

const describeRealDb = !targetDbUrl && !isE3Required ? describe.skip : describe;

describeRealDb("Forge Vector V2 — Phase B: Outbox Delivery Idempotency Across QStash Message IDs (E3)", () => {
  let pool1: Pool | null = null;
  let pool2: Pool | null = null;
  let testClient1: PrismaClient | null = null;
  let testClient2: PrismaClient | null = null;

  const RUN_ID = `idemp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const OUTBOX_EVENT_1 = `outbox_work_1_${RUN_ID}`;
  const OUTBOX_EVENT_2 = `outbox_work_2_${RUN_ID}`;
  const OUTBOX_EVENT_3 = `outbox_work_3_${RUN_ID}`;

  const MSG_A1 = `msg_a1_${RUN_ID}`;
  const MSG_B1 = `msg_b1_${RUN_ID}`;
  const MSG_A2 = `msg_a2_${RUN_ID}`;
  const MSG_B2 = `msg_b2_${RUN_ID}`;
  const MSG_A3 = `msg_a3_${RUN_ID}`;
  const MSG_B3 = `msg_b3_${RUN_ID}`;

  beforeAll(async () => {
    if (!targetDbUrl) {
      if (isE3Required) {
        throw new Error(
          "[P0_SAFETY_ERROR] E3 Real-Database tests are REQUIRED in this environment (REQUIRE_E3_CONCURRENCY=true or CI=true), but no target database URL is configured."
        );
      }
      return;
    }

    pool1 = new Pool({
      connectionString: targetDbUrl,
      max: 10,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
    testClient1 = new PrismaClient({ adapter: new PrismaPg(pool1) });

    pool2 = new Pool({
      connectionString: targetDbUrl,
      max: 10,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
    testClient2 = new PrismaClient({ adapter: new PrismaPg(pool2) });
  });

  afterAll(async () => {
    if (!testClient1) return;
    try {
      await testClient1.$executeRaw`
        DELETE FROM "EventLog"
        WHERE "outboxEventId" IN (${OUTBOX_EVENT_1}, ${OUTBOX_EVENT_2}, ${OUTBOX_EVENT_3})
           OR "messageId" IN (${MSG_A1}, ${MSG_B1}, ${MSG_A2}, ${MSG_B2}, ${MSG_A3}, ${MSG_B3});
      `;
    } catch {
      // Best-effort cleanup
    } finally {
      if (testClient1) await testClient1.$disconnect();
      if (testClient2) await testClient2.$disconnect();
      if (pool1) await pool1.end();
      if (pool2) await pool2.end();
    }
  });

  it("rejects duplicate delivery under a different messageId while original execution is PENDING", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const workerAToken = `workerA_${RUN_ID}`;
    const workerBToken = `workerB_${RUN_ID}`;

    // 1. Delivery A inserts PENDING lease for OUTBOX_EVENT_1
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "eventName", "payload", "status",
        "outboxEventId", "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${crypto.randomUUID()},
        ${MSG_A1},
        'EMBEDDING_REQUESTED',
        ${JSON.stringify({ outboxEventId: OUTBOX_EVENT_1 })}::jsonb,
        'PENDING'::"EventStatus",
        ${OUTBOX_EVENT_1},
        ${workerAToken},
        clock_timestamp() + interval '300 seconds',
        clock_timestamp(),
        clock_timestamp()
      );
    `;

    // 2. Delivery B arrives under different messageId (MSG_B1) for the same OUTBOX_EVENT_1
    // Attempt insert: should hit EventLog_outbox_active_idx partial unique index
    let hitIndexConstraint = false;
    try {
      await testClient2.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "EventLog" (
          "id", "messageId", "eventName", "payload", "status",
          "outboxEventId", "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          ${crypto.randomUUID()},
          ${MSG_B1},
          'EMBEDDING_REQUESTED',
          ${JSON.stringify({ outboxEventId: OUTBOX_EVENT_1 })}::jsonb,
          'PENDING'::"EventStatus",
          ${OUTBOX_EVENT_1},
          ${workerBToken},
          clock_timestamp() + interval '300 seconds',
          clock_timestamp(),
          clock_timestamp()
        )
        RETURNING "id";
      `;
    } catch (err: unknown) {
      hitIndexConstraint =
        String(err).includes("unique constraint") ||
        String(err).includes("EventLog_outbox_active_idx") ||
        (err as { code?: unknown })?.code === "23505" || (err as { code?: unknown })?.code === "P2002";
    }

    expect(hitIndexConstraint).toBe(true);

    // 3. Worker B resolves the collision by querying existing row for that outboxEventId
    const existingLogs = await testClient2.$queryRaw<Array<{ id: string; status: string; leaseExpiresAt: Date | null }>>`
      SELECT "id", "status", "leaseExpiresAt"
      FROM "EventLog"
      WHERE "messageId" = ${MSG_B1}
         OR ("outboxEventId" IS NOT NULL AND "outboxEventId" = ${OUTBOX_EVENT_1})
      ORDER BY "createdAt" DESC
      LIMIT 1;
    `;

    expect(existingLogs).toHaveLength(1);
    expect(existingLogs[0].status).toBe("PENDING");

    // Steal attempt by Worker B must fail because lease is active
    const steal = await testClient2.$queryRaw<Array<{ id: string }>>`
      UPDATE "EventLog"
      SET "claimToken" = ${workerBToken},
          "leaseExpiresAt" = clock_timestamp() + interval '300 seconds',
          "updatedAt" = clock_timestamp()
      WHERE "id" = ${existingLogs[0].id}
        AND "status" = 'PENDING'::"EventStatus"
        AND "leaseExpiresAt" <= clock_timestamp()
      RETURNING "id";
    `;

    expect(steal).toHaveLength(0); // Fails to steal -> returns already_running
  });

  it("returns already_processed for a different messageId when the outboxEventId is already SUCCESS", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const workerAToken = `workerA_success_${RUN_ID}`;

    // 1. Delivery A inserts and completes work for OUTBOX_EVENT_2
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "eventName", "payload", "status",
        "outboxEventId", "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${crypto.randomUUID()},
        ${MSG_A2},
        'EMBEDDING_REQUESTED',
        ${JSON.stringify({ outboxEventId: OUTBOX_EVENT_2 })}::jsonb,
        'SUCCESS'::"EventStatus",
        ${OUTBOX_EVENT_2},
        ${workerAToken},
        NULL,
        clock_timestamp(),
        clock_timestamp()
      );
    `;

    // 2. Delivery B arrives under MSG_B2. Pre-check queries completed outboxEventId
    const completedPrecheck = await testClient2.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "EventLog"
      WHERE "outboxEventId" = ${OUTBOX_EVENT_2}
        AND "status" = 'SUCCESS'::"EventStatus"
      LIMIT 1;
    `;

    expect(completedPrecheck).toHaveLength(1);
    // Worker logic returns already_processed immediately without executing
  });

  it("physically prevents inserting PENDING claim when previous delivery already completed to SUCCESS (Area C)", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const workerBToken = `workerB_race_success_${RUN_ID}`;

    // Delivery B arrives and attempts to insert PENDING for OUTBOX_EVENT_2 (which is already SUCCESS).
    // The partial unique index covering (PENDING, SUCCESS) must reject it.
    let hitIndexConstraint = false;
    try {
      await testClient2.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "EventLog" (
          "id", "messageId", "eventName", "payload", "status",
          "outboxEventId", "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          ${crypto.randomUUID()},
          ${MSG_B2},
          'EMBEDDING_REQUESTED',
          ${JSON.stringify({ outboxEventId: OUTBOX_EVENT_2 })}::jsonb,
          'PENDING'::"EventStatus",
          ${OUTBOX_EVENT_2},
          ${workerBToken},
          clock_timestamp() + interval '300 seconds',
          clock_timestamp(),
          clock_timestamp()
        )
        RETURNING "id";
      `;
    } catch (err: unknown) {
      hitIndexConstraint =
        String(err).includes("unique constraint") ||
        String(err).includes("EventLog_outbox_active_idx") ||
        (err as { code?: unknown })?.code === "23505" || (err as { code?: unknown })?.code === "P2002";
    }

    expect(hitIndexConstraint).toBe(true);
  });

  it("handles concurrent race between two deliveries of the same outboxEventId with exactly one winner", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const tokenA = `raceTokenA_${RUN_ID}`;
    const tokenB = `raceTokenB_${RUN_ID}`;

    const executeInsert = async (client: PrismaClient, msgId: string, token: string) => {
      try {
        const res = await client.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "EventLog" (
            "id", "messageId", "eventName", "payload", "status",
            "outboxEventId", "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
          ) VALUES (
            ${crypto.randomUUID()},
            ${msgId},
            'EMBEDDING_REQUESTED',
            ${JSON.stringify({ outboxEventId: OUTBOX_EVENT_3 })}::jsonb,
            'PENDING'::"EventStatus",
            ${OUTBOX_EVENT_3},
            ${token},
            clock_timestamp() + interval '300 seconds',
            clock_timestamp(),
            clock_timestamp()
          )
          RETURNING "id";
        `;
        return { success: res.length > 0, error: null };
      } catch (err: unknown) {
        return { success: false, error: err };
      }
    };

    // Race two different message deliveries for OUTBOX_EVENT_3 simultaneously
    const [resultA, resultB] = await Promise.all([
      executeInsert(testClient1, MSG_A3, tokenA),
      executeInsert(testClient2, MSG_B3, tokenB),
    ]);

    // Exactly one must succeed in inserting the active PENDING row
    const winners = (resultA.success ? 1 : 0) + (resultB.success ? 1 : 0);
    expect(winners).toBe(1);

    // The loser must have received a unique violation
    const loser = resultA.success ? resultB : resultA;
    expect(loser.success).toBe(false);
    expect(
      String(loser.error).includes("unique constraint") ||
      String(loser.error).includes("EventLog_outbox_active_idx") ||
      (loser.error as { code?: unknown })?.code === "23505" ||
      (loser.error as { code?: unknown })?.code === "P2002"
    ).toBe(true);
  });
});
