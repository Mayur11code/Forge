// src/tests/agent/proposal-decision.test.ts
//
// Assignment 37.9 — the human proposal-review decision service, end to end
// against the in-memory prisma double.
//
// The subject is `submitProposalDecision`: authorization/ownership, the
// persisted-proposal re-derivation, the backend-recomputed revision fingerprint,
// idempotency and conflict classification from durable state, the compare-and-set
// transition, and the audit line that commits with it.
//
// The double has no real rollback, so "atomic" here means the callback ENCLOSES
// both writes. The fingerprint and CAS behaviour are exercised for real, because
// the proposal service and the correlation helper are NOT mocked.

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
  prismaDouble,
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { createMessage } from "@/lib/ai/agent/services/message-service";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import {
  PROPOSAL_DECISION_MARKER,
  submitProposalDecision,
} from "@/lib/ai/agent/services/proposal-decision-service";

const lockMock = withAgentSessionLock as jest.MockedFunction<
  typeof withAgentSessionLock
>;
const getSessionMock =
  getAgentSessionForUser as jest.MockedFunction<typeof getAgentSessionForUser>;
const createMessageMock = createMessage as jest.MockedFunction<
  typeof createMessage
>;

const SESSION_ID = "clxsessiondecisionaaaaaa";
const EXECUTION_ID = "clxexecdecisionppppppppp";
const USER_ID = "user_owner";
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

const FINGERPRINT = computeProposalCorrelationId(VALID_PROPOSAL);

function seedExecution(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: EXECUTION_ID,
    sessionId: SESSION_ID,
    toolCallId: "call_prop_decision_1",
    toolName: "generateWorkflow",
    status: "COMPLETED",
    result: { ok: true, proposal: VALID_PROPOSAL },
    proposalState: AgentProposalState.AWAITING_APPROVAL,
    proposalFingerprint: FINGERPRINT,
    proposalRevision: 1,
    criticalityDecisions: { kickoff: false, follow: false },
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

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  restorePrismaDouble();

  lockMock.mockImplementation(async (_id, cb) => cb());
  getSessionMock.mockResolvedValue({
    status: "RUNNING",
    currentStep: 3,
  } as never);
  createMessageMock.mockResolvedValue({} as never);
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("request shape", () => {
  it("rejects a decision that is not APPROVED or DECLINED without locking", async () => {
    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.AWAITING_APPROVAL as never,
    });

    expect(result).toMatchObject({ ok: false, httpStatus: 400, code: "INVALID_REQUEST" });
    expect(lockMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("rejects an empty interactionId without locking", async () => {
    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: "   ",
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({ ok: false, httpStatus: 400, code: "INVALID_REQUEST" });
    expect(lockMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ownership and liveness
// ---------------------------------------------------------------------------

describe("ownership and liveness", () => {
  it("404s an unknown or foreign session before taking a lock", async () => {
    getSessionMock.mockResolvedValue(null);

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 404,
      code: "INTERACTION_NOT_FOUND",
    });
    expect(lockMock).not.toHaveBeenCalled();
  });

  it("409s a session that is no longer RUNNING before taking a lock", async () => {
    getSessionMock.mockResolvedValue({ status: "COMPLETED", currentStep: 3 } as never);

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "SESSION_NOT_RUNNING",
    });
    expect(lockMock).not.toHaveBeenCalled();
  });

  it("surfaces SESSION_BUSY when the lock is not acquired", async () => {
    lockMock.mockResolvedValueOnce(null);

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "SESSION_BUSY",
    });
  });
});

// ---------------------------------------------------------------------------
// Proposal resolution (under the lock)
// ---------------------------------------------------------------------------

describe("proposal resolution", () => {
  it("404s a proposal that is not in the caller's session", async () => {
    seedExecution({ sessionId: "someone_else_session" });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 404,
      code: "INTERACTION_NOT_FOUND",
    });
  });

  it("409s an execution that never completed", async () => {
    seedExecution({ status: "RUNNING" });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "NOT_A_PROPOSAL",
    });
  });

  it("409s a completed execution whose result is not a proposal", async () => {
    seedExecution({ result: { ok: false, code: "INVALID_INPUT" } });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "NOT_A_PROPOSAL",
    });
  });

  it("409s REVISION_MISMATCH when the stored fingerprint disagrees with the persisted proposal", async () => {
    // The row was parked on one revision but its result now hashes to another:
    // the reviewer would be approving something other than what was recorded.
    seedExecution({ proposalFingerprint: "prop_corr_deadbeefdeadbeef" });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "REVISION_MISMATCH",
    });
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.AWAITING_APPROVAL,
    );
  });

  it("still decides a legacy row whose stored fingerprint is null", async () => {
    // No fingerprint was ever written, so there is nothing to compare; the state
    // CAS is the guard that remains.
    seedExecution({ proposalFingerprint: null });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({ ok: true, state: AgentProposalState.APPROVED });
  });
});

// ---------------------------------------------------------------------------
// Idempotency and conflict classification
// ---------------------------------------------------------------------------

describe("idempotency and conflict classification", () => {
  it("treats a repeat of the same decision as an idempotent success with no writes", async () => {
    seedExecution({ proposalState: AgentProposalState.APPROVED });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      state: AgentProposalState.APPROVED,
    });
    expect(createMessageMock).not.toHaveBeenCalled();
    expect(prismaDouble.agentToolExecution.updateMany).not.toHaveBeenCalled();
  });

  it("409s NEEDS_CRITICALITY while criticality is still outstanding", async () => {
    seedExecution({ proposalState: AgentProposalState.AWAITING_CRITICALITY });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "NEEDS_CRITICALITY",
    });
  });

  it("409s PROPOSAL_EXPIRED once the review window has closed", async () => {
    seedExecution({ proposalState: AgentProposalState.EXPIRED });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "PROPOSAL_EXPIRED",
    });
  });

  it("409s PROPOSAL_ALREADY_DECIDED for the opposite terminal outcome", async () => {
    seedExecution({ proposalState: AgentProposalState.APPROVED });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.DECLINED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "PROPOSAL_ALREADY_DECIDED",
    });
  });

  it("409s PROPOSAL_NOT_AWAITING_APPROVAL for a superseded proposal", async () => {
    seedExecution({ proposalState: AgentProposalState.SUPERSEDED });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "PROPOSAL_NOT_AWAITING_APPROVAL",
    });
  });
});

// ---------------------------------------------------------------------------
// The decision (CAS + audit line)
// ---------------------------------------------------------------------------

describe("recording the decision", () => {
  it("approves a proposal and records a self-describing audit line", async () => {
    seedExecution();

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: true,
      sessionId: SESSION_ID,
      step: 3,
      state: AgentProposalState.APPROVED,
    });
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.APPROVED,
    );

    expect(createMessageMock).toHaveBeenCalledTimes(1);
    const call = createMessageMock.mock.calls[0]![0] as {
      sessionId: string;
      step: number;
      toolCallId: string;
      message: { role: string; content: string };
    };
    expect(call.sessionId).toBe(SESSION_ID);
    expect(call.step).toBe(3);
    expect(call.toolCallId).toBe(EXECUTION_ID);
    expect(call.message.role).toBe("user");
    expect(call.message.content).toContain(PROPOSAL_DECISION_MARKER);
    expect(call.message.content).toContain(`proposal: ${FINGERPRINT}`);
    expect(call.message.content).toContain("decision: approved");
  });

  it("declines a proposal and records the decline decision", async () => {
    seedExecution();

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.DECLINED,
    });

    expect(result).toMatchObject({ ok: true, state: AgentProposalState.DECLINED });
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.DECLINED,
    );

    const call = createMessageMock.mock.calls[0]![0] as {
      message: { content: string };
    };
    expect(call.message.content).toContain("decision: declined");
  });

  it("records no audit line when the compare-and-set is lost", async () => {
    // A lost CAS means another writer moved the row between the read and the
    // write. Answering conflict without a transcript line is the whole point:
    // the transcript must never claim a decision the durable row did not take.
    seedExecution();
    prismaDouble.agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const result = await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 409,
      code: "PROPOSAL_NOT_APPLIED",
    });
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it("records no outbox event: approval is not a loop trigger", async () => {
    seedExecution();

    await submitProposalDecision({
      sessionId: SESSION_ID,
      userId: USER_ID,
      interactionId: EXECUTION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(prismaDouble.agentOutboxEvent.upsert).not.toHaveBeenCalled();
  });
});
