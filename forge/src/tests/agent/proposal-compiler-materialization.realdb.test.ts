// src/tests/agent/proposal-compiler-materialization.realdb.test.ts
//
// Assignment 37.4 - the deferred half of the Verification Gate.
//
// 37.4's gate reads: "Unit tests green, plus a production-path check that the
// chosen gate runs on materialization, not only in tests." That half was
// explicitly deferred because neither a production caller (37.5) nor a
// materialization path (37.11) existed when the phase was implemented.
//
// Both exist now. The production chain is:
//
//   materializeProposal
//     -> projectProposalToUIGraph
//        -> compileWorkflowProposal
//           -> collectWorkflowDefinitionIssues      <-- AD-P4 canonical gate
//
// The unit suite (`workflow-proposal-compiler.test.ts`) proves the collector is
// the gate *inside the compiler*. This suite proves the same gate is
// load-bearing on the *materialization* path: a proposal the collector rejects
// must stop materialization before any Workflow row exists.
//
// Why a real database: `materializeProposal` performs its authorization read,
// revision check and the compare-and-set + create inside a real
// `$transaction`. A proposal that fails the gate must not leave a partially
// applied state (state advanced, no workflow) behind - that is a database
// property, not a double's. The lock is mocked pass-through for the same reason
// as the 37.11 acceptance suite: it is not the subject here and would require a
// live Redis.
//
// Run with the real-DB config:
//   npx jest --config jest.realdb.config.ts \
//     src/tests/agent/proposal-compiler-materialization.realdb.test.ts

jest.mock("server-only", () => ({}));

jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn(),
}));

import { AgentProposalState, AgentSessionStatus, type Prisma } from "@prisma/client";

import { db } from "@/lib/prisma/db";
import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import { compileWorkflowProposal } from "@/lib/workflow-types/workflow-proposal-compiler";
import { projectProposalToUIGraph } from "@/lib/workflow-types/proposal-ui-projection";
import { materializeProposal } from "@/lib/ai/agent/services/proposal-materialization-service";

jest.setTimeout(120_000);

const lockMock = withAgentSessionLock as jest.Mock;

const TAG = `c4mat_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SLUG = `${TAG}_org`;
const EMAIL = `${TAG}@example.invalid`;
const PROJECT_ID = "clxyz0000000000000000000b";

// A cycle. The proposal SCHEMA accepts it (dependsOn is just an array of refs)
// and the reference validator does not consider dependsOn, so the only layer
// that can reject it is `collectWorkflowDefinitionIssues` - which is what makes
// it a faithful probe for "does the collector run on materialization".
const CYCLIC_PROPOSAL = {
  name: "Cyclic onboarding",
  description: "Must never materialize.",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kick off", projectId: PROJECT_ID },
      dependsOn: ["follow"],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

const CYCLIC_DECISIONS = { kickoff: false, follow: false };

// The positive control. Same fixture, same call, only the graph differs, so a
// refusal above cannot be blamed on the fixture being malformed.
const ACYCLIC_PROPOSAL = {
  ...CYCLIC_PROPOSAL,
  name: "Acyclic onboarding",
  steps: {
    kickoff: {
      action: "task.create",
      inputs: { title: "Kick off", projectId: PROJECT_ID },
      dependsOn: [],
    },
    follow: {
      action: "task.create",
      inputs: { title: "Follow up", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    },
  },
};

let orgId: string;
let userId: string;
const createdSessionIds: string[] = [];

async function createApprovedProposal(proposal: unknown): Promise<{
  sessionId: string;
  executionId: string;
}> {
  const session = await db.agentSession.create({
    data: {
      orgId,
      userId,
      status: AgentSessionStatus.RUNNING,
      promptVersion: "v6",
    },
    select: { id: true },
  });
  createdSessionIds.push(session.id);

  const execution = await db.agentToolExecution.create({
    data: {
      sessionId: session.id,
      toolCallId: `${TAG}_call_${createdSessionIds.length}`,
      toolName: "generateWorkflow",
      input: {},
      status: "COMPLETED",
      result: { ok: true, proposal } as Prisma.InputJsonValue,
      proposalState: AgentProposalState.APPROVED,
      proposalFingerprint: computeProposalCorrelationId(
        proposal as Parameters<typeof computeProposalCorrelationId>[0],
      ),
      proposalRevision: 1,
      criticalityDecisions: CYCLIC_DECISIONS as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return { sessionId: session.id, executionId: execution.id };
}

beforeAll(async () => {
  const org = await db.organization.create({
    data: { slug: SLUG, name: `${TAG} org` },
    select: { id: true },
  });
  orgId = org.id;

  const user = await db.user.create({
    data: { email: EMAIL, name: `${TAG} user` },
    select: { id: true },
  });
  userId = user.id;

  await db.membership.create({
    data: { userId, orgId, role: "ADMIN" },
  });
});

afterAll(async () => {
  try {
    const workflows = await db.workflow.findMany({
      where: { orgId },
      select: { id: true },
    });

    await db.workflowRun.deleteMany({
      where: { workflowId: { in: workflows.map((w) => w.id) } },
    });
    await db.workflow.deleteMany({ where: { orgId } });
    await db.agentOutboxEvent.deleteMany({
      where: { sessionId: { in: createdSessionIds } },
    });
    await db.agentSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    await db.membership.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.organization.deleteMany({ where: { id: orgId } });

    expect({
      workflows: await db.workflow.count({ where: { orgId } }),
      sessions: await db.agentSession.count({ where: { orgId } }),
      users: await db.user.count({ where: { email: EMAIL } }),
      orgs: await db.organization.count({ where: { slug: SLUG } }),
    }).toEqual({ workflows: 0, sessions: 0, users: 0, orgs: 0 });
  } finally {
    await db.$disconnect();
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  lockMock.mockImplementation(
    async (_id: string, cb: () => Promise<unknown>) => cb(),
  );
});

describe("37.4 - collector gate on the materialization path (real Postgres)", () => {
  it("refuses a proposal the collector rejects, and writes no Workflow", async () => {
    const { sessionId, executionId } = await createApprovedProposal(CYCLIC_PROPOSAL);

    const result = await materializeProposal({ sessionId, userId, interactionId: executionId });

    // The service reports the projection stage (the compiler lives inside it).
    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "PROJECTION_FAILED",
    });

    // The gate is load-bearing: no row, and the lifecycle did not advance.
    expect(await db.workflow.count({ where: { sourceProposalId: executionId } })).toBe(0);

    const execution = await db.agentToolExecution.findUnique({
      where: { id: executionId },
      select: { proposalState: true },
    });
    expect(execution?.proposalState).toBe(AgentProposalState.APPROVED);
  });

  it("surfaces the collector's structured CYCLE issue at the gate itself", async () => {
    // Isolates WHY the materialization above failed: the production projection
    // runs the compiler, and the compiler's issue keeps the collector's code,
    // dotted input path and readable sequence. The service then maps the failed
    // projection to its own 409 code (asserted above); that mapping is 37.11's,
    // not a loss of structure inside 37.4.
    const compiled = compileWorkflowProposal(CYCLIC_PROPOSAL);
    expect(compiled.success).toBe(false);
    if (compiled.success) throw new Error("expected the compiler to reject a cycle");

    const cycle = compiled.issues.find((issue) => issue.code === "CYCLE");
    expect(cycle).toBeDefined();
    expect(cycle?.path).toBe("steps");
    expect(cycle?.message).toMatch(/kickoff -> follow -> kickoff/);

    const projected = projectProposalToUIGraph(
      CYCLIC_PROPOSAL as unknown as Parameters<typeof projectProposalToUIGraph>[0],
      CYCLIC_DECISIONS,
    );
    expect(projected.success).toBe(false);
    if (projected.success) throw new Error("expected the projection to reject a cycle");
    expect(projected.issues.map((issue) => issue.code)).toContain("CYCLE");
  });

  it("materializes the same fixture once the cycle is removed (control)", async () => {
    const { sessionId, executionId } = await createApprovedProposal(ACYCLIC_PROPOSAL);

    const result = await materializeProposal({ sessionId, userId, interactionId: executionId });

    expect(result).toMatchObject({ ok: true, state: AgentProposalState.MATERIALIZED });
    expect(await db.workflow.count({ where: { sourceProposalId: executionId } })).toBe(1);
  });
});
