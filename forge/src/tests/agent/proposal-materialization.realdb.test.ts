// src/tests/agent/proposal-materialization.realdb.test.ts
//
// Assignment 37.11 - REAL-DATABASE acceptance for proposal -> workflow
// materialization.
//
// WHY THIS FILE EXISTS
// --------------------
// `proposal-materialization.test.ts` proves the service against the in-memory
// prisma double. That double can model the unique index and the org-scoped read
// by hand, but it has no real transaction: it cannot show that the
// compare-and-set and the `workflow.create` actually commit together, that a
// P2002 leaves the proposal state untouched, or that a persisted `uiNodes`,
// `uiEdges` and `definition` are what the real Postgres row holds.
//
// This suite drives the REAL `materializeProposal` against the real Postgres
// named by DATABASE_URL:
//
//   REAL:   Prisma / Postgres, `getAgentSessionForUser` (real ownership read),
//           `getProposalReviewExecution`, the compiler, the criticality
//           contract, the 37.10 projection, the shared save-boundary validators,
//           the `$transaction` CAS + create, and the unique `sourceProposalId`
//           index.
//   MOCKED: `withAgentSessionLock` - a pass-through callback. The Redis lock is
//           not the subject here (it is covered by its own suites); letting it
//           run would require a live Redis and would serialise the concurrency
//           case we want to exercise at the database level.
//
// Run it with the real-DB config (NOT the default one):
//
//   npx jest --config jest.realdb.config.ts \
//     src/tests/agent/proposal-materialization.realdb.test.ts
//
// SIDE-EFFECT BUDGET: materialization creates a Workflow and nothing else. This
// suite mocks the lock and performs no QStash, Redis, Gemini, Pusher or email
// call. It also asserts that no WorkflowRun or AgentOutboxEvent is produced.
//
// FIXTURE HYGIENE: unique run-scoped prefix; `afterAll` deletes by recorded ids
// and by the TAG prefix, then asserts zero rows remain.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn(),
}));

// The re-save half of the round trip drives the real save action, which needs
// the request-scoped pieces mocked: session-derived org access and the Next
// cache revalidation. The database write itself is real.
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

import {
  AgentProposalState,
  AgentSessionStatus,
  type Prisma,
} from "@prisma/client";

import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { updateWorkflowState } from "@/app/actions/workflows/workflow";
import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import { projectProposalToUIGraph } from "@/lib/workflow-types/proposal-ui-projection";
import {
  collectWorkflowDefinitionIssues,
  WorkflowDefinitionSchema,
  type AppEdge,
  type AppNode,
} from "@/lib/workflow-types/workflow";
import { compileWorkflow } from "@/lib/workflow/graph-ui/compiler";
import { materializeProposal } from "@/lib/ai/agent/services/proposal-materialization-service";

jest.setTimeout(120_000);

const lockMock = withAgentSessionLock as jest.Mock;
const getOrgAccessMock = getOrgAccess as jest.Mock;

const TAG = `matacc_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SLUG_A = `${TAG}_a`;
const SLUG_B = `${TAG}_b`;
const EMAIL_A = `${TAG}_a@example.invalid`;
const EMAIL_B = `${TAG}_b@example.invalid`;

const PROJECT_ID = "clxyz0000000000000000000a";

// A validator-clean two-step proposal. `follow` depends on `kickoff`, so the
// graph is not a flat list and the projection must emit one edge.
const PROPOSAL = {
  name: "Onboard a client",
  description: "Kick off the onboarding.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Create the onboarding task", projectId: PROJECT_ID },
      dependsOn: [],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up on kickoff", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

const DECISIONS = { kickoff: false, follow: true };
const FINGERPRINT = computeProposalCorrelationId(PROPOSAL);

let orgA: { id: string };
let orgB: { id: string };
let userA: { id: string };
let userB: { id: string };

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
let toolCallSeq = 0;

async function createSessionAndProposal(
  overrides: {
    proposalState?: AgentProposalState;
    criticalityDecisions?: unknown;
    result?: unknown;
    proposalFingerprint?: string | null;
    toolName?: string;
    orgId?: string;
    userId?: string;
  } = {},
): Promise<{ sessionId: string; executionId: string }> {
  const session = await db.agentSession.create({
    data: {
      orgId: overrides.orgId ?? orgA.id,
      userId: overrides.userId ?? userA.id,
      status: AgentSessionStatus.RUNNING,
      promptVersion: "v6",
    },
    select: { id: true },
  });
  createdSessionIds.push(session.id);

  const execution = await db.agentToolExecution.create({
    data: {
      sessionId: session.id,
      toolCallId: `${TAG}_call_${toolCallSeq++}`,
      toolName: overrides.toolName ?? "generateWorkflow",
      input: {},
      status: "COMPLETED",
      result: (overrides.result === undefined
        ? { ok: true, proposal: PROPOSAL }
        : overrides.result) as Prisma.InputJsonValue,
      proposalState: overrides.proposalState ?? AgentProposalState.APPROVED,
      proposalFingerprint:
        overrides.proposalFingerprint === undefined
          ? FINGERPRINT
          : overrides.proposalFingerprint,
      proposalRevision: 1,
      criticalityDecisions: (overrides.criticalityDecisions === undefined
        ? DECISIONS
        : overrides.criticalityDecisions) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return { sessionId: session.id, executionId: execution.id };
}

function materialize(
  sessionId: string,
  executionId: string,
  userId: string = userA.id,
) {
  return materializeProposal({ sessionId, userId, interactionId: executionId });
}

async function workflowFor(executionId: string) {
  return db.workflow.findFirst({
    where: { sourceProposalId: executionId },
  });
}

beforeAll(async () => {
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
    data: { email: EMAIL_A, name: `${TAG} A user` },
    select: { id: true },
  });
  createdUserIds.push(userA.id);

  userB = await db.user.create({
    data: { email: EMAIL_B, name: `${TAG} B user` },
    select: { id: true },
  });
  createdUserIds.push(userB.id);

  await db.membership.create({
    data: { userId: userA.id, orgId: orgA.id, role: "ADMIN" },
  });
  await db.membership.create({
    data: { userId: userB.id, orgId: orgB.id, role: "ADMIN" },
  });
});

afterAll(async () => {
  try {
    const orgIds = createdOrgIds.length
      ? createdOrgIds
      : (
          await db.organization.findMany({
            where: { slug: { startsWith: TAG } },
            select: { id: true },
          })
        ).map((o) => o.id);

    const sessionIds = createdSessionIds.length
      ? createdSessionIds
      : (
          await db.agentSession.findMany({
            where: { orgId: { in: orgIds } },
            select: { id: true },
          })
        ).map((s) => s.id);

    const workflowIds = (
      await db.workflow.findMany({
        where: {
          OR: [
            { orgId: { in: orgIds } },
            { name: { startsWith: TAG } },
          ],
        },
        select: { id: true },
      })
    ).map((w) => w.id);

    await db.workflowRun.deleteMany({
      where: { workflowId: { in: workflowIds } },
    });
    await db.workflow.deleteMany({ where: { id: { in: workflowIds } } });
    await db.agentOutboxEvent.deleteMany({
      where: { sessionId: { in: sessionIds } },
    });
    // Cascades to AgentToolExecution / AgentMessage.
    await db.agentSession.deleteMany({ where: { id: { in: sessionIds } } });
    await db.membership.deleteMany({
      where: {
        OR: [
          { orgId: { in: orgIds } },
          { userId: { in: createdUserIds } },
        ],
      },
    });
    await db.user.deleteMany({
      where: {
        OR: [
          { id: { in: createdUserIds } },
          { email: { startsWith: TAG } },
        ],
      },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });

    expect({
      leftoverWorkflows: await db.workflow.count({
        where: { name: { startsWith: TAG } },
      }),
      leftoverSessions: await db.agentSession.count({
        where: { orgId: { in: orgIds } },
      }),
      leftoverOrgs: await db.organization.count({
        where: { slug: { startsWith: TAG } },
      }),
      leftoverUsers: await db.user.count({
        where: { email: { startsWith: TAG } },
      }),
    }).toEqual({
      leftoverWorkflows: 0,
      leftoverSessions: 0,
      leftoverOrgs: 0,
      leftoverUsers: 0,
    });
  } finally {
    await db.$disconnect();
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  // Pass-through lock; see the header. Database-level races are still real.
  lockMock.mockImplementation(
    async (_id: string, cb: () => Promise<unknown>) => cb(),
  );
  getOrgAccessMock.mockResolvedValue({
    organization: { id: orgA.id },
    role: "ADMIN",
  });
});

describe("37.11 materialization - real Postgres", () => {
  it("materializes an approved proposal and transitions APPROVED -> MATERIALIZED", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();

    const result = await materialize(sessionId, executionId);

    expect(result).toMatchObject({
      ok: true,
      state: AgentProposalState.MATERIALIZED,
    });

    const stored = await workflowFor(executionId);
    expect(stored).not.toBeNull();

    const execution = await db.agentToolExecution.findUnique({
      where: { id: executionId },
      select: { proposalState: true },
    });
    expect(execution?.proposalState).toBe(AgentProposalState.MATERIALIZED);

    // Provenance + human-facing identity.
    expect(stored?.sourceProposalId).toBe(executionId);
    expect(stored?.name).toBe(PROPOSAL.name);
    expect(stored?.description).toBe(PROPOSAL.description);
    expect(stored?.orgId).toBe(orgA.id);

    // Triggerless and inactive (F1).
    expect(stored?.isActive).toBe(false);
    expect(stored?.eventId).toBeNull();

    // Materialization only: no run, no loop, no outbox intent, and no Task row
    // per generated node.
    expect(
      await db.workflowRun.count({ where: { workflowId: stored!.id } }),
    ).toBe(0);
    expect(
      await db.agentOutboxEvent.count({ where: { sessionId } }),
    ).toBe(0);
    expect(
      await db.task.count({ where: { project: { orgId: orgA.id } } }),
    ).toBe(0);
  });

  it("persists the canonical definition with human criticality applied", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();

    await materialize(sessionId, executionId);
    const stored = await workflowFor(executionId);
    const definition = stored?.definition as {
      id: string;
      name: string;
      steps: Record<
        string,
        {
          id: string;
          action: string;
          dependsOn: string[];
          config: Record<string, unknown>;
          isCritical: boolean;
          kind: "ACTION" | "TRIGGER";
        }
      >;
    };

    expect(definition.id).toBe("proposal");
    expect(definition.name).toBe("Compiled Execution Graph");

    expect(definition.steps.kickoff).toEqual({
      id: "kickoff",
      action: "task.create",
      dependsOn: [],
      config: { title: "Create the onboarding task", projectId: PROJECT_ID },
      isCritical: false,
      kind: "ACTION",
    });
    expect(definition.steps.follow).toEqual({
      id: "follow",
      action: "task.create",
      dependsOn: ["kickoff"],
      config: { title: "Follow up on kickoff", projectId: PROJECT_ID },
      isCritical: true,
      kind: "ACTION",
    });

    // No model-owned criticality survived the placeholder stage.
    expect(Object.keys(definition.steps).sort()).toEqual(["follow", "kickoff"]);

    // The persisted definition passes the graph authority and the runtime
    // read-boundary validator, so a re-save/reload does not depend on the
    // materializer having written something only it can read.
    expect(collectWorkflowDefinitionIssues(definition)).toEqual([]);
    expect(WorkflowDefinitionSchema.safeParse(definition).success).toBe(true);
  });

  it("persists exactly the 37.10 UI projection through the shared boundary", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();

    await materialize(sessionId, executionId);
    const stored = await workflowFor(executionId);

    const expected = projectProposalToUIGraph(PROPOSAL, DECISIONS);
    expect(expected.success).toBe(true);
    if (!expected.success) throw new Error("fixture did not project");

    // JSON round-trip mirrors the JSONB column's representation.
    const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

    expect(stored?.uiNodes).toEqual(asJson(expected.uiNodes));
    expect(stored?.uiEdges).toEqual(asJson(expected.uiEdges));

    const nodes = stored?.uiNodes as Array<{ id: string; data?: unknown }>;
    const edges = stored?.uiEdges as Array<{ source: string; target: string }>;
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "kickoff", target: "follow" });

    // THE ROUND TRIP: the stored canvas graph recompiles to the SAME logical
    // graph the materializer persisted. This is the 37.11 verification gate -
    // definition and UI projection are two views of one graph, not two artifacts
    // that can drift.
    const recompiled = compileWorkflow(
      stored?.uiNodes as unknown as AppNode[],
      stored?.uiEdges as unknown as AppEdge[],
    );
    const persisted = stored?.definition as {
      steps: Record<
        string,
        {
          action: string;
          dependsOn: string[];
          config: Record<string, unknown>;
          isCritical: boolean;
          kind: "ACTION" | "TRIGGER";
        }
      >;
    };

    expect(Object.keys(recompiled.steps).sort()).toEqual(
      Object.keys(persisted.steps).sort(),
    );
    for (const ref of Object.keys(persisted.steps)) {
      expect(recompiled.steps[ref]).toMatchObject({
        action: persisted.steps[ref].action,
        dependsOn: persisted.steps[ref].dependsOn,
        config: persisted.steps[ref].config,
        isCritical: persisted.steps[ref].isCritical,
        kind: persisted.steps[ref].kind,
      });
    }
  });

  it("keeps provenance and identity across a real canvas re-save", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();
    await materialize(sessionId, executionId);

    const before = await workflowFor(executionId);
    if (!before) throw new Error("materialization did not persist a workflow");

    const saved = await updateWorkflowState(
      SLUG_A,
      before.id,
      before.uiNodes as unknown[],
      before.uiEdges as unknown[],
    );
    expect(saved).toEqual({ success: true });

    const after = await workflowFor(executionId);
    // `sourceProposalId` is the stable provenance key: a save rewrites the
    // canvas/definition but must never sever or repoint the proposal link.
    expect(after?.id).toBe(before.id);
    expect(after?.sourceProposalId).toBe(executionId);
    // The human-facing identity is also not a canvas field, so it survives.
    expect(after?.name).toBe(PROPOSAL.name);
    expect(after?.orgId).toBe(orgA.id);
    // Still triggerless and inactive after a save that adds no trigger.
    expect(after?.isActive).toBe(false);
    expect(after?.eventId).toBeNull();

    const recompiled = compileWorkflow(
      after?.uiNodes as unknown as AppNode[],
      after?.uiEdges as unknown as AppEdge[],
    );
    const persisted = after?.definition as {
      steps: Record<string, { action: string; dependsOn: string[] }>;
    };
    expect(Object.keys(recompiled.steps).sort()).toEqual(["follow", "kickoff"]);
    expect(recompiled.steps.follow.dependsOn).toEqual(
      persisted.steps.follow.dependsOn,
    );
  });

  it("is idempotent on retry: the same workflow id, no second row", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();

    const first = await materialize(sessionId, executionId);
    const second = await materialize(sessionId, executionId);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, idempotent: true });
    if (first.ok && second.ok) {
      expect(second.workflowId).toBe(first.workflowId);
    }

    expect(
      await db.workflow.count({ where: { sourceProposalId: executionId } }),
    ).toBe(1);
  });

  it("does not create a workflow for a proposal that is not APPROVED", async () => {
    const { sessionId, executionId } = await createSessionAndProposal({
      proposalState: AgentProposalState.AWAITING_APPROVAL,
    });

    const result = await materialize(sessionId, executionId);

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "PROPOSAL_NOT_APPROVED",
    });
    expect(await workflowFor(executionId)).toBeNull();

    const execution = await db.agentToolExecution.findUnique({
      where: { id: executionId },
      select: { proposalState: true },
    });
    expect(execution?.proposalState).toBe(AgentProposalState.AWAITING_APPROVAL);
  });

  it("rejects an incomplete criticality set without writing a workflow", async () => {
    const { sessionId, executionId } = await createSessionAndProposal({
      criticalityDecisions: { kickoff: false },
    });

    const result = await materialize(sessionId, executionId);

    expect(result).toMatchObject({ ok: false, httpStatus: 409 });
    expect(await workflowFor(executionId)).toBeNull();

    const execution = await db.agentToolExecution.findUnique({
      where: { id: executionId },
      select: { proposalState: true },
    });
    expect(execution?.proposalState).toBe(AgentProposalState.APPROVED);
  });

  it("refuses a caller who does not own the session, without writing", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();

    const result = await materialize(sessionId, executionId, userB.id);

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 404,
      code: "INTERACTION_NOT_FOUND",
    });
    expect(await workflowFor(executionId)).toBeNull();
  });

  it("never resolves a workflow sourced from the same proposal in another org", async () => {
    const { sessionId, executionId } = await createSessionAndProposal({
      proposalState: AgentProposalState.MATERIALIZED,
    });

    const foreign = await db.workflow.create({
      data: {
        name: `${TAG} foreign workflow`,
        orgId: orgB.id,
        sourceProposalId: executionId,
      },
      select: { id: true },
    });

    const result = await materialize(sessionId, executionId);

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "MATERIALIZED_WITHOUT_WORKFLOW",
    });

    // The foreign row still exists and was not handed back as if it were ours.
    expect(
      await db.workflow.count({ where: { id: foreign.id } }),
    ).toBe(1);
    expect(
      await db.workflow.count({
        where: { sourceProposalId: executionId, orgId: orgA.id },
      }),
    ).toBe(0);
  });

  it("serialises a concurrent double-start into one workflow", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();

    const [first, second] = await Promise.all([
      materialize(sessionId, executionId),
      materialize(sessionId, executionId),
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (first.ok && second.ok) {
      expect(first.workflowId).toBe(second.workflowId);
    }

    expect(
      await db.workflow.count({ where: { sourceProposalId: executionId } }),
    ).toBe(1);

    const execution = await db.agentToolExecution.findUnique({
      where: { id: executionId },
      select: { proposalState: true },
    });
    expect(execution?.proposalState).toBe(AgentProposalState.MATERIALIZED);
  });

  it("rolls the compare-and-set back when the insert fails on the unique index", async () => {
    const { sessionId, executionId } = await createSessionAndProposal();

    // A committed row already holds this source-proposal key in another org, so
    // the org-scoped lookup cannot see it and the create must hit P2002. That is
    // the one point where the CAS and the insert are proven to be one atomic
    // unit: after the failure, the proposal must NOT be MATERIALIZED.
    await db.workflow.create({
      data: {
        name: `${TAG} blocking workflow`,
        orgId: orgB.id,
        sourceProposalId: executionId,
      },
    });

    await expect(materialize(sessionId, executionId)).rejects.toMatchObject({
      code: "P2002",
    });

    const execution = await db.agentToolExecution.findUnique({
      where: { id: executionId },
      select: { proposalState: true },
    });
    expect(execution?.proposalState).toBe(AgentProposalState.APPROVED);

    // No org-A workflow was left behind by the rolled-back transaction.
    expect(
      await db.workflow.count({
        where: { sourceProposalId: executionId, orgId: orgA.id },
      }),
    ).toBe(0);
  });
});
