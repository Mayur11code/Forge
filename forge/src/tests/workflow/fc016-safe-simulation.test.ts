/**
 * FC-016 — Manual Test-Run Drawer & Trigger Output Preview (Safe Sandbox Simulation)
 */

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/security/rate-limit", () => {
  const actual = jest.requireActual("@/lib/security/rate-limit");
  return {
    ...actual,
    checkRateLimit: jest.fn(),
  };
});

jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn(),
}));

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import {
  publishWorkflowAction,
  saveWorkflowState,
  updateWorkflowState,
} from "@/app/actions/workflows/workflow";
import { simulateWorkflowRunAction } from "@/app/actions/workflows/workflow-run";
import { simulateWorkflowRun } from "@/lib/workflow/execution/simulator";
import type { WorkflowDefinition, AppNode, AppEdge } from "@/lib/workflow-types/workflow";
import {
  prismaDouble,
  resetStore,
  restoreWorkflowDouble,
} from "./helpers/prisma-double";

const ORG_A = "org_a";
const ORG_B = "org_b";
const USER_A = "user_a";

const VALID_PROJECT_ID = "clx1234567890abcdefghijkl";

const VALID_NODES = [
  {
    id: "trig_1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "Task Created", eventId: "task.created" },
  },
  {
    id: "act_1",
    type: "action",
    position: { x: 250, y: 0 },
    data: {
      label: "Create Follow-up",
      actionType: "task.create",
      config: {
        projectId: VALID_PROJECT_ID,
        title: "Follow up {{trigger.outputs.taskId}}",
      },
      isConfigured: true,
      isCritical: false,
    },
  },
];

const VALID_EDGES = [{ id: "e1", source: "trig_1", target: "act_1" }];

describe("FC-016: Safe Workflow Simulation Engine", () => {
  it("simulates trigger interpolation and synthetic task.create without side effects", async () => {
    const def: WorkflowDefinition = {
      id: "sim_def_1",
      name: "Sim Flow",
      steps: {
        trig_1: {
          id: "trig_1",
          kind: "TRIGGER",
          action: "task.created",
          dependsOn: [],
          isCritical: false,
          config: {},
        },
        act_1: {
          id: "act_1",
          kind: "ACTION",
          action: "task.create",
          dependsOn: ["trig_1"],
          isCritical: false,
          config: {
            projectId: "{{trig_1.outputs.projectId}}",
            title: "Follow up {{trig_1.outputs.taskId}}",
          },
        },
      },
    };

    const result = await simulateWorkflowRun(
      def,
      { taskId: "task_99", projectId: "proj_9", token: "secret_jwt_value" },
      { labelMap: { trig_1: "Task Created", act_1: "Create Follow-up" } },
    );

    expect(result.simulated).toBe(true);
    expect(result.status).toBe("COMPLETED");
    expect(result.triggerOutputs.token).toBe("[REDACTED]");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]).toMatchObject({
      stepId: "act_1",
      label: "Create Follow-up",
      status: "COMPLETED",
      resolvedInputs: {
        projectId: "proj_9",
        title: "Follow up task_99",
      },
      outputs: {
        taskId: "sim_task_act_1",
        projectId: "proj_9",
        title: "Follow up task_99",
        simulated: true,
      },
    });
  });

  it("handles conditional branching and marks unmatched branches as SKIPPED", async () => {
    const def: WorkflowDefinition = {
      id: "sim_branch",
      name: "Branch Flow",
      steps: {
        trig_1: {
          id: "trig_1",
          kind: "TRIGGER",
          action: "task.created",
          dependsOn: [],
          isCritical: false,
          config: {},
        },
        cond_1: {
          id: "cond_1",
          kind: "ACTION",
          action: "logic.condition",
          dependsOn: ["trig_1"],
          isCritical: false,
          config: {
            value1: "{{trig_1.outputs.count}}",
            operator: ">",
            value2: 10,
          },
        },
        true_step: {
          id: "true_step",
          kind: "ACTION",
          action: "task.create",
          dependsOn: ["cond_1"],
          routingConditions: { cond_1: "true" },
          isCritical: false,
          config: { projectId: "proj_1", title: "High count" },
        },
        false_step: {
          id: "false_step",
          kind: "ACTION",
          action: "task.create",
          dependsOn: ["cond_1"],
          routingConditions: { cond_1: "false" },
          isCritical: false,
          config: { projectId: "proj_1", title: "Low count" },
        },
      },
    };

    const result = await simulateWorkflowRun(def, { count: 25 });
    expect(result.status).toBe("COMPLETED");

    const trueStep = result.steps.find((s) => s.stepId === "true_step");
    const falseStep = result.steps.find((s) => s.stepId === "false_step");
    expect(trueStep?.status).toBe("COMPLETED");
    expect(falseStep?.status).toBe("SKIPPED");
    expect(falseStep?.skipReason).toMatch(/branch condition/i);
  });

  it("fails safely on unsupported actions and skips downstream dependents", async () => {
    const def: WorkflowDefinition = {
      id: "sim_unsupported",
      name: "Unsupported Flow",
      steps: {
        act_email: {
          id: "act_email",
          kind: "ACTION",
          action: "email.send",
          dependsOn: [],
          isCritical: false,
          config: { to: "a@b.com" },
        },
        act_after: {
          id: "act_after",
          kind: "ACTION",
          action: "task.create",
          dependsOn: ["act_email"],
          isCritical: false,
          config: { projectId: "proj_1", title: "After email" },
        },
      },
    };

    const result = await simulateWorkflowRun(def, {});
    expect(result.status).toBe("FAILED");
    expect(result.steps[0].status).toBe("FAILED");
    expect(result.steps[0].error).toMatch(/not supported in sandbox simulation/i);
    expect(result.steps[1].status).toBe("SKIPPED");
  });

  it("truncates oversized trigger outputs", async () => {
    const def: WorkflowDefinition = {
      id: "sim_truncate",
      name: "Truncate Flow",
      steps: {
        trig_1: {
          id: "trig_1",
          kind: "TRIGGER",
          action: "task.created",
          dependsOn: [],
          isCritical: false,
          config: {},
        },
      },
    };

    const result = await simulateWorkflowRun(def, {
      huge: "x".repeat(6000),
    });
    expect(result.steps[0].truncated).toBe(true);
    expect(result.steps[0].outputs?._truncated).toBe(true);
  });
});

describe("FC-016: simulateWorkflowRunAction Server Boundary & Side-Effect Isolation", () => {
  beforeEach(() => {
    resetStore();
    restoreWorkflowDouble();
    jest.clearAllMocks();
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: USER_A,
      organization: { id: ORG_A, slug: ORG_A },
    });
    (checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      status: 200,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60000,
      headers: {},
    });
  });

  it("rejects unauthorized, rate-limited, invalid JSON, forbidden payload keys, and cross-tenant requests", async () => {
    const saved = await saveWorkflowState(
      ORG_A,
      "Sim Target",
      VALID_NODES,
      VALID_EDGES,
    );
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    // 1. Unauthorized
    (getOrgAccess as jest.Mock).mockResolvedValueOnce(null);
    const unauth = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_A,
    });
    expect(unauth).toEqual({ success: false, error: "Unauthorized" });

    // 2. Rate limited
    (checkRateLimit as jest.Mock).mockResolvedValueOnce({
      allowed: false,
      status: 429,
      message: "Too many simulation requests.",
      limit: 5,
      remaining: 0,
      reset: Date.now() + 60000,
      headers: {},
    });
    const rl = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_A,
    });
    expect(rl).toEqual({ success: false, error: "Too many simulation requests." });

    // 3. Invalid JSON
    const badJson = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_A,
      triggerPayloadJson: "{bad json",
    });
    expect(badJson).toEqual({
      success: false,
      error: "Invalid trigger payload JSON.",
    });

    // 4. Forbidden orgId in trigger payload
    const forbiddenKey = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_A,
      triggerPayloadJson: JSON.stringify({ orgId: ORG_B, taskId: "t1" }),
    });
    expect(forbiddenKey.success).toBe(false);

    // 5. Cross-tenant workflow access
    (getOrgAccess as jest.Mock).mockResolvedValueOnce({
      userId: "user_b",
      organization: { id: ORG_B, slug: ORG_B },
    });
    const foreign = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_B,
      triggerPayloadJson: JSON.stringify({ taskId: "t1" }),
    });
    expect(foreign).toEqual({
      success: false,
      error: "Workflow not found in this organization.",
    });
  });

  it("simulates draft vs published independently and causes zero DB or engine side effects", async () => {
    const saved = await saveWorkflowState(
      ORG_A,
      "Draft vs Pub Sim",
      VALID_NODES,
      VALID_EDGES,
    );
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    const pub = await publishWorkflowAction(ORG_A, saved.workflowId);
    expect(pub.success).toBe(true);
    if (!pub.success) return;

    // Modify draft title after publishing v1
    const updatedNodes = VALID_NODES.map((n) =>
      n.id === "act_1"
        ? {
            ...n,
            data: {
              ...n.data,
              config: {
                projectId: VALID_PROJECT_ID,
                title: "Draft Updated {{trigger.outputs.taskId}}",
              },
            },
          }
        : n,
    );
    await updateWorkflowState(ORG_A, saved.workflowId, updatedNodes, VALID_EDGES);

    const draftSim = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_A,
      target: "draft",
      triggerPayloadJson: JSON.stringify({ taskId: "t_42" }),
    });
    expect(draftSim.success).toBe(true);
    if (draftSim.success) {
      expect(draftSim.target).toBe("draft");
      expect(draftSim.simulation.steps[1].outputs?.title).toBe("Draft Updated t_42");
    }

    const pubSim = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_A,
      target: "published",
      triggerPayloadJson: JSON.stringify({ taskId: "t_42" }),
    });
    expect(pubSim.success).toBe(true);
    if (pubSim.success) {
      expect(pubSim.target).toBe("published");
      expect(pubSim.versionNumber).toBe(1);
      expect(pubSim.simulation.steps[1].outputs?.title).toBe("Follow up t_42");
    }

    // Prove zero real persistence or execution engine calls
    expect(prismaDouble.task.create).not.toHaveBeenCalled();
    expect(prismaDouble.workflowRun.create).not.toHaveBeenCalled();
    expect(prismaDouble.workflowOutbox.create).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(advanceWorkflow).not.toHaveBeenCalled();
  });

  it("simulates multi-node downstream chains and live canvas graph overrides", async () => {
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: USER_A,
      organization: { id: ORG_A, slug: ORG_A },
    });
    (checkRateLimit as jest.Mock).mockResolvedValue({ allowed: true });

    const saved = await saveWorkflowState(
      ORG_A,
      "Multi-Node Chain",
      VALID_NODES,
      VALID_EDGES,
    );
    expect(saved.success).toBe(true);
    if (!saved.success || !saved.workflowId) throw new Error("Failed setup");

    // Add a second downstream node: act_1 -> act_2
    const liveNodes = [
      ...VALID_NODES,
      {
        id: "act_2",
        type: "action" as const,
        position: { x: 500, y: 0 },
        data: {
          label: "Second Action Step",
          actionType: "task.create",
          config: {
            projectId: VALID_PROJECT_ID,
            title: "Downstream Task {{act_1.outputs.taskId}}",
          },
          isConfigured: true,
          isCritical: false,
        },
      },
    ];
    const liveEdges = [
      ...VALID_EDGES,
      { id: "e2", source: "act_1", target: "act_2" },
    ];

    const sim = await simulateWorkflowRunAction({
      workflowId: saved.workflowId,
      orgslug: ORG_A,
      target: "draft",
      triggerPayloadJson: JSON.stringify({ taskId: "t_root", projectId: VALID_PROJECT_ID }),
      currentNodes: liveNodes as unknown as AppNode[],
      currentEdges: liveEdges as unknown as AppEdge[],
    });

    expect(sim.success).toBe(true);
    if (sim.success) {
      expect(sim.simulation.status).toBe("COMPLETED");
      expect(sim.simulation.steps).toHaveLength(3);
      expect(sim.simulation.steps[0].stepId).toBe("trig_1");
      expect(sim.simulation.steps[1].stepId).toBe("act_1");
      expect(sim.simulation.steps[1].status).toBe("COMPLETED");
      expect(sim.simulation.steps[2].stepId).toBe("act_2");
      expect(sim.simulation.steps[2].status).toBe("COMPLETED");
      expect(sim.simulation.steps[2].outputs?.title).toBe("Downstream Task sim_task_act_1");
    }
  });
});
