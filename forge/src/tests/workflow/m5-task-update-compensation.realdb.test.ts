// src/tests/workflow/m5-task-update-compensation.realdb.test.ts
//
// Level E3 Real PostgreSQL Concurrency & Saga Compensation Acceptance Suite.
// Exercises the production `task.update` action and compensation engine against
// real PostgreSQL using two independent database connections.

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/prisma/db";
import { updateTaskAction } from "@/lib/workflow/actions/core/update-task";
import type { Prisma } from "@prisma/client";
import type { JsonValue } from "@/lib/workflow-types/type";

jest.setTimeout(120_000);

const TAG = `m5_e3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const ORG_ID = `${TAG}_org`;
const USER_ID = `${TAG}_user`;
const PROJECT_ID = `${TAG}_proj`;
const WORKFLOW_ID = `${TAG}_wf`;

describe("M5 E3 Real PostgreSQL Verification: task.update Saga Compensation", () => {
  let pool2: Pool;
  let db2: PrismaClient;

  beforeAll(async () => {
    // Independent connection pool and client for genuine concurrent actor
    pool2 = new Pool({
      connectionString: `${process.env.DATABASE_URL}`,
      max: 5,
      connectionTimeoutMillis: 10_000,
    });
    const adapter2 = new PrismaPg(pool2);
    db2 = new PrismaClient({ adapter: adapter2 });

    // Seed test user, org, project, workflow in real PostgreSQL
    await db.user.create({
      data: {
        id: USER_ID,
        email: `${TAG}@forge-test.internal`,
        name: "M5 E3 Acceptance User",
      },
    });

    await db.organization.create({
      data: {
        id: ORG_ID,
        name: "M5 E3 Test Organization",
        slug: `${TAG}-org-slug`,
        memberships: {
          create: {
            userId: USER_ID,
            role: "ADMIN",
          },
        },
      },
    });

    await db.project.create({
      data: {
        id: PROJECT_ID,
        orgId: ORG_ID,
        name: "M5 E3 Acceptance Project",
      },
    });

    await db.workflow.create({
      data: {
        id: WORKFLOW_ID,
        orgId: ORG_ID,
        name: "M5 E3 Test Workflow",
        definition: {
          steps: {},
        } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  afterAll(async () => {
    try {
      // Clean up all fixtures created during test run in proper foreign-key order
      await db.executionAuditLog.deleteMany({
        where: { runId: { startsWith: TAG } },
      });
      await db.stepRun.deleteMany({
        where: { runId: { startsWith: TAG } },
      });
      await db.workflowRun.deleteMany({
        where: { workflowId: WORKFLOW_ID },
      });
      await db.domainEventOutbox.deleteMany({
        where: { orgId: ORG_ID },
      });
      await db.task.deleteMany({
        where: { projectId: PROJECT_ID },
      });
      await db.workflow.deleteMany({
        where: { id: WORKFLOW_ID },
      });
      await db.project.deleteMany({
        where: { id: PROJECT_ID },
      });
      await db.membership.deleteMany({
        where: { orgId: ORG_ID },
      });
      await db.organization.deleteMany({
        where: { id: ORG_ID },
      });
      await db.user.deleteMany({
        where: { id: USER_ID },
      });
    } finally {
      await db2.$disconnect();
      await pool2.end();
    }
  });

  let uncontendedTaskId: string;
  let uncontendedRunId: string;
  let uncontendedStepRunId: string;

  // =========================================================================
  // 1. Uncontended Compensation Restores All Changed Fields (E3)
  // =========================================================================
  test("1. Uncontended compensation: restores all modified fields to prior snapshot in PostgreSQL", async () => {
    uncontendedRunId = `${TAG}_run_1`;
    const stepId = "step_update_1";
    uncontendedStepRunId = `${TAG}_steprun_1`;

    // Create WorkflowRun and StepRun rows to satisfy ExecutionAuditLog foreign keys
    await db.workflowRun.create({
      data: {
        id: uncontendedRunId,
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
        definitionSnapshot: {},
        definitionHash: "test_hash_1",
      },
    });

    await db.stepRun.create({
      data: {
        id: uncontendedStepRunId,
        runId: uncontendedRunId,
        stepId,
        status: "RUNNING",
      },
    });

    // Create task in real DB with Prisma-generated CUID
    const createdTask = await db.task.create({
      data: {
        projectId: PROJECT_ID,
        title: "Baseline Bug Title",
        status: "TODO",
        priority: "LOW",
        description: "Initial description",
      },
    });
    const taskId = createdTask.id;
    uncontendedTaskId = taskId;

    // Execute forward action: update status, priority, and title
    const execRes = await updateTaskAction.execute({
      workflowId: WORKFLOW_ID,
      runId: uncontendedRunId,
      stepId,
      inputs: {
        taskId,
        status: "IN_PROGRESS",
        priority: "HIGH",
        title: "Triaged Bug Title",
      },
    });

    expect(execRes.success).toBe(true);

    // Verify persisted state in DB via independent connection
    const updatedInDb = await db2.task.findUnique({ where: { id: taskId } });
    expect(updatedInDb?.status).toBe("IN_PROGRESS");
    expect(updatedInDb?.priority).toBe("HIGH");
    expect(updatedInDb?.title).toBe("Triaged Bug Title");

    // Execute backward saga compensation
    const compRes = await updateTaskAction.compensate!({
      workflowId: WORKFLOW_ID,
      runId: uncontendedRunId,
      stepId,
      stepRunId: uncontendedStepRunId,
      inputs: { taskId },
      outputs: execRes.data as JsonValue,
    });

    expect(compRes.success).toBe(true);

    // Verify state in PostgreSQL via independent connection db2: all fields restored
    const restoredInDb = await db2.task.findUnique({ where: { id: taskId } });
    expect(restoredInDb?.status).toBe("TODO");
    expect(restoredInDb?.priority).toBe("LOW");
    expect(restoredInDb?.title).toBe("Baseline Bug Title");

    // Verify durable audit log record in PostgreSQL
    const auditRecord = await db2.executionAuditLog.findFirst({
      where: {
        runId: uncontendedRunId,
        eventType: "COMPENSATION_TASK_UPDATED",
      },
    });
    expect(auditRecord).toBeDefined();
    expect(auditRecord?.message).toContain(`Task ${taskId} restored`);
  });

  // =========================================================================
  // 2. Duplicate Compensation Delivery Is Idempotent (E3)
  // =========================================================================
  test("2. Duplicate compensation delivery: returns success idempotently without re-modifying state", async () => {
    const taskId = uncontendedTaskId;
    const runId = uncontendedRunId;
    const stepId = "step_update_1";
    const stepRunId = uncontendedStepRunId;

    const prevDbTask = await db2.task.findUnique({ where: { id: taskId } });

    // Call compensate a second time with exact same execution context
    const compRes2 = await updateTaskAction.compensate!({
      workflowId: WORKFLOW_ID,
      runId,
      stepId,
      stepRunId,
      inputs: { taskId },
      outputs: {
        taskId,
        previousState: { status: "TODO", priority: "LOW", title: "Baseline Bug Title" },
        appliedChanges: { status: "IN_PROGRESS", priority: "HIGH", title: "Triaged Bug Title" },
      },
    });

    expect(compRes2.success).toBe(true);
    const compData = compRes2.data as { alreadyCompensated?: boolean };
    expect(compData.alreadyCompensated).toBe(true);

    // Persisted state must remain untouched in real PostgreSQL
    const afterDbTask = await db2.task.findUnique({ where: { id: taskId } });
    expect(afterDbTask?.status).toBe(prevDbTask?.status);
    expect(afterDbTask?.priority).toBe(prevDbTask?.priority);
    expect(afterDbTask?.title).toBe(prevDbTask?.title);
  });

  // =========================================================================
  // 3. Genuine Concurrent Human Edit on Independent DB Connection (E3)
  // =========================================================================
  test("3. Concurrent human edit on independent connection: refuses compensation, preserves human intent, logs conflict", async () => {
    const runId = `${TAG}_run_2`;
    const stepId = "step_update_2";
    const stepRunId = `${TAG}_steprun_2`;

    await db.workflowRun.create({
      data: {
        id: runId,
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
        definitionSnapshot: {},
        definitionHash: "test_hash_2",
      },
    });

    await db.stepRun.create({
      data: {
        id: stepRunId,
        runId,
        stepId,
        status: "RUNNING",
      },
    });

    // 1. Create initial task
    const createdTask = await db.task.create({
      data: {
        projectId: PROJECT_ID,
        title: "Concurrency Target Task",
        status: "TODO",
        priority: "LOW",
        description: "Initial task state",
      },
    });
    const taskId = createdTask.id;

    // 2. Workflow forward step executes: changes status to IN_PROGRESS, priority to HIGH
    const execRes = await updateTaskAction.execute({
      workflowId: WORKFLOW_ID,
      runId,
      stepId,
      inputs: {
        taskId,
        status: "IN_PROGRESS",
        priority: "HIGH",
      },
    });
    expect(execRes.success).toBe(true);

    // 3. Independent actor (human on db2) modifies priority to MEDIUM (leaves status untouched)
    await db2.task.update({
      where: { id: taskId },
      data: {
        priority: "MEDIUM",
        description: "Human intervention: lowered priority after review",
      },
    });

    // 4. Downstream failure triggers backward saga compensation on db1
    const compRes = await updateTaskAction.compensate!({
      workflowId: WORKFLOW_ID,
      runId,
      stepId,
      stepRunId,
      inputs: { taskId },
      outputs: execRes.data as JsonValue,
    });

    // 5. Verification 1: CAS conflict detected & propagated
    expect(compRes.success).toBe(false);
    expect(compRes.error).toContain("Refusing to clobber human intent");
    expect(compRes.error).toContain("priority diverged");

    // 6. Verification 2: Intended intervention state
    expect(compRes.isRetriable).toBe(false);

    // 7. Verification 3: Independent DB inspection proves no human edit is overwritten
    const taskAfterComp = await db2.task.findUnique({ where: { id: taskId } });
    expect(taskAfterComp?.priority).toBe("MEDIUM"); // Preserved!
    expect(taskAfterComp?.description).toBe("Human intervention: lowered priority after review"); // Preserved!

    // 8. Verification 4: Task is NOT partially restored (status remains IN_PROGRESS, not rolled back to TODO)
    expect(taskAfterComp?.status).toBe("IN_PROGRESS");

    // 9. Verification 5: Durable audit record exists in PostgreSQL
    const conflictAudit = await db2.executionAuditLog.findFirst({
      where: {
        runId,
        eventType: "COMPENSATION_CONFLICT_DETECTED",
      },
    });
    expect(conflictAudit).toBeDefined();
    expect(conflictAudit?.logLevel).toBe("WARN");
    expect(conflictAudit?.message.toLowerCase()).toContain("refusing to clobber human intent");
  });

  // =========================================================================
  // 4. Row-Lock CAS Protection Under Direct Row-Level Contention (E3)
  // =========================================================================
  test("4. Row-lock CAS protection: concurrent race condition under row lock returns update failure", async () => {
    const runId = `${TAG}_run_3`;
    const stepId = "step_update_3";
    const stepRunId = `${TAG}_steprun_3`;

    await db.workflowRun.create({
      data: {
        id: runId,
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
        definitionSnapshot: {},
        definitionHash: "test_hash_3",
      },
    });

    await db.stepRun.create({
      data: {
        id: stepRunId,
        runId,
        stepId,
        status: "RUNNING",
      },
    });

    const createdTask = await db.task.create({
      data: {
        projectId: PROJECT_ID,
        title: "Lock Race Target Task",
        status: "TODO",
        priority: "LOW",
      },
    });
    const taskId = createdTask.id;

    const execRes = await updateTaskAction.execute({
      workflowId: WORKFLOW_ID,
      runId,
      stepId,
      inputs: {
        taskId,
        status: "IN_PROGRESS",
        priority: "HIGH",
      },
    });
    expect(execRes.success).toBe(true);

    // Simulate an interleaved edit on db2 right before compensation's CAS executes
    await db2.task.update({
      where: { id: taskId },
      data: { title: "Human concurrently edited title" },
    });

    // If workflow had changed title too, CAS fails:
    const outputsWithTitle = {
      ...(execRes.data as Record<string, unknown>),
      appliedChanges: {
        status: "IN_PROGRESS",
        priority: "HIGH",
        title: "Workflow Title",
      },
      previousState: {
        status: "TODO",
        priority: "LOW",
        title: "Lock Race Target Task",
      },
    };

    const compRes = await updateTaskAction.compensate!({
      workflowId: WORKFLOW_ID,
      runId,
      stepId,
      stepRunId,
      inputs: { taskId },
      outputs: outputsWithTitle as unknown as JsonValue,
    });

    expect(compRes.success).toBe(false);
    expect(compRes.error).toContain("title diverged");

    // Human title is preserved in real PostgreSQL
    const currentTask = await db2.task.findUnique({ where: { id: taskId } });
    expect(currentTask?.title).toBe("Human concurrently edited title");
  });
});
