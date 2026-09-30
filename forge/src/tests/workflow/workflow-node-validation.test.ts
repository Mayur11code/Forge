// src/tests/workflow/workflow-node-validation.test.ts
//
// Node validation at the persistence boundary (I2).
//
// `IncomingNodeSchema.data` was `.optional().or(z.any())`. `z.any()` accepts every
// value, so the union's right-hand branch always won and the left-hand branch was
// unreachable: `eventId`, `actionType`, `config` and `isCritical` - the fields
// that decide what executes - were never checked. The update path was blunter
// still, validating `z.array(z.any())`, which is an array literal that accepts any
// element and therefore any input.
//
// Both save actions are covered here. The register calls that out specifically:
// fixing only the create path leaves the update path writable with anything, and
// fixing only the update path leaves the create path's union inert. A test that
// exercised one action would not notice either mistake.

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

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import {
  saveWorkflowState,
  updateWorkflowState,
} from "@/app/actions/workflows/workflow";
import { prismaDouble, resetStore, restoreWorkflowDouble, store } from "./helpers/prisma-double";

const ORG_A = "org_a";
const WORKFLOW_ID = "wf_1";
const MALFORMED = { success: false, error: "Malformed workflow data." };

/**
 * Exactly what `WorkflowCanvas.tsx` puts on the canvas when a node is dropped.
 *
 * Reproduced verbatim rather than tidied up, because the discriminator lives on
 * the node and not inside `data`. A schema written against `data.type` would
 * reject every node this application creates, and the only way to know that
 * before shipping is to hold the real payload in a test.
 */
const UI_TRIGGER = {
  id: "trigger_1",
  type: "trigger",
  position: { x: 1, y: 2 },
  data: { label: "New Trigger", eventId: null },
};

const UI_ACTION = {
  id: "action_1",
  type: "action",
  position: { x: 3, y: 4 },
  data: {
    label: "New Action",
    actionType: "unset",
    config: {},
    isConfigured: false,
    isCritical: false,
  },
};

const EDGES: unknown[] = [];

const getOrgAccessMock = getOrgAccess as jest.Mock;

/**
 * The double stores rows as `Record<string, unknown>`, so anything nested inside
 * a row arrives as `unknown` and cannot be indexed. This is the shape these
 * tests actually assert on, named once so each assertion reads as a claim about
 * a workflow row instead of a chain of casts.
 */
type StoredWorkflow = {
  id: string;
  orgId: string;
  uiNodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  }>;
  uiEdges: unknown[];
  definition: { steps: Record<string, { kind: string; action: string }> };
  eventId: string | null;
  isActive: boolean;
};

function storedWorkflows(): StoredWorkflow[] {
  return store.workflows as unknown as StoredWorkflow[];
}

/** Variants that must not reach the database, each breaking one `data` field. */
const MALFORMED_NODES: Array<[string, unknown]> = [
  [
    "trigger missing label",
    { id: "n1", type: "trigger", position: { x: 0, y: 0 }, data: { eventId: null } },
  ],
  [
    "trigger eventId of the wrong type",
    { id: "n1", type: "trigger", position: { x: 0, y: 0 }, data: { label: "L", eventId: 42 } },
  ],
  [
    "action missing actionType",
    { id: "n1", type: "action", position: { x: 0, y: 0 }, data: { label: "L" } },
  ],
  [
    "action isCritical of the wrong type",
    {
      id: "n1",
      type: "action",
      position: { x: 0, y: 0 },
      data: { label: "L", actionType: "x", isCritical: "yes" },
    },
  ],
  ["data absent entirely", { id: "n1", type: "action", position: { x: 0, y: 0 } }],
  [
    "unknown node type",
    { id: "n1", type: "condition", position: { x: 0, y: 0 }, data: { label: "L" } },
  ],
  [
    "trigger node carrying action data",
    { id: "n1", type: "trigger", position: { x: 0, y: 0 }, data: { label: "L", actionType: "x" } },
  ],
  ["position missing", { id: "n1", type: "trigger", data: { label: "L", eventId: null } }],
];

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
  getOrgAccessMock.mockResolvedValue({ organization: { id: ORG_A }, role: "MEMBER" });
});

/** Seeds the row the update path needs to reach its own tenant check. */
function seedOwnedWorkflow() {
  store.workflows.push({
    id: WORKFLOW_ID,
    orgId: ORG_A,
    name: "Existing",
    uiNodes: [],
    uiEdges: [],
    definition: { id: "original", name: "Original", steps: {} },
    eventId: null,
    isActive: false,
  });
}

describe("saveWorkflowState node validation", () => {
  it("accepts the nodes the canvas actually produces", async () => {
    const result = await saveWorkflowState("acme", "My First Automation", [UI_TRIGGER, UI_ACTION], EDGES);

    expect(result.success).toBe(true);
    expect(store.workflows).toHaveLength(1);
  });

  it("applies ActionNodeData defaults to the persisted row", async () => {
    await saveWorkflowState(
      "acme",
      "Defaults",
      [{ ...UI_ACTION, data: { label: "Bare", actionType: "http" } }],
      EDGES,
    );

    expect(storedWorkflows()[0].uiNodes[0].data).toEqual({
      label: "Bare",
      actionType: "http",
      config: {},
      isConfigured: false,
      isCritical: false,
    });
  });

  it.each(MALFORMED_NODES)("rejects %s", async (_label, node) => {
    const result = await saveWorkflowState("acme", "Bad", [node], EDGES);

    expect(result).toEqual(MALFORMED);
    expect(prismaDouble.workflow.create).not.toHaveBeenCalled();
    expect(store.workflows).toHaveLength(0);
  });

  it("rejects a graph where only the second node is malformed", async () => {
    const result = await saveWorkflowState(
      "acme",
      "Partly bad",
      [UI_TRIGGER, { ...UI_ACTION, data: { label: "No action type" } }],
      EDGES,
    );

    expect(result).toEqual(MALFORMED);
    expect(prismaDouble.workflow.create).not.toHaveBeenCalled();
  });

  it("persists the validated nodes rather than the raw argument", async () => {
    await saveWorkflowState(
      "acme",
      "Unknown keys",
      [
        {
          ...UI_TRIGGER,
          data: { ...UI_TRIGGER.data, injectedByACaller: "should not survive" },
        },
      ],
      EDGES,
    );

    const stored = storedWorkflows()[0].uiNodes[0].data;
    expect(stored).not.toHaveProperty("injectedByACaller");
    expect(stored).toEqual({ label: "New Trigger", eventId: null });
  });

  /**
   * A node whose *type* and *data* disagree is caught, but only in the direction
   * that loses a required field: a node typed `trigger` must carry `eventId`.
   *
   * The reverse is not a rejection. `ActionNodeDataSchema` is an ordinary Zod
   * object, not `.strict()`, so a stray `eventId` on an action node is accepted
   * and then dropped from the row rather than refused. That is the safer of the
   * two outcomes and the intended schemas behave this way: a key the schema does
   * not name cannot reach the database or the compiled definition, whereas
   * `.strict()` would turn any field added to the canvas later into a hard save
   * failure. This test pins the behaviour so the asymmetry is deliberate rather
   * than an accident someone reads as a hole.
   */
  it("strips a stray trigger field from an action node instead of persisting it", async () => {
    const result = await saveWorkflowState(
      "acme",
      "Stray field",
      [
        {
          ...UI_ACTION,
          data: { ...UI_ACTION.data, eventId: "evt_should_not_apply" },
        },
      ],
      EDGES,
    );

    expect(result.success).toBe(true);
    const stored = storedWorkflows()[0];
    expect(stored.uiNodes[0].data).not.toHaveProperty("eventId");
    expect(stored.eventId).toBeNull();
    expect(stored.definition.steps.action_1.kind).toBe("ACTION");
  });
});

describe("updateWorkflowState node validation", () => {
  it("accepts the nodes the canvas actually produces", async () => {
    seedOwnedWorkflow();

    const result = await updateWorkflowState("acme", WORKFLOW_ID, [UI_TRIGGER, UI_ACTION], EDGES);

    expect(result).toEqual({ success: true });
    expect(prismaDouble.workflow.updateMany).toHaveBeenCalled();
  });

  it.each(MALFORMED_NODES)("rejects %s", async (_label, node) => {
    seedOwnedWorkflow();

    const result = await updateWorkflowState("acme", WORKFLOW_ID, [node], EDGES);

    expect(result).toEqual(MALFORMED);
    expect(prismaDouble.workflow.findFirst).not.toHaveBeenCalled();
    expect(prismaDouble.workflow.updateMany).not.toHaveBeenCalled();
  });

  it("persists the validated nodes rather than the raw argument", async () => {
    seedOwnedWorkflow();

    await updateWorkflowState(
      "acme",
      WORKFLOW_ID,
      [
        {
          ...UI_TRIGGER,
          data: { ...UI_TRIGGER.data, injectedByACaller: "should not survive" },
        },
      ],
      EDGES,
    );

    const stored = storedWorkflows()[0].uiNodes[0].data;
    expect(stored).not.toHaveProperty("injectedByACaller");
  });
});
