// src/tests/workflow/immutable-definition.realdb.test.ts
//
// Level E3 Real PostgreSQL Integration Test Suite for F-03 & F-03.2.
// Runs against real Neon database to verify:
// 1. F-03.2 Section 2: PostgreSQL Immutability & Hardened Constraints (all 9 direct SQL cases
//    tested against an independent raw pg.Pool connection).
// 2. F03-18: PostgreSQL trigger `prevent_workflow_run_snapshot_mutation` rejects
//    any direct UPDATE to definitionSnapshot or definitionHash once set.
// 3. F03-15: Concurrent workflow edit and workflow start guarantees transactional
//    consistency: every run captures either clean pre-edit or clean post-edit snapshot.
// 4. F03-01 to F03-04: Workflow edits in PostgreSQL do not affect running executions;
//    evaluator and step execution proceed strictly from frozen snapshot.

jest.mock("server-only", () => ({}));

jest.mock("@upstash/redis", () => ({
  Redis: { fromEnv: () => ({ set: jest.fn(), eval: jest.fn() }) },
}));

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: { trigger: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/events/event-bus", () => ({
  dispatchEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/workflow/execution/mutex", () => ({
  acquireLock: jest.fn().mockResolvedValue("lock_token_realdb_f03"),
  releaseLock: jest.fn().mockResolvedValue(true),
  startRunLockHeartbeat: jest.fn().mockReturnValue({
    stop: jest.fn().mockResolvedValue(undefined),
    hasLostOwnership: jest.fn().mockReturnValue(false),
  }),
}));

import { Pool } from "pg";
import { db } from "@/lib/prisma/db";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import {
  computeWorkflowDefinitionHash,
  verifyWorkflowSnapshotIntegrity,
} from "@/lib/workflow/validation/canonical-hash";
import type { WorkflowExecutionSnapshot } from "@/lib/workflow-types/snapshot";
import type { Prisma } from "@prisma/client";

jest.setTimeout(120_000);

const TAG = `f03_real_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ORG_ID = `${TAG}_org`;
const PROJECT_ID = `${TAG}_proj`;
const USER_ID = `${TAG}_user`;
const WORKFLOW_ID = `${TAG}_wf`;

// Independent raw PostgreSQL connection pool
const rawPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

describe("Real PostgreSQL Immutable Workflow Execution Contract (F-03 / F-03.2)", () => {
  beforeAll(async () => {
    await db.organization.create({
      data: {
        id: ORG_ID,
        name: "Test Org For F-03 RealDB",
        slug: `${TAG}_slug`,
      },
    });

    await db.user.create({
      data: {
        id: USER_ID,
        email: `${TAG}@example.com`,
        name: "Test User For F-03",
      },
    });

    await db.project.create({
      data: {
        id: PROJECT_ID,
        orgId: ORG_ID,
        name: "Test Project For F-03",
      },
    });

    await db.workflow.create({
      data: {
        id: WORKFLOW_ID,
        orgId: ORG_ID,
        name: "RealDB Immutable Definition WF",
        definition: {
          id: "wf_v1",
          name: "Original Definition V1",
          steps: {
            step_1: {
              id: "step_1",
              kind: "ACTION",
              action: "task.create",
              config: {
                title: "Original Step 1 Task",
                projectId: PROJECT_ID,
              },
              dependsOn: [],
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    try {
      await db.executionAuditLog.deleteMany({
        where: { runId: { startsWith: TAG } },
      });
      await db.stepRun.deleteMany({
        where: { runId: { startsWith: TAG } },
      });
      await db.workflowRun.deleteMany({
        where: { id: { startsWith: TAG } },
      });
      await db.workflow.deleteMany({ where: { id: WORKFLOW_ID } });
      await db.task.deleteMany({ where: { projectId: PROJECT_ID } });
      await db.vectorEntityHead.deleteMany({ where: { orgId: ORG_ID } });
      await db.project.deleteMany({ where: { id: PROJECT_ID } });
      await db.user.deleteMany({ where: { id: USER_ID } });
      await db.organization.deleteMany({ where: { id: ORG_ID } });
    } catch (err) {
      console.warn("Cleanup warning:", err);
    } finally {
      await rawPool.end();
    }
  });

  // -------------------------------------------------------------------------
  // F-03.2 Section 2: All 9 Direct SQL Cases via Independent Connection
  // -------------------------------------------------------------------------
  describe("F-03.2 Section 2: PostgreSQL Immutability & Hardened Constraints (9 Direct SQL Cases)", () => {
    const validSnapshotObj: WorkflowExecutionSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: WORKFLOW_ID,
      workflowName: "RealDB Immutable Definition WF",
      definition: {
        id: "wf_v1",
        name: "Original Definition V1",
        steps: {
          step_1: {
            id: "step_1",
            kind: "ACTION",
            action: "task.create",
            isCritical: false,
            config: { title: "Test Direct SQL", projectId: PROJECT_ID },
            dependsOn: [],
          },
        },
      },
      actionManifest: [{ stepId: "step_1", actionId: "task.create", actionVersion: "1.0.0" }],
      createdAt: new Date().toISOString(),
    };
    const validHashStr = computeWorkflowDefinitionHash(validSnapshotObj);

    const validRunId = `${TAG}_sql_valid`;
    const legacyRunId = `${TAG}_sql_legacy`;

    // Case 1: Valid new insert succeeds
    it("Case 1: Valid new insert succeeds with populated snapshot and hash", async () => {
      const res = await rawPool.query(
        `INSERT INTO "WorkflowRun" (id, "workflowId", status, context, "contextVersion", "definitionSnapshot", "definitionHash", "startedAt", "lastAdvancedAt")
         VALUES ($1, $2, 'RUNNING', '{}'::jsonb, 0, $3::jsonb, $4, NOW(), NOW())
         RETURNING id, "definitionHash", status;`,
        [validRunId, WORKFLOW_ID, JSON.stringify(validSnapshotObj), validHashStr],
      );

      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].id).toBe(validRunId);
      expect(res.rows[0].definitionHash).toBe(validHashStr);
      expect(res.rows[0].status).toBe("RUNNING");
    });

    // Case 2: New insert with snapshot only fails (CHECK constraint & trigger)
    it("Case 2: New insert with snapshot only fails (trigger and CHECK constraint chk_workflow_run_snapshot_pair)", async () => {
      const runId = `${TAG}_sql_snap_only`;
      // A. Normal insert fails via insert trigger
      let error: Error | null = null;
      try {
        await rawPool.query(
          `INSERT INTO "WorkflowRun" (id, "workflowId", status, context, "contextVersion", "definitionSnapshot", "definitionHash", "startedAt", "lastAdvancedAt")
           VALUES ($1, $2, 'RUNNING', '{}'::jsonb, 0, $3::jsonb, NULL, NOW(), NOW());`,
          [runId, WORKFLOW_ID, JSON.stringify(validSnapshotObj)],
        );
      } catch (err) {
        error = err as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain(
        "New WorkflowRun must be created with both definitionSnapshot and definitionHash populated",
      );

      // B. Even if insert trigger is bypassed, table CHECK constraint chk_workflow_run_snapshot_pair rejects it
      await rawPool.query(`ALTER TABLE "WorkflowRun" DISABLE TRIGGER trg_workflow_run_snapshot_insert;`);
      let checkConstraintErr: Error | null = null;
      try {
        await rawPool.query(
          `INSERT INTO "WorkflowRun" (id, "workflowId", status, context, "contextVersion", "definitionSnapshot", "definitionHash", "startedAt", "lastAdvancedAt")
           VALUES ($1, $2, 'RUNNING', '{}'::jsonb, 0, $3::jsonb, NULL, NOW(), NOW());`,
          [`${runId}_b`, WORKFLOW_ID, JSON.stringify(validSnapshotObj)],
        );
      } catch (err) {
        checkConstraintErr = err as Error;
      } finally {
        await rawPool.query(`ALTER TABLE "WorkflowRun" ENABLE TRIGGER trg_workflow_run_snapshot_insert;`);
      }
      expect(checkConstraintErr).not.toBeNull();
      expect(checkConstraintErr!.message).toContain("chk_workflow_run_snapshot_pair");
    });

    // Case 3: New insert with hash only fails (CHECK constraint & trigger)
    it("Case 3: New insert with hash only fails (trigger and CHECK constraint chk_workflow_run_snapshot_pair)", async () => {
      const runId = `${TAG}_sql_hash_only`;
      // A. Normal insert fails via insert trigger
      let error: Error | null = null;
      try {
        await rawPool.query(
          `INSERT INTO "WorkflowRun" (id, "workflowId", status, context, "contextVersion", "definitionSnapshot", "definitionHash", "startedAt", "lastAdvancedAt")
           VALUES ($1, $2, 'RUNNING', '{}'::jsonb, 0, NULL, $3, NOW(), NOW());`,
          [runId, WORKFLOW_ID, validHashStr],
        );
      } catch (err) {
        error = err as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain(
        "New WorkflowRun must be created with both definitionSnapshot and definitionHash populated",
      );

      // B. Even if insert trigger is bypassed, table CHECK constraint chk_workflow_run_snapshot_pair rejects it
      await rawPool.query(`ALTER TABLE "WorkflowRun" DISABLE TRIGGER trg_workflow_run_snapshot_insert;`);
      let checkConstraintErr: Error | null = null;
      try {
        await rawPool.query(
          `INSERT INTO "WorkflowRun" (id, "workflowId", status, context, "contextVersion", "definitionSnapshot", "definitionHash", "startedAt", "lastAdvancedAt")
           VALUES ($1, $2, 'RUNNING', '{}'::jsonb, 0, NULL, $3, NOW(), NOW());`,
          [`${runId}_b`, WORKFLOW_ID, validHashStr],
        );
      } catch (err) {
        checkConstraintErr = err as Error;
      } finally {
        await rawPool.query(`ALTER TABLE "WorkflowRun" ENABLE TRIGGER trg_workflow_run_snapshot_insert;`);
      }
      expect(checkConstraintErr).not.toBeNull();
      expect(checkConstraintErr!.message).toContain("chk_workflow_run_snapshot_pair");
    });

    // Case 4: New insert with neither fails (trigger)
    it("Case 4: New insert with neither fails (trigger trg_workflow_run_snapshot_insert)", async () => {
      const runId = `${TAG}_sql_neither`;
      let error: Error | null = null;
      try {
        await rawPool.query(
          `INSERT INTO "WorkflowRun" (id, "workflowId", status, context, "contextVersion", "definitionSnapshot", "definitionHash", "startedAt", "lastAdvancedAt")
           VALUES ($1, $2, 'RUNNING', '{}'::jsonb, 0, NULL, NULL, NOW(), NOW());`,
          [runId, WORKFLOW_ID],
        );
      } catch (err) {
        error = err as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain(
        "New WorkflowRun must be created with both definitionSnapshot and definitionHash populated",
      );
    });

    // Case 5: Existing legacy NULL/NULL row remains readable
    it("Case 5: Existing legacy NULL/NULL row remains readable", async () => {
      // Model a pre-migration legacy row by disabling the insert trigger temporarily
      await rawPool.query(`ALTER TABLE "WorkflowRun" DISABLE TRIGGER trg_workflow_run_snapshot_insert;`);
      try {
        await rawPool.query(
          `INSERT INTO "WorkflowRun" (id, "workflowId", status, context, "contextVersion", "definitionSnapshot", "definitionHash", "startedAt", "lastAdvancedAt")
           VALUES ($1, $2, 'RUNNING', '{}'::jsonb, 0, NULL, NULL, NOW(), NOW());`,
          [legacyRunId, WORKFLOW_ID],
        );
      } finally {
        await rawPool.query(`ALTER TABLE "WorkflowRun" ENABLE TRIGGER trg_workflow_run_snapshot_insert;`);
      }

      const res = await rawPool.query(
        `SELECT id, "definitionSnapshot", "definitionHash", status FROM "WorkflowRun" WHERE id = $1;`,
        [legacyRunId],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].id).toBe(legacyRunId);
      expect(res.rows[0].definitionSnapshot).toBeNull();
      expect(res.rows[0].definitionHash).toBeNull();
      expect(res.rows[0].status).toBe("RUNNING");
    });

    // Case 6: Legacy NULL/NULL row cannot be populated by ordinary UPDATE
    it("Case 6: Legacy NULL/NULL row cannot be populated by ordinary UPDATE", async () => {
      let snapErr: Error | null = null;
      try {
        await rawPool.query(
          `UPDATE "WorkflowRun" SET "definitionSnapshot" = $1::jsonb WHERE id = $2;`,
          [JSON.stringify(validSnapshotObj), legacyRunId],
        );
      } catch (err) {
        snapErr = err as Error;
      }
      expect(snapErr).not.toBeNull();
      expect(snapErr!.message).toContain(
        "WorkflowRun definitionSnapshot is immutable and cannot be populated, modified, or cleared after creation",
      );

      let hashErr: Error | null = null;
      try {
        await rawPool.query(
          `UPDATE "WorkflowRun" SET "definitionHash" = $1 WHERE id = $2;`,
          [validHashStr, legacyRunId],
        );
      } catch (err) {
        hashErr = err as Error;
      }
      expect(hashErr).not.toBeNull();
      expect(hashErr!.message).toContain(
        "WorkflowRun definitionHash is immutable and cannot be populated, modified, or cleared after creation",
      );
    });

    // Case 7: Populated snapshot/hash cannot be modified
    it("Case 7: Populated snapshot/hash cannot be modified", async () => {
      let snapErr: Error | null = null;
      try {
        await rawPool.query(
          `UPDATE "WorkflowRun" SET "definitionSnapshot" = '{"tampered":true}'::jsonb WHERE id = $1;`,
          [validRunId],
        );
      } catch (err) {
        snapErr = err as Error;
      }
      expect(snapErr).not.toBeNull();
      expect(snapErr!.message).toContain(
        "WorkflowRun definitionSnapshot is immutable and cannot be populated, modified, or cleared after creation",
      );

      let hashErr: Error | null = null;
      try {
        await rawPool.query(
          `UPDATE "WorkflowRun" SET "definitionHash" = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE id = $1;`,
          [validRunId],
        );
      } catch (err) {
        hashErr = err as Error;
      }
      expect(hashErr).not.toBeNull();
      expect(hashErr!.message).toContain(
        "WorkflowRun definitionHash is immutable and cannot be populated, modified, or cleared after creation",
      );
    });

    // Case 8: Populated snapshot/hash cannot be cleared
    it("Case 8: Populated snapshot/hash cannot be cleared", async () => {
      let snapErr: Error | null = null;
      try {
        await rawPool.query(
          `UPDATE "WorkflowRun" SET "definitionSnapshot" = NULL WHERE id = $1;`,
          [validRunId],
        );
      } catch (err) {
        snapErr = err as Error;
      }
      expect(snapErr).not.toBeNull();
      expect(snapErr!.message).toContain(
        "WorkflowRun definitionSnapshot is immutable and cannot be populated, modified, or cleared after creation",
      );

      let hashErr: Error | null = null;
      try {
        await rawPool.query(
          `UPDATE "WorkflowRun" SET "definitionHash" = NULL WHERE id = $1;`,
          [validRunId],
        );
      } catch (err) {
        hashErr = err as Error;
      }
      expect(hashErr).not.toBeNull();
      expect(hashErr!.message).toContain(
        "WorkflowRun definitionHash is immutable and cannot be populated, modified, or cleared after creation",
      );
    });

    // Case 9: Normal WorkflowRun updates unrelated to snapshot/hash still work
    it("Case 9: Normal WorkflowRun updates unrelated to snapshot/hash still work on both populated and legacy rows", async () => {
      // Normal update on valid populated row
      await rawPool.query(
        `UPDATE "WorkflowRun" SET status = 'COMPLETED', "completedAt" = NOW() WHERE id = $1;`,
        [validRunId],
      );
      const resValid = await rawPool.query(
        `SELECT status, "definitionHash" FROM "WorkflowRun" WHERE id = $1;`,
        [validRunId],
      );
      expect(resValid.rows[0].status).toBe("COMPLETED");
      expect(resValid.rows[0].definitionHash).toBe(validHashStr);

      // Normal update on legacy NULL/NULL row
      await rawPool.query(
        `UPDATE "WorkflowRun" SET status = 'COMPLETED', "completedAt" = NOW() WHERE id = $1;`,
        [legacyRunId],
      );
      const resLegacy = await rawPool.query(
        `SELECT status, "definitionSnapshot", "definitionHash" FROM "WorkflowRun" WHERE id = $1;`,
        [legacyRunId],
      );
      expect(resLegacy.rows[0].status).toBe("COMPLETED");
      expect(resLegacy.rows[0].definitionSnapshot).toBeNull();
      expect(resLegacy.rows[0].definitionHash).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // F03-18: Database trigger prevent_workflow_run_snapshot_mutation via Prisma
  // -------------------------------------------------------------------------
  it("F03-18: Database trigger rejects direct UPDATE to definitionSnapshot or definitionHash once set", async () => {
    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);
    expect(run).toBeDefined();
    expect(run.definitionSnapshot).toBeDefined();
    expect(run.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    // 1. Attempt to mutate definitionSnapshot via raw SQL
    let snapshotError: Error | null = null;
    try {
      await db.$executeRawUnsafe(
        `UPDATE "WorkflowRun" SET "definitionSnapshot" = $1::jsonb WHERE id = $2`,
        JSON.stringify({ tampered: true }),
        run.id,
      );
    } catch (err) {
      snapshotError = err as Error;
    }
    expect(snapshotError).not.toBeNull();
    expect(snapshotError!.message).toContain(
      "WorkflowRun definitionSnapshot is immutable and cannot be populated, modified, or cleared after creation",
    );

    // 2. Attempt to mutate definitionHash via raw SQL
    let hashError: Error | null = null;
    try {
      await db.$executeRawUnsafe(
        `UPDATE "WorkflowRun" SET "definitionHash" = $1 WHERE id = $2`,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        run.id,
      );
    } catch (err) {
      hashError = err as Error;
    }
    expect(hashError).not.toBeNull();
    expect(hashError!.message).toContain(
      "WorkflowRun definitionHash is immutable and cannot be populated, modified, or cleared after creation",
    );

    // 3. Normal updates to mutable fields (e.g. status) succeed
    await db.workflowRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED" },
    });
    const refreshed = await db.workflowRun.findUnique({ where: { id: run.id } });
    expect(refreshed?.status).toBe("COMPLETED");
  });

  // -------------------------------------------------------------------------
  // F03-15: Concurrent workflow edit and workflow start
  // -------------------------------------------------------------------------
  it("F03-15: Concurrent workflow edit and workflow start produces clean atomic snapshots", async () => {
    const v2Definition = {
      id: "wf_v2",
      name: "Updated Definition V2",
      steps: {
        step_1: {
          id: "step_1",
          kind: "ACTION",
          action: "task.create",
          config: {
            title: "Updated Step 1 Task",
            projectId: PROJECT_ID,
          },
          dependsOn: [],
        },
        step_2: {
          id: "step_2",
          kind: "ACTION",
          action: "task.create",
          config: {
            title: "Updated Step 2 Task",
            projectId: PROJECT_ID,
          },
          dependsOn: ["step_1"],
        },
      },
    };

    // Concurrently start runs while updating the workflow definition
    const startPromises = [
      startWorkflow(ORG_ID, WORKFLOW_ID),
      startWorkflow(ORG_ID, WORKFLOW_ID),
    ];

    const updatePromise = db.workflow.update({
      where: { id: WORKFLOW_ID },
      data: { definition: v2Definition as unknown as Prisma.InputJsonValue },
    });

    const [runs] = await Promise.all([
      Promise.all(startPromises),
      updatePromise,
    ]);

    expect(runs.length).toBe(2);

    for (const run of runs) {
      // Must have valid snapshot and hash
      expect(run.definitionSnapshot).toBeDefined();
      expect(run.definitionHash).toBeDefined();

      const snapshot = run.definitionSnapshot as unknown as WorkflowExecutionSnapshot;
      const verified = verifyWorkflowSnapshotIntegrity(snapshot, run.definitionHash!);
      expect(verified).toBeDefined();

      // The snapshot must be either clean v1 or clean v2, never half-applied
      const stepCount = Object.keys(snapshot.definition.steps).length;
      expect([1, 2]).toContain(stepCount);
      if (stepCount === 1) {
        expect(snapshot.definition.name).toBe("Original Definition V1");
      } else {
        expect(snapshot.definition.name).toBe("Updated Definition V2");
      }
    }
  });

  // -------------------------------------------------------------------------
  // F03-01 & F03-04: Running execution ignores subsequent workflow changes in PostgreSQL
  // -------------------------------------------------------------------------
  it("F03-01 to F03-04: Running execution in real DB proceeds strictly from snapshot despite DB changes", async () => {
    // Reset workflow to a distinct v3 definition
    const v3Definition = {
      id: "wf_v3",
      name: "Version 3 Definition",
      steps: {
        step_initial: {
          id: "step_initial",
          kind: "ACTION",
          action: "task.create",
          config: {
            title: "Snapshot Task Title",
            projectId: PROJECT_ID,
          },
          dependsOn: [],
        },
      },
    };

    await db.workflow.update({
      where: { id: WORKFLOW_ID },
      data: { definition: v3Definition as unknown as Prisma.InputJsonValue },
    });

    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);

    // Now mutate workflow in DB to v4 (deleting step_initial, adding step_other)
    await db.workflow.update({
      where: { id: WORKFLOW_ID },
      data: {
        definition: {
          id: "wf_v4",
          name: "Completely Changed V4",
          steps: {
            step_other: {
              id: "step_other",
              kind: "ACTION",
              action: "send.email",
              dependsOn: [],
            },
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Advance workflow: evaluator resolves from snapshot, not from mutated DB workflow
    await advanceWorkflow(run.id);

    const stepRuns = await db.stepRun.findMany({
      where: { runId: run.id },
    });

    expect(stepRuns.length).toBe(1);
    expect(stepRuns[0].stepId).toBe("step_initial");
    expect(stepRuns.some((s) => s.stepId === "step_other")).toBe(false);
  });
});
