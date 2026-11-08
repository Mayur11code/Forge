// forge/src/tests/vector/part3-dispatch-integration.realdb.test.ts
/**
 * Forge Vector V2 — Phase B Remediation: Part 3.1
 * Production Dispatcher Integration Suite (E3 Acceptance)
 *
 * Verifies Objective A by invoking the actual production `dispatchVectorOutboxBatch` function
 * against the real PostgreSQL database, mocking ONLY the external QStash boundary (`publishEvent`).
 *
 * 1. QStash publish failure invokes the real handleVectorOutboxPublishFailure path and persists exactly one retry.
 * 2. Successful publication followed by a mark-dispatched failure does not corrupt a completed event.
 * 3. An uncertain publish acknowledgement preserves the stable outboxEventId and does not create a second logical event.
 * 4. Failure in retry persistence is surfaced rather than silently counted as a successfully recovered event.
 */

jest.mock("server-only", () => ({}));

// Mock ONLY the external QStash broker boundary
jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn(),
  getTopic: jest.fn().mockReturnValue("events"),
}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, VectorEntityType, VectorOutboxStatus } from "@prisma/client";
import {
  dispatchVectorOutboxBatch,
  completeVectorOutboxEvent,
} from "@/lib/vector/outbox";
import * as outboxModule from "@/lib/vector/outbox";
import { publishEvent } from "@/lib/events/queue";
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

describeRealDb("Part 3.1 — Production Dispatcher Integration Verification (E3 Real-DB)", () => {
  let pool: Pool | null = null;
  let testClient: PrismaClient | null = null;

  const RUN_ID = `p31_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const ORG_ID = `org_${RUN_ID}`;
  const createdOutboxIds: string[] = [];

  beforeAll(async () => {
    if (!targetDbUrl) {
      if (isE3Required) {
        throw new Error(
          "[P0_SAFETY_ERROR] E3 Real-Database tests are REQUIRED in this environment (REQUIRE_E3_CONCURRENCY=true or CI=true), but no target database URL is configured."
        );
      }
      return;
    }

    pool = new Pool({
      connectionString: targetDbUrl,
      max: 10,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
    testClient = new PrismaClient({ adapter: new PrismaPg(pool) });
  });

  afterAll(async () => {
    if (testClient) {
      try {
        if (createdOutboxIds.length > 0) {
          await testClient.$executeRaw`
            DELETE FROM "VectorOutboxEvent"
            WHERE id = ANY(${createdOutboxIds});
          `;
        }
      } catch (err) {
        console.error("Cleanup error in dispatch integration test:", err);
      } finally {
        await testClient.$disconnect();
        if (pool) await pool.end();
      }
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. QStash publish failure invokes real failure path & persists exactly 1 retry
  // ---------------------------------------------------------------------------
  it("1. QStash publish failure invokes real handleVectorOutboxPublishFailure and persists exactly one retry", async () => {
    if (!testClient) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `outbox_fail_1_${RUN_ID}`;
    createdOutboxIds.push(outboxId);

    // Insert an eligible PENDING outbox row
    await testClient.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_fail_1', 1, 'hash_f1', 'v2',
        'PENDING'::"VectorOutboxStatus", 0, clock_timestamp(), clock_timestamp()
      );
    `;

    // Configure external QStash mock to reject with a transient error
    (publishEvent as jest.Mock).mockRejectedValueOnce(new Error("QStash HTTP 503 Service Unavailable"));

    // Invoke actual production dispatcher
    const sweeperName = `sweeper_test_1_${RUN_ID}`;
    const result = await dispatchVectorOutboxBatch(10, sweeperName);

    // Verify dispatcher counters
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);

    // Verify actual database row state
    const [row] = await testClient.$queryRaw<Array<{
      status: string;
      dispatchAttempts: number;
      dispatchClaimToken: string | null;
      dispatchLeaseExpiresAt: Date | null;
      nextRetryAt: Date | null;
      terminalError: string | null;
    }>>`
      SELECT "status", "dispatchAttempts", "dispatchClaimToken", "dispatchLeaseExpiresAt", "nextRetryAt", "terminalError"
      FROM "VectorOutboxEvent"
      WHERE id = ${outboxId};
    `;

    expect(row.status).toBe("PENDING");
    // Exactly 1 retry persisted
    expect(row.dispatchAttempts).toBe(1);
    expect(row.dispatchClaimToken).toBeNull();
    expect(row.dispatchLeaseExpiresAt).toBeNull();
    expect(row.terminalError).toContain("QStash HTTP 503 Service Unavailable");
    expect(row.nextRetryAt).not.toBeNull();
    // Next retry scheduled in future on DB clock
    const retryDelayMs = new Date(row.nextRetryAt!).getTime() - Date.now();
    expect(retryDelayMs).toBeGreaterThan(0);
    expect(retryDelayMs).toBeLessThanOrEqual(6_000); // 5s backoff (+ clock skew tolerance)
  });

  // ---------------------------------------------------------------------------
  // 2. Successful publication followed by mark-dispatched race does not corrupt COMPLETED
  // ---------------------------------------------------------------------------
  it("2. Successful publication followed by a mark-dispatched failure does not corrupt a completed event", async () => {
    if (!testClient) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `outbox_race_2_${RUN_ID}`;
    createdOutboxIds.push(outboxId);

    await testClient.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_race_2', 1, 'hash_r2', 'v2',
        'PENDING'::"VectorOutboxStatus", 0, clock_timestamp(), clock_timestamp()
      );
    `;

    // Fast worker completes the outbox event during publishing
    (publishEvent as jest.Mock).mockImplementationOnce(async () => {
      // Worker completes the row before markVectorOutboxDispatched runs
      await completeVectorOutboxEvent({
        db: testClient!,
        outboxEventId: outboxId,
      });
      return { messageId: "msg_fast_worker_completed" };
    });

    const sweeperName = `sweeper_test_2_${RUN_ID}`;
    const result = await dispatchVectorOutboxBatch(10, sweeperName);

    // Dispatcher recognizes COMPLETED by fast worker as successful dispatch
    expect(result.dispatched).toBeGreaterThanOrEqual(1);

    // Verify row in database is still COMPLETED and uncorrupted
    const [row] = await testClient.$queryRaw<Array<{
      status: string;
      dispatchClaimToken: string | null;
      dispatchLeaseExpiresAt: Date | null;
      dispatchAttempts: number;
    }>>`
      SELECT "status", "dispatchClaimToken", "dispatchLeaseExpiresAt", "dispatchAttempts"
      FROM "VectorOutboxEvent"
      WHERE id = ${outboxId};
    `;

    expect(row.status).toBe("COMPLETED");
    expect(row.dispatchClaimToken).toBeNull();
    expect(row.dispatchLeaseExpiresAt).toBeNull();
    // Dispatch attempts was not incremented
    expect(row.dispatchAttempts).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Uncertain publish acknowledgement preserves stable outboxEventId (no duplicate event)
  // ---------------------------------------------------------------------------
  it("3. An uncertain publish acknowledgement preserves the stable outboxEventId and does not create a second logical event", async () => {
    if (!testClient) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    const stableOutboxId = `outbox_stable_3_${RUN_ID}`;
    const entityId = `task_stable_3_${RUN_ID}`;
    createdOutboxIds.push(stableOutboxId);

    await testClient.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${stableOutboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", ${entityId}, 1, 'hash_s3', 'v2',
        'PENDING'::"VectorOutboxStatus", 0, clock_timestamp(), clock_timestamp()
      );
    `;

    // Uncertain publish acknowledgement (network reset after send)
    (publishEvent as jest.Mock).mockRejectedValueOnce(new Error("ECONNRESET: QStash acknowledgement lost"));

    const sweeperName1 = `sweeper_test_3_a_${RUN_ID}`;
    const res1 = await dispatchVectorOutboxBatch(10, sweeperName1);
    expect(res1.failed).toBeGreaterThanOrEqual(1);

    // Verify exactly ONE outbox event exists for this entity (stable ID preserved)
    const rows = await testClient.$queryRaw<Array<{ id: string; status: string; dispatchAttempts: number }>>`
      SELECT "id", "status", "dispatchAttempts"
      FROM "VectorOutboxEvent"
      WHERE "entityType" = 'TASK'::"VectorEntityType" AND "entityId" = ${entityId};
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(stableOutboxId);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].dispatchAttempts).toBe(1);

    // Reset nextRetryAt to clock_timestamp() - 1s so it is eligible immediately for second attempt
    await testClient.$executeRaw`
      UPDATE "VectorOutboxEvent"
      SET "nextRetryAt" = clock_timestamp() - interval '1 second'
      WHERE id = ${stableOutboxId};
    `;

    // Second publish succeeds
    (publishEvent as jest.Mock).mockResolvedValueOnce({ messageId: "msg_success_ack" });

    const sweeperName2 = `sweeper_test_3_b_${RUN_ID}`;
    const res2 = await dispatchVectorOutboxBatch(10, sweeperName2);
    expect(res2.dispatched).toBeGreaterThanOrEqual(1);

    // Verify QStash was called with the exact same stable outboxEventId and deduplicationId
    expect(publishEvent).toHaveBeenCalledWith(
      "EMBEDDING_REQUESTED",
      expect.objectContaining({
        outboxEventId: stableOutboxId,
        entityId,
      }),
      undefined,
      expect.objectContaining({
        messageId: stableOutboxId,
        deduplicationId: `dedup_${stableOutboxId}_1`,
      })
    );

    // Verify still exactly ONE row exists and is DISPATCHED
    const finalRows = await testClient.$queryRaw<Array<{ id: string; status: string; dispatchAttempts: number }>>`
      SELECT "id", "status", "dispatchAttempts"
      FROM "VectorOutboxEvent"
      WHERE "entityType" = 'TASK'::"VectorEntityType" AND "entityId" = ${entityId};
    `;
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].id).toBe(stableOutboxId);
    expect(finalRows[0].status).toBe("DISPATCHED");
  });

  // ---------------------------------------------------------------------------
  // 4. Failure in retry persistence is surfaced rather than silently counted as recovered
  // ---------------------------------------------------------------------------
  it("4. Failure in retry persistence is surfaced rather than silently counted as a successfully recovered event", async () => {
    if (!testClient) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    const outboxId = `outbox_err_4_${RUN_ID}`;
    createdOutboxIds.push(outboxId);

    await testClient.$executeRaw`
      INSERT INTO "VectorOutboxEvent" (
        "id", "orgId", "entityType", "entityId", "sourceRevision", "contentHash", "pipelineVersion",
        "status", "dispatchAttempts", "createdAt", "updatedAt"
      ) VALUES (
        ${outboxId}, ${ORG_ID}, 'TASK'::"VectorEntityType", 'task_err_4', 1, 'hash_e4', 'v2',
        'PENDING'::"VectorOutboxStatus", 0, clock_timestamp(), clock_timestamp()
      );
    `;

    // 1. Publish fails
    (publishEvent as jest.Mock).mockRejectedValueOnce(new Error("Initial broker publish failure"));

    // 2. Retry persistence fails in the database during failure recovery
    const { db } = await import("@/lib/prisma/db");
    const originalQueryRaw = db.$queryRaw.bind(db);
    let queryCount = 0;

    const dbSpy = jest.spyOn(db, "$queryRaw").mockImplementation(((...args: unknown[]) => {
      queryCount++;
      // Call 1 is claimVectorOutboxBatch (succeeds)
      // Call 2 is in handleVectorOutboxPublishFailure (simulated DB error during retry persistence)
      if (queryCount === 2) {
        throw new Error("CRITICAL_DATABASE_DEADLOCK_DURING_RETRY");
      }
      return (originalQueryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof db.$queryRaw);

    try {
      // Must NOT swallow or silently count as successfully recovered: error MUST surface
      await expect(
        dispatchVectorOutboxBatch(10, `sweeper_err_4_${RUN_ID}`)
      ).rejects.toThrow("CRITICAL_DATABASE_DEADLOCK_DURING_RETRY");
    } finally {
      dbSpy.mockRestore();
    }
  });
});
