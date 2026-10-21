// src/tests/agent/proposal-review-expiry.test.ts
//
// Assignment 37.9 — the proposal review lifecycle: the deadline stamped at
// criticality, the approve/decline compare-and-set, the review-expiry sweep, the
// durable settled-state probe, and the stalled-session exemption.
//
// Everything runs against the in-memory prisma double, so the CAS predicates are
// exercised for real: a double that ignored `proposalState` or `expiresAt` would
// make the lost-CAS and not-yet-due tests pass vacuously. The transactions are
// enclosure-only (no rollback simulation); that gap is called out in the report.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/ai/agent/status", () => ({ publishAgentStatus: jest.fn() }));

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

jest.mock("@/lib/ai/agent/outbox", () => ({
  recordAgentEvent: jest.fn(),
  rearmOutboxEvent: jest.fn(),
  buildOutboxIdempotencyKey: jest.fn(
    (eventType: string, aggregateId: string) => `${eventType}:${aggregateId}`,
  ),
}));

import {
  AgentProposalState,
  AgentSessionStatus,
  AgentToolExecutionStatus,
} from "@prisma/client";

import {
  prismaDouble,
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import {
  recordAgentEvent,
  rearmOutboxEvent,
} from "@/lib/ai/agent/outbox";
import {
  expireStaleProposalReviews,
  redriveStalledSessions,
} from "@/lib/ai/agent/reaper";
import { getAgentApprovalTimeoutMs } from "@/lib/ai/agent/constants";
import {
  expireProposalReview,
  findDueProposalReviewCandidates,
  hasSettledProposal,
  recordCriticalityDecision,
  recordProposalDecision,
} from "@/lib/ai/agent/services/proposal-service";

const lockMock = withAgentSessionLock as jest.MockedFunction<
  typeof withAgentSessionLock
>;
const recordEventMock = recordAgentEvent as jest.MockedFunction<
  typeof recordAgentEvent
>;
const rearmMock = rearmOutboxEvent as jest.MockedFunction<
  typeof rearmOutboxEvent
>;

const SESSION_ID = "clxsessionexpiryccccccc";
const EXECUTION_ID = "clxexecexpiryddddddddd";

const tx = prismaDouble as unknown as Parameters<
  typeof recordProposalDecision
>[0];

function seedExecution(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: EXECUTION_ID,
    sessionId: SESSION_ID,
    toolCallId: "call_expiry_1",
    toolName: "generateWorkflow",
    status: "COMPLETED",
    result: { ok: true },
    proposalState: AgentProposalState.AWAITING_APPROVAL,
    proposalFingerprint: "fp_1",
    proposalRevision: 1,
    criticalityDecisions: null,
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
  recordEventMock.mockResolvedValue(undefined as never);
  rearmMock.mockResolvedValue({ state: "queued", attempts: 1 } as never);
});

// ---------------------------------------------------------------------------
// The deadline is stamped when the proposal crosses into AWAITING_APPROVAL
// ---------------------------------------------------------------------------

describe("recordCriticalityDecision — review deadline", () => {
  it("stamps expiresAt in the same CAS that enters AWAITING_APPROVAL", async () => {
    seedExecution({ proposalState: AgentProposalState.AWAITING_CRITICALITY });
    const now = new Date(1_000_000);

    const ok = await recordCriticalityDecision(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      decisions: { kickoff: true },
      now,
    });

    expect(ok).toBe(true);
    const row = store.executions[0]!;
    expect(row.proposalState).toBe(AgentProposalState.AWAITING_APPROVAL);
    expect((row.expiresAt as Date).getTime()).toBe(
      now.getTime() + getAgentApprovalTimeoutMs(),
    );
  });

  it("keeps a proposal's deadline pinned even if it later loses the CAS", async () => {
    seedExecution({ proposalState: AgentProposalState.AWAITING_APPROVAL });

    const ok = await recordCriticalityDecision(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      decisions: { kickoff: true },
      now: new Date(1_000_000),
    });

    expect(ok).toBe(false);
    expect(store.executions[0]!.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Approve / decline compare-and-set
// ---------------------------------------------------------------------------

describe("recordProposalDecision", () => {
  it("approves a proposal awaiting approval", async () => {
    seedExecution();

    const ok = await recordProposalDecision(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(ok).toBe(true);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.APPROVED,
    );
  });

  it("declines a proposal awaiting approval", async () => {
    seedExecution();

    const ok = await recordProposalDecision(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      decision: AgentProposalState.DECLINED,
    });

    expect(ok).toBe(true);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.DECLINED,
    );
  });

  it("loses the CAS for a proposal that is no longer awaiting approval", async () => {
    seedExecution({ proposalState: AgentProposalState.EXPIRED });

    const ok = await recordProposalDecision(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      decision: AgentProposalState.APPROVED,
    });

    expect(ok).toBe(false);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.EXPIRED,
    );
  });
});

// ---------------------------------------------------------------------------
// Review expiry compare-and-set
// ---------------------------------------------------------------------------

describe("expireProposalReview", () => {
  const now = new Date(2_000_000);

  it("closes a proposal whose deadline has passed", async () => {
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });

    const ok = await expireProposalReview(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      now,
    });

    expect(ok).toBe(true);
    const row = store.executions[0]!;
    expect(row.proposalState).toBe(AgentProposalState.EXPIRED);
    expect((row.expiredAt as Date).getTime()).toBe(now.getTime());
  });

  it("never expires a proposal before its deadline", async () => {
    seedExecution({ expiresAt: new Date(now.getTime() + 1) });

    const ok = await expireProposalReview(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      now,
    });

    expect(ok).toBe(false);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.AWAITING_APPROVAL,
    );
  });

  it("never expires a proposal that has no deadline", async () => {
    seedExecution({ expiresAt: null });

    const ok = await expireProposalReview(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      now,
    });

    expect(ok).toBe(false);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.AWAITING_APPROVAL,
    );
  });

  it("loses to a human who decided just before the sweep", async () => {
    seedExecution({
      proposalState: AgentProposalState.DECLINED,
      expiresAt: new Date(now.getTime() - 1),
    });

    const ok = await expireProposalReview(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      now,
    });

    expect(ok).toBe(false);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.DECLINED,
    );
    expect(store.executions[0]!.expiredAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Candidate selection and the settled probe
// ---------------------------------------------------------------------------

describe("findDueProposalReviewCandidates", () => {
  const now = new Date(3_000_000);

  it("returns only awaiting-approval proposals that are genuinely due", async () => {
    seedExecution({
      id: "due",
      expiresAt: new Date(now.getTime() - 5),
    });
    seedExecution({
      id: "future",
      proposalRevision: 2,
      expiresAt: new Date(now.getTime() + 5),
    });
    seedExecution({
      id: "no_deadline",
      proposalRevision: 3,
      expiresAt: null,
    });
    seedExecution({
      id: "already_decided",
      proposalRevision: 4,
      proposalState: AgentProposalState.APPROVED,
      expiresAt: new Date(now.getTime() - 5),
    });

    const candidates = await findDueProposalReviewCandidates(10, now);

    expect(candidates.map((c) => c.id)).toEqual(["due"]);
    expect(candidates[0]!.sessionId).toBe(SESSION_ID);
  });

  it("passes the limit and the deadline ordering through to the query", async () => {
    await findDueProposalReviewCandidates(7, now);

    const arg = prismaDouble.agentToolExecution.findMany.mock.calls[0]![0] as {
      take: number;
      orderBy: Record<string, string>;
    };
    expect(arg.take).toBe(7);
    expect(arg.orderBy).toEqual({ expiresAt: "asc" });
  });
});

describe("hasSettledProposal", () => {
  it.each([
    [AgentProposalState.APPROVED, true],
    [AgentProposalState.DECLINED, true],
    [AgentProposalState.EXPIRED, true],
    [AgentProposalState.AWAITING_APPROVAL, false],
    [AgentProposalState.AWAITING_CRITICALITY, false],
    [AgentProposalState.INVALID, false],
    [null, false],
  ])("reports %s as settled=%s", async (state, expected) => {
    seedExecution({ proposalState: state });

    expect(await hasSettledProposal(SESSION_ID)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// The maintenance sweep
// ---------------------------------------------------------------------------

describe("expireStaleProposalReviews", () => {
  const now = new Date(4_000_000);

  it("expires every due proposal", async () => {
    seedExecution({ id: "a", expiresAt: new Date(now.getTime() - 10) });
    seedExecution({
      id: "b",
      proposalRevision: 2,
      expiresAt: new Date(now.getTime() - 5),
    });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(2);
    expect(summary.scanned).toBe(2);
    expect(summary.errors).toEqual([]);
    expect(store.executions.map((row) => row.proposalState)).toEqual([
      AgentProposalState.EXPIRED,
      AgentProposalState.EXPIRED,
    ]);
  });

  it("counts a candidate whose CAS lost as skipped, not expired", async () => {
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });
    // The candidate scan saw a due row, but by the time the CAS runs the human
    // has decided. The transition matches nothing.
    prismaDouble.agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("keeps going when one candidate throws and records the failure", async () => {
    seedExecution({ id: "ok", expiresAt: new Date(now.getTime() - 1) });
    seedExecution({
      id: "boom",
      proposalRevision: 2,
      expiresAt: new Date(now.getTime() - 2),
    });

    let calls = 0;
    prismaDouble.$transaction.mockImplementation(
      (async (fn: (tx: unknown) => Promise<unknown>) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("db hiccup");
        }
        return fn(prismaDouble);
      }) as never,
    );

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("db hiccup");
    expect(summary.expired).toBe(1);
  });

  it("bounds the pass with the limit", async () => {
    await expireStaleProposalReviews({ limit: 3, now });

    const arg = prismaDouble.agentToolExecution.findMany.mock.calls[0]![0] as {
      take: number;
    };
    expect(arg.take).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Stalled-session exemption: a settled proposal is not a stall
// ---------------------------------------------------------------------------

describe("redriveStalledSessions — settled proposal exemption", () => {
  const now = new Date(5_000_000);

  function seedSession(overrides: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      id: SESSION_ID,
      orgId: "org_1",
      userId: "user_a",
      status: "RUNNING",
      currentStep: 4,
      updatedAt: new Date(0),
      ...overrides,
    };
    store.sessions.push(row);
    return row;
  }

  it("does not re-drive a session whose proposal was already decided", async () => {
    seedSession();
    seedExecution({ proposalState: AgentProposalState.APPROVED });

    const summary = await redriveStalledSessions({ limit: 10, now });

    expect(summary.skippedWaiting).toBe(1);
    expect(summary.redriven).toBe(0);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("does not re-drive a session whose proposal review expired", async () => {
    seedSession();
    seedExecution({ proposalState: AgentProposalState.EXPIRED });

    const summary = await redriveStalledSessions({ limit: 10, now });

    expect(summary.skippedWaiting).toBe(1);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("still re-drives a stale session with nothing in flight (control)", async () => {
    // Non-vacuity: the exemption must be doing the work. Remove the settled
    // proposal and the same session IS re-driven.
    seedSession();

    const summary = await redriveStalledSessions({ limit: 10, now });

    expect(summary.skippedWaiting).toBe(0);
    expect(summary.redriven).toBe(1);
    expect(recordEventMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Assignment 37.14 — proposal expiry while the session waits on a human
// ---------------------------------------------------------------------------
//
// Candidate selection is deliberately unfiltered by session status: an expired
// AWAITING_APPROVAL proposal must be found whether its session is parked
// (WAITING_CONFIRMATION) or still RUNNING (legacy). What the sweep must NOT do is
// blindly release a wait that belongs to a different human act.

describe("expireStaleProposalReviews — WAITING_CONFIRMATION sessions", () => {
  const now = new Date(6_000_000);

  function seedSession(overrides: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      id: SESSION_ID,
      orgId: "org_1",
      userId: "user_a",
      status: AgentSessionStatus.WAITING_CONFIRMATION,
      currentStep: 4,
      updatedAt: new Date(0),
      ...overrides,
    };
    store.sessions.push(row);
    return row;
  }

  it("expires a due proposal and releases the waiting session", async () => {
    seedSession();
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.EXPIRED,
    );
    expect(store.sessions[0]!.status).toBe(AgentSessionStatus.RUNNING);

    // Expiry is a silent terminal transition: no loop continuation, no
    // materialization, no new execution.
    expect(recordEventMock).not.toHaveBeenCalled();
    expect(store.outbox).toHaveLength(0);
    expect(store.workflows).toHaveLength(0);
  });

  it("leaves a future-dated proposal and the waiting session untouched", async () => {
    seedSession();
    seedExecution({ expiresAt: new Date(now.getTime() + 1) });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.scanned).toBe(0);
    expect(summary.expired).toBe(0);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.AWAITING_APPROVAL,
    );
    expect(store.sessions[0]!.status).toBe(
      AgentSessionStatus.WAITING_CONFIRMATION,
    );
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("does not clear a clarification wait when no proposal is expirable", async () => {
    seedSession();
    seedExecution({
      id: "clarification",
      proposalState: AgentProposalState.NEEDS_CLARIFICATION,
      expiresAt: null,
    });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.scanned).toBe(0);
    expect(store.sessions[0]!.status).toBe(
      AgentSessionStatus.WAITING_CONFIRMATION,
    );
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("does not clear a clarification wait when an unrelated proposal expires", async () => {
    // The stronger isolation case: the sweep DOES expire a proposal in the same
    // session, but the session is still waiting on a clarification. The coarse
    // wait marker cannot distinguish the two, so the guard must not clear it.
    seedSession();
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });
    seedExecution({
      id: "clarification",
      proposalRevision: 2,
      proposalState: AgentProposalState.NEEDS_CLARIFICATION,
      expiresAt: null,
    });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(1);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.EXPIRED,
    );
    expect(store.sessions[0]!.status).toBe(
      AgentSessionStatus.WAITING_CONFIRMATION,
    );
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("does not clear a wait held by a tool awaiting confirmation", async () => {
    seedSession();
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });
    seedExecution({
      id: "tool-confirmation",
      proposalRevision: 2,
      status: AgentToolExecutionStatus.PENDING_CONFIRMATION,
      proposalState: null,
      expiresAt: new Date(now.getTime() - 1),
    });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(1);
    expect(store.sessions[0]!.status).toBe(
      AgentSessionStatus.WAITING_CONFIRMATION,
    );
  });

  it("does not resurrect a terminal session", async () => {
    seedSession({ status: AgentSessionStatus.FAILED });
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(1);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.EXPIRED,
    );
    expect(store.sessions[0]!.status).toBe(AgentSessionStatus.FAILED);
  });

  it("cannot clear the wait when the proposal CAS loses", async () => {
    seedSession();
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });
    prismaDouble.agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.AWAITING_APPROVAL,
    );
    expect(store.sessions[0]!.status).toBe(
      AgentSessionStatus.WAITING_CONFIRMATION,
    );
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("is safe to repeat and does not duplicate side effects", async () => {
    seedSession();
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });

    const first = await expireStaleProposalReviews({ limit: 10, now });
    const second = await expireStaleProposalReviews({ limit: 10, now });

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
    expect(second.scanned).toBe(0);
    expect(store.sessions[0]!.status).toBe(AgentSessionStatus.RUNNING);
    expect(store.outbox).toHaveLength(0);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("keeps the existing RUNNING-session behavior", async () => {
    seedSession({ status: AgentSessionStatus.RUNNING });
    seedExecution({ expiresAt: new Date(now.getTime() - 1) });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.expired).toBe(1);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.EXPIRED,
    );
    expect(store.sessions[0]!.status).toBe(AgentSessionStatus.RUNNING);
  });

  it("does not expire a proposal that is still awaiting criticality", async () => {
    seedSession();
    seedExecution({
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      expiresAt: new Date(now.getTime() - 1),
    });

    const summary = await expireStaleProposalReviews({ limit: 10, now });

    expect(summary.scanned).toBe(0);
    expect(store.executions[0]!.proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
    expect(store.sessions[0]!.status).toBe(
      AgentSessionStatus.WAITING_CONFIRMATION,
    );
  });
});
