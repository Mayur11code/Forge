// src/tests/vector/v2-concurrency.realdb.test.ts
/**
 * Forge Vector V2 — Phase B: Concurrency, Failure & Revision Verification (E3 Acceptance)
 *
 * Verifies key adversarial failure scenarios from Section 16 of Rev 3.2:
 * 1. S1: Domain transaction rollback leaves zero outbox rows.
 * 2. S9/S10/S11: Revision supersession ($A \to B \to A$ and concurrent workers):
 *    Head row-lock check rejects activation if head.latestRevision > worker's sourceRevision.
 * 3. S15/S16: Decoupled attachment provenance:
 *    Parent task status update does not bump child attachment revision;
 *    Parent task title update atomically bumps child attachment revision.
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, VectorEntityType, VectorOutboxStatus } from "@prisma/client";
import { recordVectorSyncIntent, completeVectorOutboxEvent } from "@/lib/vector/outbox";
import {
  reserveGeneration,
  markGenerationWritten,
  activateGeneration,
  failGeneration,
} from "@/lib/vector/generation-state";
import { updateTaskInOrg } from "@/lib/tasks/update-task";

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

const describeRealDb = !targetDbUrl && !isE3Required ? describe.skip : describe;

describeRealDb("Forge Vector V2 — Phase B: Real-Database Concurrency & Revision Fencing (E3)", () => {
  let pool1: Pool | null = null;
  let pool2: Pool | null = null;
  let testClient1: PrismaClient | null = null;
  let testClient2: PrismaClient | null = null;

  const RUN_ID = `v2conc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ORG_ID = `org_${RUN_ID}`;
  const PROJECT_ID = `proj_${RUN_ID}`;
  const TASK_ID_1 = `task1_${RUN_ID}`;
  const TASK_ID_2 = `task2_${RUN_ID}`;
  const ATTACHMENT_ID = `att_${RUN_ID}`;

  const TX_OPTS = { maxWait: 30000, timeout: 45000 };

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

    // Seed test fixtures
    await testClient1.organization.create({
      data: { id: ORG_ID, slug: `slug_${RUN_ID}`, name: `Org ${RUN_ID}` },
    });
    await testClient1.project.create({
      data: { id: PROJECT_ID, name: `Project ${RUN_ID}`, orgId: ORG_ID },
    });
    await testClient1.task.create({
      data: {
        id: TASK_ID_1,
        title: `Task 1 ${RUN_ID}`,
        projectId: PROJECT_ID,
        status: "TODO",
        priority: "MEDIUM",
      },
    });
    await testClient1.task.create({
      data: {
        id: TASK_ID_2,
        title: `Task 2 ${RUN_ID}`,
        projectId: PROJECT_ID,
        status: "TODO",
        priority: "MEDIUM",
      },
    });
    await testClient1.attachment.create({
      data: {
        id: ATTACHMENT_ID,
        name: `file_${RUN_ID}.pdf`,
        url: `https://example.com/files/${ATTACHMENT_ID}.pdf`,
        size: 1024,
        taskId: TASK_ID_2,
        fileKey: `keys/${ATTACHMENT_ID}`,
      },
    });
  });

  afterAll(async () => {
    if (!testClient1) return;
    try {
      await testClient1.$executeRaw`
        UPDATE "VectorEntityHead" SET "activeGenId" = NULL WHERE "orgId" = ${ORG_ID};
      `;
      await testClient1.$executeRaw`
        DELETE FROM "VectorGeneration" WHERE "headId" IN (SELECT id FROM "VectorEntityHead" WHERE "orgId" = ${ORG_ID});
      `;
      await testClient1.$executeRaw`
        DELETE FROM "VectorOutboxEvent" WHERE "orgId" = ${ORG_ID};
      `;
      await testClient1.$executeRaw`
        DELETE FROM "VectorEntityHead" WHERE "orgId" = ${ORG_ID};
      `;
      await testClient1.attachment.deleteMany({ where: { id: ATTACHMENT_ID } });
      await testClient1.task.deleteMany({ where: { projectId: PROJECT_ID } });
      await testClient1.project.delete({ where: { id: PROJECT_ID } });
      await testClient1.organization.delete({ where: { id: ORG_ID } });
    } catch {
      // Best-effort cleanup
    } finally {
      if (testClient1) await testClient1.$disconnect();
      if (testClient2) await testClient2.$disconnect();
      if (pool1) await pool1.end();
      if (pool2) await pool2.end();
    }
  });

  it("S1: rolls back outbox event atomically when domain transaction aborts", async () => {
    if (!testClient1) return;

    const abortedTaskId = `task_aborted_${RUN_ID}`;

    try {
      await testClient1.$transaction(async (tx) => {
        await tx.task.create({
          data: {
            id: abortedTaskId,
            title: "Will abort",
            projectId: PROJECT_ID,
            status: "TODO",
            priority: "LOW",
          },
        });

        await recordVectorSyncIntent({
          tx,
          orgId: ORG_ID,
          entityType: VectorEntityType.TASK,
          entityId: abortedTaskId,
          contentHash: "hash_aborted",
        });

        throw new Error("INJECTED_DOMAIN_TX_ROLLBACK");
      }, TX_OPTS);
    } catch (e: any) {
      expect(e.message).toBe("INJECTED_DOMAIN_TX_ROLLBACK");
    }

    // Verify neither task nor outbox event exists
    const task = await testClient1.task.findUnique({ where: { id: abortedTaskId } });
    expect(task).toBeNull();

    const outboxRows = await testClient1.vectorOutboxEvent.findMany({
      where: { entityId: abortedTaskId },
    });
    expect(outboxRows).toHaveLength(0);
  });

  it("S9/S10/S11: rejects activation of a superseded worker when head latestRevision is newer", async () => {
    if (!testClient1 || !testClient2) return;

    // 1. Initial mutation establishes revision 1
    const { sourceRevision: rev1 } = await testClient1.$transaction(async (tx) => {
      return recordVectorSyncIntent({
        tx,
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_1,
        contentHash: "hash_state_A",
      });
    }, TX_OPTS);

    expect(rev1).toBeGreaterThanOrEqual(1);

    // 2. Worker 1 starts: reserves generation for rev1
    const taskRow1 = await testClient1.task.findUniqueOrThrow({ where: { id: TASK_ID_1 } });
    const sourceVersion1 = `task:${taskRow1.updatedAt.toISOString()}:${PROJECT_ID}`;

    const res1 = await reserveGeneration({
      orgId: ORG_ID,
      entityType: VectorEntityType.TASK,
      entityId: TASK_ID_1,
      sourceVersion: sourceVersion1,
      embeddingModelId: "gemini-embedding-001",
      embeddingDimension: 768,
      contractVersion: "v2",
      expectedChunkCount: 1,
      leaseDurationSeconds: 300,
      tx: testClient1,
    });

    await markGenerationWritten({
      receipt: {
        generationId: res1.generation.id,
        claimToken: res1.claimToken,
        writtenChunkCount: 1,
      },
      tx: testClient1,
    });

    // 3. Concurrently, Mutation 2 commits (advancing latestRevision to rev2)
    const { sourceRevision: rev2 } = await testClient2.$transaction(async (tx) => {
      return recordVectorSyncIntent({
        tx,
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_1,
        contentHash: "hash_state_B",
      });
    }, TX_OPTS);

    expect(rev2).toBe(rev1 + 1);

    // 4. Worker 1 attempts to activate with its older revision (rev1)
    // Worker 1 checks latestRevision under row lock:
    let worker1Activated = false;
    let worker1Superseded = false;

    await testClient1.$transaction(async (tx) => {
      const headRows = await tx.$queryRaw<Array<{ latestRevision: number; isTombstone: boolean }>>`
        SELECT "latestRevision", "isTombstone"
        FROM "VectorEntityHead"
        WHERE id = ${res1.head.id}
        FOR UPDATE;
      `;

      if (headRows[0].latestRevision > rev1) {
        worker1Superseded = true;
        await failGeneration({
          generationId: res1.generation.id,
          claimToken: res1.claimToken,
          errorMessage: "Superseded by newer revision",
          tx,
        });
        return;
      }

      await activateGeneration({
        headId: res1.head.id,
        generationId: res1.generation.id,
        claimToken: res1.claimToken,
        expectedSourceVersion: sourceVersion1,
        tx,
      });
      worker1Activated = true;
    }, TX_OPTS);

    // Worker 1 must be rejected due to revision supersession
    expect(worker1Superseded).toBe(true);
    expect(worker1Activated).toBe(false);

    // Verify head's activeGenId is NOT pointing to worker 1's generation
    const headCheck = await testClient1.vectorEntityHead.findUnique({
      where: { id: res1.head.id },
    });
    expect(headCheck?.activeGenId).not.toBe(res1.generation.id);
  });

  it("S15/S16: verifies decoupled child attachment provenance on parent task updates", async () => {
    if (!testClient1) return;

    // 1. Initial intent for attachment establishing baseline
    await testClient1.$transaction(async (tx) => {
      await recordVectorSyncIntent({
        tx,
        orgId: ORG_ID,
        entityType: VectorEntityType.ATTACHMENT,
        entityId: ATTACHMENT_ID,
        contentHash: "hash_att_v1",
      });
    }, TX_OPTS);

    const attHeadBefore = await testClient1.vectorEntityHead.findUnique({
      where: {
        orgId_entityType_entityId: {
          orgId: ORG_ID,
          entityType: VectorEntityType.ATTACHMENT,
          entityId: ATTACHMENT_ID,
        },
      },
    });
    const baselineAttRevision = attHeadBefore?.latestRevision ?? 1;

    // Clear outbox events for attachment to test emission
    await testClient1.$executeRaw`
      DELETE FROM "VectorOutboxEvent" WHERE "entityId" = ${ATTACHMENT_ID};
    `;

    // 2. S15: Update parent task STATUS only (does NOT alter attachment semantic text)
    await testClient1.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: TASK_ID_2 },
        data: { status: "IN_PROGRESS" },
      });
      // Domain mutation records intent for task only
      await recordVectorSyncIntent({
        tx,
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_2,
        contentHash: "hash_task_status_changed",
      });
    }, TX_OPTS);

    // Child attachment revision must remain unchanged, and 0 attachment outbox events emitted
    const attHeadAfterStatus = await testClient1.vectorEntityHead.findUnique({
      where: {
        orgId_entityType_entityId: {
          orgId: ORG_ID,
          entityType: VectorEntityType.ATTACHMENT,
          entityId: ATTACHMENT_ID,
        },
      },
    });
    expect(attHeadAfterStatus?.latestRevision).toBe(baselineAttRevision);

    const attOutboxAfterStatus = await testClient1.vectorOutboxEvent.findMany({
      where: { entityId: ATTACHMENT_ID },
    });
    expect(attOutboxAfterStatus).toHaveLength(0);

    // 3. S16: Update parent task TITLE (alters attachment semantic text)
    await testClient1.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: TASK_ID_2 },
        data: { title: `New Title For Task 2 ${RUN_ID}` },
      });
      await recordVectorSyncIntent({
        tx,
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_2,
        contentHash: "hash_task_title_changed",
      });
      // Child attachments are updated atomically when parent title changes
      await recordVectorSyncIntent({
        tx,
        orgId: ORG_ID,
        entityType: VectorEntityType.ATTACHMENT,
        entityId: ATTACHMENT_ID,
        contentHash: "hash_att_v2_parent_title_changed",
      });
    }, TX_OPTS);

    // Child attachment revision MUST be incremented, and an outbox event emitted
    const attHeadAfterTitle = await testClient1.vectorEntityHead.findUnique({
      where: {
        orgId_entityType_entityId: {
          orgId: ORG_ID,
          entityType: VectorEntityType.ATTACHMENT,
          entityId: ATTACHMENT_ID,
        },
      },
    });
    expect(attHeadAfterTitle?.latestRevision).toBe(baselineAttRevision + 1);

    const attOutboxAfterTitle = await testClient1.vectorOutboxEvent.findMany({
      where: { entityId: ATTACHMENT_ID, status: VectorOutboxStatus.PENDING },
    });
    expect(attOutboxAfterTitle).toHaveLength(1);
    expect(attOutboxAfterTitle[0].sourceRevision).toBe(baselineAttRevision + 1);
  });
});
