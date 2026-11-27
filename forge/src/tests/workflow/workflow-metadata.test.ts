// src/tests/workflow/workflow-metadata.test.ts
//
// FC-012 — Server action metadata persistence, validation & tenant-scope tests.

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
import {
  prismaDouble,
  resetStore,
  restoreWorkflowDouble,
  store,
} from "./helpers/prisma-double";

const ORG_A = "org_a";
const ORG_B = "org_b";
const WORKFLOW_ID = "wf_1";

const VALID_NODES = [
  {
    id: "trigger_1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "On Task Created", eventId: "task.created" },
  },
];

const CYCLIC_NODES = [
  {
    id: "a1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Step A",
      actionType: "task.create",
      config: {},
      isConfigured: false,
      isCritical: false,
    },
  },
  {
    id: "a2",
    type: "action",
    position: { x: 100, y: 0 },
    data: {
      label: "Step B",
      actionType: "task.create",
      config: {},
      isConfigured: false,
      isCritical: false,
    },
  },
];

const CYCLIC_EDGES = [
  { id: "e1", source: "a1", target: "a2" },
  { id: "e2", source: "a2", target: "a1" },
];

const getOrgAccessMock = getOrgAccess as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
  getOrgAccessMock.mockResolvedValue({
    organization: { id: ORG_A },
    role: "MEMBER",
  });
});

describe("saveWorkflowState metadata & validation (FC-012)", () => {
  it("persists name and optional description on creation", async () => {
    const result = await saveWorkflowState(
      "acme",
      "  Customer Triage  ",
      VALID_NODES,
      [],
      "  Routes urgent tasks automatically.  ",
    );

    expect(result).toMatchObject({
      success: true,
      workflowId: expect.any(String),
      name: "Customer Triage",
      description: "Routes urgent tasks automatically.",
    });
    expect(store.workflows[0]).toMatchObject({
      name: "Customer Triage",
      description: "Routes urgent tasks automatically.",
      orgId: ORG_A,
    });
  });

  it("accepts empty or omitted description and normalizes empty string to null", async () => {
    const result = await saveWorkflowState(
      "acme",
      "Minimal Flow",
      VALID_NODES,
      [],
      "   ",
    );

    expect(result).toMatchObject({
      success: true,
      workflowId: expect.any(String),
      name: "Minimal Flow",
      description: null,
    });
    expect(store.workflows[0]).toMatchObject({
      name: "Minimal Flow",
      description: null,
    });
  });

  it("rejects blank or over-long workflow names without writing", async () => {
    const blank = await saveWorkflowState("acme", "   ", VALID_NODES, []);
    expect(blank).toEqual({ success: false, error: "Workflow name is required." });

    const tooLong = await saveWorkflowState(
      "acme",
      "x".repeat(101),
      VALID_NODES,
      [],
    );
    expect(tooLong).toEqual({
      success: false,
      error: "Workflow name must be at most 100 characters.",
    });
    expect(prismaDouble.workflow.create).not.toHaveBeenCalled();
  });

  it("rejects over-long description without writing", async () => {
    const res = await saveWorkflowState(
      "acme",
      "Valid Name",
      VALID_NODES,
      [],
      "d".repeat(501),
    );
    expect(res).toEqual({
      success: false,
      error: "Workflow description must be at most 500 characters.",
    });
    expect(prismaDouble.workflow.create).not.toHaveBeenCalled();
  });

  it("rejects unauthorized creation", async () => {
    getOrgAccessMock.mockResolvedValueOnce(null);

    const res = await saveWorkflowState("acme", "Valid Name", VALID_NODES, []);
    expect(res).toEqual({ success: false, error: "Unauthorized" });
    expect(prismaDouble.workflow.create).not.toHaveBeenCalled();
  });

  it("does not write when graph compilation fails", async () => {
    const res = await saveWorkflowState(
      "acme",
      "Cyclic Flow",
      CYCLIC_NODES,
      CYCLIC_EDGES,
      "Should not persist",
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("cycle");
    }
    expect(prismaDouble.workflow.create).not.toHaveBeenCalled();
  });
});

describe("updateWorkflowState metadata & invariants (FC-012)", () => {
  function seedOwnedWorkflow() {
    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_A,
      name: "Original Name",
      description: "Original Description",
      uiNodes: VALID_NODES,
      uiEdges: [],
      definition: { id: "d1", name: "Original", steps: {} },
      eventId: "task.created",
      isActive: true,
    });
  }

  it("persists updated name and description in one write", async () => {
    seedOwnedWorkflow();

    const res = await updateWorkflowState("acme", WORKFLOW_ID, VALID_NODES, [], {
      name: "Renamed Flow",
      description: "Updated summary",
    });

    expect(res).toMatchObject({
      success: true,
      name: "Renamed Flow",
      description: "Updated summary",
    });
    expect(store.workflows[0]).toMatchObject({
      name: "Renamed Flow",
      description: "Updated summary",
    });
  });

  it("preserves existing name and description when metadata is omitted", async () => {
    seedOwnedWorkflow();

    const res = await updateWorkflowState("acme", WORKFLOW_ID, VALID_NODES, []);

    expect(res).toMatchObject({ success: true });
    expect(store.workflows[0]).toMatchObject({
      name: "Original Name",
      description: "Original Description",
    });
  });

  it("rejects malformed metadata without issuing a write", async () => {
    seedOwnedWorkflow();

    const res = await updateWorkflowState("acme", WORKFLOW_ID, VALID_NODES, [], {
      name: "   ",
    });

    expect(res).toEqual({ success: false, error: "Workflow name is required." });
    expect(prismaDouble.workflow.updateMany).not.toHaveBeenCalled();
    expect(store.workflows[0]).toMatchObject({ name: "Original Name" });
  });

  it("does not partially update metadata when graph compilation fails", async () => {
    seedOwnedWorkflow();

    const res = await updateWorkflowState(
      "acme",
      WORKFLOW_ID,
      CYCLIC_NODES,
      CYCLIC_EDGES,
      { name: "New Name", description: "New Description" },
    );

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("cycle");
    }
    expect(prismaDouble.workflow.updateMany).not.toHaveBeenCalled();
    expect(store.workflows[0]).toMatchObject({
      name: "Original Name",
      description: "Original Description",
    });
  });

  it("rejects foreign-tenant metadata updates without writing", async () => {
    store.workflows.push({
      id: WORKFLOW_ID,
      orgId: ORG_B,
      name: "Foreign Flow",
      description: "Foreign Desc",
      uiNodes: VALID_NODES,
      uiEdges: [],
      definition: { id: "d2", name: "Foreign", steps: {} },
      eventId: "task.created",
      isActive: true,
    });

    const res = await updateWorkflowState("acme", WORKFLOW_ID, VALID_NODES, [], {
      name: "Hijacked",
    });

    expect(res).toEqual({
      success: false,
      error: "Workflow not found in this organization.",
    });
    expect(prismaDouble.workflow.updateMany).not.toHaveBeenCalled();
    expect(store.workflows[0]).toMatchObject({ name: "Foreign Flow" });
  });
});
