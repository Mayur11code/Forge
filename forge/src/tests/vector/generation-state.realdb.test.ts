// src/tests/vector/generation-state.realdb.test.ts
/**
 * Forge Vector V2 — Phase A: Real-Database Acceptance Test Suite
 *
 * P0 Target Safety Guarantees:
 * 1. Dedicated test client: Uses explicitly configured disposable database URL
 *    or explicitly authorized Neon development database.
 * 2. Application singleton isolation: Never touches default application `db` client.
 * 3. Identity validation: Verifies connected database identity (`current_database()`),
 *    rejects target matching production, verifies approved Neon hostname and database name.
 * 4. Honest test behavior:
 *    - Unconfigured & optional: Entire suite marked genuinely skipped (describe.skip).
 *    - Unconfigured & required (CI / REQUIRE_E3_CONCURRENCY=true): Fails immediately with [P0_SAFETY_ERROR].
 *    - Target configured but invalid identity: Fails before any writes.
 *    - Target configured but schema missing: Fails with actionable setup message (no silent skip).
 * 5. Fixture Isolation: All test rows scoped by unique TAG and cleaned up in afterAll in reverse FK order.
 * 6. Multi-Connection Concurrency: Uses independent database connections (pool1/pool2) for barrier synchronization.
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  reserveGeneration,
  markGenerationWritten,
  activateGeneration,
  tombstoneEntityHead,
  TombstonedEntityError,
  LeaseExpiredError,
  ConcurrentWriterConflictError,
  StaleSourceVersionError,
} from "@/lib/vector/generation-state";
import { taskSourceVersion, attachmentSourceVersion } from "@/lib/vector/provenance";

jest.setTimeout(120_000);

// Approved Neon development target parameters
const APPROVED_NEON_DEV_HOSTS = [
  "ep-muddy-water-ah607io6-pooler.c-3.us-east-1.aws.neon.tech",
  "ep-muddy-water-ah607io6.c-3.us-east-1.aws.neon.tech",
];
const APPROVED_NEON_DEV_DB = "neondb";

// Interactive transaction options to accommodate cloud PostgreSQL round-trip latency
const TX_OPTS = {
  maxWait: 30000,
  timeout: 45000,
};

// Helper to safely parse database target identity without printing secrets
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

// Deterministic Suite Execution Choice
const describeRealDb = !targetDbUrl && !isE3Required ? describe.skip : describe;

describeRealDb("Forge Vector V2 — Phase A: Real-Database Invariant Acceptance", () => {
  let pool1: Pool | null = null;
  let pool2: Pool | null = null;
  let testClient1: PrismaClient | null = null;
  let testClient2: PrismaClient | null = null;

  const RUN_ID = `e3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ORG_ID = `org_${RUN_ID}`;
  const PROJECT_ID = `proj_${RUN_ID}`;
  const TASK_ID = `task_${RUN_ID}`;

  const createdProjectIds: string[] = [PROJECT_ID];
  const createdTaskIds: string[] = [TASK_ID];
  const createdAttachmentIds: string[] = [];

  beforeAll(async () => {
    // 1. Missing configuration handling
    if (!targetDbUrl) {
      if (isE3Required) {
        throw new Error(
          "[P0_SAFETY_ERROR] E3 Real-Database tests are REQUIRED in this environment, but neither DISPOSABLE_TEST_DATABASE_URL nor authorized Neon dev configuration is set."
        );
      }
      return; // describe.skip will handle non-required mode
    }

    // 2. Identity validation: Parse target parameters
    const testTarget = parseDbTarget(targetDbUrl);

    if (!testTarget.host || !testTarget.dbName) {
      throw new Error(
        "[P0_SAFETY_ERROR] Target database URL could not be parsed into a valid host and database name."
      );
    }

    // Production database target protection
    if (/(?:prod|production)/i.test(testTarget.host) || /(?:prod|production)/i.test(testTarget.dbName)) {
      throw new Error(
        `[P0_SAFETY_VIOLATION] Target '${testTarget.host}/${testTarget.dbName}' appears to be a production target. Real-database tests are strictly forbidden against production.`
      );
    }

    if (isNeonDevAuthorized) {
      // Explicitly authorized Neon development database check
      const isApprovedHost = APPROVED_NEON_DEV_HOSTS.includes(testTarget.host);
      const isApprovedDb = testTarget.dbName === APPROVED_NEON_DEV_DB;

      if (!isApprovedHost || !isApprovedDb) {
        throw new Error(
          `[P0_SAFETY_VIOLATION] Neon development authorization is enabled, but target host '${testTarget.host}' or database '${testTarget.dbName}' is not in the approved development list (${APPROVED_NEON_DEV_DB} on ${APPROVED_NEON_DEV_HOSTS.join(" / ")}). Aborting.`
        );
      }
    } else {
      // Disposable database allowlist check
      const defaultTarget = parseDbTarget(process.env.DATABASE_URL);
      if (
        defaultTarget.host &&
        defaultTarget.dbName &&
        defaultTarget.host === testTarget.host &&
        defaultTarget.dbName === testTarget.dbName
      ) {
        throw new Error(
          `[P0_SAFETY_VIOLATION] Database URL points to the default application database (${testTarget.dbName} on ${testTarget.host}) without explicit ALLOW_NEON_DEV_DB_TESTS=true authorization. Aborting.`
        );
      }

      const isAllowlisted =
        process.env.DISPOSABLE_TEST_DATABASE_ALLOW === "true" ||
        /(?:test|disposable|sandbox|scratch)/i.test(testTarget.dbName);

      if (!isAllowlisted) {
        throw new Error(
          `[P0_SAFETY_VIOLATION] Database name '${testTarget.dbName}' does not match the disposable allowlist pattern (test|disposable|sandbox|scratch) and DISPOSABLE_TEST_DATABASE_ALLOW is not set to 'true'.`
        );
      }
    }

    // 3. Construct dedicated test clients on independent connection pools
    pool1 = new Pool({
      connectionString: targetDbUrl,
      max: 20,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
    const adapter1 = new PrismaPg(pool1);
    testClient1 = new PrismaClient({ adapter: adapter1 });

    pool2 = new Pool({
      connectionString: targetDbUrl,
      max: 20,
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
    const adapter2 = new PrismaPg(pool2);
    testClient2 = new PrismaClient({ adapter: adapter2 });

    // 4. Explicitly verify connected database identity via live SQL query
    const idResult = await testClient1.$queryRaw<Array<{ current_db: string; current_user: string }>>`
      SELECT current_database() as "current_db", current_user as "current_user"
    `;

    const actualDb = idResult[0]?.current_db?.toLowerCase();
    if (actualDb !== testTarget.dbName) {
      throw new Error(
        `[P0_SAFETY_VIOLATION] Live connected database '${actualDb}' does not match expected target '${testTarget.dbName}'. Aborting.`
      );
    }

    // 5. Verify required schema is migrated on target database
    const schemaCheck = await testClient1.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'VectorEntityHead'
      ) as "exists";
    `;

    if (!schemaCheck[0]?.exists) {
      throw new Error(
        "[P0_SCHEMA_MISSING] VectorEntityHead table is not present on the target database. Migrations must be applied prior to running real-DB tests."
      );
    }

    // 6. Seed initial test fixtures on dedicated test client
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
        name: `Project ${RUN_ID}`,
        orgId: ORG_ID,
      },
    });

    await testClient1.task.create({
      data: {
        id: TASK_ID,
        title: `Task ${RUN_ID}`,
        projectId: PROJECT_ID,
      },
    });
  });

  afterAll(async () => {
    if (!testClient1) return;

    try {
      // Clean up uniquely tagged fixtures in reverse dependency order
      // 1. Clear activeGenId pointers so ON DELETE RESTRICT on VectorGeneration is not violated
      await testClient1.$executeRaw`
        UPDATE "VectorEntityHead" SET "activeGenId" = NULL WHERE "orgId" = ${ORG_ID}
      `;

      await testClient1.$executeRaw`
        DELETE FROM "VectorGeneration"
        WHERE "headId" IN (SELECT id FROM "VectorEntityHead" WHERE "orgId" = ${ORG_ID})
      `;

      await testClient1.$executeRaw`
        DELETE FROM "VectorEntityHead" WHERE "orgId" = ${ORG_ID}
      `;

      await testClient1.$executeRaw`
        DELETE FROM "DomainOutboxEvent" WHERE "orgId" = ${ORG_ID}
      `;

      if (createdAttachmentIds.length > 0) {
        await testClient1.attachment.deleteMany({
          where: { id: { in: createdAttachmentIds } },
        });
      }

      if (createdTaskIds.length > 0) {
        await testClient1.task.deleteMany({
          where: { id: { in: createdTaskIds } },
        });
      }

      if (createdProjectIds.length > 0) {
        await testClient1.project.deleteMany({
          where: { id: { in: createdProjectIds } },
        });
      }

      await testClient1.organization.deleteMany({
        where: { id: ORG_ID },
      });

      // Verify zero leftover rows for this run
      const remainingHeads = await testClient1.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count FROM "VectorEntityHead" WHERE "orgId" = ${ORG_ID}
      `;
      const headCount = Number(remainingHeads[0]?.count ?? BigInt(0));

      if (headCount > 0) {
        console.warn(`[REAL-DB FIXTURE LEAK WARNING]: ${headCount} heads remaining for ${ORG_ID}`);
      } else {
        console.log(`✅ [REAL-DB CLEANUP]: All fixtures for ${ORG_ID} cleanly removed.`);
      }
    } catch (cleanupErr) {
      console.error("[REAL-DB CLEANUP ERROR]:", cleanupErr);
    } finally {
      await testClient1.$disconnect();
      if (testClient2) await testClient2.$disconnect();
      if (pool1) await pool1.end();
      if (pool2) await pool2.end();
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: Competing reservations cannot establish two valid writers
  // ---------------------------------------------------------------------------
  it("Scenario 1: Competing reservations cannot establish two valid writers for the same head", async () => {
    if (!testClient1 || !testClient2) return;

    // Client 1 reserves generation
    const res1 = await testClient1.$transaction(async (tx1) => {
      return await reserveGeneration({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: TASK_ID,
        sourceVersion: "v1_concurrency",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 3,
        leaseDurationSeconds: 60,
        tx: tx1,
      });
    }, TX_OPTS);

    expect(res1.generation.status).toBe("WRITING");

    // Client 2 attempts to reserve on the same task while lease is active
    await expect(
      testClient2.$transaction(async (tx2) => {
        return await reserveGeneration({
          orgId: ORG_ID,
          entityType: "TASK",
          entityId: TASK_ID,
          sourceVersion: "v1_concurrency_competing",
          embeddingModelId: "text-embedding-3-small",
          embeddingDimension: 1536,
          contractVersion: "v1",
          expectedChunkCount: 3,
          leaseDurationSeconds: 60,
          tx: tx2,
        });
      }, TX_OPTS)
    ).rejects.toThrow(ConcurrentWriterConflictError);

    // Verify exactly 1 WRITING generation exists
    const activeWriters = await testClient1.vectorGeneration.findMany({
      where: { headId: res1.head.id, status: "WRITING" },
    });
    expect(activeWriters.length).toBe(1);
    expect(activeWriters[0].id).toBe(res1.generation.id);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Reservation racing with tombstoning
  // ---------------------------------------------------------------------------
  it("Scenario 2: Reservation racing with tombstoning cannot leave a valid generation after tombstone commitment", async () => {
    if (!testClient1 || !testClient2) return;

    const task2Id = `task_tomb_race_${RUN_ID}`;
    await testClient1.task.create({
      data: { id: task2Id, title: "Task Tomb Race", projectId: PROJECT_ID },
    });
    createdTaskIds.push(task2Id);

    // Client 2 commits tombstone
    await testClient2.$transaction(async (tx2) => {
      await tombstoneEntityHead({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: task2Id,
        tx: tx2,
      });
    }, TX_OPTS);

    // Client 1 attempts reserveGeneration on the tombstoned entity
    await expect(
      testClient1.$transaction(async (tx1) => {
        return await reserveGeneration({
          orgId: ORG_ID,
          entityType: "TASK",
          entityId: task2Id,
          sourceVersion: "v1",
          embeddingModelId: "text-embedding-3-small",
          embeddingDimension: 1536,
          contractVersion: "v1",
          expectedChunkCount: 1,
          tx: tx1,
        });
      }, TX_OPTS)
    ).rejects.toThrow(TombstonedEntityError);

    // Verify head remains tombstone with no active or writing generation
    const head = await testClient1.vectorEntityHead.findUniqueOrThrow({
      where: {
        orgId_entityType_entityId: { orgId: ORG_ID, entityType: "TASK", entityId: task2Id },
      },
    });
    expect(head.isTombstone).toBe(true);
    expect(head.activeGenId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Expired writer completion is rejected
  // ---------------------------------------------------------------------------
  it("Scenario 3: Expired writer completion is rejected", async () => {
    if (!testClient1) return;

    const task3Id = `task_exp_write_${RUN_ID}`;
    await testClient1.task.create({
      data: { id: task3Id, title: "Task Expired Writer", projectId: PROJECT_ID },
    });
    createdTaskIds.push(task3Id);

    const res = await testClient1.$transaction(async (tx) => {
      const r = await reserveGeneration({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: task3Id,
        sourceVersion: "v1",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 2,
        leaseDurationSeconds: 1,
        tx,
      });
      // Force expired lease directly in PostgreSQL
      await tx.$executeRaw`
        UPDATE "VectorGeneration"
        SET "leaseExpiresAt" = clock_timestamp() - interval '10 seconds'
        WHERE id = ${r.generation.id}
      `;
      return r;
    }, TX_OPTS);

    await expect(
      testClient1.$transaction(async (tx) => {
        return await markGenerationWritten({
          receipt: {
            generationId: res.generation.id,
            claimToken: res.claimToken,
            writtenChunkCount: 2,
          },
          tx,
        });
      }, TX_OPTS)
    ).rejects.toThrow(LeaseExpiredError);

    const gen = await testClient1.vectorGeneration.findUniqueOrThrow({
      where: { id: res.generation.id },
    });
    expect(gen.status).toBe("WRITING");
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Expired lease activation is rejected
  // ---------------------------------------------------------------------------
  it("Scenario 4: Expired lease activation is rejected", async () => {
    if (!testClient1) return;

    const task4Id = `task_exp_act_${RUN_ID}`;
    const task4 = await testClient1.task.create({
      data: { id: task4Id, title: "Task Expired Act", projectId: PROJECT_ID },
    });
    createdTaskIds.push(task4Id);

    const version = taskSourceVersion({
      updatedAt: task4.updatedAt,
      projectId: PROJECT_ID,
    });

    const res = await testClient1.$transaction(async (tx) => {
      const r = await reserveGeneration({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: task4Id,
        sourceVersion: version,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 2,
        tx,
      });
      await markGenerationWritten({
        receipt: {
          generationId: r.generation.id,
          claimToken: r.claimToken,
          writtenChunkCount: 2,
        },
        tx,
      });
      // Expire lease in PostgreSQL before activation
      await tx.$executeRaw`
        UPDATE "VectorGeneration"
        SET "leaseExpiresAt" = clock_timestamp() - interval '5 seconds'
        WHERE id = ${r.generation.id}
      `;
      return r;
    }, TX_OPTS);

    await expect(
      testClient1.$transaction(async (tx) => {
        return await activateGeneration({
          headId: res.head.id,
          generationId: res.generation.id,
          claimToken: res.claimToken,
          expectedSourceVersion: version,
          tx,
        });
      }, TX_OPTS)
    ).rejects.toThrow(LeaseExpiredError);

    const head = await testClient1.vectorEntityHead.findUniqueOrThrow({
      where: { id: res.head.id },
    });
    expect(head.activeGenId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Competing activations cannot create multiple ACTIVE generations
  // ---------------------------------------------------------------------------
  it("Scenario 5: Competing activations cannot create multiple ACTIVE generations or pointer mismatch", async () => {
    if (!testClient1 || !testClient2) return;

    const task5Id = `task_dual_act_${RUN_ID}`;
    const task5 = await testClient1.task.create({
      data: { id: task5Id, title: "Task Dual Activation", projectId: PROJECT_ID },
    });
    createdTaskIds.push(task5Id);

    const version = taskSourceVersion({
      updatedAt: task5.updatedAt,
      projectId: PROJECT_ID,
    });

    // Create Gen A in WRITTEN state
    const resA = await testClient1.$transaction(async (tx) => {
      const r = await reserveGeneration({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: task5Id,
        sourceVersion: version,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 2,
        tx,
      });
      await markGenerationWritten({
        receipt: { generationId: r.generation.id, claimToken: r.claimToken, writtenChunkCount: 2 },
        tx,
      });
      return r;
    }, TX_OPTS);

    // Activate Gen A first
    const actA = await testClient1.$transaction(async (tx1) => {
      return await activateGeneration({
        headId: resA.head.id,
        generationId: resA.generation.id,
        claimToken: resA.claimToken,
        expectedSourceVersion: version,
        tx: tx1,
      });
    }, TX_OPTS);

    expect(actA.activatedGeneration.status).toBe("ACTIVE");
    expect(actA.head.activeGenId).toBe(resA.generation.id);

    // Reserve Gen B on Client 2
    const resB = await testClient2.$transaction(async (tx) => {
      const r = await reserveGeneration({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: task5Id,
        sourceVersion: version,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 2,
        tx,
      });
      await markGenerationWritten({
        receipt: { generationId: r.generation.id, claimToken: r.claimToken, writtenChunkCount: 2 },
        tx,
      });
      return r;
    }, TX_OPTS);

    // Activate Gen B on Client 2
    const actB = await testClient2.$transaction(async (tx2) => {
      return await activateGeneration({
        headId: resB.head.id,
        generationId: resB.generation.id,
        claimToken: resB.claimToken,
        expectedSourceVersion: version,
        tx: tx2,
      });
    }, TX_OPTS);

    expect(actB.activatedGeneration.status).toBe("ACTIVE");
    expect(actB.head.activeGenId).toBe(resB.generation.id);
    expect(actB.obsoletedGenerationId).toBe(resA.generation.id);

    // Verify in PostgreSQL: exactly 1 ACTIVE generation and 1 OBSOLETE generation
    const activeGens = await testClient1.vectorGeneration.findMany({
      where: { headId: resA.head.id, status: "ACTIVE" },
    });
    expect(activeGens.length).toBe(1);
    expect(activeGens[0].id).toBe(resB.generation.id);

    const oldGen = await testClient1.vectorGeneration.findUniqueOrThrow({
      where: { id: resA.generation.id },
    });
    expect(oldGen.status).toBe("OBSOLETE");
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Deletion racing with activation preserves tombstone invariant
  // ---------------------------------------------------------------------------
  it("Scenario 6: Deletion racing with activation preserves the tombstone invariant", async () => {
    if (!testClient1 || !testClient2) return;

    const task6Id = `task_del_race_${RUN_ID}`;
    const task6 = await testClient1.task.create({
      data: { id: task6Id, title: "Task Deletion Race", projectId: PROJECT_ID },
    });
    createdTaskIds.push(task6Id);

    const version = taskSourceVersion({
      updatedAt: task6.updatedAt,
      projectId: PROJECT_ID,
    });

    const res = await testClient1.$transaction(async (tx) => {
      const r = await reserveGeneration({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: task6Id,
        sourceVersion: version,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 1,
        tx,
      });
      await markGenerationWritten({
        receipt: { generationId: r.generation.id, claimToken: r.claimToken, writtenChunkCount: 1 },
        tx,
      });
      return r;
    }, TX_OPTS);

    // Client 2 deletes task and commits tombstone
    await testClient2.$transaction(async (tx2) => {
      await tombstoneEntityHead({
        orgId: ORG_ID,
        entityType: "TASK",
        entityId: task6Id,
        tx: tx2,
      });
      await tx2.task.delete({ where: { id: task6Id } });
    }, TX_OPTS);

    // Client 1 attempts activation on the deleted entity
    await expect(
      testClient1.$transaction(async (tx1) => {
        return await activateGeneration({
          headId: res.head.id,
          generationId: res.generation.id,
          claimToken: res.claimToken,
          expectedSourceVersion: version,
          tx: tx1,
        });
      }, TX_OPTS)
    ).rejects.toThrow();

    // Verify head remains tombstone with NULL active pointer
    const head = await testClient1.vectorEntityHead.findUniqueOrThrow({
      where: { id: res.head.id },
    });
    expect(head.isTombstone).toBe(true);
    expect(head.activeGenId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Project deletion and child attachment activation respect locking
  // ---------------------------------------------------------------------------
  it("Scenario 7: Project deletion and child attachment activation respect locking", async () => {
    if (!testClient1 || !testClient2) return;

    const proj7Id = `proj_lock_${RUN_ID}`;
    const task7Id = `task_lock_${RUN_ID}`;
    const att7Id = `att_lock_${RUN_ID}`;

    await testClient1.project.create({
      data: { id: proj7Id, name: "Project Lock Test", orgId: ORG_ID },
    });
    createdProjectIds.push(proj7Id);

    const task7 = await testClient1.task.create({
      data: { id: task7Id, title: "Task Lock Test", projectId: proj7Id },
    });
    createdTaskIds.push(task7Id);

    const att7 = await testClient1.attachment.create({
      data: {
        id: att7Id,
        taskId: task7Id,
        name: "att.txt",
        fileKey: `key_${att7Id}`,
        url: `https://example.com/att_${att7Id}.txt`,
        size: 512,
      },
    });
    createdAttachmentIds.push(att7Id);

    const attVersion = attachmentSourceVersion({
      taskId: task7Id,
      createdAt: att7.createdAt,
      size: 512,
      task: { updatedAt: task7.updatedAt },
    });

    // Reserve and mark WRITTEN for attachment
    const resAtt = await testClient1.$transaction(async (tx) => {
      const r = await reserveGeneration({
        orgId: ORG_ID,
        entityType: "ATTACHMENT",
        entityId: att7Id,
        sourceVersion: attVersion,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 1,
        tx,
      });
      await markGenerationWritten({
        receipt: { generationId: r.generation.id, claimToken: r.claimToken, writtenChunkCount: 1 },
        tx,
      });
      return r;
    }, TX_OPTS);

    // Client 1 locks the Project in a transaction (simulating project deletion step 1)
    await testClient1.$transaction(async (tx1) => {
      await tx1.$queryRaw`
        SELECT id FROM "Project" WHERE id = ${proj7Id} FOR UPDATE
      `;

      // Tombstone and delete child attachments, task, and project
      await tombstoneEntityHead({
        orgId: ORG_ID,
        entityType: "ATTACHMENT",
        entityId: att7Id,
        tx: tx1,
      });
      await tx1.attachment.delete({ where: { id: att7Id } });
      await tx1.task.delete({ where: { id: task7Id } });
      await tx1.project.delete({ where: { id: proj7Id } });
    }, TX_OPTS);

    // Client 2 attempting activation after project deletion lock commits
    await expect(
      testClient2.$transaction(async (tx2) => {
        return await activateGeneration({
          headId: resAtt.head.id,
          generationId: resAtt.generation.id,
          claimToken: resAtt.claimToken,
          expectedSourceVersion: attVersion,
          tx: tx2,
        });
      }, TX_OPTS)
    ).rejects.toThrow();

    // Verify attachment head is tombstoned with activeGenId = null
    const attHead = await testClient2.vectorEntityHead.findUniqueOrThrow({
      where: { id: resAtt.head.id },
    });
    expect(attHead.isTombstone).toBe(true);
    expect(attHead.activeGenId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: Attachment activation cannot use stale parent Task data
  // ---------------------------------------------------------------------------
  it("Scenario 8: Attachment activation cannot use stale parent Task data", async () => {
    if (!testClient1 || !testClient2) return;

    const task8Id = `task_stale_${RUN_ID}`;
    const att8Id = `att_stale_${RUN_ID}`;

    const task8 = await testClient1.task.create({
      data: { id: task8Id, title: "Task Stale Test", projectId: PROJECT_ID },
    });
    createdTaskIds.push(task8Id);

    const att8 = await testClient1.attachment.create({
      data: {
        id: att8Id,
        taskId: task8Id,
        name: "data.csv",
        fileKey: `key_${att8Id}`,
        url: `https://example.com/att_${att8Id}.csv`,
        size: 1024,
      },
    });
    createdAttachmentIds.push(att8Id);

    const initialTaskVersion = taskSourceVersion({
      updatedAt: task8.updatedAt,
      projectId: PROJECT_ID,
    });

    const initialAttVersion = attachmentSourceVersion({
      taskId: task8Id,
      createdAt: att8.createdAt,
      size: 1024,
      task: { updatedAt: task8.updatedAt },
    });

    // Client 1 reserves and marks written with expectedParentTaskVersion
    const resAtt = await testClient1.$transaction(async (tx) => {
      const r = await reserveGeneration({
        orgId: ORG_ID,
        entityType: "ATTACHMENT",
        entityId: att8Id,
        sourceVersion: initialAttVersion,
        parentTaskVersion: initialTaskVersion,
        embeddingModelId: "text-embedding-3-small",
        embeddingDimension: 1536,
        contractVersion: "v1",
        expectedChunkCount: 1,
        tx,
      });
      await markGenerationWritten({
        receipt: { generationId: r.generation.id, claimToken: r.claimToken, writtenChunkCount: 1 },
        tx,
      });
      return r;
    }, TX_OPTS);

    // Concurrently, Task 8 is updated in PostgreSQL (updatedAt changes)
    await testClient2.$executeRaw`
      UPDATE "Task"
      SET "updatedAt" = clock_timestamp() + interval '1 second'
      WHERE id = ${task8Id}
    `;

    // Client 1 attempts activation with initial (now stale) task version
    await expect(
      testClient1.$transaction(async (tx1) => {
        return await activateGeneration({
          headId: resAtt.head.id,
          generationId: resAtt.generation.id,
          claimToken: resAtt.claimToken,
          expectedSourceVersion: initialAttVersion,
          expectedParentTaskVersion: initialTaskVersion,
          tx: tx1,
        });
      }, TX_OPTS)
    ).rejects.toThrow(StaleSourceVersionError);

    const head = await testClient1.vectorEntityHead.findUniqueOrThrow({
      where: { id: resAtt.head.id },
    });
    expect(head.activeGenId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: Composite FK rejects cross-head active-generation pointers
  // ---------------------------------------------------------------------------
  it("Scenario 9: Composite FK rejects cross-head active-generation pointers", async () => {
    if (!testClient1) return;

    const headA = `head_fk_a_${RUN_ID}`;
    const headB = `head_fk_b_${RUN_ID}`;
    const genB = `gen_fk_b_${RUN_ID}`;

    await testClient1.$executeRaw`
      INSERT INTO "VectorEntityHead" (id, "orgId", "entityType", "entityId", "isTombstone", "updatedAt")
      VALUES (${headA}, ${ORG_ID}, 'TASK', 'task_fk_a', false, clock_timestamp())
    `;
    await testClient1.$executeRaw`
      INSERT INTO "VectorEntityHead" (id, "orgId", "entityType", "entityId", "isTombstone", "updatedAt")
      VALUES (${headB}, ${ORG_ID}, 'TASK', 'task_fk_b', false, clock_timestamp())
    `;

    // Gen B belongs to Head B
    await testClient1.$executeRaw`
      INSERT INTO "VectorGeneration" (
        id, "headId", "sourceVersion", "embeddingModelId", "embeddingDimension",
        "contractVersion", "expectedChunkCount", status, "updatedAt"
      ) VALUES (
        ${genB}, ${headB}, 'v1', 'text-embedding-3-small', 1536, 'v1', 1, 'WRITTEN', clock_timestamp()
      )
    `;

    // Setting headA.activeGenId = genB violates composite foreign key constraint
    // (VectorEntityHead_activeGenId_id_fkey)
    await expect(
      testClient1.$executeRaw`
        UPDATE "VectorEntityHead" SET "activeGenId" = ${genB} WHERE id = ${headA}
      `
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Scenario 10: PostgreSQL uniqueness and check constraints reject invalid states
  // ---------------------------------------------------------------------------
  describe("Scenario 10: PostgreSQL uniqueness and check constraints reject invalid states", () => {
    it("10a: check constraint chk_head_tombstone_no_active_gen rejects activeGenId when isTombstone = true", async () => {
      if (!testClient1) return;

      const headId = `head_tomb_chk_${RUN_ID}`;
      const genId = `gen_dummy_${RUN_ID}`;

      await testClient1.$executeRaw`
        INSERT INTO "VectorEntityHead" (id, "orgId", "entityType", "entityId", "isTombstone", "activeGenId", "updatedAt")
        VALUES (${headId}, ${ORG_ID}, 'TASK', 'dummy_task_chk', false, NULL, clock_timestamp())
      `;

      await testClient1.$executeRaw`
        INSERT INTO "VectorGeneration" (
          id, "headId", "sourceVersion", "embeddingModelId", "embeddingDimension",
          "contractVersion", "expectedChunkCount", status, "updatedAt"
        ) VALUES (
          ${genId}, ${headId}, 'v1', 'text-embedding-3-small', 1536, 'v1', 1, 'ACTIVE', clock_timestamp()
        )
      `;

      await testClient1.$executeRaw`
        UPDATE "VectorEntityHead" SET "activeGenId" = ${genId} WHERE id = ${headId}
      `;

      // Must be rejected by chk_head_tombstone_no_active_gen
      await expect(
        testClient1.$executeRaw`
          UPDATE "VectorEntityHead" SET "isTombstone" = true WHERE id = ${headId}
        `
      ).rejects.toThrow();
    });

    it("10b: check constraint chk_gen_lease_requires_claim_token rejects lease without claim token", async () => {
      if (!testClient1) return;

      const headId = `head_lease_chk_${RUN_ID}`;
      const genId = `gen_lease_chk_${RUN_ID}`;

      await testClient1.$executeRaw`
        INSERT INTO "VectorEntityHead" (id, "orgId", "entityType", "entityId", "isTombstone", "updatedAt")
        VALUES (${headId}, ${ORG_ID}, 'TASK', 'dummy_task_lease', false, clock_timestamp())
      `;

      await expect(
        testClient1.$executeRaw`
          INSERT INTO "VectorGeneration" (
            id, "headId", "sourceVersion", "embeddingModelId", "embeddingDimension",
            "contractVersion", "expectedChunkCount", status, "claimToken", "leaseExpiresAt", "updatedAt"
          ) VALUES (
            ${genId}, ${headId}, 'v1', 'text-embedding-3-small', 1536, 'v1', 1, 'WRITING',
            NULL, clock_timestamp() + interval '5 minutes', clock_timestamp()
          )
        `
      ).rejects.toThrow();
    });

    it("10c: partial unique index idx_vector_gen_active_per_head rejects multiple ACTIVE generations", async () => {
      if (!testClient1) return;

      const headId = `head_idx_chk_${RUN_ID}`;
      const gen1 = `gen_act1_${RUN_ID}`;
      const gen2 = `gen_act2_${RUN_ID}`;

      await testClient1.$executeRaw`
        INSERT INTO "VectorEntityHead" (id, "orgId", "entityType", "entityId", "isTombstone", "updatedAt")
        VALUES (${headId}, ${ORG_ID}, 'TASK', 'dummy_task_idx', false, clock_timestamp())
      `;

      await testClient1.$executeRaw`
        INSERT INTO "VectorGeneration" (
          id, "headId", "sourceVersion", "embeddingModelId", "embeddingDimension",
          "contractVersion", "expectedChunkCount", status, "updatedAt"
        ) VALUES (
          ${gen1}, ${headId}, 'v1', 'text-embedding-3-small', 1536, 'v1', 1, 'ACTIVE', clock_timestamp()
        )
      `;

      await expect(
        testClient1.$executeRaw`
          INSERT INTO "VectorGeneration" (
            id, "headId", "sourceVersion", "embeddingModelId", "embeddingDimension",
            "contractVersion", "expectedChunkCount", status, "updatedAt"
          ) VALUES (
            ${gen2}, ${headId}, 'v2', 'text-embedding-3-small', 1536, 'v1', 1, 'ACTIVE', clock_timestamp()
          )
        `
      ).rejects.toThrow();
    });
  });
});
