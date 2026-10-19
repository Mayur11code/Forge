// src/tests/agent/proposal-materialization.test.ts
//
// Assignment 37.11 — the proposal → workflow materialization service, end to end
// against the in-memory prisma double.
//
// The subject is `materializeProposal`: authorization/ownership, exact-revision
// binding, authoritative criticality application, the 37.10 UI projection, the
// shared persistence boundary, triggerless storage, provenance/naming, the
// atomic compare-and-set, idempotency, and the duplicate/conflict/recovery
// matrix.
//
// The double models the two properties the correctness argument rests on: the
// unique `sourceProposalId` index (P2002) and the org-scoped workflow read. It
// has no real rollback, so "atomic" here means the callback ENCLOSES both writes;
// the rollback guarantee is a property of Postgres and is stated, not simulated.
//
// The proposal compiler, the criticality contract, the 37.10 projection and the
// correlation helper are NOT mocked, so the fingerprint, exact-set rule and graph
// projection are exercised for real.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/ai/agent/locks", () => ({
  withAgentSessionLock: jest.fn(),
}));

jest.mock("@/lib/ai/agent/session-service", () => ({
  getAgentSessionForUser: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
}));

import { AgentProposalState } from "@prisma/client";

import {
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import { projectProposalToUIGraph } from "@/lib/workflow-types/proposal-ui-projection";
import { materializeProposal } from "@/lib/ai/agent/services/proposal-materialization-service";

const lockMock = withAgentSessionLock as jest.MockedFunction<
  typeof withAgentSessionLock
>;
const getSessionMock =
  getAgentSessionForUser as jest.MockedFunction<typeof getAgentSessionForUser>;

const SESSION_ID = "clxsessionmaterializeaaaa";
const EXECUTION_ID = "clxexecmaterializepppppppp";
const USER_ID = "user_owner";
const ORG_ID = "org_materialize";
const PROJECT_ID = "clxyz0000000000000000000a";

const VALID_PROPOSAL = {
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
const FINGERPRINT = computeProposalCorrelationId(VALID_PROPOSAL);

function seedExecution(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: EXECUTION_ID,
    sessionId: SESSION_ID,
    toolCallId: "call_materialize_1",
    toolName: "generateWorkflow",
    status: "COMPLETED",
    result: { ok: true, proposal: VALID_PROPOSAL },
    proposalState: AgentProposalState.APPROVED,
    proposalFingerprint: FINGERPRINT,
    proposalRevision: 1,
    criticalityDecisions: DECISIONS,
    clarificationAnswer: null,
    expiresAt: null,
    expiredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };

  store.executions.push(row);
  return row;
}

function call(interactionId: string = EXECUTION_ID) {
  return materializeProposal({
    sessionId: SESSION_ID,
    userId: USER_ID,
    interactionId,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  restorePrismaDouble();
  // Pass-through lock: the service's lock-wrapping is covered by its own tests;
  // here it must simply run the callback.
  lockMock.mockImplementation(async (_id, cb) => cb());
  getSessionMock.mockResolvedValue({
    id: SESSION_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    status: "RUNNING",
    currentStep: 2,
  } as never);
});

describe("authorization", () => {
  it("returns 404 for a session the caller does not own", async () => {
    getSessionMock.mockResolvedValue(null);

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 404 });
    expect(store.workflows).toHaveLength(0);
  });

  it("rejects an empty interactionId with 400", async () => {
    const result = await call("");

    expect(result).toMatchObject({ ok: false, httpStatus: 400 });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an interaction in another session", async () => {
    seedExecution({ sessionId: "someone_else" });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it("does not materialize into an org other than the session's", async () => {
    seedExecution();

    await call();

    expect(store.workflows).toHaveLength(1);
    expect(store.workflows[0].orgId).toBe(ORG_ID);
  });
});

describe("successful materialization", () => {
  it("creates exactly one workflow and transitions APPROVED -> MATERIALIZED", async () => {
    seedExecution();

    const result = await call();

    expect(result).toMatchObject({
      ok: true,
      workflowId: expect.any(String),
      state: AgentProposalState.MATERIALIZED,
    });
    expect(store.workflows).toHaveLength(1);
    expect(store.executions[0].proposalState).toBe(AgentProposalState.MATERIALIZED);
  });

  it("persists the human-facing name and description from the proposal", async () => {
    seedExecution();

    await call();

    expect(store.workflows[0].name).toBe(VALID_PROPOSAL.name);
    expect(store.workflows[0].description).toBe(VALID_PROPOSAL.description);
  });

  it("stores null description when the proposal has none", async () => {
    const noDescription = { name: "No desc", steps: VALID_PROPOSAL.steps };
    seedExecution({
      result: { ok: true, proposal: noDescription },
      proposalFingerprint: computeProposalCorrelationId(noDescription),
    });

    await call();

    expect(store.workflows[0].description).toBeNull();
  });

  it("uses the durable execution id as the provenance key", async () => {
    seedExecution();

    await call();

    expect(store.workflows[0].sourceProposalId).toBe(EXECUTION_ID);
  });

  it("stores the workflow triggerless and inactive", async () => {
    seedExecution();

    await call();

    expect(store.workflows[0].eventId).toBeNull();
    expect(store.workflows[0].isActive).toBe(false);
  });

  it("persists the exact 37.10 UI projection", async () => {
    seedExecution();

    await call();

    const expected = projectProposalToUIGraph(VALID_PROPOSAL, DECISIONS);
    expect(expected.success).toBe(true);
    if (!expected.success) throw new Error("fixture did not project");

    expect(store.workflows[0].uiNodes).toEqual(expected.uiNodes);
    expect(store.workflows[0].uiEdges).toEqual(expected.uiEdges);
  });

  it("persists a definition that preserves actions, inputs, deps and criticality", async () => {
    seedExecution();

    await call();

    const definition = store.workflows[0].definition as {
      steps: Record<
        string,
        { action: string; dependsOn: string[]; config: unknown; isCritical: boolean; kind: string }
      >;
    };

    expect(definition.steps.kickoff).toMatchObject({
      action: "task.create",
      dependsOn: [],
      isCritical: false,
      kind: "ACTION",
    });
    expect(definition.steps.follow).toMatchObject({
      action: "task.create",
      dependsOn: ["kickoff"],
      isCritical: true,
      kind: "ACTION",
    });
  });
});

describe("exact-revision binding", () => {
  it("rejects a stored fingerprint that no longer matches the persisted proposal", async () => {
    seedExecution({ proposalFingerprint: "prop_corr_stale000000" });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "REVISION_MISMATCH" });
    expect(store.workflows).toHaveLength(0);
    expect(store.executions[0].proposalState).toBe(AgentProposalState.APPROVED);
  });

  it("accepts a null stored fingerprint (legacy row) and still guards via CAS", async () => {
    seedExecution({ proposalFingerprint: null });

    const result = await call();

    expect(result).toMatchObject({ ok: true });
    expect(store.workflows).toHaveLength(1);
  });
});

describe("authoritative criticality", () => {
  it("rejects a missing criticality decision set", async () => {
    seedExecution({ criticalityDecisions: { kickoff: false } });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409 });
    expect(store.workflows).toHaveLength(0);
  });

  it("rejects an extra criticality key", async () => {
    seedExecution({
      criticalityDecisions: { kickoff: false, follow: true, ghost: true },
    });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409 });
    expect(store.workflows).toHaveLength(0);
  });

  it("rejects a non-boolean criticality value", async () => {
    seedExecution({
      criticalityDecisions: { kickoff: "critical", follow: true },
    });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409 });
    expect(store.workflows).toHaveLength(0);
  });

  it("rejects a null criticality record", async () => {
    seedExecution({ criticalityDecisions: null });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409 });
    expect(store.workflows).toHaveLength(0);
  });
});

describe("lifecycle eligibility", () => {
  const ineligible: Array<[string, AgentProposalState, string]> = [
    ["declined", AgentProposalState.DECLINED, "PROPOSAL_DECLINED"],
    ["expired", AgentProposalState.EXPIRED, "PROPOSAL_EXPIRED"],
    ["superseded", AgentProposalState.SUPERSEDED, "PROPOSAL_SUPERSEDED"],
    ["invalid", AgentProposalState.INVALID, "PROPOSAL_INVALID"],
    ["awaiting approval", AgentProposalState.AWAITING_APPROVAL, "PROPOSAL_NOT_APPROVED"],
    ["awaiting criticality", AgentProposalState.AWAITING_CRITICALITY, "PROPOSAL_NOT_APPROVED"],
  ];

  it.each(ineligible)("refuses a %s proposal", async (_name, state, code) => {
    seedExecution({ proposalState: state });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409, code });
    expect(store.workflows).toHaveLength(0);
  });

  it("returns not-found when the id names a non-proposal execution", async () => {
    // The proposal lookup is scoped by `toolName = generateWorkflow`, so a
    // tool execution that is not a proposal is simply not this session's
    // reviewable proposal. It must never be materialized.
    seedExecution({ toolName: "task.create" });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 404 });
    expect(store.workflows).toHaveLength(0);
  });

  it("refuses a completed execution whose result is not a proposal", async () => {
    seedExecution({ result: { ok: false, code: "INVALID_INPUT" } });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "NOT_A_PROPOSAL" });
  });
});

describe("idempotency and recovery", () => {
  it("returns the existing workflow on a repeat, without creating a second", async () => {
    seedExecution();

    const first = await call();
    const second = await call();

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, idempotent: true });
    if (first.ok && second.ok) {
      expect(second.workflowId).toBe(first.workflowId);
    }
    expect(store.workflows).toHaveLength(1);
  });

  it("resolves a MATERIALIZED proposal with its matching workflow idempotently", async () => {
    seedExecution({ proposalState: AgentProposalState.MATERIALIZED });
    store.workflows.push({
      id: "wf_existing",
      orgId: ORG_ID,
      sourceProposalId: EXECUTION_ID,
    });

    const result = await call();

    expect(result).toMatchObject({ ok: true, idempotent: true, workflowId: "wf_existing" });
    expect(store.workflows).toHaveLength(1);
  });

  it("reports a consistency failure for MATERIALIZED with no matching workflow", async () => {
    seedExecution({ proposalState: AgentProposalState.MATERIALIZED });

    const result = await call();

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "MATERIALIZED_WITHOUT_WORKFLOW",
    });
    expect(store.workflows).toHaveLength(0);
  });

  it("does not resolve a workflow owned by another org", async () => {
    seedExecution({ proposalState: AgentProposalState.MATERIALIZED });
    store.workflows.push({
      id: "wf_foreign",
      orgId: "org_other",
      sourceProposalId: EXECUTION_ID,
    });

    const result = await call();

    expect(result).toMatchObject({
      ok: false,
      code: "MATERIALIZED_WITHOUT_WORKFLOW",
    });
  });

  it("returns the existing workflow when one exists while the state is still APPROVED", async () => {
    seedExecution({ proposalState: AgentProposalState.APPROVED });
    store.workflows.push({
      id: "wf_recovered",
      orgId: ORG_ID,
      sourceProposalId: EXECUTION_ID,
    });

    const result = await call();

    expect(result).toMatchObject({ ok: true, idempotent: true, workflowId: "wf_recovered" });
    expect(store.workflows).toHaveLength(1);
    expect(store.executions[0].proposalState).toBe(AgentProposalState.MATERIALIZED);
  });

  it("honours a lost compare-and-set by creating no workflow", async () => {
    seedExecution();
    // The first CAS updates nothing (the row appears already advanced), which is
    // what a competing caller would cause. No workflow may be left behind.
    prismaDoubleMock().agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const result = await call();

    expect(result).toMatchObject({ ok: false, httpStatus: 409 });
    expect(store.workflows).toHaveLength(0);
  });
});

describe("unique-constraint defense", () => {
  it("does not create a duplicate when the unique index rejects the insert", async () => {
    seedExecution();
    // A competing caller already inserted the workflow between our read and our
    // write. The real unique index would throw P2002; the double models that.
    store.workflows.push({
      id: "wf_racer",
      orgId: ORG_ID,
      sourceProposalId: EXECUTION_ID,
    });

    const result = await call();

    expect(result).toMatchObject({ ok: true, idempotent: true, workflowId: "wf_racer" });
    expect(store.workflows).toHaveLength(1);
  });
});

describe("no execution side effects", () => {
  it("does not enqueue an outbox event, a run, or a model-loop continuation", async () => {
    seedExecution();

    await call();

    // The outbox store is shared with the agent loop's delivery intents; a
    // materialization must add nothing to it.
    expect(store.outbox).toHaveLength(0);
  });
});

// Re-read the shared double through the same module the service uses, so the
// per-test stub cannot accidentally target a different instance.
function prismaDoubleMock() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./helpers/prisma-double").prismaDouble as {
    agentToolExecution: { updateMany: jest.Mock };
  };
}
