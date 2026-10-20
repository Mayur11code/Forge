// src/tests/workflow/workflow-run-boundary-scope.test.ts
//
// I6 — the two publicly reachable entry points that hand work to
// `startWorkflow`:
//
//   * `triggerWorkflowRun` — the canvas "Run" server action.
//   * `POST /api/workflow/test/[workflowId]/test-run` — a public route.
//
// Both used to call `startWorkflow` with no authentication and no tenant check,
// so the exec path was reachable by anyone who could invoke them. The fix puts
// authentication and a verified org scope in front of each. Nothing here touches
// the engine: `startWorkflow` is replaced with a spy so the assertions are about
// whether execution was reached at all, and with which organization.

jest.mock("server-only", () => ({}));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/prisma/db", () => ({
  db: { workflow: { findFirst: jest.fn() } },
}));

jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";
import { POST } from "@/app/api/workflow/test/[workflowId]/test-run/route";

const authMock = auth as jest.Mock;
const getOrgAccessMock = getOrgAccess as jest.Mock;
const workflowFindFirst = db.workflow.findFirst as jest.Mock;
const startWorkflowMock = startWorkflow as jest.Mock;

const ORG_A_ID = "org_a_id";
const WORKFLOW_ID = "wf_1";
const SLUG_A = "acme";
const SLUG_B = "globex";

function postTestRun(workflowId = WORKFLOW_ID) {
  return POST(
    new Request(`http://localhost/api/workflow/test/${workflowId}/test-run`, {
      method: "POST",
    }),
    { params: Promise.resolve({ workflowId }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  startWorkflowMock.mockResolvedValue({ id: "run_1" });
  authMock.mockResolvedValue({ user: { id: "user_1" } });
  getOrgAccessMock.mockResolvedValue({
    userId: "user_1",
    organization: { id: ORG_A_ID },
    membership: { role: "MEMBER" },
  });
});

describe("triggerWorkflowRun (canvas server action)", () => {
  it("refuses an unauthenticated/unauthorized caller with no side effects", async () => {
    getOrgAccessMock.mockResolvedValue(null);

    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG_B, {});

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it("passes the verified organization id, never the client-supplied slug", async () => {
    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG_A, { projectId: "p_1" });

    expect(getOrgAccessMock).toHaveBeenCalledWith(SLUG_A);
    expect(startWorkflowMock).toHaveBeenCalledWith(ORG_A_ID, WORKFLOW_ID, {
      projectId: "p_1",
    });
    expect(result).toEqual({
      success: true,
      runId: "run_1",
      redirectTo: `/org/${SLUG_A}/runs/run_1`,
    });
  });

  it("propagates a refusal from startWorkflow as an error, not a success", async () => {
    startWorkflowMock.mockRejectedValue(new Error("Cannot start workflow: x not found."));

    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG_A, {});

    expect(result).toEqual({
      success: false,
      error: "Cannot start workflow: x not found.",
    });
  });

  it("cannot be tricked into a foreign tenant by client-supplied identity in the payload", async () => {
    // A caller who tries to smuggle an organization id through the payload must
    // not influence the tenant actually used. The org passed to the engine is
    // the one `getOrgAccess` verified from the slug; payload fields are opaque
    // trigger data.
    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG_A, {
      orgId: "org_attacker",
      organizationId: "org_attacker",
      projectId: "p_1",
    });

    expect(result.success).toBe(true);
    expect(getOrgAccessMock).toHaveBeenCalledWith(SLUG_A);
    // First positional argument is the verified org id, not any payload value.
    expect(startWorkflowMock).toHaveBeenCalledWith(
      ORG_A_ID,
      WORKFLOW_ID,
      expect.objectContaining({ orgId: "org_attacker" }),
    );
    expect(startWorkflowMock.mock.calls[0][0]).toBe(ORG_A_ID);
  });

  it("creates no run and dispatches nothing when authorization fails", async () => {
    getOrgAccessMock.mockResolvedValue(null);

    const result = await triggerWorkflowRun(WORKFLOW_ID, SLUG_B, {
      projectId: "p_1",
    });

    expect(result.success).toBe(false);
    // The engine is the only path that creates a WorkflowRun and pushes the
    // first domino; not reaching it means no run and no QStash dispatch.
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });
});

describe("POST test-run route", () => {
  it("rejects an unauthenticated request with 401 and never reaches execution", async () => {
    authMock.mockResolvedValue(null);

    const res = await postTestRun();

    expect(res.status).toBe(401);
    expect(workflowFindFirst).not.toHaveBeenCalled();
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the caller's membership and starts with the resolved org", async () => {
    workflowFindFirst.mockResolvedValue({ id: WORKFLOW_ID, orgId: ORG_A_ID });

    const res = await postTestRun();

    expect(workflowFindFirst).toHaveBeenCalledWith({
      where: {
        id: WORKFLOW_ID,
        organization: { memberships: { some: { userId: "user_1" } } },
      },
      select: { id: true, orgId: true },
    });
    expect(startWorkflowMock).toHaveBeenCalledWith(ORG_A_ID, WORKFLOW_ID, {
      projectId: "cmnj8u44p0003a0gcvqgt25dv",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      runId: "run_1",
      redirectTo: `/org/${ORG_A_ID}/runs/run_1`,
    });
  });

  it("returns 404 for a foreign workflow without an existence oracle", async () => {
    // A membership-scoped lookup against another tenant's workflow matches
    // nothing, exactly as a missing workflow does. The two responses are
    // indistinguishable except for the id the caller already supplied — the
    // same shape `startWorkflow` reports for a not-found workflow, whether the
    // miss was "does not exist" or "exists, but belongs to someone else".
    workflowFindFirst.mockResolvedValue(null);

    const foreign = await postTestRun("wf_foreign");
    const missing = await postTestRun("wf_missing");

    const foreignBody = (await foreign.json()) as Record<string, unknown>;
    const missingBody = (await missing.json()) as Record<string, unknown>;

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(Object.keys(foreignBody)).toEqual(Object.keys(missingBody));
    expect(foreignBody).not.toHaveProperty("orgId");
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });
});
