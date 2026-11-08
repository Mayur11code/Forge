// forge/src/tests/vector/part1-transactional-outbox.realdb.test.ts
/**
 * Forge Vector V2 Phase B — Part 1: Real-Database Transactional Outbox Consistency (E3)
 *
 * Demonstrates against live PostgreSQL (Neon):
 * 1. Transactional consistency: Task and VectorOutboxEvent are persisted atomically.
 * 2. Physical rollback: When vector-sync intent fails or transaction is aborted,
 *    the Task/Attachment is NEVER committed to PostgreSQL.
 * 3. Attachment creation resolves parent task and org, writing attachment and intent together.
 */

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, VectorEntityType, VectorOutboxStatus } from "@prisma/client";
import { recordVectorSyncIntent } from "@/lib/vector/outbox";
import { computeTaskContentHash, computeAttachmentContentHash, computeAttachmentParentTaskVersion } from "@/lib/vector/provenance";
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

describeRealDb("Part 1: Real-Database Transactional Outbox Consistency (E3)", () => {
  let pool: Pool | null = null;
  let prisma: PrismaClient | null = null;

  const RUN_ID = `part1_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ORG_ID = `org_${RUN_ID}`;
  const PROJECT_ID = `proj_${RUN_ID}`;
  const TASK_ID_SUCCESS = `task_succ_${RUN_ID}`;
  const TASK_ID_FAIL = `task_fail_${RUN_ID}`;
  const ATT_ID_SUCCESS = `att_succ_${RUN_ID}`;
  const ATT_ID_FAIL = `att_fail_${RUN_ID}`;

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
      max: 5,
      connectionTimeoutMillis: 30000,
    });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    // Seed test Organization and Project
    await prisma.organization.create({
      data: {
        id: ORG_ID,
        name: `Test Org ${RUN_ID}`,
        slug: `slug-${RUN_ID}`,
      },
    });

    await prisma.project.create({
      data: {
        id: PROJECT_ID,
        name: `Test Project ${RUN_ID}`,
        orgId: ORG_ID,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.$executeRaw`
        DELETE FROM "VectorOutboxEvent" WHERE "orgId" = ${ORG_ID};
      `;
      await prisma.$executeRaw`
        DELETE FROM "VectorEntityHead" WHERE "orgId" = ${ORG_ID};
      `;
      await prisma.attachment.deleteMany({
        where: { id: { in: [ATT_ID_SUCCESS, ATT_ID_FAIL] } },
      });
      await prisma.task.deleteMany({
        where: { id: { in: [TASK_ID_SUCCESS, TASK_ID_FAIL] } },
      });
      await prisma.project.deleteMany({
        where: { id: PROJECT_ID },
      });
      await prisma.organization.deleteMany({
        where: { id: ORG_ID },
      });
    } catch {
      // Best-effort cleanup
    } finally {
      await prisma.$disconnect();
      if (pool) await pool.end();
    }
  });

  it("persists Task and VectorOutboxEvent atomically in the same PostgreSQL transaction", async () => {
    if (!prisma) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    const contentHash = computeTaskContentHash({
      id: TASK_ID_SUCCESS,
      projectId: PROJECT_ID,
      title: "Real DB Atomic Task",
      description: "Testing real commit",
      status: "TODO",
      priority: "MEDIUM",
      assigneeId: null,
    });

    // Execute canonical transactional write
    await prisma.$transaction(async (tx) => {
      await tx.task.create({
        data: {
          id: TASK_ID_SUCCESS,
          projectId: PROJECT_ID,
          title: "Real DB Atomic Task",
          description: "Testing real commit",
          priority: "MEDIUM",
        },
      });

      await recordVectorSyncIntent({
        tx: tx as any,
        orgId: ORG_ID,
        entityType: VectorEntityType.TASK,
        entityId: TASK_ID_SUCCESS,
        contentHash,
      });
    });

    // Verify both exist in PostgreSQL
    const taskInDb = await prisma.task.findUnique({ where: { id: TASK_ID_SUCCESS } });
    expect(taskInDb).not.toBeNull();
    expect(taskInDb?.title).toBe("Real DB Atomic Task");

    const outboxInDb = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM "VectorOutboxEvent"
      WHERE "entityId" = ${TASK_ID_SUCCESS}
      LIMIT 1;
    `;
    expect(outboxInDb).toHaveLength(1);
    expect(outboxInDb[0].status).toBe("PENDING");
  });

  it("physically rolls back Task creation when outbox intent persistence fails in PostgreSQL", async () => {
    if (!prisma) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    const contentHash = computeTaskContentHash({
      id: TASK_ID_FAIL,
      projectId: PROJECT_ID,
      title: "Task That Must Roll Back",
      description: null,
      status: "TODO",
      priority: "LOW",
      assigneeId: null,
    });

    let transactionThrew = false;
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Create task row in uncommitted transaction
        await tx.task.create({
          data: {
            id: TASK_ID_FAIL,
            projectId: PROJECT_ID,
            title: "Task That Must Roll Back",
            priority: "LOW",
          },
        });

        // 2. Intent persistence fails (e.g. simulated DB error or forced constraint violation)
        throw new Error("INTENT_FAILURE_FORCED_ROLLBACK");
      });
    } catch (err: any) {
      transactionThrew = true;
      expect(err.message).toBe("INTENT_FAILURE_FORCED_ROLLBACK");
    }

    expect(transactionThrew).toBe(true);

    // 3. Verify PostgreSQL engine rolled back: Task does NOT exist in the database!
    const taskInDb = await prisma.task.findUnique({ where: { id: TASK_ID_FAIL } });
    expect(taskInDb).toBeNull();

    // Verify no outbox row was written
    const outboxInDb = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "VectorOutboxEvent"
      WHERE "entityId" = ${TASK_ID_FAIL};
    `;
    expect(outboxInDb).toHaveLength(0);
  });

  it("persists Attachment and VectorOutboxEvent atomically with resolved parent task & org", async () => {
    if (!prisma) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    // Use TASK_ID_SUCCESS as the parent task
    await prisma.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({
        data: {
          id: ATT_ID_SUCCESS,
          taskId: TASK_ID_SUCCESS,
          fileKey: `key_${RUN_ID}`,
          url: "https://cdn.example.com/spec.pdf",
          name: "spec.pdf",
          size: 2048,
        },
      });

      const parentTask = await tx.task.findUniqueOrThrow({
        where: { id: TASK_ID_SUCCESS },
        select: {
          title: true,
          projectId: true,
          project: {
            select: { orgId: true },
          },
        },
      });

      const contentHash = computeAttachmentContentHash({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        fileKey: attachment.fileKey,
        taskId: attachment.taskId,
      });

      const parentTaskVersion = computeAttachmentParentTaskVersion({
        title: parentTask.title,
        projectId: parentTask.projectId,
      });

      await recordVectorSyncIntent({
        tx: tx as any,
        orgId: parentTask.project.orgId,
        entityType: VectorEntityType.ATTACHMENT,
        entityId: attachment.id,
        contentHash,
        parentTaskVersion,
      });
    });

    // Verify attachment exists
    const attInDb = await prisma.attachment.findUnique({ where: { id: ATT_ID_SUCCESS } });
    expect(attInDb).not.toBeNull();
    expect(attInDb?.name).toBe("spec.pdf");

    // Verify outbox event exists for attachment
    const outboxInDb = await prisma.$queryRaw<Array<{ id: string; orgId: string; entityType: string }>>`
      SELECT id, "orgId", "entityType" FROM "VectorOutboxEvent"
      WHERE "entityId" = ${ATT_ID_SUCCESS}
      LIMIT 1;
    `;
    expect(outboxInDb).toHaveLength(1);
    expect(outboxInDb[0].orgId).toBe(ORG_ID);
    expect(outboxInDb[0].entityType).toBe("ATTACHMENT");
  });

  it("physically rolls back Attachment creation when intent persistence fails", async () => {
    if (!prisma) {
      if (isE3Required) throw new Error("[P0_SAFETY_ERROR] Test client was not initialized despite mandatory E3 requirement.");
      return;
    }

    let transactionThrew = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.attachment.create({
          data: {
            id: ATT_ID_FAIL,
            taskId: TASK_ID_SUCCESS,
            fileKey: `key_fail_${RUN_ID}`,
            url: "https://cdn.example.com/fail.pdf",
            name: "fail.pdf",
            size: 512,
          },
        });

        // Intent fails
        throw new Error("ATTACHMENT_INTENT_FAILURE");
      });
    } catch (err: any) {
      transactionThrew = true;
      expect(err.message).toBe("ATTACHMENT_INTENT_FAILURE");
    }

    expect(transactionThrew).toBe(true);

    // Verify Attachment does NOT exist in PostgreSQL
    const attInDb = await prisma.attachment.findUnique({ where: { id: ATT_ID_FAIL } });
    expect(attInDb).toBeNull();
  });
});
