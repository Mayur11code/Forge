// src/tests/workflow/workflow-saga-rollback.test.ts
//
// End-to-end Saga rollback and compensation test suite (F-01 and F-05A).
// Covers all 8 specified scenarios:
// 1. Complete linear rollback A -> B -> C with convergence to ROLLED_BACK.
// 2. Forward execution regression guard (RUNNING / PENDING -> EXECUTE).
// 3. Duplicate delivery during compensation (rejected with "In progress").
// 4. Retry of retriable compensation failure (parks in COMPENSATION_RETRYING, responds 500).
// 5. Stale worker fencing on claim token.
// 6. Trigger node rollback handling (transitions to COMPENSATED, not SUCCESS).
// 7. Terminal compensation failure (transitions to COMPENSATION_FAILED, converges to REQUIRES_INTERVENTION).
// 8. Reverse dependency ordering verification (children must compensate before parents).

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

jest.mock("@/lib/workflow/execution/mutex", () => ({
  acquireLock: jest.fn().mockResolvedValue("lock_token_123"),
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

import { NextRequest } from "next/server";
import { handleWorkflowEvent } from "@/app/api/workflow/wf";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { completeCompensationAttempt } from "@/lib/workflow/execution/compensation-claim";
import { ActionRegistry } from "@/lib/workflow-types/action-registry";
import type { WorkflowAction } from "@/lib/workflow-types/type";
import { resetStore, restoreWorkflowDouble, store } from "./helpers/prisma-double";

describe("Workflow Saga Rollback & Compensation Execution (F-01 & F-05A)", () => {
  const RUN_ID = "run_saga_e2e";
  const WORKFLOW_ID = "wf_saga_e2e";

  const compensateMock = jest.fn();
  const executeMock = jest.fn();

  const testAction: WorkflowAction = {
    id: "test.saga_compensate",
    execute: executeMock,
    compensate: compensateMock,
  };

  beforeAll(() => {
    (ActionRegistry as Record<string, WorkflowAction>)["test.saga_compensate"] = testAction;
  });

  afterAll(() => {
    delete (ActionRegistry as Record<string, unknown>)["test.saga_compensate"];
    restoreWorkflowDouble();
  });

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    publishedEvents.length = 0;

    executeMock.mockResolvedValue({ success: true, data: { result: "forward_ok" } });
    compensateMock.mockResolvedValue({ success: true, data: { result: "compensated_ok" } });
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

  // -------------------------------------------------------------------------
  // Scenario 1: Complete linear rollback A -> B -> C converges to ROLLED_BACK
  // -------------------------------------------------------------------------
  it("Scenario 1: Complete linear rollback executes in reverse order and converges to ROLLED_BACK", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "linear-abc",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_a: { id: "step_a", action: "test.saga_compensate", dependsOn: [], kind: "ACTION" },
          step_b: { id: "step_b", action: "test.saga_compensate", dependsOn: ["step_a"], kind: "ACTION" },
          step_c: { id: "step_c", action: "test.saga_compensate", dependsOn: ["step_b"], kind: "ACTION" },
        },
      },
      orgId: "org_1",
      eventId: null,
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

    // Step A and B succeeded; C failed triggering rollback
    store.stepRuns.push(
      {
        id: "sr_a",
        runId: RUN_ID,
        stepId: "step_a",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        inputs: { step: "a" },
        outputs: { res: "ok_a" },
      },
      {
        id: "sr_b",
        runId: RUN_ID,
        stepId: "step_b",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
        inputs: { step: "b" },
        outputs: { res: "ok_b" },
      },
      {
        id: "sr_c",
        runId: RUN_ID,
        stepId: "step_c",
        status: "FAILED",
        attempts: 1,
        compensationAttempts: 0,
        error: "Action C crashed",
      }
    );

    // 1. Advance evaluator: B is the leaf of successful steps, so B must be published first
    await advanceWorkflow(RUN_ID);

    const nodeEvents1 = publishedEvents.filter((e) => e.type === "EXECUTE_WORKFLOW_NODE");
    expect(nodeEvents1).toHaveLength(1);
    expect(nodeEvents1[0].data.stepRunId).toBe("sr_b");

    // 2. Worker executes compensation for B
    const reqB = createPostRequest("sr_b", RUN_ID);
    const resB = await handleWorkflowEvent(reqB);
    expect(resB.status).toBe(200);

    const stepB = store.stepRuns.find((s) => s.id === "sr_b");
    expect(stepB?.status).toBe("COMPENSATED");

    // 3. Evaluator evaluates again: now A is ready to compensate
    publishedEvents.length = 0;
    await advanceWorkflow(RUN_ID);

    const nodeEvents2 = publishedEvents.filter((e) => e.type === "EXECUTE_WORKFLOW_NODE");
    expect(nodeEvents2).toHaveLength(1);
    expect(nodeEvents2[0].data.stepRunId).toBe("sr_a");

    // 4. Worker executes compensation for A
    const reqA = createPostRequest("sr_a", RUN_ID);
    const resA = await handleWorkflowEvent(reqA);
    expect(resA.status).toBe(200);

    const stepA = store.stepRuns.find((s) => s.id === "sr_a");
    expect(stepA?.status).toBe("COMPENSATED");

    // 5. Final evaluator convergence check: all steps are COMPENSATED or FAILED
    await advanceWorkflow(RUN_ID);

    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("ROLLED_BACK");
    expect(run?.completedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Forward execution regression guard
  // -------------------------------------------------------------------------
  it("Scenario 2: Forward execution executes PENDING steps forward and updates context", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "forward-wf",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_fwd: { id: "step_fwd", action: "test.saga_compensate", dependsOn: [], kind: "ACTION" },
        },
      },
      orgId: "org_1",
      eventId: null,
    });

    store.runs.push({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: "RUNNING",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    store.stepRuns.push({
      id: "sr_fwd",
      runId: RUN_ID,
      stepId: "step_fwd",
      status: "PENDING",
      attempts: 0,
      compensationAttempts: 0,
    });

    const req = createPostRequest("sr_fwd", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Execution Complete");
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(compensateMock).not.toHaveBeenCalled();

    const step = store.stepRuns.find((s) => s.id === "sr_fwd");
    expect(step?.status).toBe("SUCCESS");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Duplicate delivery during compensation
  // -------------------------------------------------------------------------
  it("Scenario 3: Duplicate delivery while step is COMPENSATING is rejected with 'In progress'", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "dup-wf",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_a: { id: "step_a", action: "test.saga_compensate", dependsOn: [], kind: "ACTION" },
        },
      },
      orgId: "org_1",
      eventId: null,
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

    store.stepRuns.push({
      id: "sr_dup",
      runId: RUN_ID,
      stepId: "step_a",
      status: "COMPENSATING",
      attempts: 1,
      compensationAttempts: 1,
      compensationClaimToken: "active_token_xyz",
      compensationLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const req = createPostRequest("sr_dup", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("In progress");
    expect(compensateMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Retry of retriable compensation failure
  // -------------------------------------------------------------------------
  it("Scenario 4: Retriable compensation failure parks in COMPENSATION_RETRYING and returns 500", async () => {
    compensateMock.mockResolvedValueOnce({
      success: false,
      isRetriable: true,
      error: "Temporary external network timeout",
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      name: "retry-wf",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_a: { id: "step_a", action: "test.saga_compensate", dependsOn: [], kind: "ACTION" },
        },
      },
      orgId: "org_1",
      eventId: null,
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

    store.stepRuns.push({
      id: "sr_retry",
      runId: RUN_ID,
      stepId: "step_a",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
    });

    const req = createPostRequest("sr_retry", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Retrying");

    const step = store.stepRuns.find((s) => s.id === "sr_retry");
    expect(step?.status).toBe("COMPENSATION_RETRYING");
    expect(step?.compensationAttempts).toBe(1);
    expect(step?.compensationClaimToken).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Stale worker fencing on claim token
  // -------------------------------------------------------------------------
  it("Scenario 5: Stale worker with old token cannot complete or overwrite newer claim", async () => {
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
      id: "sr_fence",
      runId: RUN_ID,
      stepId: "step_a",
      status: "COMPENSATING",
      attempts: 1,
      compensationAttempts: 2,
      compensationClaimToken: "valid_token_2",
      compensationLeaseExpiresAt: new Date(Date.now() + 60_000),
    });

    // Stale worker with "stale_token_1" tries to complete
    const outcome = await completeCompensationAttempt({
      stepRunId: "sr_fence",
      runId: RUN_ID,
      claimToken: "stale_token_1",
    });

    expect(outcome.completed).toBe(false);

    const step = store.stepRuns.find((s) => s.id === "sr_fence");
    expect(step?.status).toBe("COMPENSATING");
    expect(step?.compensationClaimToken).toBe("valid_token_2");
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Trigger node handling during rollback
  // -------------------------------------------------------------------------
  it("Scenario 6: Trigger node transitions to COMPENSATED during rollback without action call", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "trigger-wf",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          trigger_1: { id: "trigger_1", action: "trigger.webhook", dependsOn: [], kind: "TRIGGER" },
        },
      },
      orgId: "org_1",
      eventId: null,
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

    store.stepRuns.push({
      id: "sr_trig",
      runId: RUN_ID,
      stepId: "trigger_1",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
    });

    const req = createPostRequest("sr_trig", RUN_ID, "TRIGGER");
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200);
    expect(compensateMock).not.toHaveBeenCalled();

    const step = store.stepRuns.find((s) => s.id === "sr_trig");
    expect(step?.status).toBe("COMPENSATED");
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Terminal compensation failure converges to REQUIRES_INTERVENTION
  // -------------------------------------------------------------------------
  it("Scenario 7: Fatal compensation failure transitions to COMPENSATION_FAILED and converges to REQUIRES_INTERVENTION", async () => {
    compensateMock.mockResolvedValueOnce({
      success: false,
      isRetriable: false,
      error: "External payment refund permanently refused",
    });

    store.workflows.push({
      id: WORKFLOW_ID,
      name: "intervention-wf",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_a: { id: "step_a", action: "test.saga_compensate", dependsOn: [], kind: "ACTION" },
        },
      },
      orgId: "org_1",
      eventId: null,
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

    store.stepRuns.push({
      id: "sr_fatal",
      runId: RUN_ID,
      stepId: "step_a",
      status: "SUCCESS",
      attempts: 1,
      compensationAttempts: 0,
    });

    const req = createPostRequest("sr_fatal", RUN_ID);
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200); // 200 acknowledges QStash message because failure is terminal

    const step = store.stepRuns.find((s) => s.id === "sr_fatal");
    expect(step?.status).toBe("COMPENSATION_FAILED");

    // Evaluator pass: with a COMPENSATION_FAILED step, the run converges to REQUIRES_INTERVENTION
    await advanceWorkflow(RUN_ID);

    const run = store.runs.find((r) => r.id === RUN_ID);
    expect(run?.status).toBe("REQUIRES_INTERVENTION");
    expect(run?.completedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Scenario 8: Reverse dependency ordering verification
  // -------------------------------------------------------------------------
  it("Scenario 8: Evaluator strictly enforces reverse dependency ordering during rollback", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "order-wf",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_1: { id: "step_1", action: "test.saga_compensate", dependsOn: [], kind: "ACTION" },
          step_2: { id: "step_2", action: "test.saga_compensate", dependsOn: ["step_1"], kind: "ACTION" },
        },
      },
      orgId: "org_1",
      eventId: null,
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

    store.stepRuns.push(
      {
        id: "sr_1",
        runId: RUN_ID,
        stepId: "step_1",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
      },
      {
        id: "sr_2",
        runId: RUN_ID,
        stepId: "step_2",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
      }
    );

    // Initial pass: only step_2 (the leaf) must be dispatched. step_1 has a child that is still SUCCESS
    await advanceWorkflow(RUN_ID);

    const nodeEvents1 = publishedEvents.filter((e) => e.type === "EXECUTE_WORKFLOW_NODE");
    expect(nodeEvents1).toHaveLength(1);
    expect(nodeEvents1[0].data.stepRunId).toBe("sr_2");

    // While step_2 is COMPENSATING, step_1 MUST NOT be dispatched
    store.stepRuns.find((s) => s.id === "sr_2")!.status = "COMPENSATING";
    publishedEvents.length = 0;
    await advanceWorkflow(RUN_ID);
    const nodeEvents2 = publishedEvents.filter((e) => e.type === "EXECUTE_WORKFLOW_NODE");
    expect(nodeEvents2).toHaveLength(0);

    // Once step_2 is COMPENSATED, step_1 is now eligible
    store.stepRuns.find((s) => s.id === "sr_2")!.status = "COMPENSATED";
    publishedEvents.length = 0;
    await advanceWorkflow(RUN_ID);

    const nodeEvents3 = publishedEvents.filter((e) => e.type === "EXECUTE_WORKFLOW_NODE");
    expect(nodeEvents3).toHaveLength(1);
    expect(nodeEvents3[0].data.stepRunId).toBe("sr_1");
  });
});
