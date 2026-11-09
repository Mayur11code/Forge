// src/tests/workflow/compensation-contract.test.ts
//
// F-02.2: Real Task Compensation & Safe Saga Reversal Unit/Double Test Suite.
//
// Invariants verified across 10 unit/double scenarios:
// Scenario 1: Basic task compensation (createTaskAction.compensate deletes task, settles to COMPENSATED, converges to ROLLED_BACK).
// Scenario 2: User-modified task (title changed -> refuses delete, task preserved, COMPENSATION_FAILED, REQUIRES_INTERVENTION).
// Scenario 3: Task status changed (status != TODO -> refuses delete, task preserved, COMPENSATION_FAILED, REQUIRES_INTERVENTION).
// Scenario 4: Task with comments (comments > 0 -> refuses delete, comments/task preserved, COMPENSATION_FAILED, REQUIRES_INTERVENTION).
// Scenario 5: Task with attachments (attachments > 0 -> refuses delete, attachments/task preserved, COMPENSATION_FAILED, REQUIRES_INTERVENTION).
// Scenario 6: Tenant mismatch (task belongs to another org -> refuses delete, COMPENSATION_FAILED, REQUIRES_INTERVENTION).
// Scenario 8: Duplicate compensation delivery (exclusive claim fencing prevents double execution).
// Scenario 9: Crash after task deletion (task missing but COMPENSATION_TASK_DELETED receipt exists -> idempotently completes to COMPENSATED).
// Scenario 10: Linear Saga A -> B -> C rollback (B compensated, A compensated with task deleted, converges to ROLLED_BACK).
// Scenario 11: Missing compensator for genuine uncompensated action (truthfully fails with COMPENSATION_FAILED, REQUIRES_INTERVENTION).

jest.mock("server-only", () => ({}));

jest.mock("@upstash/redis", () => ({
  Redis: { fromEnv: () => ({ set: jest.fn(), eval: jest.fn() }) },
}));

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: { trigger: jest.fn().mockResolvedValue(undefined) },
}));

const publishedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn((type: string, data: Record<string, unknown>) => {
    publishedEvents.push({ type, data });
    return Promise.resolve(undefined);
  }),
}));

jest.mock("@/lib/events/event-bus", () => ({
  dispatchEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/workflow/execution/mutex", () => ({
  acquireLock: jest.fn().mockResolvedValue("lock_token_contract_123"),
  releaseLock: jest.fn().mockResolvedValue(true),
  startRunLockHeartbeat: jest.fn().mockReturnValue({
    stop: jest.fn().mockResolvedValue(undefined),
    hasLostOwnership: jest.fn().mockReturnValue(false),
  }),
}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

import { NextRequest } from "next/server";
import { handleWorkflowEvent } from "@/app/api/workflow/wf";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { ActionRegistry } from "@/lib/workflow-types/action-registry";
import type { WorkflowAction } from "@/lib/workflow-types/type";
import { resetStore, restoreWorkflowDouble, store } from "./helpers/prisma-double";

describe("Real Task Compensation & Safe Saga Reversal (F-02.2)", () => {
  const RUN_ID = "run_f02_contract";
  const WORKFLOW_ID = "wf_f02_contract";
  const ORG_ID = "org_f02_test";
  const PROJECT_ID = "proj_f02_test";

  const realCompensateMock = jest.fn();
  const realExecuteMock = jest.fn();

  const realCompensatorAction: WorkflowAction = {
    id: "test.real_compensator",
    execute: realExecuteMock,
    compensate: realCompensateMock,
  };

  const missingCompensatorAction: WorkflowAction = {
    id: "test.missing_compensator",
    execute: jest.fn().mockResolvedValue({ success: true, data: { sideEffect: "active" } }),
  };

  beforeAll(() => {
    (ActionRegistry as Record<string, WorkflowAction>)["test.real_compensator"] = realCompensatorAction;
    (ActionRegistry as Record<string, WorkflowAction>)["test.missing_compensator"] = missingCompensatorAction;
  });

  afterAll(() => {
    delete (ActionRegistry as Record<string, unknown>)["test.real_compensator"];
    delete (ActionRegistry as Record<string, unknown>)["test.missing_compensator"];
    restoreWorkflowDouble();
  });

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    publishedEvents.length = 0;

    realExecuteMock.mockResolvedValue({ success: true, data: { fileCreated: "report.pdf" } });
    realCompensateMock.mockResolvedValue({ success: true, data: { fileDeleted: "report.pdf" } });

    // Seed default org and project
    store.projects.push({
      id: PROJECT_ID,
      orgId: ORG_ID,
      name: "Default Test Project",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  function createPostRequest(stepRunId: string, runId: string, kind = "ACTION") {
    return new NextRequest("http://localhost/api/workflow", {
      method: "POST",
      body: JSON.stringify({
        type: "EXECUTE_WORKFLOW_NODE",
        data: {
          runId,
          stepRunId,
          kind,
        },
      }),
    });
  }

  // =========================================================================
  // Scenario 1: Successful Task Compensation & Safe Deletion
  // =========================================================================
  it("Scenario 1: task.create rollback deletes unmodified task and converges to ROLLED_BACK", async () => {
    const TASK_ID = "task_clean_123";

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Task Compensation WF",
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
    });

    const createdAt = new Date();
    const updatedAt = new Date();

    store.tasks.push({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Clean Task",
      description: "Description",
      status: "TODO",
      priority: "MEDIUM",
      assigneeId: null,
      createdAt,
      updatedAt,
    });

    store.stepRuns.push({
      id: "sr_task_1",
      runId: RUN_ID,
      stepId: "step_task",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { title: "Clean Task", projectId: PROJECT_ID },
      outputs: {
        taskId: TASK_ID,
        title: "Clean Task",
        projectId: PROJECT_ID,
        taskSnapshot: {
          title: "Clean Task",
          description: "Description",
          status: "TODO",
          priority: "MEDIUM",
          projectId: PROJECT_ID,
          assigneeId: null,
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const req = createPostRequest("sr_task_1", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    // 1. Task row MUST be physically deleted from store
    const taskInStore = store.tasks.find((t) => t.id === TASK_ID);
    expect(taskInStore).toBeUndefined();

    // 2. StepRun settled to COMPENSATED
    const step = store.stepRuns.find((s) => s.id === "sr_task_1");
    expect(step?.status).toBe("COMPENSATED");
    expect(step?.compensationClaimToken).toBeNull();

    // 3. Durable receipt recorded in ExecutionAuditLog
    const receiptLog = store.auditLogs.find(
      (l) => l.stepId === "sr_task_1" && l.eventType === "COMPENSATION_TASK_DELETED"
    );
    expect(receiptLog).toBeDefined();
    const payload = receiptLog?.payload as Record<string, unknown>;
    expect(payload.taskId).toBe(TASK_ID);
    expect(payload.orgId).toBe(ORG_ID);

    // 4. Workflow converges to ROLLED_BACK
    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("ROLLED_BACK");
  });

  // =========================================================================
  // Scenario 2: User-Modified Task (Refuses Delete, Preserves Task)
  // =========================================================================
  it("Scenario 2: User-modified task is preserved, compensation fails, and run settles to REQUIRES_INTERVENTION", async () => {
    const TASK_ID = "task_modified_456";

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Task Compensation WF",
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
    });

    // Task was modified by user after creation!
    store.tasks.push({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "User Modified Title", // modified from "Original Title"
      description: "Description",
      status: "TODO",
      priority: "MEDIUM",
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    store.stepRuns.push({
      id: "sr_task_mod",
      runId: RUN_ID,
      stepId: "step_task",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { title: "Original Title", projectId: PROJECT_ID },
      outputs: {
        taskId: TASK_ID,
        title: "Original Title",
        projectId: PROJECT_ID,
        taskSnapshot: {
          title: "Original Title",
          description: "Description",
          status: "TODO",
          priority: "MEDIUM",
          projectId: PROJECT_ID,
          assigneeId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const req = createPostRequest("sr_task_mod", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    // 1. Invariant: Task row MUST be preserved
    const taskInStore = store.tasks.find((t) => t.id === TASK_ID);
    expect(taskInStore).toBeDefined();
    expect(taskInStore?.title).toBe("User Modified Title");

    // 2. StepRun transitioned to COMPENSATION_FAILED
    const step = store.stepRuns.find((s) => s.id === "sr_task_mod");
    expect(step?.status).toBe("COMPENSATION_FAILED");
    expect(step?.error).toContain("modified");

    // 3. Workflow settles to REQUIRES_INTERVENTION
    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("REQUIRES_INTERVENTION");
  });

  // =========================================================================
  // Scenario 3: Task Status Changed (e.g. IN_PROGRESS)
  // =========================================================================
  it("Scenario 3: Task status changed to IN_PROGRESS refuses deletion and preserves task", async () => {
    const TASK_ID = "task_status_789";

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Task Compensation WF",
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
    });

    // Task is in progress!
    store.tasks.push({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Active Task",
      description: null,
      status: "IN_PROGRESS",
      priority: "HIGH",
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    store.stepRuns.push({
      id: "sr_task_status",
      runId: RUN_ID,
      stepId: "step_task",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { title: "Active Task", projectId: PROJECT_ID },
      outputs: {
        taskId: TASK_ID,
        title: "Active Task",
        taskSnapshot: {
          title: "Active Task",
          description: null,
          status: "TODO",
          priority: "HIGH",
          projectId: PROJECT_ID,
          assigneeId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const req = createPostRequest("sr_task_status", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    // Task preserved
    const taskInStore = store.tasks.find((t) => t.id === TASK_ID);
    expect(taskInStore).toBeDefined();
    expect(taskInStore?.status).toBe("IN_PROGRESS");

    const step = store.stepRuns.find((s) => s.id === "sr_task_status");
    expect(step?.status).toBe("COMPENSATION_FAILED");
    expect(step?.error).toContain("status has changed to IN_PROGRESS");

    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("REQUIRES_INTERVENTION");
  });

  // =========================================================================
  // Scenario 4: Inbound Relations Check — Comments Exist
  // =========================================================================
  it("Scenario 4: Task with user comments refuses deletion to protect comment data", async () => {
    const TASK_ID = "task_with_comments";

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Task Compensation WF",
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
    });

    store.tasks.push({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Commented Task",
      description: null,
      status: "TODO",
      priority: "LOW",
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // User added a comment
    store.comments.push({
      id: "comm_1",
      taskId: TASK_ID,
      content: "Do not delete this!",
      createdAt: new Date(),
    });

    store.stepRuns.push({
      id: "sr_task_comm",
      runId: RUN_ID,
      stepId: "step_task",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { title: "Commented Task", projectId: PROJECT_ID },
      outputs: {
        taskId: TASK_ID,
        title: "Commented Task",
        taskSnapshot: {
          title: "Commented Task",
          description: null,
          status: "TODO",
          priority: "LOW",
          projectId: PROJECT_ID,
          assigneeId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const req = createPostRequest("sr_task_comm", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    // Both task and comment preserved
    expect(store.tasks.find((t) => t.id === TASK_ID)).toBeDefined();
    expect(store.comments.find((c) => c.taskId === TASK_ID)).toBeDefined();

    const step = store.stepRuns.find((s) => s.id === "sr_task_comm");
    expect(step?.status).toBe("COMPENSATION_FAILED");
    expect(step?.error).toContain("user comment(s)");

    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("REQUIRES_INTERVENTION");
  });

  // =========================================================================
  // Scenario 5: Inbound Relations Check — Attachments Exist
  // =========================================================================
  it("Scenario 5: Task with user attachments refuses deletion to protect files", async () => {
    const TASK_ID = "task_with_attachments";

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Task Compensation WF",
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
    });

    store.tasks.push({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Attached Task",
      description: null,
      status: "TODO",
      priority: "LOW",
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // User attached a file
    store.attachments.push({
      id: "att_1",
      taskId: TASK_ID,
      fileName: "requirements.pdf",
      createdAt: new Date(),
    });

    store.stepRuns.push({
      id: "sr_task_att",
      runId: RUN_ID,
      stepId: "step_task",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { title: "Attached Task", projectId: PROJECT_ID },
      outputs: {
        taskId: TASK_ID,
        title: "Attached Task",
        taskSnapshot: {
          title: "Attached Task",
          description: null,
          status: "TODO",
          priority: "LOW",
          projectId: PROJECT_ID,
          assigneeId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const req = createPostRequest("sr_task_att", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    // Both task and attachment preserved
    expect(store.tasks.find((t) => t.id === TASK_ID)).toBeDefined();
    expect(store.attachments.find((a) => a.taskId === TASK_ID)).toBeDefined();

    const step = store.stepRuns.find((s) => s.id === "sr_task_att");
    expect(step?.status).toBe("COMPENSATION_FAILED");
    expect(step?.error).toContain("user attachment(s)");

    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("REQUIRES_INTERVENTION");
  });

  // =========================================================================
  // Scenario 6: Tenant Mismatch
  // =========================================================================
  it("Scenario 6: Cross-tenant task compensation attempt is rejected and preserved", async () => {
    const TASK_ID = "task_other_org";
    const OTHER_ORG_ID = "org_other_foreign";
    const OTHER_PROJ_ID = "proj_other_foreign";

    store.projects.push({
      id: OTHER_PROJ_ID,
      orgId: OTHER_ORG_ID,
      name: "Other Org Project",
    });

    store.tasks.push({
      id: TASK_ID,
      projectId: OTHER_PROJ_ID,
      title: "Foreign Task",
      status: "TODO",
      priority: "MEDIUM",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID, // Workflow belongs to ORG_ID, but task belongs to OTHER_ORG_ID
      name: "Task Compensation WF",
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
    });

    store.stepRuns.push({
      id: "sr_task_tenant",
      runId: RUN_ID,
      stepId: "step_task",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { title: "Foreign Task", projectId: OTHER_PROJ_ID },
      outputs: {
        taskId: TASK_ID,
        title: "Foreign Task",
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const req = createPostRequest("sr_task_tenant", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    // Foreign task preserved
    expect(store.tasks.find((t) => t.id === TASK_ID)).toBeDefined();

    const step = store.stepRuns.find((s) => s.id === "sr_task_tenant");
    expect(step?.status).toBe("COMPENSATION_FAILED");
    expect(step?.error).toContain("Tenant mismatch");

    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("REQUIRES_INTERVENTION");
  });

  // =========================================================================
  // Scenario 8: Duplicate Compensation Delivery Fencing
  // =========================================================================
  it("Scenario 8: Duplicate compensation delivery while actively COMPENSATING is skipped safely", async () => {
    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.stepRuns.push({
      id: "sr_dup_active",
      runId: RUN_ID,
      stepId: "step_task",
      status: "COMPENSATING",
      attempts: 1,
      compensationAttempts: 1,
      compensationClaimToken: "active_token_other_worker",
      compensationLeaseExpiresAt: new Date(Date.now() + 60_000), // active lease
      inputs: {},
      outputs: { taskId: "task_any" },
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Duplicate Delivery WF",
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
    });

    const req = createPostRequest("sr_dup_active", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("In progress");

    const step = store.stepRuns.find((s) => s.id === "sr_dup_active");
    expect(step?.status).toBe("COMPENSATING");
    expect(step?.compensationClaimToken).toBe("active_token_other_worker");
  });

  // =========================================================================
  // Scenario 9: Crash-After-Delete Recovery with Durable Receipt
  // =========================================================================
  it("Scenario 9: Crash-after-delete retry detects COMPENSATION_TASK_DELETED receipt and safely completes", async () => {
    const TASK_ID = "task_already_deleted_123";

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Crash Recovery WF",
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
    });

    // Task is NOT in store.tasks (already deleted by prior attempt)

    // But durable receipt EXISTS in auditLogs:
    store.auditLogs.push({
      id: "audit_receipt_1",
      runId: RUN_ID,
      stepId: "sr_crash_retry",
      eventType: "COMPENSATION_TASK_DELETED",
      logLevel: "INFO",
      payload: {
        taskId: TASK_ID,
        title: "Deleted Task",
        projectId: PROJECT_ID,
        orgId: ORG_ID,
      },
      createdAt: new Date(),
    });

    store.stepRuns.push({
      id: "sr_crash_retry",
      runId: RUN_ID,
      stepId: "step_task",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { title: "Deleted Task", projectId: PROJECT_ID },
      outputs: {
        taskId: TASK_ID,
        title: "Deleted Task",
      },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const req = createPostRequest("sr_crash_retry", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    // StepRun settles to COMPENSATED idempotently!
    const step = store.stepRuns.find((s) => s.id === "sr_crash_retry");
    expect(step?.status).toBe("COMPENSATED");

    // Workflow converges to ROLLED_BACK
    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("ROLLED_BACK");
  });

  // =========================================================================
  // Scenario 10: Linear Saga A -> B -> C Rollback
  // =========================================================================
  it("Scenario 10: Saga A -> B -> C: Step C fails, Step B compensated, Step A task deleted, converges to ROLLED_BACK", async () => {
    const TASK_ID = "task_saga_clean";

    store.tasks.push({
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: "Saga Task",
      description: null,
      status: "TODO",
      priority: "MEDIUM",
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {
        step_a: { taskId: TASK_ID },
        step_b: { reportId: "rep_123" },
      },
      contextVersion: 2,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.stepRuns.push(
      {
        id: "sr_step_a",
        runId: RUN_ID,
        stepId: "step_a",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        compensationClaimToken: null,
        compensationLeaseExpiresAt: null,
        inputs: { title: "Saga Task", projectId: PROJECT_ID },
        outputs: {
          taskId: TASK_ID,
          title: "Saga Task",
          taskSnapshot: {
            title: "Saga Task",
            description: null,
            status: "TODO",
            priority: "MEDIUM",
            projectId: PROJECT_ID,
            assigneeId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        startedAt: new Date(),
        completedAt: new Date(),
      },
      {
        id: "sr_step_b",
        runId: RUN_ID,
        stepId: "step_b",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        compensationClaimToken: null,
        compensationLeaseExpiresAt: null,
        inputs: { reportName: "Summary" },
        outputs: { fileCreated: "report.pdf" },
        startedAt: new Date(),
        completedAt: new Date(),
      },
      {
        id: "sr_step_c",
        runId: RUN_ID,
        stepId: "step_c",
        status: "FAILED",
        attempts: 3,
        compensationAttempts: 0,
        compensationClaimToken: null,
        compensationLeaseExpiresAt: null,
        inputs: {},
        outputs: null,
        startedAt: new Date(),
        completedAt: new Date(),
        error: "Downstream API failure",
      }
    );

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Saga A-B-C Workflow",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_a: {
            id: "step_a",
            kind: "ACTION",
            action: "task.create",
            dependsOn: [],
          },
          step_b: {
            id: "step_b",
            kind: "ACTION",
            action: "test.real_compensator",
            dependsOn: ["step_a"],
          },
          step_c: {
            id: "step_c",
            kind: "ACTION",
            action: "test.real_compensator",
            dependsOn: ["step_b"],
          },
        },
      },
    });

    // 1. Advance workflow: evaluator selects step_b first (reverse topological)
    await advanceWorkflow(RUN_ID);

    const bEvents = publishedEvents.filter(
      (e) => e.type === "EXECUTE_WORKFLOW_NODE" && e.data.stepRunId === "sr_step_b"
    );
    expect(bEvents.length).toBe(1);

    // 2. Deliver compensation for step_b
    const reqB = createPostRequest("sr_step_b", RUN_ID);
    await handleWorkflowEvent(reqB);

    const stepB = store.stepRuns.find((s) => s.id === "sr_step_b");
    expect(stepB?.status).toBe("COMPENSATED");
    expect(realCompensateMock).toHaveBeenCalledTimes(1);

    // 3. Deliver compensation for step_a (unblocked by step_b completion)
    const aEvents = publishedEvents.filter(
      (e) => e.type === "EXECUTE_WORKFLOW_NODE" && e.data.stepRunId === "sr_step_a"
    );
    expect(aEvents.length).toBe(1);

    const reqA = createPostRequest("sr_step_a", RUN_ID);
    await handleWorkflowEvent(reqA);

    const stepA = store.stepRuns.find((s) => s.id === "sr_step_a");
    expect(stepA?.status).toBe("COMPENSATED");

    // Task must be deleted!
    expect(store.tasks.find((t) => t.id === TASK_ID)).toBeUndefined();

    // 4. Run must converge to ROLLED_BACK!
    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("ROLLED_BACK");
    expect(run?.completedAt).not.toBeNull();
  });

  // =========================================================================
  // Scenario 11: Missing Compensator for Genuine Uncompensated Action
  // =========================================================================
  it("Scenario 11: Action without compensator fails truthfully and forces REQUIRES_INTERVENTION", async () => {
    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.stepRuns.push({
      id: "sr_missing_action",
      runId: RUN_ID,
      stepId: "step_uncomp",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { sensitiveToken: "super_secret", normalField: "ok" },
      outputs: { generatedId: "gen_123" },
      startedAt: new Date(),
      completedAt: new Date(),
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_ID,
      name: "Uncompensated Action WF",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_uncomp: {
            id: "step_uncomp",
            kind: "ACTION",
            action: "test.missing_compensator",
            dependsOn: [],
          },
        },
      },
    });

    const req = createPostRequest("sr_missing_action", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);

    const step = store.stepRuns.find((s) => s.id === "sr_missing_action");
    expect(step?.status).toBe("COMPENSATION_FAILED");
    expect(step?.error).toContain("has no compensator");

    // Failure evidence in audit log
    const failedLog = store.auditLogs.find(
      (l) => l.stepId === "sr_missing_action" && l.eventType === "COMPENSATION_FAILED"
    );
    expect(failedLog).toBeDefined();
    expect(failedLog?.logLevel).toBe("FATAL");

    const payload = failedLog?.payload as Record<string, unknown>;
    expect(payload.actionId).toBe("test.missing_compensator");
    expect(payload.reason).toBe("UNCOMPENSATED_ACTION");
    expect(payload.outputs).toEqual({ generatedId: "gen_123" });

    // Inputs have secret redacted
    const inputs = payload.inputs as Record<string, unknown>;
    expect(inputs.sensitiveToken).toBe("[REDACTED]");
    expect(inputs.normalField).toBe("ok");

    // Run converges to REQUIRES_INTERVENTION
    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("REQUIRES_INTERVENTION");
  });
});
