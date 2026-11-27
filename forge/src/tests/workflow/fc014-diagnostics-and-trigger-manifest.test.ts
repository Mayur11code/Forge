// src/tests/workflow/fc014-diagnostics-and-trigger-manifest.test.ts
//
// FC-014 — Canonical graph diagnostics, trigger cardinality, independent root
// preservation, and trigger-vs-action manifest regression tests.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn().mockResolvedValue("ADVANCED"),
}));

import { evaluateWorkflowDiagnostics } from "@/lib/workflow/validation/diagnostics";
import { compileWorkflow } from "@/lib/workflow/graph-ui/compiler";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import type { AppEdge, AppNode } from "@/lib/workflow-types/workflow";
import {
  prismaDouble,
  resetStore,
  restoreWorkflowDouble,
  store,
} from "./helpers/prisma-double";

const VALID_CUID = "cmwxmfrxw0001cggcs8r68ewd";

function makeTrigger(id = "trig_1", eventId: string | null = "task.created"): AppNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "On Task Created", eventId },
  };
}

function makeAction(
  id = "act_1",
  actionType = "task.create",
  config: Record<string, unknown> = {
    title: "Valid Task Title",
    projectId: VALID_CUID,
  },
): AppNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 120 },
    data: {
      label: "Create a Task",
      actionType,
      config,
      isConfigured: true,
      isCritical: false,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
});

describe("FC-014 evaluateWorkflowDiagnostics", () => {
  it("reports EMPTY_GRAPH ERROR when canvas has no nodes", () => {
    const report = evaluateWorkflowDiagnostics([], []);
    expect(report.canPublish).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EMPTY_GRAPH", severity: "ERROR", blocksPublish: true }),
      ]),
    );
  });

  it("blocks publish with NO_TRIGGER for triggerless graphs while preserving structural validity", () => {
    const nodes = [makeAction("act_1")];
    const report = evaluateWorkflowDiagnostics(nodes, []);
    expect(report.canPublish).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NO_TRIGGER", severity: "ERROR", blocksPublish: true }),
      ]),
    );
    // Structural compiler still accepts independent action root for drafts
    expect(() => compileWorkflow(nodes, [])).not.toThrow();
  });

  it("reports MULTIPLE_TRIGGERS and UNCONFIGURED_TRIGGER errors", () => {
    const nodes = [
      makeTrigger("trig_1", null),
      makeTrigger("trig_2", "task.created"),
      makeAction("act_1"),
    ];
    const report = evaluateWorkflowDiagnostics(nodes, [
      { id: "e1", source: "trig_1", target: "act_1" },
    ]);
    expect(report.canPublish).toBe(false);
    expect(report.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["UNCONFIGURED_TRIGGER", "MULTIPLE_TRIGGERS"]),
    );
  });

  it("reports INVALID_ACTION, MISSING_REQUIRED_INPUT, INVALID_INPUT_TYPE, and INVALID_VARIABLE_REFERENCE", () => {
    const nodes = [
      makeTrigger("trig_1", "task.created"),
      makeAction("act_unset", "unset", {}),
      makeAction("act_bad_ref", "task.create", {
        title: "{{nonexistent.outputs.title}}",
        projectId: "bad-id",
      }),
      makeAction("act_missing", "task.create", {}),
    ];
    const edges: AppEdge[] = [
      { id: "e1", source: "trig_1", target: "act_unset" },
      { id: "e2", source: "trig_1", target: "act_bad_ref" },
      { id: "e3", source: "trig_1", target: "act_missing" },
    ];
    const report = evaluateWorkflowDiagnostics(nodes, edges);
    expect(report.canPublish).toBe(false);
    expect(report.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        "INVALID_ACTION",
        "INVALID_VARIABLE_REFERENCE",
        "INVALID_INPUT_TYPE",
        "MISSING_REQUIRED_INPUT",
      ]),
    );
  });

  it("surfaces disconnected/independent roots as non-blocking WARNING when a valid trigger exists", () => {
    const nodes = [
      makeTrigger("trig_1", "task.created"),
      makeAction("act_connected", "task.create", {
        title: "Connected Task",
        projectId: "{{trigger.outputs.projectId}}",
      }),
      makeAction("act_orphan", "task.create", {
        title: "Independent Root Task",
        projectId: VALID_CUID,
      }),
    ];
    const edges: AppEdge[] = [
      { id: "e1", source: "trig_1", target: "act_connected" },
    ];

    const report = evaluateWorkflowDiagnostics(nodes, edges);
    expect(report.errors).toHaveLength(0);
    expect(report.canPublish).toBe(true);
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "INDEPENDENT_COMPONENT",
        severity: "WARNING",
        nodeId: "act_orphan",
        blocksPublish: false,
      }),
    ]);
  });

  it("reports CYCLE error with path attribution", () => {
    const nodes = [makeTrigger("trig_1"), makeAction("a1"), makeAction("a2")];
    const edges: AppEdge[] = [
      { id: "e1", source: "trig_1", target: "a1" },
      { id: "e2", source: "a1", target: "a2" },
      { id: "e3", source: "a2", target: "a1" },
    ];
    const report = evaluateWorkflowDiagnostics(nodes, edges);
    expect(report.canPublish).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CYCLE", severity: "ERROR", blocksPublish: true }),
      ]),
    );
  });
});

describe("FC-014 trigger vs action manifest regression in startWorkflow", () => {
  it("starts a workflow containing a configured TRIGGER step without requiring an ActionRegistry entry for task.created", async () => {
    const nodes = [
      makeTrigger("trig_1", "task.created"),
      makeAction("act_1", "task.create", {
        title: "Auto Task",
        projectId: VALID_CUID,
      }),
    ];
    const edges: AppEdge[] = [{ id: "e1", source: "trig_1", target: "act_1" }];
    const definition = compileWorkflow(nodes, edges);

    store.workflows.push({
      id: "wf_trig_test",
      orgId: "org_1",
      name: "Trigger + Action Flow",
      definition,
      uiNodes: nodes,
      uiEdges: edges,
      isActive: true,
      eventId: "task.created",
    });

    const run = await startWorkflow("org_1", "wf_trig_test", {
      projectId: VALID_CUID,
    });

    expect(run.id).toBeDefined();
    expect(prismaDouble.workflowRun.create).toHaveBeenCalledTimes(1);
    const createdSnapshot = (run as unknown as {
      definitionSnapshot: {
        actionManifest: Array<{ stepId: string; actionId: string }>;
      };
    }).definitionSnapshot;
    // Only ACTION steps belong in actionManifest, never TRIGGER steps
    expect(createdSnapshot.actionManifest).toEqual([
      { stepId: "act_1", actionId: "task.create", actionVersion: "1.0.0" },
    ]);
  });

  it("rejects unknown trigger IDs and unregistered ACTION steps at ignition", async () => {
    const badTriggerDef = compileWorkflow([makeTrigger("trig_1", "unknown.evt")], []);
    store.workflows.push({
      id: "wf_bad_trig",
      orgId: "org_1",
      name: "Bad Trigger",
      definition: badTriggerDef,
    });

    await expect(startWorkflow("org_1", "wf_bad_trig")).rejects.toThrow(
      /unknown trigger/i,
    );

    const badActionDef = compileWorkflow([makeAction("act_1", "ghost.action")], []);
    store.workflows.push({
      id: "wf_bad_act",
      orgId: "org_1",
      name: "Bad Action",
      definition: badActionDef,
    });

    await expect(startWorkflow("org_1", "wf_bad_act")).rejects.toThrow(
      /not registered/i,
    );
  });
});
