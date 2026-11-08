// forge/src/tests/vector/part3-outbox-concurrency.realdb.test.ts
/**
 * Forge Vector V2 — Phase B Remediation: Part 3
 * Outbox State Machine & Forward Migration Real PostgreSQL Concurrency Tests (E3 Acceptance)
 *
 * Demonstrates all 6 mandatory concurrency requirements from Section 7.2 using
 * two independent database connection pools:
 *
 * 1. Two dispatchers contending for the same eligible event with SKIP LOCKED.
 * 2. A claim stolen after lease expiration on database clock.
 * 3. Stale dispatcher attempting retry update after claim theft fails closed.
 * 4. Publish failure racing with downstream successful completion (COMPLETED preserved).
 * 5. Concurrent retry handlers attempting to update the same event (exactly one succeeds).
 * 6. Database-level PENDING/SUCCESS partial unique index enforcement rejecting duplicates.
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, VectorEntityType } from "@prisma/client";
import {
  claimVectorOutboxBatch,
  completeVectorOutboxEvent,
  handleVectorOutboxPublishFailure,
} from "@/lib/vector/outbox";
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

describeRealDb("Forge Vector V2 — Phase B: Real PostgreSQL Concurrency & Forward Migration Index (E3)", () => {
  let pool1: Pool | null = null;
  let pool2: Pool | null = null;
  let testClient1: PrismaClient | null = null;
  let testClient2: PrismaClient | null = null;

  const RUN_ID = `p3_e3_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const ORG_ID = `org_${RUN_ID}`;
  const createdOutboxIds: string[] = [];
  const createdEventLogIds: string[] = [];

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
    if (testClient1) {
      try {
        if (createdOutboxIds.length > 0) {
          await testClient1.$executeRaw`
            DELETE FROM "VectorOutboxEvent"
            WHERE id = ANY(${createdOutboxIds});
          `;
        }
        if (createdEventLogIds.length > 0) {
          await testClient1.$executeRaw`
            DELETE FROM "EventLog"
            WHERE id = ANY(${createdEventLogIds});
          `;
        }
      } catch (err) {
        // Cleanup error logged, best effort
        console.error("Cleanup warning in part3 realdb test:", err);
      } finally {
        if (testClient1) await testClient1.$disconnect();
        if (testClient2) await testClient2.$disconnect();
        if (pool1) await pool1.end();
        if (pool2) await pool2.end();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Case 1: Two dispatchers attempting to claim the same eligible event
  // ---------------------------------------------------------------------------
  it("1. Two dispatchers contending for the same eligible event with SKIP LOCKED yields exactly one winner", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `evt_case1_${RUN_ID}`;
    createdOutboxIds.push(outboxId);

    // Insert eligible PENDING event
    await testClient1.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion", "status", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_case1', 1, 'hash_case1', 'v2', 'PENDING'::"VectorOutboxStatus", 0, clock_timestamp(), clock_timestamp()
      );
    `;

    const tokenA = `disp_A_${RUN_ID}`;
    const tokenB = `disp_B_${RUN_ID}`;

    // Concurrent claim attempts from two separate connections
    const [claimA, claimB] = await Promise.all([
      claimVectorOutboxBatch({
        db: testClient1,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: tokenA,
      }),
      claimVectorOutboxBatch({
        db: testClient2,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: tokenB,
      }),
    ]);

    const aHasRow = claimA.rows.some((r) => r.id === outboxId);
    const bHasRow = claimB.rows.some((r) => r.id === outboxId);

    // Exactly one dispatcher wins the claim
    expect(aHasRow !== bHasRow).toBe(true);
    const winningToken = aHasRow ? tokenA : tokenB;

    // Verify in database that winningToken owns the row
    const [row] = await testClient1.$queryRaw<Array<{ status: string; dispatchClaimToken: string }>>`
      SELECT "status", "dispatchClaimToken"
      FROM "VectorOutboxEvent"
      WHERE id = ${outboxId};
    `;
    expect(row.status).toBe("CLAIMED");
    expect(row.dispatchClaimToken).toBe(winningToken);
  });

  // ---------------------------------------------------------------------------
  // Case 2: A claim stolen after lease expiration
  // ---------------------------------------------------------------------------
  it("2. A claim stolen after lease expiration on database clock transitions to new owner", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `evt_case2_${RUN_ID}`;
    createdOutboxIds.push(outboxId);
    const staleToken = `disp_stale_${RUN_ID}`;
    const stealingToken = `disp_stealer_${RUN_ID}`;

    // Insert CLAIMED event with expired lease on database clock
    await testClient1.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchClaimToken", "dispatchLeaseExpiresAt", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_case2', 1, 'hash_case2', 'v2',
        'CLAIMED'::"VectorOutboxStatus", ${staleToken}, clock_timestamp() - interval '5 seconds', 0, clock_timestamp(), clock_timestamp()
      );
    `;

    // Dispatcher 2 reclaims the expired row
    const claimRes = await claimVectorOutboxBatch({
      db: testClient2,
      batchSize: 10,
      leaseSeconds: 60,
      claimToken: stealingToken,
    });

    const hasStolenRow = claimRes.rows.some((r) => r.id === outboxId);
    expect(hasStolenRow).toBe(true);

    const [row] = await testClient1.$queryRaw<Array<{ status: string; dispatchClaimToken: string }>>`
      SELECT "status", "dispatchClaimToken"
      FROM "VectorOutboxEvent"
      WHERE id = ${outboxId};
    `;
    expect(row.status).toBe("CLAIMED");
    expect(row.dispatchClaimToken).toBe(stealingToken);
  });

  // ---------------------------------------------------------------------------
  // Case 3: Stale dispatcher attempting retry update after claim theft
  // ---------------------------------------------------------------------------
  it("3. Stale dispatcher attempting retry update after claim theft fails closed with CLAIM_LOST", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `evt_case3_${RUN_ID}`;
    createdOutboxIds.push(outboxId);
    const staleToken = `disp_stale_3_${RUN_ID}`;
    const newOwnerToken = `disp_newowner_3_${RUN_ID}`;

    // Row is currently owned by newOwnerToken with an active lease
    await testClient1.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchClaimToken", "dispatchLeaseExpiresAt", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_case3', 1, 'hash_case3', 'v2',
        'CLAIMED'::"VectorOutboxStatus", ${newOwnerToken}, clock_timestamp() + interval '60 seconds', 1, clock_timestamp(), clock_timestamp()
      );
    `;

    // Stale dispatcher attempts to report a failure and reschedule retry
    const res = await handleVectorOutboxPublishFailure({
      db: testClient1,
      outboxEventId: outboxId,
      dispatchClaimToken: staleToken,
      error: new Error("Stale publish failure"),
      maxAttempts: 5,
    });

    // Fails closed
    expect(res.status).toBe("CLAIM_LOST");

    // In DB: new owner's claim and attempts are completely untouched
    const [row] = await testClient2.$queryRaw<Array<{ status: string; dispatchClaimToken: string; dispatchAttempts: number }>>`
      SELECT "status", "dispatchClaimToken", "dispatchAttempts"
      FROM "VectorOutboxEvent"
      WHERE id = ${outboxId};
    `;
    expect(row.status).toBe("CLAIMED");
    expect(row.dispatchClaimToken).toBe(newOwnerToken);
    expect(row.dispatchAttempts).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Case 4: Publish failure racing with downstream worker completion
  // ---------------------------------------------------------------------------
  it("4. Publish failure racing with downstream worker completion preserves COMPLETED state", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `evt_case4_${RUN_ID}`;
    createdOutboxIds.push(outboxId);
    const token = `disp_case4_${RUN_ID}`;

    await testClient1.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchClaimToken", "dispatchLeaseExpiresAt", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_case4', 1, 'hash_case4', 'v2',
        'CLAIMED'::"VectorOutboxStatus", ${token}, clock_timestamp() + interval '60 seconds', 0, clock_timestamp(), clock_timestamp()
      );
    `;

    // Worker completes the row first via Connection 2
    const completed = await completeVectorOutboxEvent({
      db: testClient2,
      outboxEventId: outboxId,
    });
    expect(completed).toBe(true);

    // Delayed failure callback executes on Connection 1
    const failRes = await handleVectorOutboxPublishFailure({
      db: testClient1,
      outboxEventId: outboxId,
      dispatchClaimToken: token,
      error: new Error("Network timeout after worker executed"),
      maxAttempts: 5,
    });

    expect(failRes.status).toBe("ALREADY_COMPLETED");

    // Verify row status remains COMPLETED
    const [row] = await testClient1.$queryRaw<Array<{ status: string; dispatchClaimToken: string | null }>>`
      SELECT "status", "dispatchClaimToken"
      FROM "VectorOutboxEvent"
      WHERE id = ${outboxId};
    `;
    expect(row.status).toBe("COMPLETED");
    expect(row.dispatchClaimToken).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Case 5: Concurrent retry handlers attempting to update the same event
  // ---------------------------------------------------------------------------
  it("5. Concurrent retry handlers attempting to update the same event executes exactly once", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `evt_case5_${RUN_ID}`;
    createdOutboxIds.push(outboxId);
    const token = `disp_case5_${RUN_ID}`;

    await testClient1.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchClaimToken", "dispatchLeaseExpiresAt", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_case5', 1, 'hash_case5', 'v2',
        'CLAIMED'::"VectorOutboxStatus", ${token}, clock_timestamp() + interval '60 seconds', 1, clock_timestamp(), clock_timestamp()
      );
    `;

    // Fire two failure callbacks concurrently with the same token
    const [resA, resB] = await Promise.all([
      handleVectorOutboxPublishFailure({
        db: testClient1,
        outboxEventId: outboxId,
        dispatchClaimToken: token,
        error: new Error("Publish callback A"),
        maxAttempts: 5,
      }),
      handleVectorOutboxPublishFailure({
        db: testClient2,
        outboxEventId: outboxId,
        dispatchClaimToken: token,
        error: new Error("Publish callback B"),
        maxAttempts: 5,
      }),
    ]);

    const results = [resA.status, resB.status];
    expect(results).toContain("RETRY_SCHEDULED");
    expect(results).toContain("CLAIM_LOST");

    // Attempts must have incremented by exactly 1 (from 1 to 2, not 3)
    const [row] = await testClient1.$queryRaw<Array<{ status: string; dispatchAttempts: number; dispatchClaimToken: string | null }>>`
      SELECT "status", "dispatchAttempts", "dispatchClaimToken"
      FROM "VectorOutboxEvent"
      WHERE id = ${outboxId};
    `;
    expect(row.status).toBe("PENDING");
    expect(row.dispatchAttempts).toBe(2);
    expect(row.dispatchClaimToken).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Case 6: Database-level PENDING/SUCCESS partial unique index enforcement
  // ---------------------------------------------------------------------------
  it("6. Database-level partial unique index EventLog_outbox_active_idx enforces uniqueness across PENDING and SUCCESS", async () => {
    if (!testClient1 || !testClient2) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test clients were not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `outbox_idx_test_${RUN_ID}`;
    const logId1 = `log_1_${RUN_ID}`;
    const logId2 = `log_2_${RUN_ID}`;
    const logId3 = `log_3_${RUN_ID}`;
    const logId4 = `log_4_${RUN_ID}`;
    createdEventLogIds.push(logId1, logId2, logId3, logId4);

    // 1. First insert with status = PENDING succeeds
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "outboxEventId", "eventName", "status", "createdAt", "updatedAt"
      ) VALUES (
        ${logId1}, ${'msg_1_' + RUN_ID}, ${outboxId}, 'TASK_CREATED', 'PENDING'::"EventStatus", clock_timestamp(), clock_timestamp()
      );
    `;

    // 2. Second insert with status = PENDING for the same outboxEventId MUST BE REJECTED by DB
    let duplicatePendingFailed = false;
    try {
      await testClient2.$executeRaw`
        INSERT INTO "EventLog" (
          "id", "messageId", "outboxEventId", "eventName", "status", "createdAt", "updatedAt"
        ) VALUES (
          ${logId2}, ${'msg_2_' + RUN_ID}, ${outboxId}, 'TASK_CREATED', 'PENDING'::"EventStatus", clock_timestamp(), clock_timestamp()
        );
      `;
    } catch (err: unknown) {
      duplicatePendingFailed = true;
      expect((err as Error).message).toMatch(/EventLog_outbox_active_idx|unique constraint|23505/i);
    }
    expect(duplicatePendingFailed).toBe(true);

    // 3. Update the first EventLog from PENDING to SUCCESS
    await testClient1.$executeRaw`
      UPDATE "EventLog"
      SET "status" = 'SUCCESS'::"EventStatus",
          "updatedAt" = clock_timestamp()
      WHERE id = ${logId1};
    `;

    // 4. Third insert with status = PENDING while first is SUCCESS MUST STILL BE REJECTED by DB
    let duplicateAfterSuccessFailed = false;
    try {
      await testClient2.$executeRaw`
        INSERT INTO "EventLog" (
          "id", "messageId", "outboxEventId", "eventName", "status", "createdAt", "updatedAt"
        ) VALUES (
          ${logId3}, ${'msg_3_' + RUN_ID}, ${outboxId}, 'TASK_CREATED', 'PENDING'::"EventStatus", clock_timestamp(), clock_timestamp()
        );
      `;
    } catch (err: unknown) {
      duplicateAfterSuccessFailed = true;
      expect((err as Error).message).toMatch(/EventLog_outbox_active_idx|unique constraint|23505/i);
    }
    expect(duplicateAfterSuccessFailed).toBe(true);

    // 5. Fourth insert with status = FAILED is ALLOWED (not included in the partial unique index)
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "outboxEventId", "eventName", "status", "createdAt", "updatedAt"
      ) VALUES (
        ${logId4}, ${'msg_4_' + RUN_ID}, ${outboxId}, 'TASK_CREATED', 'FAILED'::"EventStatus", clock_timestamp(), clock_timestamp()
      );
    `;

    const [failedRow] = await testClient1.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "EventLog" WHERE id = ${logId4};
    `;
    expect(failedRow.status).toBe("FAILED");
  });
});
