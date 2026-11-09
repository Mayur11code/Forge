// src/tests/workflow/compensation-contract.realdb.test.ts
//
// Level E3 Real PostgreSQL Integration Test Suite for F-02.2.
// Runs against real Neon database to verify:
// 1. Scenario 1: Real Neon task creation, safe rollback, physical task deletion, vector tombstone verification, ROLLED_BACK convergence.
// 2. Scenario 2: Real Neon task with comments refuses deletion, preserves physical task and user comments, REQUIRES_INTERVENTION.
// 3. Scenario 7: Real concurrent task mutation detected via snapshot comparison under row lock, refuses deletion, preserves task, REQUIRES_INTERVENTION.
// 4. Scenario 9: Crash-after-delete recovery on real Neon DB via durable COMPENSATION_TASK_DELETED receipt in ExecutionAuditLog.

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
  acquireLock: jest.fn().mockResolvedValue("lock_token_realdb_f02"),
  releaseLock: jest.fn().mockResolvedValue(true),
  startRunLockHeartbeat: jest.fn().mockReturnValue({
    stop: jest.fn().mockResolvedValue(undefined),
    hasLostOwnership: jest.fn().mockReturnValue(false),
  }),
}));

import { db } from "@/lib/prisma/db";
import { wrapStepOperation } from "@/lib/workflow/execution/wrapper";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { VectorEntityType } from "@prisma/client";

jest.setTimeout(120_000);

const TAG = `f02_real_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const ORG_ID = `${TAG}_org`;
const PROJECT_ID = `${TAG}_proj`;
const USER_ID = `${TAG}_user`;
const WORKFLOW_ID = `${TAG}_wf`;

describe("Real PostgreSQL Task Compensation & Safe Saga Reversal (F-02.2)", () => {
  beforeAll(async () => {
    await db.organization.create({
      data: {
        id: ORG_ID,
        name: "Test Org For F-02.2 RealDB",
        slug: `${TAG}_slug`,
      },
    });

    await db.user.create({
      data: {
        id: USER_ID,
        email: `${TAG}@example.com`,
        name: "Test User For Comments",
      },
    });

    await db.project.create({
      data: {
        id: PROJECT_ID,
        orgId: ORG_ID,
        name: "Test Project For F-02.2",
      },
    });

    await db.workflow.create({
      data: {
        id: WORKFLOW_ID,
        orgId: ORG_ID,
        name: "RealDB Task Compensation WF",
        definition: {
          id: "d1",
          name: "d1",
          steps: {
            step_task: {
              id: "step_task",
              kind: "ACTION",
              action: "task.create",
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
        where: {
          runId: { startsWith: TAG },
        },
      });
      await db.stepRun.deleteMany({
        where: {
          runId: { startsWith: TAG },
        },
      });
      await db.workflowRun.deleteMany({
        where: {
          id: { startsWith: TAG },
        },
      });
      await db.workflow.deleteMany({ where: { id: WORKFLOW_ID } });
      await db.comment.deleteMany({ where: { userId: USER_ID } });
      await db.task.deleteMany({ where: { projectId: PROJECT_ID } });
      await db.vectorEntityHead.deleteMany({ where: { orgId: ORG_ID } });
      await db.project.deleteMany({ where: { id: PROJECT_ID } });
      await db.user.deleteMany({ where: { id: USER_ID } });
      await db.organization.deleteMany({ where: { id: ORG_ID } });
    } catch (e) {
      console.warn("Cleanup warning:", e);
    }
  });

  // =========================================================================
  // Scenario 1: Successful Task Compensation on Real Neon DB
  // =========================================================================
  it("1. Clean task is physically deleted from PostgreSQL, vector tombstoned, and converges to ROLLED_BACK", async () => {
    const RUN_ID = `${TAG}_run_1`;
    const STEP_RUN_ID = `${TAG}_sr_task_1`;
    const TASK_ID = `${TAG}_task_clean_1`;

    await db.workflowRun.create({
      data: {
        id: RUN_ID,
        workflowId: WORKFLOW_ID,
        status: "ROLLING_BACK",
      },
    });

    const createdTask = await db.task.create({
      data: {
        id: TASK_ID,
        projectId: PROJECT_ID,
        title: "Real Business Task To Safely Delete",
        description: "Initial description",
        status: "TODO",
        priority: "MEDIUM",
      },
    });

    await db.stepRun.create({
      data: {
        id: STEP_RUN_ID,
        runId: RUN_ID,
        stepId: "step_task",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        inputs: { title: "Real Business Task To Safely Delete", projectId: PROJECT_ID },
        outputs: {
          taskId: TASK_ID,
          title: "Real Business Task To Safely Delete",
          projectId: PROJECT_ID,
          taskSnapshot: {
            title: createdTask.title,
            description: createdTask.description,
            status: createdTask.status,
            priority: createdTask.priority,
            projectId: createdTask.projectId,
            assigneeId: createdTask.assigneeId,
            createdAt: createdTask.createdAt.toISOString(),
            updatedAt: createdTask.updatedAt.toISOString(),
          },
        },
      },
    });

    // Execute compensation for task.create
    const result = await wrapStepOperation(
      RUN_ID,
      "step_task",
      "task.create",
      "ACTION",
      undefined,
      "COMPENSATE"
    );

    expect(result.success).toBe(true);

    // 1. INVARIANT: Physical Task row MUST BE DELETED from PostgreSQL
    const taskInDb = await db.task.findUnique({
      where: { id: TASK_ID },
    });
    expect(taskInDb).toBeNull();

    // 2. INVARIANT: StepRun in PostgreSQL settled to COMPENSATED
    const stepInDb = await db.stepRun.findUnique({
      where: { id: STEP_RUN_ID },
    });
    expect(stepInDb?.status).toBe("COMPENSATED");
    expect(stepInDb?.compensationClaimToken).toBeNull();

    // 3. INVARIANT: Vector entity head exists and is tombstoned in PostgreSQL
    const head = await db.vectorEntityHead.findUnique({
      where: {
        orgId_entityType_entityId: {
          orgId: ORG_ID,
          entityType: VectorEntityType.TASK,
          entityId: TASK_ID,
        },
      },
    });
    expect(head).not.toBeNull();
    expect(head?.isTombstone).toBe(true);
    expect(head?.activeGenId).toBeNull();

    // 4. INVARIANT: Durable compensation receipt in ExecutionAuditLog
    const receipt = await db.executionAuditLog.findFirst({
      where: {
        runId: RUN_ID,
        stepId: STEP_RUN_ID,
        eventType: "COMPENSATION_TASK_DELETED",
      },
    });
    expect(receipt).not.toBeNull();
    const payload = receipt?.payload as Record<string, unknown>;
    expect(payload?.taskId).toBe(TASK_ID);
    expect(payload?.orgId).toBe(ORG_ID);

    // 5. INVARIANT: advanceWorkflow converges run to ROLLED_BACK
    await advanceWorkflow(RUN_ID);
    const runInDb = await db.workflowRun.findUnique({
      where: { id: RUN_ID },
    });
    expect(runInDb?.status).toBe("ROLLED_BACK");
    expect(runInDb?.completedAt).not.toBeNull();
  });

  // =========================================================================
  // Scenario 2: Task with Comments Refuses Deletion in Real Neon DB
  // =========================================================================
  it("2. Task with user comments refuses deletion, preserves physical row in PostgreSQL, and settles to REQUIRES_INTERVENTION", async () => {
    const RUN_ID = `${TAG}_run_2`;
    const STEP_RUN_ID = `${TAG}_sr_task_2`;
    const TASK_ID = `${TAG}_task_with_comm_2`;
    const COMMENT_ID = `${TAG}_comm_2`;

    await db.workflowRun.create({
      data: {
        id: RUN_ID,
        workflowId: WORKFLOW_ID,
        status: "ROLLING_BACK",
      },
    });

    const createdTask = await db.task.create({
      data: {
        id: TASK_ID,
        projectId: PROJECT_ID,
        title: "Task With Comments Protected",
        status: "TODO",
        priority: "MEDIUM",
      },
    });

    // Create user comment on the task
    await db.comment.create({
      data: {
        id: COMMENT_ID,
        taskId: TASK_ID,
        userId: USER_ID,
        content: "Important discussion thread that must not be deleted",
      },
    });

    await db.stepRun.create({
      data: {
        id: STEP_RUN_ID,
        runId: RUN_ID,
        stepId: "step_task",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        inputs: { title: "Task With Comments Protected", projectId: PROJECT_ID },
        outputs: {
          taskId: TASK_ID,
          title: "Task With Comments Protected",
          projectId: PROJECT_ID,
          taskSnapshot: {
            title: createdTask.title,
            description: createdTask.description,
            status: createdTask.status,
            priority: createdTask.priority,
            projectId: createdTask.projectId,
            assigneeId: createdTask.assigneeId,
            createdAt: createdTask.createdAt.toISOString(),
            updatedAt: createdTask.updatedAt.toISOString(),
          },
        },
      },
    });

    const result = await wrapStepOperation(
      RUN_ID,
      "step_task",
      "task.create",
      "ACTION",
      undefined,
      "COMPENSATE"
    );

    expect(result.success).toBe(false);

    // 1. INVARIANT: Physical Task row MUST STILL EXIST in PostgreSQL
    const taskInDb = await db.task.findUnique({
      where: { id: TASK_ID },
    });
    expect(taskInDb).not.toBeNull();
    expect(taskInDb?.title).toBe("Task With Comments Protected");

    // 2. INVARIANT: Comment MUST STILL EXIST in PostgreSQL
    const commentInDb = await db.comment.findUnique({
      where: { id: COMMENT_ID },
    });
    expect(commentInDb).not.toBeNull();
    expect(commentInDb?.content).toContain("Important discussion thread");

    // 3. INVARIANT: StepRun transitioned to COMPENSATION_FAILED
    const stepInDb = await db.stepRun.findUnique({
      where: { id: STEP_RUN_ID },
    });
    expect(stepInDb?.status).toBe("COMPENSATION_FAILED");
    expect(stepInDb?.error).toContain("user comment(s)");

    // 4. INVARIANT: Workflow converges to REQUIRES_INTERVENTION
    await advanceWorkflow(RUN_ID);
    const runInDb = await db.workflowRun.findUnique({
      where: { id: RUN_ID },
    });
    expect(runInDb?.status).toBe("REQUIRES_INTERVENTION");
    expect(runInDb?.completedAt).not.toBeNull();
  });

  // =========================================================================
  // Scenario 7: Concurrent Mutation Detected via Snapshot Under Lock
  // =========================================================================
  it("7. Task field mutation detected under row lock refuses deletion, preserves task, and settles to REQUIRES_INTERVENTION", async () => {
    const RUN_ID = `${TAG}_run_7`;
    const STEP_RUN_ID = `${TAG}_sr_task_7`;
    const TASK_ID = `${TAG}_task_mutated_7`;

    await db.workflowRun.create({
      data: {
        id: RUN_ID,
        workflowId: WORKFLOW_ID,
        status: "ROLLING_BACK",
      },
    });

    const createdTask = await db.task.create({
      data: {
        id: TASK_ID,
        projectId: PROJECT_ID,
        title: "Original Task Title Before Mutation",
        status: "TODO",
        priority: "LOW",
      },
    });

    // StepRun snapshot has the original title
    await db.stepRun.create({
      data: {
        id: STEP_RUN_ID,
        runId: RUN_ID,
        stepId: "step_task",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        inputs: { title: "Original Task Title Before Mutation", projectId: PROJECT_ID },
        outputs: {
          taskId: TASK_ID,
          title: "Original Task Title Before Mutation",
          projectId: PROJECT_ID,
          taskSnapshot: {
            title: "Original Task Title Before Mutation",
            description: null,
            status: "TODO",
            priority: "LOW",
            projectId: PROJECT_ID,
            assigneeId: null,
            createdAt: createdTask.createdAt.toISOString(),
            updatedAt: createdTask.updatedAt.toISOString(),
          },
        },
      },
    });

    // User mutates task title in PostgreSQL!
    await db.task.update({
      where: { id: TASK_ID },
      data: { title: "Mutated Task Title By Colleague" },
    });

    const result = await wrapStepOperation(
      RUN_ID,
      "step_task",
      "task.create",
      "ACTION",
      undefined,
      "COMPENSATE"
    );

    expect(result.success).toBe(false);

    // 1. INVARIANT: Mutated task row MUST STILL EXIST in PostgreSQL
    const taskInDb = await db.task.findUnique({
      where: { id: TASK_ID },
    });
    expect(taskInDb).not.toBeNull();
    expect(taskInDb?.title).toBe("Mutated Task Title By Colleague");

    // 2. INVARIANT: StepRun transitioned to COMPENSATION_FAILED
    const stepInDb = await db.stepRun.findUnique({
      where: { id: STEP_RUN_ID },
    });
    expect(stepInDb?.status).toBe("COMPENSATION_FAILED");
    expect(stepInDb?.error).toContain("modified since creation");

    // 3. INVARIANT: Workflow converges to REQUIRES_INTERVENTION
    await advanceWorkflow(RUN_ID);
    const runInDb = await db.workflowRun.findUnique({
      where: { id: RUN_ID },
    });
    expect(runInDb?.status).toBe("REQUIRES_INTERVENTION");
  });

  // =========================================================================
  // Scenario 9: Crash-After-Delete Gap Recovery via Durable Receipt
  // =========================================================================
  it("9. Crash-after-delete retry detects durable receipt in ExecutionAuditLog and idempotently completes", async () => {
    const RUN_ID = `${TAG}_run_9`;
    const STEP_RUN_ID = `${TAG}_sr_task_9`;
    const TASK_ID = `${TAG}_task_crash_9`;

    await db.workflowRun.create({
      data: {
        id: RUN_ID,
        workflowId: WORKFLOW_ID,
        status: "ROLLING_BACK",
      },
    });

    // Task does NOT exist in db (already deleted)

    await db.stepRun.create({
      data: {
        id: STEP_RUN_ID,
        runId: RUN_ID,
        stepId: "step_task",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        inputs: { title: "Prior Deleted Task", projectId: PROJECT_ID },
        outputs: {
          taskId: TASK_ID,
          title: "Prior Deleted Task",
          projectId: PROJECT_ID,
        },
      },
    });

    // Durable receipt committed by prior attempt
    await db.executionAuditLog.create({
      data: {
        runId: RUN_ID,
        stepId: STEP_RUN_ID,
        logLevel: "INFO",
        eventType: "COMPENSATION_TASK_DELETED",
        message: `Task ${TASK_ID} safely deleted and vector tombstoned during saga rollback`,
        payload: {
          taskId: TASK_ID,
          title: "Prior Deleted Task",
          projectId: PROJECT_ID,
          orgId: ORG_ID,
          runId: RUN_ID,
          stepId: "step_task",
          stepRunId: STEP_RUN_ID,
        },
      },
    });

    const result = await wrapStepOperation(
      RUN_ID,
      "step_task",
      "task.create",
      "ACTION",
      undefined,
      "COMPENSATE"
    );

    expect(result.success).toBe(true);

    // StepRun settles to COMPENSATED
    const stepInDb = await db.stepRun.findUnique({
      where: { id: STEP_RUN_ID },
    });
    expect(stepInDb?.status).toBe("COMPENSATED");

    // Workflow converges to ROLLED_BACK
    await advanceWorkflow(RUN_ID);
    const runInDb = await db.workflowRun.findUnique({
      where: { id: RUN_ID },
    });
    expect(runInDb?.status).toBe("ROLLED_BACK");
  });
});
