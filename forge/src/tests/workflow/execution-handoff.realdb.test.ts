// src/tests/workflow/execution-handoff.realdb.test.ts
//
// Assignment 37.12 — REAL-DATABASE acceptance for the execution handoff.
//
// WHY THIS FILE EXISTS
// --------------------
// src/tests/workflow/execution-handoff.test.ts proves the handoff CONTRACT with
// a mocked database: exactly one `workflowRun.create`, correct arguments, no
// workflow write. But a mock cannot show that the production query actually
// persists a run whose stored `context` is the empty trigger namespace, nor that
// a real materialized workfow row is left byte-for-byte untouched by a handoff.
// This suite does that against the real Postgres named by DATABASE_URL.
//
// It accepts a *materialized-shaped* workflow: triggerless (`eventId = null`),
// inactive (`isActive = false`), with a literal-config definition and a
// human-decided criticality flag — the shape 37.11 persists. Then it drives the
// REAL `triggerWorkflowRun` server action, which calls the REAL `startWorkflow`.
//
// WHAT IS REAL vs MOCKED
// ----------------------
//   REAL:   Prisma / Postgres, `getOrgAccess` (real membership query),
//           `startWorkflow` (real tenant-scoped lookup + run creation),
//           `triggerWorkflowRun`.
//   MOCKED: `auth()` — no request/cookie scope in a Jest process; identity is
//           not the subject. `advanceWorkflow` — the engine's first domino;
//           letting it run would acquire a real Redis lock and publish real
//           QStash messages. The boundary under test is the DECISION TO CREATE
//           THE RUN, so the positive case asserts `advanceWorkflow` was reached
//           with the created run id and nothing beyond Postgres is touched.
//
// Run it with the real-DB config (NOT the default one):
//
//   npx jest --config jest.realdb.config.ts \
//     src/tests/workflow/execution-handoff.realdb.test.ts
//
// SIDE-EFFECT BUDGET: with `advanceWorkflow` mocked, a run of this suite touches
// only Postgres. No QStash, Redis, Gemini, Pusher or email call is reachable.
//
// FIXTURE HYGIENE: unique run-scoped prefix; `afterAll` deletes by recorded ids
// AND by the TAG prefix, then asserts zero rows remain.

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));
jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn(),
}));

import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { triggerWorkflowRun } from "@/app/actions/workflows/workflow-run";

// A cold Neon connection can take tens of seconds; the default 5s hook timeout
// would fail misleadingly.
jest.setTimeout(120_000);

const authMock = auth as jest.Mock;
const advanceWorkflowMock = advanceWorkflow as jest.Mock;

const TAG = `handoff_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SLUG = `${TAG}_org`;
const EMAIL = `${TAG}_user@example.invalid`;

// The same literal definition a validator-clean, materialized proposal yields:
// no {{trigger.outputs.*}} reference, so an empty trigger namespace is correct.
const MATERIALIZED_DEFINITION = {
  id: `${TAG}_compiled`,
  name: "Compiled Execution Graph",
  steps: {
    n1: {
      id: "n1",
      action: "task.create",
      dependsOn: [],
      config: { title: "Onboard new hire", projectId: `${TAG}_project` },
      isCritical: true,
      kind: "ACTION",
    },
  },
};

let org: { id: string };
let user: { id: string };
let workflow: { id: string };

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const createdWorkflowIds: string[] = [];

function setAuthedUser(userId: string) {
  authMock.mockResolvedValue({ user: { id: userId, email: `${userId}@x` } });
}

async function runCount(workflowId: string) {
  return db.workflowRun.count({ where: { workflowId } });
}

beforeAll(async () => {
  org = await db.organization.create({
    data: { slug: SLUG, name: `${TAG} org` },
    select: { id: true },
  });
  createdOrgIds.push(org.id);

  user = await db.user.create({
    data: { email: EMAIL, name: `${TAG} user` },
    select: { id: true },
  });
  createdUserIds.push(user.id);

  await db.membership.create({
    data: { userId: user.id, orgId: org.id, role: "ADMIN" },
  });

  // The materialized shape: triggerless, inactive, literal config.
  workflow = await db.workflow.create({
    data: {
      name: `${TAG} materialized workflow`,
      orgId: org.id,
      isActive: false,
      definition: MATERIALIZED_DEFINITION,
    },
    select: { id: true },
  });
  createdWorkflowIds.push(workflow.id);

  advanceWorkflowMock.mockResolvedValue(undefined);
});

afterAll(async () => {
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

    await db.workflowRun.deleteMany({ where: { workflowId: { in: workflowIds } } });
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

    expect({
      leftoverRuns: await db.workflowRun.count({
        where: { workflowId: { in: workflowIds } },
      }),
      leftoverWorkflows: await db.workflow.count({
        where: { name: { startsWith: TAG } },
      }),
      leftoverOrgs: await db.organization.count({
        where: { slug: { startsWith: TAG } },
      }),
      leftoverUsers: await db.user.count({
        where: { email: { startsWith: TAG } },
      }),
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

describe("37.12 handoff — real Postgres", () => {
  it("creates nothing until an explicit start (no auto-run on materialization)", async () => {
    // The workflow exists in a materialized shape, is inactive and triggerless,
    // and has never been run: the mere existence of the row starts nothing.
    expect(await runCount(workflow.id)).toBe(0);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("persists exactly one RUNNING run with an empty trigger context, and reaches the engine", async () => {
    setAuthedUser(user.id);

    const before = await runCount(workflow.id);
    const result = await triggerWorkflowRun(workflow.id, SLUG);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.redirectTo).toBe(`/org/${SLUG}/runs/${result.runId}`);

    // The real query: exactly one new row, RUNNING, context primed with an empty
    // trigger namespace (a generated workflow consumes no trigger data).
    expect(await runCount(workflow.id)).toBe(before + 1);
    const stored = await db.workflowRun.findUnique({
      where: { id: result.runId },
      select: { workflowId: true, status: true, context: true },
    });
    expect(stored?.workflowId).toBe(workflow.id);
    expect(stored?.status).toBe("RUNNING");
    expect(stored?.context).toEqual({ trigger: { outputs: {} } });

    expect(advanceWorkflowMock).toHaveBeenCalledWith(result.runId);
  });

  it("leaves the persisted definition, dependencies, config and criticality untouched", async () => {
    setAuthedUser(user.id);

    const before = await db.workflow.findUnique({
      where: { id: workflow.id },
      select: { definition: true, isActive: true, updatedAt: true },
    });

    await triggerWorkflowRun(workflow.id, SLUG);

    const after = await db.workflow.findUnique({
      where: { id: workflow.id },
      select: { definition: true, isActive: true, updatedAt: true },
    });

    // Byte-for-byte equal, and `updatedAt` unchanged: the handoff never writes
    // the Workflow row. The engine consumes the human-approved definition as-is;
    // it does not re-derive or overwrite it.
    expect(after?.definition).toEqual(before?.definition);
    expect(after?.isActive).toBe(false);
    expect(after?.updatedAt?.toISOString()).toBe(before?.updatedAt?.toISOString());
  });

  it("refuses a trigger context that names tenant/identity keys, creating no run", async () => {
    setAuthedUser(user.id);

    const before = await runCount(workflow.id);
    const result = await triggerWorkflowRun(workflow.id, SLUG, {
      orgId: org.id,
      projectId: `${TAG}_project`,
    });

    expect(result).toEqual({ success: false, error: "Invalid trigger data." });
    expect(await runCount(workflow.id)).toBe(before);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });

  it("creates no run for an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);

    const before = await runCount(workflow.id);
    const result = await triggerWorkflowRun(workflow.id, SLUG);

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(await runCount(workflow.id)).toBe(before);
    expect(advanceWorkflowMock).not.toHaveBeenCalled();
  });
});
