// src/tests/workflow/workflow-test-run-tenant-context.test.ts
//
// Regression and hardening tests for POST /api/workflow/test/[workflowId]/test-run.
// Verifies that:
// 1. Hardcoded development project IDs are completely eliminated.
// 2. Non-default organizations can run workflow tests cleanly.
// 3. Optional project context is validated against the workflow's owning organization.
// 4. Cross-tenant project IDs are rejected with 404 before execution.
// 5. Malformed or forbidden trigger keys are rejected with 400.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    workflow: { findFirst: jest.fn() },
    project: { findFirst: jest.fn() },
  },
}));

jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

jest.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({
    allowed: true,
    status: 200,
    headers: {},
  }),
  createRateLimitResponse: jest.fn(),
  RATE_LIMIT_POLICIES: {
    REQUEST_WORKFLOW_TEST_RUN: "REQUEST_WORKFLOW_TEST_RUN",
  },
}));

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { POST } from "@/app/api/workflow/test/[workflowId]/test-run/route";

const authMock = auth as jest.Mock;
const workflowFindFirst = db.workflow.findFirst as jest.Mock;
const projectFindFirst = db.project.findFirst as jest.Mock;
const startWorkflowMock = startWorkflow as jest.Mock;

const USER_ID = "user_enterprise";
const ORG_CUSTOM = "org_custom_enterprise_99";
const WORKFLOW_ID = "wf_custom_1";
const PROJECT_VALID = "proj_valid_in_org";
const PROJECT_CROSS_TENANT = "proj_belonging_to_other_org";

function makeTestRunRequest(workflowId: string, body?: unknown) {
  const init: RequestInit = {
    method: "POST",
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return POST(
    new Request(`http://localhost/api/workflow/test/${workflowId}/test-run`, init),
    { params: Promise.resolve({ workflowId }) },
  );
}

describe("POST /api/workflow/test/[workflowId]/test-run — Dynamic Tenant Context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: USER_ID } });
    startWorkflowMock.mockResolvedValue({ id: "run_enterprise_1" });
    workflowFindFirst.mockResolvedValue({
      id: WORKFLOW_ID,
      orgId: ORG_CUSTOM,
    });
  });

  it("permits non-default organization test run with NO hardcoded project ID when body is omitted", async () => {
    const res = await makeTestRunRequest(WORKFLOW_ID);

    expect(res.status).toBe(200);
    // Verified invariant: no fabricated or hardcoded 'cmnj8u44p0003a0gcvqgt25dv'
    expect(startWorkflowMock).toHaveBeenCalledWith(ORG_CUSTOM, WORKFLOW_ID, {});
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.runId).toBe("run_enterprise_1");
    expect(body.redirectTo).toBe(`/org/${ORG_CUSTOM}/runs/run_enterprise_1`);
  });

  it("permits non-default organization test run with empty JSON body", async () => {
    const res = await makeTestRunRequest(WORKFLOW_ID, {});

    expect(res.status).toBe(200);
    expect(startWorkflowMock).toHaveBeenCalledWith(ORG_CUSTOM, WORKFLOW_ID, {});
  });

  it("accepts a validated project belonging to the workflow's organization", async () => {
    projectFindFirst.mockResolvedValueOnce({ id: PROJECT_VALID });

    const res = await makeTestRunRequest(WORKFLOW_ID, {
      projectId: PROJECT_VALID,
    });

    expect(res.status).toBe(200);
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: PROJECT_VALID,
        orgId: ORG_CUSTOM,
      },
      select: { id: true },
    });
    expect(startWorkflowMock).toHaveBeenCalledWith(ORG_CUSTOM, WORKFLOW_ID, {
      projectId: PROJECT_VALID,
    });
  });

  it("rejects cross-tenant projectId with 404 without executing workflow", async () => {
    // Project exists in DB, but does NOT belong to ORG_CUSTOM
    projectFindFirst.mockResolvedValueOnce(null);

    const res = await makeTestRunRequest(WORKFLOW_ID, {
      projectId: PROJECT_CROSS_TENANT,
    });

    expect(res.status).toBe(404);
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: PROJECT_CROSS_TENANT,
        orgId: ORG_CUSTOM,
      },
      select: { id: true },
    });
    // Critical invariant: startWorkflow must NEVER be called with cross-tenant project
    expect(startWorkflowMock).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Project not found in this organization.");
  });

  it("rejects forbidden trigger context keys (e.g. orgId injection) with 400", async () => {
    const res = await makeTestRunRequest(WORKFLOW_ID, {
      orgId: "org_attacker_override",
    });

    expect(res.status).toBe(400);
    expect(startWorkflowMock).not.toHaveBeenCalled();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid trigger data.");
  });

  it("rejects malformed JSON body with 400", async () => {
    const req = new Request(
      `http://localhost/api/workflow/test/${WORKFLOW_ID}/test-run`,
      {
        method: "POST",
        body: "{ invalid json ...",
        headers: { "Content-Type": "application/json" },
      },
    );

    const res = await POST(req, {
      params: Promise.resolve({ workflowId: WORKFLOW_ID }),
    });

    expect(res.status).toBe(400);
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });
});
