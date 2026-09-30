// src/tests/workflow/workflow-update-scope.test.ts
//
// Tenant scope of `updateWorkflowState`.
//
// The write used to be `db.workflow.update({ where: { id: workflowId } })`.
// `getOrgAccess` ran first and established that the caller belonged to *an*
// organization, but the predicate that followed never mentioned that
// organization, so the two facts had nothing to do with each other. Any
// authenticated member of any org could name any workflow id and overwrite it -
// another tenant's graph, another tenant's `eventId`, and the `isActive` flag
// that decides whether that tenant's automation fires at all.
//
// The three things asserted below are the properties a later refactor has to
// preserve, and each corresponds to a distinct way this can regress:
//
//   1. A foreign workflow is refused AND no write is issued. Asserting only the
//      refusal would still pass if the code checked the tenant and then wrote
//      anyway, which is the shape the original bug is closest to.
//   2. "Not yours" and "does not exist" are the same response, compared with
//      `toEqual` across both calls. Distinct wording, status, or shape is an
//      existence oracle, and the test fails on the difference rather than on a
//      human noticing it later.
//   3. The write's own predicate carries `orgId`. The refusal in (1) is a read;
//      if the write dropped the constraint, the read would still pass every
//      other test here while the actual mutation stayed cross-tenant.

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

import { revalidatePath } from "next/cache";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { updateWorkflowState } from "@/app/actions/workflows/workflow";
import { prismaDouble, resetStore, restoreWorkflowDouble, store } from "./helpers/prisma-double";

const ORG_A = "org_a";
const ORG_B = "org_b";
const WORKFLOW_ID = "wf_1";

/**
 * A single trigger step, which is the smallest graph `compileWorkflow` accepts.
 *
 * Deliberately a fully valid node. Since 37.0B the update path validates node
 * `data` for real, so a fixture missing `label` would be rejected as malformed
 * and these tenant-scope cases would pass for the wrong reason - every one of
 * them would return "Malformed workflow data." before reaching the tenant check.
 * Node-shape rejection is asserted in `workflow-node-validation.test.ts`.
 */
const NODES = [
  {
    id: "n1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "New Trigger", eventId: "evt_1" },
  },
];

const EDGES: unknown[] = [];

const NOT_FOUND = "Workflow not found in this organization.";

const getOrgAccessMock = getOrgAccess as jest.Mock;
const revalidatePathMock = revalidatePath as unknown as jest.Mock;

function seedWorkflow(orgId: string) {
  resetStore();
  store.workflows.push({
    id: WORKFLOW_ID,
    orgId,
    name: "Existing workflow",
    uiNodes: [],
    uiEdges: [],
    definition: { id: "original", name: "Original", steps: {} },
    eventId: "evt_original",
    isActive: true,
  });
}

function storedWorkflow() {
  return store.workflows[0] as Record<string, unknown>;
}

function savedRow() {
  return { ...storedWorkflow() };
}

async function update(workflowId = WORKFLOW_ID) {
  return updateWorkflowState("acme", workflowId, NODES, EDGES);
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
  getOrgAccessMock.mockResolvedValue({
    organization: { id: ORG_A },
    role: "MEMBER",
  });
});

describe("updateWorkflowState tenant scope", () => {
  it("refuses another organization's workflow and issues no write", async () => {
    seedWorkflow(ORG_B);
    const before = savedRow();

    const result = await update();

    expect(result).toEqual({ success: false, error: NOT_FOUND });
    expect(storedWorkflow()).toEqual(before);
    expect(prismaDouble.workflow.updateMany).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("refuses a workflow that does not exist, indistinguishably", async () => {
    seedWorkflow(ORG_B);
    const foreign = await update();

    resetStore();

    const missing = await update();

    expect(missing).toEqual(foreign);
    expect(missing).toEqual({ success: false, error: NOT_FOUND });
    expect(prismaDouble.workflow.updateMany).not.toHaveBeenCalled();
  });

  it("carries orgId in the write predicate, not only in the lookup", async () => {
    seedWorkflow(ORG_A);

    const result = await update();

    expect(result).toEqual({ success: true });
    expect(prismaDouble.workflow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WORKFLOW_ID, orgId: ORG_A },
      }),
    );
    expect(prismaDouble.workflow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WORKFLOW_ID, orgId: ORG_A },
      }),
    );
  });

  it("persists the compiled definition for the owning organization", async () => {
    seedWorkflow(ORG_A);

    const result = await update();

    expect(result).toEqual({ success: true });
    const saved = storedWorkflow();
    expect(saved.uiNodes).toEqual(NODES);
    expect(saved.eventId).toBe("evt_1");
    expect(saved.isActive).toBe(true);
    expect(saved.definition).toMatchObject({ steps: { n1: { kind: "TRIGGER" } } });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/org/${ORG_A}/workflows/${WORKFLOW_ID}`);
  });

  it("performs no lookup and no write when access is denied", async () => {
    seedWorkflow(ORG_A);
    getOrgAccessMock.mockResolvedValue(null);

    const result = await update();

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(prismaDouble.workflow.findFirst).not.toHaveBeenCalled();
    expect(prismaDouble.workflow.updateMany).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
