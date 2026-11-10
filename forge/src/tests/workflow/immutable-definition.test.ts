// src/tests/workflow/immutable-definition.test.ts
//
// F-03 Unit Acceptance Test Suite
// Verifies immutable execution contract, action version pinning, canonical hashing,
// and runtime isolation against acceptance matrix items F03-01 to F03-14, F03-16 to F03-18.

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/redis/client", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { redisDouble } = require("./helpers/redis-double");
  return { redis: redisDouble };
});

jest.mock("@upstash/redis", () => ({
  Redis: { fromEnv: () => ({ set: jest.fn(), eval: jest.fn() }) },
}));

const publishedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn(async (type: string, data: Record<string, unknown>) => {
    publishedEvents.push({ type, data });
  }),
}));

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: {
    trigger: jest.fn().mockResolvedValue({}),
  },
}));

import { NextRequest } from "next/server";
import { db } from "@/lib/prisma/db";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import {
  ActionRegistry,
  registerAction,
  formatActionKey,
  parseActionKey,
  getAction,
} from "@/lib/workflow-types/action-registry";
import type { WorkflowAction } from "@/lib/workflow-types/type";
import {
  computeWorkflowDefinitionHash,
  verifyWorkflowSnapshotIntegrity,
  canonicalizeJson,
  buildCanonicalExecutionPayload,
} from "@/lib/workflow/validation/canonical-hash";
import {
  WorkflowExecutionSnapshot,
} from "@/lib/workflow-types/snapshot";
import { resetStore, store } from "./helpers/prisma-double";

describe("F-03: Immutable Workflow Execution Contract & Action Version Pinning", () => {
  const ORG_ID = "org_f03_test";
  const WORKFLOW_ID = "wf_f03_test";
  const PROJECT_ID = "cmnj8u44p0003a0gcvqgt25dv";

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

  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    publishedEvents.length = 0;

    // Seed default project for task.create actions
    store.projects.push({
      id: PROJECT_ID,
      name: "Default Test Project",
      orgId: ORG_ID,
    });
  });

  // -------------------------------------------------------------------------
  // F03-09: Canonical JSON serialization & key order independence
  // -------------------------------------------------------------------------
  it("F03-09: Canonically equivalent JSON key reordering produces the same hash", () => {
    const objA = { z: 1, a: 2, m: { y: "hello", b: "world" } };
    const objB = { a: 2, m: { b: "world", y: "hello" }, z: 1 };

    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));

    const snapshotA: WorkflowExecutionSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: "wf_1",
      workflowName: "Canonical Test",
      definition: {
        id: "d1",
        name: "Test",
        steps: {
          step_1: { id: "step_1", action: "task.create", dependsOn: [], kind: "ACTION", isCritical: false, config: { title: "T1", priority: "HIGH" } },
        },
      },
      actionManifest: [{ stepId: "step_1", actionId: "task.create", actionVersion: "1.0.0" }],
      createdAt: "2026-11-10T12:00:00.000Z",
    };

    const snapshotB: WorkflowExecutionSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: "wf_1",
      workflowName: "Canonical Test",
      definition: {
        name: "Test",
        id: "d1",
        steps: {
          step_1: { config: { priority: "HIGH", title: "T1" }, dependsOn: [], kind: "ACTION", isCritical: false, id: "step_1", action: "task.create" },
        },
      },
      actionManifest: [{ actionVersion: "1.0.0", actionId: "task.create", stepId: "step_1" }],
      createdAt: "2026-11-10T12:00:00.000Z",
    };

    expect(computeWorkflowDefinitionHash(snapshotA)).toBe(computeWorkflowDefinitionHash(snapshotB));
  });

  // -------------------------------------------------------------------------
  // F03-10: UI-only presentation changes do not affect canonical hash
  // -------------------------------------------------------------------------
  it("F03-10: UI-only layout changes do not affect hash", () => {
    const baseSnapshot: WorkflowExecutionSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: "wf_1",
      workflowName: "UI Test",
      definition: {
        id: "d1",
        name: "Test",
        steps: {
          step_1: { id: "step_1", action: "task.create", dependsOn: [], kind: "ACTION", isCritical: false, config: { title: "Task" } },
        },
      },
      actionManifest: [{ stepId: "step_1", actionId: "task.create", actionVersion: "1.0.0" }],
      createdAt: "2026-11-10T12:00:00.000Z",
    };

    const layoutChangedSnapshot: WorkflowExecutionSnapshot = {
      ...baseSnapshot,
      definition: {
        ...baseSnapshot.definition,
        steps: {
          step_1: {
            ...baseSnapshot.definition.steps.step_1,
            config: {
              title: "Task",
              position: { x: 500, y: 750 },
              width: 250,
              height: 100,
            },
          },
        },
      },
    };

    expect(computeWorkflowDefinitionHash(baseSnapshot)).toBe(
      computeWorkflowDefinitionHash(layoutChangedSnapshot),
    );
  });

  // -------------------------------------------------------------------------
  // F03-11: Changing execution-relevant configuration changes hash
  // -------------------------------------------------------------------------
  it("F03-11: Changing execution-relevant configuration affects hash", () => {
    const snapshot1: WorkflowExecutionSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: "wf_1",
      workflowName: "Exec Test",
      definition: {
        id: "d1",
        name: "Test",
        steps: {
          step_1: { id: "step_1", action: "task.create", dependsOn: [], kind: "ACTION", isCritical: false, config: { title: "Original" } },
        },
      },
      actionManifest: [{ stepId: "step_1", actionId: "task.create", actionVersion: "1.0.0" }],
      createdAt: "2026-11-10T12:00:00.000Z",
    };

    const snapshot2: WorkflowExecutionSnapshot = {
      ...snapshot1,
      definition: {
        ...snapshot1.definition,
        steps: {
          step_1: {
            ...snapshot1.definition.steps.step_1,
            config: { title: "Modified Title" },
          },
        },
      },
    };

    expect(computeWorkflowDefinitionHash(snapshot1)).not.toBe(
      computeWorkflowDefinitionHash(snapshot2),
    );
  });

  // -------------------------------------------------------------------------
  // F03-12: Corrupt or tampered snapshot without updating hash is rejected
  // -------------------------------------------------------------------------
  it("F03-12: Corrupt or tampered snapshot without updating hash is rejected", () => {
    const snapshot: WorkflowExecutionSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: "wf_1",
      workflowName: "Integrity Test",
      definition: {
        id: "d1",
        name: "Test",
        steps: {
          step_1: { id: "step_1", action: "task.create", dependsOn: [], kind: "ACTION", isCritical: false, config: { title: "Original" } },
        },
      },
      actionManifest: [{ stepId: "step_1", actionId: "task.create", actionVersion: "1.0.0" }],
      createdAt: "2026-11-10T12:00:00.000Z",
    };

    const validHash = computeWorkflowDefinitionHash(snapshot);
    const validResult = verifyWorkflowSnapshotIntegrity(snapshot, validHash);
    expect(validResult.valid).toBe(true);

    // Tamper with the snapshot step action
    const tamperedSnapshot = {
      ...snapshot,
      definition: {
        ...snapshot.definition,
        steps: {
          step_1: { ...snapshot.definition.steps.step_1, action: "malicious.action" },
        },
      },
    };

    const tamperedResult = verifyWorkflowSnapshotIntegrity(tamperedSnapshot, validHash);
    expect(tamperedResult.valid).toBe(false);
    if (!tamperedResult.valid) {
      expect(tamperedResult.code).toBe("HASH_MISMATCH");
    }
  });

  // -------------------------------------------------------------------------
  // F03-13 & F03-14: Missing snapshot on active run fails closed to intervention
  // -------------------------------------------------------------------------
  it("F03-13 & F03-14: Active run without snapshot fails closed to REQUIRES_INTERVENTION", async () => {
    store.workflows.push({
      id: "wf_legacy",
      name: "Legacy Workflow",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_1: { id: "step_1", action: "task.create", dependsOn: [], kind: "ACTION" },
        },
      },
      orgId: ORG_ID,
      eventId: null,
    });

    store.runs.push({
      id: "run_legacy",
      workflowId: "wf_legacy",
      status: "RUNNING",
      context: {},
      contextVersion: 0,
      definitionSnapshot: null,
      definitionHash: null,
      isLegacyRunWithoutSnapshot: true,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    await advanceWorkflow("run_legacy");

    const run = store.runs.find((r) => r.id === "run_legacy");
    expect(run?.status).toBe("REQUIRES_INTERVENTION");

    const audit = store.auditLogs.find((l) => l.runId === "run_legacy");
    expect(audit?.eventType).toBe("EXECUTION_HALTED");
    expect(audit?.message).toContain("Run lacks immutable execution snapshot");
  });

  // -------------------------------------------------------------------------
  // F03-01 & F03-02: Edit graph after start — run 1 keeps original, run 2 gets new
  // -------------------------------------------------------------------------
  it("F03-01 & F03-02: Run 1 preserves original graph A -> B -> C after workflow is edited to A -> D", async () => {
    const originalDefinition = {
      id: "def_abc",
      name: "Original ABC",
      steps: {
        step_a: { id: "step_a", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "A", projectId: PROJECT_ID } },
        step_b: { id: "step_b", action: "task.create", dependsOn: ["step_a"], kind: "ACTION", config: { title: "B", projectId: PROJECT_ID } },
        step_c: { id: "step_c", action: "task.create", dependsOn: ["step_b"], kind: "ACTION", config: { title: "C", projectId: PROJECT_ID } },
      },
    };

    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Workflow ABC",
      definition: originalDefinition,
      orgId: ORG_ID,
      eventId: null,
    });

    // 1. Start Run 1 on original definition A -> B -> C
    const run1 = await startWorkflow(ORG_ID, WORKFLOW_ID);
    expect(run1.definitionSnapshot).toBeDefined();
    const run1Snapshot = run1.definitionSnapshot as unknown as WorkflowExecutionSnapshot;
    expect(Object.keys(run1Snapshot.definition.steps)).toEqual(["step_a", "step_b", "step_c"]);

    // 2. User edits workflow definition in-place to A -> D
    const updatedDefinition = {
      id: "def_ad",
      name: "Updated AD",
      steps: {
        step_a: { id: "step_a", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "A", projectId: PROJECT_ID } },
        step_d: { id: "step_d", action: "task.create", dependsOn: ["step_a"], kind: "ACTION", config: { title: "D", projectId: PROJECT_ID } },
      },
    };
    store.workflows[0].definition = updatedDefinition;

    // 3. Complete Step A for Run 1
    const stepA = store.stepRuns.find((s) => s.runId === run1.id && s.stepId === "step_a");
    expect(stepA).toBeDefined();
    stepA!.status = "SUCCESS";

    // 4. Advance Run 1: Must dispatch step_b (from frozen snapshot), NOT step_d!
    publishedEvents.length = 0;
    await advanceWorkflow(run1.id);

    const run1Dispatches = publishedEvents.filter((e) => e.type === "EXECUTE_WORKFLOW_NODE");
    expect(run1Dispatches).toHaveLength(1);
    const dispatchedStepRun = store.stepRuns.find((s) => s.id === run1Dispatches[0].data.stepRunId);
    expect(dispatchedStepRun?.stepId).toBe("step_b");

    // 5. Start Run 2: Must capture updated definition A -> D
    const run2 = await startWorkflow(ORG_ID, WORKFLOW_ID);
    const run2Snapshot = run2.definitionSnapshot as unknown as WorkflowExecutionSnapshot;
    expect(Object.keys(run2Snapshot.definition.steps)).toEqual(["step_a", "step_d"]);
  });

  // -------------------------------------------------------------------------
  // F03-03: Delete node from mutable definition after queueing
  // -------------------------------------------------------------------------
  it("F03-03: Deleting node from Workflow.definition after queueing resolves node from frozen snapshot", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Workflow With B",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_a: { id: "step_a", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "Task A", projectId: PROJECT_ID } },
          step_b: { id: "step_b", action: "task.create", dependsOn: ["step_a"], kind: "ACTION", config: { title: "Task B", projectId: PROJECT_ID } },
        },
      },
      orgId: ORG_ID,
      eventId: null,
    });

    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);

    // Queue Step B
    const stepB = await db.stepRun.create({
      data: {
        runId: run.id,
        stepId: "step_b",
        status: "PENDING",
      },
    });

    // Mutate workflow definition: completely delete step_b
    store.workflows[0].definition = {
      id: "d1",
      name: "d1",
      steps: {
        step_a: { id: "step_a", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "Task A", projectId: PROJECT_ID } },
      },
    };

    // Worker executes step_b: resolves from run.definitionSnapshot despite missing from workflow
    const req = createPostRequest(stepB.id, run.id);
    const { handleWorkflowEvent } = await import("@/app/api/workflow/wf");
    const res = await handleWorkflowEvent(req);
    const updatedStepB = store.stepRuns.find((s) => s.id === stepB.id);
    expect(res.status).toBe(200);
    expect(updatedStepB?.status).toBe("SUCCESS");
  });

  // -------------------------------------------------------------------------
  // F03-04: Change node inputs/config after run creation
  // -------------------------------------------------------------------------
  it("F03-04: Changing node config in Workflow.definition does not alter running execution inputs", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Config Workflow",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_1: {
            id: "step_1",
            action: "task.create",
            dependsOn: [],
            kind: "ACTION",
            config: { title: "Original Locked Title", projectId: PROJECT_ID },
          },
        },
      },
      orgId: ORG_ID,
      eventId: null,
    });

    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);

    // Mutate definition config
    (store.workflows[0].definition as { steps: Record<string, { config: { title: string } }> }).steps.step_1.config.title = "Altered Unsafe Title";

    const stepRun = store.stepRuns.find((s) => s.runId === run.id && s.stepId === "step_1");
    expect(stepRun).toBeDefined();

    const req = createPostRequest(String(stepRun!.id), run.id);
    const { handleWorkflowEvent } = await import("@/app/api/workflow/wf");
    await handleWorkflowEvent(req);

    const task = store.tasks.find((t) => t.title === "Original Locked Title");
    expect(task).toBeDefined();
    expect(store.tasks.find((t) => t.title === "Altered Unsafe Title")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F03-05: Edit workflow after forward execution, then compensate
  // -------------------------------------------------------------------------
  it("F03-05: Editing workflow after forward execution preserves rollback graph and compensator", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Saga Edit Test",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          step_task: { id: "step_task", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "Saga Task", projectId: PROJECT_ID } },
          step_crit: { id: "step_crit", action: "task.create", dependsOn: ["step_task"], kind: "ACTION", isCritical: true, config: { title: "Crit Task", projectId: PROJECT_ID } },
        },
      },
      orgId: ORG_ID,
      eventId: null,
    });

    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);

    // Forward step_task succeeds
    const stepTask = store.stepRuns.find((s) => s.runId === run.id && s.stepId === "step_task")!;
    const req = createPostRequest(String(stepTask.id), run.id);
    const { handleWorkflowEvent } = await import("@/app/api/workflow/wf");
    await handleWorkflowEvent(req);
    expect(stepTask.status).toBe("SUCCESS");

    // Critical step fails
    const stepCrit = store.stepRuns.find((s) => s.runId === run.id && s.stepId === "step_crit")!;
    stepCrit.status = "FAILED";

    // Edit workflow definition completely: remove step_task
    store.workflows[0].definition = {
      id: "d1",
      name: "d1",
      steps: {
        step_crit: { id: "step_crit", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "Crit Task", projectId: PROJECT_ID } },
      },
    };

    // Evaluator triggers rollback
    publishedEvents.length = 0;
    await advanceWorkflow(run.id);

    const runState = store.runs.find((r) => r.id === run.id);
    expect(runState?.status).toBe("ROLLING_BACK");

    // Evaluator dispatches compensation for step_task from frozen snapshot
    const compensationEvents = publishedEvents.filter((e) => e.type === "EXECUTE_WORKFLOW_NODE");
    expect(compensationEvents).toHaveLength(1);
    expect(compensationEvents[0].data.stepRunId).toBe(stepTask.id);

    // Worker executes compensation: deletes task
    const compReq = createPostRequest(String(stepTask.id), run.id);
    await handleWorkflowEvent(compReq);
    expect(stepTask.status).toBe("COMPENSATED");
  });

  // -------------------------------------------------------------------------
  // F03-06 & F03-07: Action version pinning across execution and compensation
  // -------------------------------------------------------------------------
  it("F03-06 & F03-07: Action version pinning uses originally pinned version during forward and compensation", async () => {
    const v1Execute = jest.fn().mockResolvedValue({ success: true, data: { v: 1 } });
    const v1Compensate = jest.fn().mockResolvedValue({ success: true });

    const v2Execute = jest.fn().mockResolvedValue({ success: true, data: { v: 2 } });
    const v2Compensate = jest.fn().mockResolvedValue({ success: true });

    const actionV1: WorkflowAction = {
      id: "test.version_pin",
      version: "1.0.0",
      execute: v1Execute,
      compensate: v1Compensate,
    };

    const actionV2: WorkflowAction = {
      id: "test.version_pin",
      version: "2.0.0",
      execute: v2Execute,
      compensate: v2Compensate,
    };

    registerAction(actionV1);
    (ActionRegistry as Record<string, WorkflowAction>)["test.version_pin"] = actionV1;

    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Version Pin Test",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          s1: { id: "s1", action: "test.version_pin", dependsOn: [], kind: "ACTION" },
        },
      },
      orgId: ORG_ID,
      eventId: null,
    });

    // 1. Start run: pins version "1.0.0"
    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);
    const snapshot = run.definitionSnapshot as unknown as WorkflowExecutionSnapshot;
    expect(snapshot.actionManifest[0].actionVersion).toBe("1.0.0");

    // 2. Deploy version "2.0.0" as active action in registry
    registerAction(actionV2);
    (ActionRegistry as Record<string, WorkflowAction>)["test.version_pin"] = actionV2;

    // 3. Worker executes s1: must call v1Execute, NOT v2Execute!
    const step1 = store.stepRuns.find((s) => s.runId === run.id && s.stepId === "s1")!;
    const req = createPostRequest(String(step1.id), run.id);
    const { handleWorkflowEvent } = await import("@/app/api/workflow/wf");
    await handleWorkflowEvent(req);

    expect(v1Execute).toHaveBeenCalledTimes(1);
    expect(v2Execute).not.toHaveBeenCalled();

    // 4. Trigger compensation on s1: must call v1Compensate, NOT v2Compensate!
    step1.status = "SUCCESS";
    const runRow = store.runs.find((r) => r.id === run.id)!;
    runRow.status = "ROLLING_BACK";

    const compReq = createPostRequest(String(step1.id), run.id);
    await handleWorkflowEvent(compReq);

    expect(v1Compensate).toHaveBeenCalledTimes(1);
    expect(v2Compensate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // F03-08: Exact pinned action version is unavailable -> safe failure
  // -------------------------------------------------------------------------
  it("F03-08: Exact pinned action version unavailable fails safely without latest-version fallback", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Unavailable Version Test",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          s1: { id: "s1", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "T", projectId: PROJECT_ID } },
        },
      },
      orgId: ORG_ID,
      eventId: null,
    });

    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);
    const snapshot = run.definitionSnapshot as unknown as WorkflowExecutionSnapshot;

    // Simulate an execution snapshot pinned to an unavailable version "9.9.9"
    snapshot.actionManifest[0].actionVersion = "9.9.9";
    const newHash = computeWorkflowDefinitionHash(snapshot);

    const runRow = store.runs.find((r) => r.id === run.id)!;
    runRow.definitionSnapshot = snapshot;
    runRow.definitionHash = newHash;

    const step1 = store.stepRuns.find((s) => s.runId === run.id && s.stepId === "s1")!;
    const req = createPostRequest(String(step1.id), run.id);
    const { handleWorkflowEvent } = await import("@/app/api/workflow/wf");
    const res = await handleWorkflowEvent(req);

    expect(res.status).toBe(200); // 200 signals acknowledged terminal failure
    expect(step1.status).toBe("FAILED");
    expect(step1.error).toContain("Action task.create@9.9.9 not found in registry");
  });

  // -------------------------------------------------------------------------
  // F03-16: Tenant boundary
  // -------------------------------------------------------------------------
  it("F03-16: startWorkflow with foreign tenant rejects run creation", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Tenant Test",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          s1: { id: "s1", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "T", projectId: PROJECT_ID } },
        },
      },
      orgId: "org_owner",
      eventId: null,
    });

    await expect(startWorkflow("org_attacker", WORKFLOW_ID)).rejects.toThrow(
      `Cannot start workflow: ${WORKFLOW_ID} not found.`,
    );

    expect(store.runs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // F03-17: Retry / recovery preserves frozen definition and action versions
  // -------------------------------------------------------------------------
  it("F03-17: Retry and recovery preserve original frozen snapshot and pinned action versions", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      name: "Retry Preservation Test",
      definition: {
        id: "d1",
        name: "d1",
        steps: {
          s1: { id: "s1", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "Retry Task", projectId: PROJECT_ID } },
        },
      },
      orgId: ORG_ID,
      eventId: null,
    });

    const run = await startWorkflow(ORG_ID, WORKFLOW_ID);
    const originalHash = run.definitionHash;

    // Mutate definition during retry
    store.workflows[0].definition = {
      id: "d1_mutated",
      name: "d1_mutated",
      steps: {
        s2: { id: "s2", action: "task.create", dependsOn: [], kind: "ACTION" },
      },
    };

    const step1 = store.stepRuns.find((s) => s.runId === run.id && s.stepId === "s1")!;
    step1.status = "RETRYING";
    step1.attempts = 1;

    // Advance retry
    await advanceWorkflow(run.id);

    const reReadRun = store.runs.find((r) => r.id === run.id);
    expect(reReadRun?.definitionHash).toBe(originalHash);

    const snapshot = reReadRun?.definitionSnapshot as unknown as WorkflowExecutionSnapshot;
    expect(snapshot.definition.id).toBe("d1");
    expect(snapshot.actionManifest[0].stepId).toBe("s1");
    expect(snapshot.actionManifest[0].actionVersion).toBe("1.0.0");
  });

  // -------------------------------------------------------------------------
  // F-03.2 Section 3: Acceptance Coverage Completion
  // -------------------------------------------------------------------------
  describe("F-03.2 Section 3: Acceptance Coverage Completion", () => {
    it("rejects run creation before dispatch if an action is not registered in the manifest", async () => {
      store.workflows.push({
        id: "wf_invalid_action",
        name: "Invalid Action WF",
        definition: {
          id: "def_inv",
          name: "def_inv",
          steps: {
            s1: {
              id: "s1",
              action: "unregistered.custom_action",
              dependsOn: [],
              kind: "ACTION",
            },
          },
        },
        orgId: ORG_ID,
        eventId: null,
      });

      await expect(startWorkflow(ORG_ID, "wf_invalid_action")).rejects.toThrow(
        /step "s1" requires action "unregistered.custom_action" which is not registered/,
      );

      // Verify no WorkflowRun row was created
      expect(store.runs.filter((r) => r.workflowId === "wf_invalid_action")).toHaveLength(0);
      // Verify no events were dispatched
      expect(publishedEvents).toHaveLength(0);
    });

    it("newly created run atomically contains non-null valid snapshot and matching definitionHash", async () => {
      store.workflows.push({
        id: "wf_atomic_test",
        name: "Atomic Test WF",
        definition: {
          id: "def_atomic",
          name: "def_atomic",
          steps: {
            s1: {
              id: "s1",
              action: "task.create",
              dependsOn: [],
              kind: "ACTION",
              config: { title: "Atomic Task", projectId: PROJECT_ID },
            },
          },
        },
        orgId: ORG_ID,
        eventId: null,
      });

      const run = await startWorkflow(ORG_ID, "wf_atomic_test");
      expect(run.definitionSnapshot).toBeDefined();
      expect(run.definitionHash).toBeDefined();

      const snapshot = run.definitionSnapshot as unknown as WorkflowExecutionSnapshot;
      expect(snapshot.snapshotSchemaVersion).toBe(1);
      expect(snapshot.workflowId).toBe("wf_atomic_test");
      expect(snapshot.actionManifest).toEqual([
        { stepId: "s1", actionId: "task.create", actionVersion: "1.0.0" },
      ]);

      const verification = verifyWorkflowSnapshotIntegrity(snapshot, run.definitionHash);
      expect(verification.valid).toBe(true);
    });

    it("preserves credential references in snapshot while redacting secrets in hash payload without leaking in logs", async () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      const credWorkflowDef = {
        id: "def_creds",
        name: "Credentials WF",
        steps: {
          s1: {
            id: "s1",
            action: "task.create",
            dependsOn: [],
            kind: "ACTION",
            config: {
              title: "Credential Step",
              projectId: PROJECT_ID,
              apiKeyRef: "vault_cred_99", // credential reference
              connectionId: "conn_stripe_prod", // connection reference
              apiSecretKey: "sk-live-super-secret-12345", // raw secret key pattern
              password: "super-sensitive-password", // raw password pattern
            },
          },
        },
      };

      store.workflows.push({
        id: "wf_creds",
        name: "Credentials WF",
        definition: credWorkflowDef,
        orgId: ORG_ID,
        eventId: null,
      });

      const run = await startWorkflow(ORG_ID, "wf_creds");

      // 1. Snapshot preserves the original config verbatim (so workers can resolve references)
      const snapshot = run.definitionSnapshot as unknown as WorkflowExecutionSnapshot;
      const stepConfig = snapshot.definition.steps.s1.config as Record<string, unknown>;
      expect(stepConfig.apiKeyRef).toBe("vault_cred_99");
      expect(stepConfig.connectionId).toBe("conn_stripe_prod");

      // 2. Canonical hash payload redacts raw secret values to [REDACTED_SECRET]
      const canonicalPayload = buildCanonicalExecutionPayload(snapshot);
      const normalizedSteps = (canonicalPayload.definition as { steps: Record<string, { config: Record<string, unknown> }> }).steps;
      const normalizedConfig = normalizedSteps.s1.config;
      expect(normalizedConfig.apiSecretKey).toBe("[REDACTED_SECRET]");
      expect(normalizedConfig.password).toBe("[REDACTED_SECRET]");
      // References that do not match sensitive secret patterns remain intact
      expect(normalizedConfig.connectionId).toBe("conn_stripe_prod");

      // 3. Ignition logs only hash, never leaking secrets or raw configuration
      const logCalls = consoleSpy.mock.calls.map((call) => call.join(" "));
      const ignitionLogs = logCalls.filter((l) => l.includes("[IGNITION]"));
      expect(ignitionLogs.length).toBeGreaterThan(0);
      for (const logLine of ignitionLogs) {
        expect(logLine).not.toContain("sk-live-super-secret-12345");
        expect(logLine).not.toContain("super-sensitive-password");
        expect(logLine).toContain(run.definitionHash!);
      }

      consoleSpy.mockRestore();
    });

    it("worker terminates delivery loop (400) and halts step when snapshot integrity check fails", async () => {
      store.workflows.push({
        id: "wf_tamper_worker",
        name: "Tamper Worker WF",
        definition: {
          id: "def_tamper",
          name: "def_tamper",
          steps: {
            s1: { id: "s1", action: "task.create", dependsOn: [], kind: "ACTION", config: { title: "T", projectId: PROJECT_ID } },
          },
        },
        orgId: ORG_ID,
        eventId: null,
      });

      const run = await startWorkflow(ORG_ID, "wf_tamper_worker");
      const stepRun = store.stepRuns.find((s) => s.runId === run.id && s.stepId === "s1")!;

      // Tamper with the definitionHash on the run row
      const runRow = store.runs.find((r) => r.id === run.id)!;
      runRow.definitionHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

      const req = createPostRequest(String(stepRun.id), run.id);
      const { handleWorkflowEvent } = await import("@/app/api/workflow/wf");
      const res = await handleWorkflowEvent(req);

      // 400 signals client error to QStash, preventing endless redelivery
      expect(res.status).toBe(400);

      // StepRun is marked FAILED with integrity check failure
      const updatedStep = store.stepRuns.find((s) => s.id === stepRun.id);
      expect(updatedStep?.status).toBe("FAILED");
      expect(updatedStep?.error).toContain("Snapshot integrity check failed");

      // Evaluator halts the run to REQUIRES_INTERVENTION
      await advanceWorkflow(run.id);
      expect(runRow.status).toBe("REQUIRES_INTERVENTION");
    });
  });

  // -------------------------------------------------------------------------
  // F-03.2 Section 4: Action-Version Registry Verification
  // -------------------------------------------------------------------------
  describe("F-03.2 Section 4: Action-Version Registry Verification", () => {
    it("rejects '@' delimiter in action.id to prevent composite key collision", () => {
      const maliciousAction: WorkflowAction = {
        id: "task@create",
        version: "1.0.0",
        execute: jest.fn(),
      };

      expect(() => registerAction(maliciousAction)).toThrow(
        /actionId cannot contain '@' delimiter/,
      );
    });

    it("rejects '@' delimiter in action.version to prevent composite key collision", () => {
      const maliciousVersionAction: WorkflowAction = {
        id: "task.valid",
        version: "1.0@beta",
        execute: jest.fn(),
      };

      expect(() => registerAction(maliciousVersionAction)).toThrow(
        /actionVersion cannot contain '@' delimiter/,
      );
    });

    it("parses valid action keys deterministically and returns null for invalid formats", () => {
      expect(formatActionKey("task.create", "1.0.0")).toBe("task.create@1.0.0");

      const parsed = parseActionKey("task.create@1.0.0");
      expect(parsed).toEqual({ actionId: "task.create", version: "1.0.0" });

      expect(parseActionKey("no_delimiter")).toBeNull();
      expect(parseActionKey("too@many@delimiters")).toBeNull();
      expect(parseActionKey("@missing_action")).toBeNull();
      expect(parseActionKey("missing_version@")).toBeNull();
    });

    it("deterministic duplicate registration: exact same instance succeeds, conflicting implementation throws", () => {
      const dummyAction: WorkflowAction = {
        id: "custom.action_dup",
        version: "1.0.0",
        execute: jest.fn(),
      };

      // First registration succeeds
      expect(() => registerAction(dummyAction)).not.toThrow();

      // Duplicate registration of the exact same object succeeds idempotently
      expect(() => registerAction(dummyAction)).not.toThrow();

      // Conflicting registration with different function/implementation throws
      const conflictingAction: WorkflowAction = {
        id: "custom.action_dup",
        version: "1.0.0",
        execute: jest.fn(), // different function instance
      };

      expect(() => registerAction(conflictingAction)).toThrow(
        /Duplicate action registration rejected: action "custom.action_dup" version "1.0.0" is already registered with a different implementation/,
      );
    });

    it("getAction returns exact pinned version, never silently falls back to latest on mismatch", () => {
      const actionV1: WorkflowAction = {
        id: "custom.pinned_lookup",
        version: "1.0.0",
        execute: jest.fn(),
      };
      const actionV2: WorkflowAction = {
        id: "custom.pinned_lookup",
        version: "2.0.0",
        execute: jest.fn(),
      };

      registerAction(actionV1);
      registerAction(actionV2);

      // Exact version returns the corresponding action
      expect(getAction("custom.pinned_lookup", "1.0.0")).toBe(actionV1);
      expect(getAction("custom.pinned_lookup", "2.0.0")).toBe(actionV2);

      // Requesting an unpinned/unregistered version returns undefined (no silent fallback!)
      expect(getAction("custom.pinned_lookup", "3.0.0")).toBeUndefined();
    });
  });
});
