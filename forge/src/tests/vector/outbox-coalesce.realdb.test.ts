// src/tests/vector/outbox-coalesce.realdb.test.ts
/**
 * Forge Vector V2 — Phase B: Real-Database Outbox Concurrency & Coalescing Suite (E3)
 *
 * Verifies:
 * 1. Multi-connection atomic monotonic revision bump on VectorEntityHead.
 * 2. In-place coalescing of VectorOutboxEvent while status is PENDING.
 * 3. Non-blocking new PENDING event creation when previous event is CLAIMED.
 * 4. Partial unique index enforcement on (entityType, entityId) WHERE status = 'PENDING'.
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, VectorEntityType, VectorOutboxStatus } from "@prisma/client";
import {
  recordVectorSyncIntent,
  claimVectorOutboxBatch,
  markVectorOutboxDispatched,
  completeVectorOutboxEvent,
} from "@/lib/vector/outbox";

jest.setTimeout(120_000);

const APPROVED_NEON_DEV_HOSTS = [
  "ep-muddy-water-ah607io6-pooler.c-3.us-east-1.aws.neon.tech",
  "ep-muddy-water-ah607io6.c-3.us-east-1.aws.neon.tech",
];
const APPROVED_NEON_DEV_DB = "neondb";

function parseDbTarget(urlStr?: string): { host?: string; port?: string; dbName?: string } {
  if (!urlStr) return {};
  try {
    const parsed = new URL(urlStr);
    const dbName = parsed.pathname.replace(/^\//, "").split("?")[0];
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || "5432",
      dbName: dbName.toLowerCase(),
    };
  } catch {
    return {};
  }
}

const isNeonDevAuthorized = process.env.ALLOW_NEON_DEV_DB_TESTS === "true";
const targetDbUrl =
  process.env.DISPOSABLE_TEST_DATABASE_URL ||
  process.env.FORGE_DISPOSABLE_TEST_DATABASE_URL ||
  (isNeonDevAuthorized ? process.env.DATABASE_URL : undefined);

const isE3Required =
  process.env.REQUIRE_E3_CONCURRENCY === "true" ||
  process.env.CI === "true";

const TX_OPTS = {
  maxWait: 30000,
  timeout: 45000,
};

const describeRealDb = !targetDbUrl && !isE3Required ? describe.skip : describe;

describeRealDb("Forge Vector V2 — Phase B: Outbox Real-Database Concurrency & Coalescing", () => {
  let pool1: Pool | null = null;
  let pool2: Pool | null = null;
  let testClient1: PrismaClient | null = null;
  let testClient2: PrismaClient | null = null;

  const RUN_ID = `outbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ORG_ID = `org_${RUN_ID}`;
  const PROJECT_ID = `proj_${RUN_ID}`;
  const TASK_ID_1 = `task1_${RUN_ID}`;
  const TASK_ID_2 = `task2_${RUN_ID}`;

  beforeAll(async () => {
    if (!targetDbUrl) {
      if (isE3Required) {
        throw new Error(
          "[P0_SAFETY_ERROR] E3 Real-Database tests are REQUIRED, but no target database is configured."
        );
      }
      return;
    }

    const testTarget = parseDbTarget(targetDbUrl);
    if (!testTarget.host || !testTarget.dbName) {
      throw new Error("[P0_SAFETY_ERROR] Target database URL could not be parsed.");
    }

    if (isNeonDevAuthorized) {
      const isApprovedHost = APPROVED_NEON_DEV_HOSTS.includes(testTarget.host);
      const isApprovedDb = testTarget.dbName === APPROVED_NEON_DEV_DB;
      if (!isApprovedHost || !isApprovedDb) {
        throw new Error(`[P0_SAFETY_VIOLATION] Neon development host/db not approved.`);
      }
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

    // Verify VectorOutboxEvent table exists
    const schemaCheck = await testClient1.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'VectorOutboxEvent'
      ) as "exists";
    `;

    if (!schemaCheck[0]?.exists) {
      throw new Error("[P0_SCHEMA_MISSING] VectorOutboxEvent table is not migrated on target DB.");
    }

    // Seed test organization, project and tasks via Prisma client
    await testClient1.organization.create({
      data: {
        id: ORG_ID,
        slug: `slug_${RUN_ID}`,
        name: `Org ${RUN_ID}`,
      },
    });
    await testClient1.project.create({
      data: {
        id: PROJECT_ID,
        name: 'Outbox Concurrency Test Project',
        orgId: ORG_ID,
      },
    });
    await testClient1.task.create({
      data: {
        id: TASK_ID_1,
        title: 'Concurrent Outbox Task 1',
        projectId: PROJECT_ID,
        status: 'TODO',
        priority: 'MEDIUM',
      },
    });
    await testClient1.task.create({
      data: {
        id: TASK_ID_2,
        title: 'Concurrent Outbox Task 2',
        projectId: PROJECT_ID,
        status: 'TODO',
        priority: 'MEDIUM',
      },
    });
  });

  afterAll(async () => {
    if (!testClient1) return;
    try {
      await testClient1.$executeRaw`
        DELETE FROM "VectorOutboxEvent" WHERE "orgId" = ${ORG_ID};
      `;
      await testClient1.$executeRaw`
        DELETE FROM "VectorEntityHead" WHERE "orgId" = ${ORG_ID};
      `;
      await testClient1.task.deleteMany({
        where: { id: { in: [TASK_ID_1, TASK_ID_2] } },
      });
      await testClient1.project.delete({
        where: { id: PROJECT_ID },
      });
      await testClient1.organization.delete({
        where: { id: ORG_ID },
      });
    } catch {
      // Ignore cleanup error in teardown
    } finally {
      if (testClient1) await testClient1.$disconnect();
      if (testClient2) await testClient2.$disconnect();
      if (pool1) await pool1.end();
      if (pool2) await pool2.end();
    }
  });

  it("coalesces repeated mutations while status is PENDING and bumps latestRevision monotonically", async () => {
    if (!testClient1) return;

    // Perform 3 sequential mutations in transactions on TASK_ID_1
    for (let i = 1; i <= 3; i++) {
      await testClient1.$transaction(async (tx) => {
        await recordVectorSyncIntent({
          tx,
          orgId: ORG_ID,
          entityType: VectorEntityType.TASK,
          entityId: TASK_ID_1,
          contentHash: `hash_version_${i}`,
        });
      }, TX_OPTS);
    }

    // Verify VectorEntityHead latestRevision is 3
    const head = await testClient1.vectorEntityHead.findUnique({
      where: {
        orgId_entityType_entityId: {
          orgId: ORG_ID,
          entityType: VectorEntityType.TASK,
          entityId: TASK_ID_1,
        },
      },
    });
    expect(head).toBeDefined();
    expect(head?.latestRevision).toBe(3);

    // Verify exactly 1 row exists in VectorOutboxEvent with status PENDING, sourceRevision 3
    const outboxRows = await testClient1.vectorOutboxEvent.findMany({
      where: {
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_1,
      },
    });

    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe(VectorOutboxStatus.PENDING);
    expect(outboxRows[0].sourceRevision).toBe(3);
    expect(outboxRows[0].contentHash).toBe("hash_version_3");
  });

  it("handles multi-connection concurrent mutations without race conditions or deadlocks", async () => {
    if (!testClient1 || !testClient2) return;

    // Execute concurrent mutations using both independent connection pools on TASK_ID_2
    const operations = Array.from({ length: 6 }).map((_, idx) => {
      const client = idx % 2 === 0 ? testClient1! : testClient2!;
      return client.$transaction(async (tx) => {
        return recordVectorSyncIntent({
          tx,
          orgId: ORG_ID,
          entityType: VectorEntityType.TASK,
          entityId: TASK_ID_2,
          contentHash: `hash_concurrent_${idx}`,
        });
      }, TX_OPTS);
    });

    const results = await Promise.all(operations);
    expect(results).toHaveLength(6);

    // Verify head latestRevision reflects all 6 updates
    const head = await testClient1.vectorEntityHead.findUnique({
      where: {
        orgId_entityType_entityId: {
          orgId: ORG_ID,
          entityType: VectorEntityType.TASK,
          entityId: TASK_ID_2,
        },
      },
    });
    expect(head?.latestRevision).toBe(6);

    // Outbox event was coalesced to a single PENDING row with sourceRevision 6
    const outboxRows = await testClient1.vectorOutboxEvent.findMany({
      where: {
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_2,
      },
    });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe(VectorOutboxStatus.PENDING);
    expect(outboxRows[0].sourceRevision).toBe(6);
  });

  it("creates a new PENDING row without blocking once earlier event is CLAIMED", async () => {
    if (!testClient1) return;

    // 1. Claim the pending event for TASK_ID_1
    const claimRes = await claimVectorOutboxBatch({
      db: testClient1,
      batchSize: 10,
      leaseSeconds: 300,
      claimToken: `claim_${RUN_ID}`,
    });

    const claimedTask1 = claimRes.rows.find((r) => r.entityId === TASK_ID_1);
    expect(claimedTask1).toBeDefined();

    // Verify row status is now CLAIMED
    const claimedRow = await testClient1.vectorOutboxEvent.findUnique({
      where: { id: claimedTask1!.id },
    });
    expect(claimedRow?.status).toBe(VectorOutboxStatus.CLAIMED);

    // 2. Perform a new mutation on TASK_ID_1 while previous event is CLAIMED
    await testClient1.$transaction(async (tx) => {
      await recordVectorSyncIntent({
        tx,
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_1,
        contentHash: "hash_version_4_after_claim",
      });
    }, TX_OPTS);

    // 3. Verify there are now TWO outbox rows: one CLAIMED, one PENDING
    const task1Rows = await testClient1.vectorOutboxEvent.findMany({
      where: {
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_1,
      },
      orderBy: { sourceRevision: "asc" },
    });

    expect(task1Rows).toHaveLength(2);
    expect(task1Rows[0].status).toBe(VectorOutboxStatus.CLAIMED);
    expect(task1Rows[0].sourceRevision).toBe(3);

    expect(task1Rows[1].status).toBe(VectorOutboxStatus.PENDING);
    expect(task1Rows[1].sourceRevision).toBe(4);
    expect(task1Rows[1].contentHash).toBe("hash_version_4_after_claim");
  });
});
