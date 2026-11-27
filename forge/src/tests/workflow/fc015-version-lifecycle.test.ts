/**
 * FC-015 — Draft vs. Published State Management & Active Lifecycle
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

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import {
  publishWorkflowAction,
  saveWorkflowState,
  toggleWorkflowActiveAction,
  updateWorkflowState,
} from "@/app/actions/workflows/workflow";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import {
  resetStore,
  restoreWorkflowDouble,
  store,
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
        title: "Follow up on {{trigger.outputs.taskId}}",
      },
      isConfigured: true,
      isCritical: false,
    },
  },
];

const VALID_EDGES = [
  {
    id: "e1",
    source: "trig_1",
    target: "act_1",
  },
];

const INVALID_NODES = [
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
      label: "Unconfigured Action",
      actionType: "task.create",
      config: { projectId: "", title: "" },
      isConfigured: false,
      isCritical: false,
    },
  },
];

describe("FC-015: Draft vs Published Lifecycle & Immutable WorkflowVersion", () => {
  beforeEach(() => {
    resetStore();
    restoreWorkflowDouble();
    jest.clearAllMocks();
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: USER_A,
      organization: { id: ORG_A, slug: ORG_A },
    });
  });

  it("saves new workflows as unpublished inactive drafts", async () => {
    const res = await saveWorkflowState(
      ORG_A,
      "Onboarding Draft",
      VALID_NODES,
      VALID_EDGES,
      "Initial draft",
    );

    expect(res.success).toBe(true);
    expect(store.workflows).toHaveLength(1);
    const wf = store.workflows[0];
    expect(wf.isActive).toBe(false);
    expect(wf.publishedVersionId).toBeNull();
    expect(wf.draftRevision).toBe(1);
    expect(store.workflowVersions).toHaveLength(0);
  });

  it("rejects publishing when graph diagnostics contain errors", async () => {
    const saved = await saveWorkflowState(
      ORG_A,
      "Invalid Draft",
      INVALID_NODES,
      VALID_EDGES,
    );
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    const pub = await publishWorkflowAction(ORG_A, saved.workflowId);
    expect(pub.success).toBe(false);
    if (pub.success) return;
    expect(pub.error).toMatch(/Task Title is required|validation errors/i);
    expect(store.workflowVersions).toHaveLength(0);
    expect(store.workflows[0].publishedVersionId).toBeNull();
    expect(store.workflows[0].isActive).toBe(false);
  });

  it("publishes immutable v1, preserves it when draft is edited, and increments monotonically to v2", async () => {
    const saved = await saveWorkflowState(
      ORG_A,
      "Lifecycle Flow",
      VALID_NODES,
      VALID_EDGES,
    );
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    const pub1 = await publishWorkflowAction(ORG_A, saved.workflowId);
    if (!pub1.success) {
      throw new Error(`Expected pub1 to succeed, got: ${pub1.error}`);
    }
    expect(pub1.success).toBe(true);

    expect(pub1.versionNumber).toBe(1);
    expect(pub1.isActive).toBe(true);
    expect(store.workflowVersions).toHaveLength(1);
    const v1Snapshot = JSON.stringify(store.workflowVersions[0].definition);

    // Edit draft after publishing
    const modifiedNodes = VALID_NODES.map((n) =>
      n.id === "act_1"
        ? {
            ...n,
            data: {
              ...n.data,
              config: { projectId: VALID_PROJECT_ID, title: "Draft v2 Title" },
            },
          }
        : n,
    );
    const updated = await updateWorkflowState(
      ORG_A,
      saved.workflowId,
      modifiedNodes,
      VALID_EDGES,
      { expectedDraftRevision: 1 },
    );
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.draftRevision).toBe(2);
    }

    // Published v1 remains completely unchanged and active
    expect(JSON.stringify(store.workflowVersions[0].definition)).toBe(v1Snapshot);
    expect(store.workflows[0].publishedVersionId).toBe(pub1.versionId);
    expect(store.workflows[0].isActive).toBe(true);

    // Stale expectedDraftRevision CAS check fails closed
    const stale = await updateWorkflowState(
      ORG_A,
      saved.workflowId,
      VALID_NODES,
      VALID_EDGES,
      { expectedDraftRevision: 1 },
    );
    expect(stale.success).toBe(false);
    if (!stale.success) {
      expect(stale.error).toMatch(/modified in another session/i);
    }

    // Second publish creates v2 without mutating v1
    const pub2 = await publishWorkflowAction(ORG_A, saved.workflowId);
    expect(pub2.success).toBe(true);
    if (!pub2.success) return;

    expect(pub2.versionNumber).toBe(2);
    expect(pub2.versionId).not.toBe(pub1.versionId);
    expect(store.workflowVersions).toHaveLength(2);
    expect(JSON.stringify(store.workflowVersions[0].definition)).toBe(v1Snapshot);
    expect(store.workflows[0].publishedVersionId).toBe(pub2.versionId);
  });

  it("enforces published + active gating on toggleWorkflowActiveAction and startWorkflow", async () => {
    const saved = await saveWorkflowState(
      ORG_A,
      "Gated Flow",
      VALID_NODES,
      VALID_EDGES,
    );
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    // Cannot activate an unpublished workflow
    const activateUnpublished = await toggleWorkflowActiveAction(
      ORG_A,
      saved.workflowId,
      true,
    );
    expect(activateUnpublished.success).toBe(false);

    // Live execution rejects unpublished draft
    await expect(
      startWorkflow(
        ORG_A,
        saved.workflowId,
        { taskId: "t1", projectId: "proj_1" },
      ),
    ).rejects.toThrow(/not been published|unpublished/i);

    // Publish -> becomes active
    const pub = await publishWorkflowAction(ORG_A, saved.workflowId);
    if (!pub.success) {
      throw new Error(`Expected pub to succeed, got: ${pub.error}`);
    }
    expect(pub.success).toBe(true);

    // Modify draft so draft differs from published v1
    const draftEditedNodes = VALID_NODES.map((n) =>
      n.id === "act_1"
        ? {
            ...n,
            data: {
              ...n.data,
              config: { projectId: VALID_PROJECT_ID, title: "Unpublished Draft Title" },
            },
          }
        : n,
    );
    await updateWorkflowState(ORG_A, saved.workflowId, draftEditedNodes, VALID_EDGES);

    // Pause -> startWorkflow must reject paused workflow
    const paused = await toggleWorkflowActiveAction(ORG_A, saved.workflowId, false);
    expect(paused).toEqual({ success: true, isActive: false });
    await expect(
      startWorkflow(
        ORG_A,
        saved.workflowId,
        { taskId: "t2", projectId: "proj_1" },
      ),
    ).rejects.toThrow(/paused|inactive/i);

    // Re-activate -> startWorkflow executes against published v1 snapshot and records workflowVersionId
    const reactivated = await toggleWorkflowActiveAction(ORG_A, saved.workflowId, true);
    expect(reactivated).toEqual({ success: true, isActive: true });

    const run = await startWorkflow(
      ORG_A,
      saved.workflowId,
      { taskId: "t3", projectId: "proj_1" },
    );
    expect(run.workflowVersionId).toBe(pub.versionId);
    expect(JSON.stringify(run.definitionSnapshot)).toContain(
      "Follow up on {{trigger.outputs.taskId}}",
    );
    expect(JSON.stringify(run.definitionSnapshot)).not.toContain(
      "Unpublished Draft Title",
    );
  });

  it("refuses cross-tenant publish and toggle actions", async () => {
    const saved = await saveWorkflowState(
      ORG_A,
      "Tenant A Flow",
      VALID_NODES,
      VALID_EDGES,
    );
    expect(saved.success).toBe(true);
    if (!saved.success) return;

    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: "user_b",
      organization: { id: ORG_B, slug: ORG_B },
    });

    const pub = await publishWorkflowAction(ORG_B, saved.workflowId);
    expect(pub.success).toBe(false);
    expect(store.workflowVersions).toHaveLength(0);

    const toggle = await toggleWorkflowActiveAction(ORG_B, saved.workflowId, true);
    expect(toggle.success).toBe(false);
  });
});
