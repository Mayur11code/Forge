// src/tests/security/i6-cross-tenant.realdb.test.ts
//
// I6 / Gate G — REAL-DATABASE acceptance test for cross-tenant workflow
// execution.
//
// WHY THIS FILE EXISTS
// --------------------
// The other I6 suites (trigger-tenant-scope, workflow-run-boundary-scope) run
// with the Prisma client mocked. They assert that the tenant predicate is passed
// to `findFirst`, but no SQL is ever executed, so they cannot prove that the
// production query actually refuses another tenant's row. Gate G requires the
// stronger evidence: a real database where org A exists, org B exists, a
// workflow belongs to B, and a caller authenticated for A genuinely cannot start
// it — with a real `SELECT count(*)` proving no `WorkflowRun` row was created.
//
// Run it with the real-DB config (NOT the default one):
//
//   npx jest --config jest.realdb.config.ts \
//     src/tests/security/i6-cross-tenant.realdb.test.ts
//
// The default `jest.setup-db-guard.ts` blanket-refuses a real PrismaClient, so
// this suite cannot run under `jest.config.ts` — by design.
//
// WHAT IS REAL vs MOCKED
// ----------------------
//   REAL:   Prisma / Postgres (`@/lib/prisma/db`), `getOrgAccess` (its real
//           membership query), `startWorkflow` (its real tenant-scoped lookup),
//           `triggerWorkflowRun` and the test-run route.
//   MOCKED: `auth()` — NextAuth needs a request/cookie scope that a Jest process
//           does not have; identity is not what Gate G disputes. It is replaced
//           with a function that returns the current fixture user.
//           `advanceWorkflow` — the engine's first domino. Letting it run would
//           acquire a real Redis lock and publish real QStash messages that
//           dispatch real actions; the boundary under test is the *decision to
//           create the run*, not the engine. The positive case therefore asserts
//           that `advanceWorkflow` was reached with the created run id.
//
// SIDE-EFFECT BUDGET: with `advanceWorkflow` mocked, a run of this suite touches
// only Postgres. No QStash, Redis, Gemini, Pusher or email call is reachable.
//
// FIXTURE HYGIENE: every row uses a unique run-scoped prefix and `afterAll`
// deletes it, then asserts zero rows remain. See `cleanup()`.

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));
jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn(),
}));

import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { startWorkflow } from "@/lib/workflow/execution/trigger";
import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";
import { POST } from "@/app/api/workflow/test/[workflowId]/test-run/route";

// A real (cold) Neon connection takes several seconds to establish; the default
// Jest 5s hook timeout is far too short and produces a misleading "hook
// exceeded timeout" rather than a connection error.
jest.setTimeout(120_000);

const authMock = auth as jest.Mock;
const advanceWorkflowMock = advanceWorkflow as jest.Mock;

// A unique prefix per process run, so concurrent or repeated runs never collide
// and cleanup can target exactly the rows this suite created.
const TAG = `i6acc_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SLUG_A = `${TAG}_a`;
const SLUG_B = `${TAG}_b`;
const EMAIL_A = `${TAG}_a@example.invalid`;
const EMAIL_B = `${TAG}_b@example.invalid`;

let orgA: { id: string };
let orgB: { id: string };
let userA: { id: string };
let userB: { id: string };
let workflowB: { id: string };
let workflowA: { id: string };

// Ids created so far, so cleanup is idempotent and safe even if `beforeAll`
// throws partway through (which is what produces orphaned fixture rows).
const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const createdWorkflowIds: string[] = [];

const NOT_FOUND = (id: string) => `Cannot start workflow: ${id} not found.`;

function setAuthedUser(userId: string) {
  authMock.mockResolvedValue({ user: { id: userId, email: `${userId}@x` } });
}

function postTestRun(workflowId: string) {
  return POST(
    new Request(`http://localhost/api/workflow/test/${workflowId}/test-run`, {
      method: "POST",
    }),
    { params: Promise.resolve({ workflowId }) },
  );
}

async function runCount(workflowId: string) {
  return db.workflowRun.count({ where: { workflowId } });
}

beforeAll(async () => {
  // Fixtures: two independent tenants, each with a user and a membership, plus
  // one workflow owned by each. Crucially, user A is NOT a member of org B and
  // vice versa.
  orgA = await db.organization.create({
    data: { slug: SLUG_A, name: `${TAG} A` },
    select: { id: true },
  });
  createdOrgIds.push(orgA.id);
  orgB = await db.organization.create({
    data: { slug: SLUG_B, name: `${TAG} B` },
    select: { id: true },
  });
  createdOrgIds.push(orgB.id);

  userA = await db.user.create({
    data: { email: EMAIL_A, name: `${TAG} user A` },
    select: { id: true },
  });
  createdUserIds.push(userA.id);
  userB = await db.user.create({
    data: { email: EMAIL_B, name: `${TAG} user B` },
    select: { id: true },
  });
  createdUserIds.push(userB.id);

  await db.membership.create({
    data: { userId: userA.id, orgId: orgA.id, role: "ADMIN" },
  });
  await db.membership.create({
    data: { userId: userB.id, orgId: orgB.id, role: "ADMIN" },
  });

  workflowA = await db.workflow.create({
    data: { name: `${TAG} workflow A`, orgId: orgA.id },
    select: { id: true },
  });
  createdWorkflowIds.push(workflowA.id);
  workflowB = await db.workflow.create({
    data: { name: `${TAG} workflow B`, orgId: orgB.id },
    select: { id: true },
  });
  createdWorkflowIds.push(workflowB.id);

  advanceWorkflowMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  // Delete in FK-safe order. Workflow runs cascade from workflows, and step
  // runs / audit logs cascade from runs. Membership has no cascade, so it is
  // deleted before users and organizations.
  //
  // Cleanup is driven by the recorded ids AND by the run TAG prefix, so it also
  // removes anything left by a partially-completed `beforeAll`. It must never
  // throw, or the remaining fixtures leak.
  try {
    const orgIds =
      createdOrgIds.length > 0
        ? createdOrgIds
        : (
            await db.organization.findMany({
              where: { slug: { startsWith: TAG } },
              select: { id: true },
            })
          ).map((o) => o.id);

    const workflowIds =
      createdWorkflowIds.length > 0
        ? createdWorkflowIds
        : (
            await db.workflow.findMany({
              where: { orgId: { in: orgIds } },
              select: { id: true },
            })
          ).map((w) => w.id);

    await db.workflowRun.deleteMany({
      where: { workflowId: { in: workflowIds } },
    });
    await db.workflow.deleteMany({ where: { id: { in: workflowIds } } });
    await db.membership.deleteMany({
      where: { OR: [{ orgId: { in: orgIds } }, { userId: { in: createdUserIds } }] },
    });
    await db.user.deleteMany({
      where: {
        OR: [{ id: { in: createdUserIds } }, { email: { startsWith: TAG } }],
      },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });

    // Prove the fixtures are gone.
    const leftoverRuns = await db.workflowRun.count({
      where: { workflowId: { in: workflowIds } },
    });
    const leftoverWorkflows = await db.workflow.count({
      where: { name: { startsWith: TAG } },
    });
    const leftoverOrgs = await db.organization.count({
      where: { slug: { startsWith: TAG } },
    });
    const leftoverUsers = await db.user.count({
      where: { email: { startsWith: TAG } },
    });

    expect({
      leftoverRuns,
      leftoverWorkflows,
      leftoverOrgs,
      leftoverUsers,
    }).toEqual({
      leftoverRuns: 0,
      leftoverWorkflows: 0,
      leftoverOrgs: 0,
      leftoverUsers: 0,
    });
  } finally {
    await db.$disconnect();
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  advanceWorkflowMock.mockResolvedValue(undefined);
});

describe("I6 / Gate G — startWorkflow against a real database", () => {
  it("refuses another organization's workflow and creates no WorkflowRun row", async () => {
    // userA / orgA tries to start org B's workflow through the engine entrypoint.
    await expect(startWorkflow(orgA.id, workflowB.id)).rejects.toThrow(
      NOT_FOUND(workflowB.id),
    );

    // The real-DB analogue of `expect(create).not.toHaveBeenCalled()`: query the
    // table. A tenant predicate that merely ran but was not enforced would leave
    // a row here.
    expect(await runCount(workflowB.id)).toBe(0);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("refuses a workflow that does not exist, indistinguishably from a foreign one", async () => {
    const missingId = `${TAG}_missing_workflow`;

    await expect(startWorkflow(orgA.id, missingId)).rejects.toThrow(
      NOT_FOUND(missingId),
    );
    expect(await runCount(missingId)).toBe(0);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("starts the run and reaches the engine for the owning organization (positive control)", async () => {
    setAuthedUser(userA.id);

    const run = await startWorkflow(orgA.id, workflowA.id, {
      projectId: `${TAG}_project`,
    });

    expect(run.id).toBeTruthy();
    expect(await runCount(workflowA.id)).toBe(1);

    const stored = await db.workflowRun.findFirst({
      where: { workflowId: workflowA.id },
      select: { status: true, context: true },
    });
    expect(stored?.status).toBe("RUNNING");
    expect(stored?.context).toMatchObject({
      trigger: { outputs: { projectId: `${TAG}_project` } },
    });

    expect(advanceWorkflowMock).toHaveBeenCalledWith(run.id);
  });
});

describe("I6 / Gate G — triggerWorkflowRun server action against a real database", () => {
  it("refuses a member of A acting on B's slug (real getOrgAccess), no run created", async () => {
    setAuthedUser(userA.id);

    const before = await runCount(workflowB.id);
    const result = await triggerWorkflowRun(workflowB.id, SLUG_B, {
      projectId: `${TAG}_project`,
    });

    // Real `getOrgAccess(SLUG_B)` finds org B, but userA has no membership in it,
    // so access is null and the action stops with no side effects.
    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(await runCount(workflowB.id)).toBe(before);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("starts A's workflow when A acts on A's own slug (positive control)", async () => {
    setAuthedUser(userA.id);

    const result = await triggerWorkflowRun(workflowA.id, SLUG_A, {
      projectId: `${TAG}_project`,
    });

    expect(result.success).toBe(true);
    expect(await runCount(workflowA.id)).toBeGreaterThan(0);
    expect(advanceWorkflowMock).toHaveBeenCalled();
  });

  it("refuses a payload that smuggles an org id, before the engine (37.12 boundary)", async () => {
    setAuthedUser(userA.id);

    const before = await runCount(workflowA.id);
    const result = await triggerWorkflowRun(workflowA.id, SLUG_A, {
      projectId: `${TAG}_project`,
      orgId: orgB.id,
      organizationId: orgB.id,
    });

    // 37.12 tightened the trigger context into a data boundary: a reserved
    // tenant/identity key is refused outright rather than silently ignored, so
    // the action stops before any run is created. The tenant was never at risk
    // (it is server-derived), but the explicit refusal is the stronger contract.
    expect(result).toEqual({ success: false, error: "Invalid trigger data." });
    expect(await runCount(workflowA.id)).toBe(before);
    expect(await runCount(workflowB.id)).toBe(0);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });
});

describe("I6 / Gate G — test-run route against a real database", () => {
  it("returns 404 for a foreign workflow via a real membership-scoped query", async () => {
    setAuthedUser(userA.id);

    const before = await runCount(workflowB.id);
    const res = await postTestRun(workflowB.id);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("orgId");
    expect(await runCount(workflowB.id)).toBe(before);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("returns an identical 404 for a nonexistent workflow (no existence oracle)", async () => {
    setAuthedUser(userA.id);
    const missingId = `${TAG}_missing_workflow`;

    const foreign = await postTestRun(workflowB.id);
    const missing = await postTestRun(missingId);

    const foreignBody = (await foreign.json()) as Record<string, unknown>;
    const missingBody = (await missing.json()) as Record<string, unknown>;

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(Object.keys(foreignBody)).toEqual(Object.keys(missingBody));
  });

  it("starts A's workflow for a member of A (positive control)", async () => {
    setAuthedUser(userA.id);

    const res = await postTestRun(workflowA.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("runId");
    expect(advanceWorkflowMock).toHaveBeenCalled();
  });

  it("rejects an unauthenticated request with 401 and no side effects", async () => {
    authMock.mockResolvedValue(null);

    const before = await runCount(workflowA.id);
    const res = await postTestRun(workflowA.id);

    expect(res.status).toBe(401);
    expect(await runCount(workflowA.id)).toBe(before);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });
});
