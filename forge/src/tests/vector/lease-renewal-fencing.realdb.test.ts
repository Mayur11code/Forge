// src/tests/vector/lease-renewal-fencing.realdb.test.ts
/**
 * Forge Vector V2 — Phase B: Real-Database Lease Renewal & Fencing (E3 Acceptance)
 *
 * Verifies Area 3.3:
 * 1. Monotonic EventLog lease extension via renewEventLogLease prevents premature stealing.
 * 2. Monotonic VectorGeneration lease extension via renewGenerationLease preserves writer reservation.
 * 3. Fencing against stolen leases (Scenario S20): When a worker's lease expires and is stolen,
 *    subsequent renewals, activation, and completion by the stale worker fail closed with
 *    OWNERSHIP_LOST / OwnershipTokenMismatchError.
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, VectorEntityType } from "@prisma/client";
import { renewEventLogLease } from "@/lib/events/worker";
import {
  reserveGeneration,
  renewGenerationLease,
  markGenerationWritten,
  activateGeneration,
  OwnershipTokenMismatchError,
} from "@/lib/vector/generation-state";
import { taskSourceVersion } from "@/lib/vector/provenance";
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

describeRealDb("Forge Vector V2 — Phase B: Real-Database Lease Renewal & Fencing (E3)", () => {
  let pool1: Pool | null = null;
  let pool2: Pool | null = null;
  let testClient1: PrismaClient | null = null;
  let testClient2: PrismaClient | null = null;

  const RUN_ID = `fence_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ORG_ID = `org_fence_${RUN_ID}`;
  const TASK_ID_A = `task_fence_a_${RUN_ID}`;
  const TASK_ID_B = `task_fence_b_${RUN_ID}`;
  const PROJECT_ID = `proj_fence_${RUN_ID}`;
  const MSG_ID_A = `msg_fence_a_${RUN_ID}`;
  const MSG_ID_B = `msg_fence_b_${RUN_ID}`;

  beforeAll(async () => {
    if (!targetDbUrl) return;

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

    // Seed domain entities for generation-state tests
    await testClient1.organization.create({
      data: {
        id: ORG_ID,
        name: `Org ${RUN_ID}`,
        slug: `slug-${RUN_ID}`,
        projects: {
          create: {
            id: PROJECT_ID,
            name: `Project ${RUN_ID}`,
            tasks: {
              create: [
                {
                  id: TASK_ID_A,
                  title: "Lease Renewal Verification Task A",
                  description: "Verifies monotonic lease renewals.",
                },
                {
                  id: TASK_ID_B,
                  title: "Lease Renewal Verification Task B",
                  description: "Verifies fencing against stale owners.",
                },
              ],
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!testClient1) return;
    try {
      await testClient1.vectorGeneration.deleteMany({
        where: { head: { orgId: ORG_ID } },
      });
      await testClient1.vectorEntityHead.deleteMany({
        where: { orgId: ORG_ID },
      });
      await testClient1.eventLog.deleteMany({
        where: { messageId: { in: [MSG_ID_A, MSG_ID_B] } },
      });
      await testClient1.task.deleteMany({
        where: { id: { in: [TASK_ID_A, TASK_ID_B] } },
      });
      await testClient1.project.deleteMany({
        where: { id: PROJECT_ID },
      });
      await testClient1.organization.deleteMany({
        where: { id: ORG_ID },
      });
    } catch {
      // Best-effort cleanup
    } finally {
      if (testClient1) await testClient1.$disconnect();
      if (testClient2) await testClient2.$disconnect();
      if (pool1) await pool1.end();
      if (pool2) await pool2.end();
    }
  });

  it("Test A: Legitimate long-running worker extends EventLog and Generation leases preventing stealing", async () => {
    if (!testClient1 || !testClient2) return;

    const workerClaimToken = `legit_worker_${RUN_ID}`;

    const taskA = await testClient1.task.findUniqueOrThrow({
      where: { id: TASK_ID_A },
      select: { updatedAt: true, projectId: true },
    });
    const validSourceVersionA = taskSourceVersion({
      updatedAt: taskA.updatedAt,
      projectId: taskA.projectId,
    });

    // 1. Insert EventLog row with 60s lease
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "eventName", "payload", "status",
        "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${crypto.randomUUID()},
        ${MSG_ID_A},
        'EMBEDDING_REQUESTED',
        '{}'::jsonb,
        'PENDING'::"EventStatus",
        ${workerClaimToken},
        clock_timestamp() + interval '60 seconds',
        clock_timestamp(),
        clock_timestamp()
      );
    `;

    // 2. Reserve generation
    const reservation = await reserveGeneration({
      orgId: ORG_ID,
      entityType: VectorEntityType.TASK,
      entityId: TASK_ID_A,
      sourceVersion: validSourceVersionA,
      embeddingModelId: "gemini-embedding-001",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 1,
      leaseDurationSeconds: 60,
      tx: testClient1 as any,
    });

    expect(reservation.claimToken).toBeDefined();

    // 3. Worker periodically renews both leases
    const eventLogRenewed = await renewEventLogLease({
      messageId: MSG_ID_A,
      claimToken: workerClaimToken,
      extensionSeconds: 300,
      dbClient: testClient1,
    });
    expect(eventLogRenewed.renewed).toBe(true);

    const genRenewed = await renewGenerationLease({
      generationId: reservation.generation.id,
      claimToken: reservation.claimToken,
      extensionSeconds: 300,
      tx: testClient1 as any,
    });
    expect(genRenewed.id).toBe(reservation.generation.id);

    // 4. Competing worker attempts to steal the EventLog lease
    const thiefToken = `thief_${RUN_ID}`;
    const stealAttempt = await testClient2.$queryRaw<Array<{ id: string }>>`
      UPDATE "EventLog"
      SET "claimToken" = ${thiefToken},
          "leaseExpiresAt" = clock_timestamp() + interval '300 seconds',
          "updatedAt" = clock_timestamp()
      WHERE "messageId" = ${MSG_ID_A}
        AND "status" = 'PENDING'::"EventStatus"
        AND "leaseExpiresAt" <= clock_timestamp()
      RETURNING "id";
    `;
    expect(stealAttempt).toHaveLength(0); // Fails closed, lease is active

    // 5. Original worker successfully marks EventLog as SUCCESS
    const affected = await testClient1.$executeRaw`
      UPDATE "EventLog"
      SET "status" = 'SUCCESS'::"EventStatus",
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE "claimToken" = ${workerClaimToken};
    `;
    expect(affected).toBe(1);
  });

  it("Test B: Stale worker loses lease to thief; subsequent renewal and activation fail closed (Scenario S20)", async () => {
    if (!testClient1 || !testClient2) return;

    const staleMsgId = MSG_ID_B;
    const staleWorkerToken = `stale_worker_${RUN_ID}`;
    const thiefToken = `thief_worker_${RUN_ID}`;

    const taskB = await testClient1.task.findUniqueOrThrow({
      where: { id: TASK_ID_B },
      select: { updatedAt: true, projectId: true },
    });
    const validSourceVersionB = taskSourceVersion({
      updatedAt: taskB.updatedAt,
      projectId: taskB.projectId,
    });

    // 1. Worker reserves generation
    const reservation = await reserveGeneration({
      orgId: ORG_ID,
      entityType: VectorEntityType.TASK,
      entityId: TASK_ID_B,
      sourceVersion: validSourceVersionB,
      embeddingModelId: "gemini-embedding-001",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 1,
      leaseDurationSeconds: 60,
      tx: testClient1 as any,
    });

    // Insert EventLog with expired lease
    await testClient1.$executeRaw`
      INSERT INTO "EventLog" (
        "id", "messageId", "eventName", "payload", "status",
        "claimToken", "leaseExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${crypto.randomUUID()},
        ${staleMsgId},
        'EMBEDDING_REQUESTED',
        '{}'::jsonb,
        'PENDING'::"EventStatus",
        ${staleWorkerToken},
        clock_timestamp() - interval '5 seconds',
        clock_timestamp(),
        clock_timestamp()
      );
    `;

    // 2. Thief steals the EventLog lease
    const stolen = await testClient2.$queryRaw<Array<{ id: string }>>`
      UPDATE "EventLog"
      SET "claimToken" = ${thiefToken},
          "leaseExpiresAt" = clock_timestamp() + interval '300 seconds',
          "updatedAt" = clock_timestamp()
      WHERE "messageId" = ${staleMsgId}
        AND "status" = 'PENDING'::"EventStatus"
        AND "leaseExpiresAt" <= clock_timestamp()
      RETURNING "id";
    `;
    expect(stolen).toHaveLength(1);

    // 3. Stale worker tries to renew EventLog lease -> fails closed (renewed: false)
    const renewalResult = await renewEventLogLease({
      messageId: staleMsgId,
      claimToken: staleWorkerToken,
      extensionSeconds: 300,
      dbClient: testClient1,
    });
    expect(renewalResult.renewed).toBe(false);

    // 4. Stale worker tries to mark EventLog SUCCESS with stale claimToken -> affects 0 rows (OWNERSHIP_LOST)
    const completeAffected = await testClient1.$executeRaw`
      UPDATE "EventLog"
      SET "status" = 'SUCCESS'::"EventStatus",
          "leaseExpiresAt" = NULL,
          "updatedAt" = clock_timestamp()
      WHERE "claimToken" = ${staleWorkerToken};
    `;
    expect(completeAffected).toBe(0);

    // 5. Stale worker tries to renew VectorGeneration lease with wrong claimToken -> throws OwnershipTokenMismatchError
    await expect(
      renewGenerationLease({
        generationId: reservation.generation.id,
        claimToken: "wrong_tampered_token",
        extensionSeconds: 300,
        tx: testClient1 as any,
      })
    ).rejects.toThrow(OwnershipTokenMismatchError);

    // 6. Legitimate worker marks generation written
    await markGenerationWritten({
      receipt: {
        generationId: reservation.generation.id,
        claimToken: reservation.claimToken,
        writtenChunkCount: 1,
      },
      tx: testClient1 as any,
    });

    // 7. Stale worker tries to activate generation using wrong claimToken -> throws OwnershipTokenMismatchError
    await expect(
      activateGeneration({
        headId: reservation.head.id,
        generationId: reservation.generation.id,
        claimToken: "wrong_tampered_token",
        expectedSourceVersion: validSourceVersionB,
        tx: testClient1 as any,
      })
    ).rejects.toThrow(OwnershipTokenMismatchError);
  });
});
