// src/tests/security/http-route-authz.test.ts
//
// S2/S3/S4/S7/S8 — authorization and response-hygiene fixations on HTTP routes.
//
// Each route below is publicly reachable (the middleware matcher excludes
// `/api`), so each had to self-authenticate. The fixes add an authentication /
// authorization gate and, in two cases, remove a disclosure from the response
// body. These tests pin the gate and the disclosure behaviour, not the business
// logic that runs behind them.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    membership: { findUnique: jest.fn() },
    task: { findFirst: jest.fn() },
    project: { findFirst: jest.fn() },
    workflow: { findFirst: jest.fn() },
  },
}));

jest.mock("@/lib/workflow/execution/trigger", () => ({
  startWorkflow: jest.fn(),
}));

jest.mock("razorpay", () => {
  const create = jest.fn();
  const ctor = jest.fn().mockImplementation(() => ({
    subscriptions: { create },
  }));
  (ctor as unknown as { __create: jest.Mock }).__create = create;
  return { __esModule: true, default: ctor };
});

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: { project: { findFirst: jest.fn() } },
}));

jest.mock("@/lib/tasks/create-task", () => ({
  createTaskInOrg: jest.fn(),
}));

jest.mock("@/lib/ai/provider", () => ({ googleProvider: {} }));
jest.mock("@/lib/ai/schemas", () => ({
  architectureReportSchema: {},
  triageSchema: {},
}));

jest.mock("ai", () => ({
  streamText: jest.fn(),
  generateObject: jest.fn(),
  Output: { object: jest.fn() },
}));

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { prisma } from "@/lib/prisma/extended";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import Razorpay from "razorpay";

const authMock = auth as jest.MockedFunction<typeof auth>;
const membershipFindUnique = db.membership.findUnique as jest.Mock;
const taskFindFirst = db.task.findFirst as jest.Mock;
const projectFindFirst = prisma.project.findFirst as jest.Mock;
const workflowFindFirst = db.workflow.findFirst as jest.Mock;
const startWorkflowMock = startWorkflow as jest.Mock;
const getOrgAccessMock = getOrgAccess as jest.Mock;
const razorpayCreate = (Razorpay as unknown as { __create: jest.Mock }).__create;

const USER_ID = "user_1";
const ORG_ID = "org_1";

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER_ID } } as never);
});

// ---------------------------------------------------------------------------
// S2 — POST /api/razerpay/create-order
// ---------------------------------------------------------------------------
describe("S2 create-order requires an authenticated ADMIN of the named org", () => {
  async function createOrder(orgId?: string) {
    const { POST } = await import("@/app/api/razerpay/create-order/route");
    return POST(
      jsonRequest("http://localhost/api/razerpay/create-order", { orgId }),
    );
  }

  it("rejects an unauthenticated request with 401 and creates no subscription", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await createOrder(ORG_ID);

    expect(res.status).toBe(401);
    expect(razorpayCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 403 and creates no subscription", async () => {
    membershipFindUnique.mockResolvedValue(null);

    const res = await createOrder(ORG_ID);

    expect(res.status).toBe(403);
    expect(razorpayCreate).not.toHaveBeenCalled();
  });

  it("rejects a plain MEMBER with 403", async () => {
    membershipFindUnique.mockResolvedValue({ role: "MEMBER" });

    const res = await createOrder(ORG_ID);

    expect(res.status).toBe(403);
    expect(razorpayCreate).not.toHaveBeenCalled();
  });

  it("scopes the membership lookup to the session user and the requested org", async () => {
    membershipFindUnique.mockResolvedValue({ role: "ADMIN" });
    razorpayCreate.mockResolvedValue({ id: "sub_1" });

    await createOrder(ORG_ID);

    expect(membershipFindUnique).toHaveBeenCalledWith({
      where: { userId_orgId: { userId: USER_ID, orgId: ORG_ID } },
      select: { role: true },
    });
  });

  it("lets an ADMIN through", async () => {
    membershipFindUnique.mockResolvedValue({ role: "ADMIN" });
    razorpayCreate.mockResolvedValue({ id: "sub_1" });

    const res = await createOrder(ORG_ID);

    expect(res.status).toBe(200);
    expect(razorpayCreate).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S3 — POST /api/stream-audit
// ---------------------------------------------------------------------------
describe("S3 stream-audit requires authentication", () => {
  it("rejects an unauthenticated request with 401 before invoking the model", async () => {
    authMock.mockResolvedValue(null as never);
    const { POST } = await import("@/app/api/stream-audit/route");

    const res = await POST(
      jsonRequest("http://localhost/api/stream-audit", { architecture: "x" }),
    );

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// S4 — uploadthing task-attachment tenant scope
// ---------------------------------------------------------------------------
describe("S4 uploadthing scopes an attachment to the caller's org", () => {
  it("resolves the task under the authorized orgId, not by id alone", async () => {
    taskFindFirst.mockResolvedValue({ id: "task_1" });

    const { assertTaskInOrg } = await import("@/app/api/uploadthing/core");

    await expect(assertTaskInOrg(ORG_ID, "task_1")).resolves.toBe(true);
    expect(taskFindFirst).toHaveBeenCalledWith({
      where: { id: "task_1", project: { orgId: ORG_ID } },
      select: { id: true },
    });
  });

  it("refuses a task whose id exists but is not in the authorized org", async () => {
    // A real database scoped by `project: { orgId }` returns null for a foreign
    // task even though its id is valid.
    taskFindFirst.mockResolvedValue(null);

    const { assertTaskInOrg } = await import("@/app/api/uploadthing/core");

    await expect(assertTaskInOrg(ORG_ID, "foreign_task")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S7 — POST /api/triage: no project-existence oracle
// ---------------------------------------------------------------------------
describe("S7 triage does not distinguish missing from forbidden", () => {
  async function triage(projectId: string) {
    const { POST } = await import("@/app/api/triage/route");
    return POST(
      jsonRequest("http://localhost/api/triage", {
        projectId,
        rawBugReport: "something broke",
      }),
    );
  }

  it("returns the same 404 for a missing project and an unauthorized one", async () => {
    projectFindFirst.mockResolvedValue(null);
    const missing = await triage("missing");

    projectFindFirst.mockResolvedValue({
      id: "p",
      orgId: "org_x",
      organization: { slug: "other" },
    });
    getOrgAccessMock.mockResolvedValue(null);
    const forbidden = await triage("foreign");

    expect(missing.status).toBe(404);
    expect(forbidden.status).toBe(404);
    expect(await missing.json()).toEqual(await forbidden.json());
  });
});

// ---------------------------------------------------------------------------
// S8 — POST /api/workflow/test/[workflowId]/test-run response hygiene
// ---------------------------------------------------------------------------
describe("S8 test-run does not echo internals on failure", () => {
  it("returns a generic 500 body without the error message or stack", async () => {
    workflowFindFirst.mockResolvedValue({ id: "wf_1", orgId: ORG_ID });
    startWorkflowMock.mockRejectedValue(new Error("SECRET_INTERNAL_DETAIL"));

    const { POST } = await import(
      "@/app/api/workflow/test/[workflowId]/test-run/route"
    );
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ workflowId: "wf_1" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("SECRET_INTERNAL_DETAIL");
    expect(body.stack).toBeUndefined();
  });
});
