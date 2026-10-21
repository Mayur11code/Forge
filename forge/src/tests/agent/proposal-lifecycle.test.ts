// src/tests/agent/proposal-lifecycle.test.ts
//
// Assignment 37.8 (F4) — the durable proposal lifecycle.
//
// The subject is the lifecycle stored on `AgentToolExecution`: classification of
// a `generateWorkflow` result, revision ranking, the compare-and-set
// persistence, supersession, the durable human-decision writes, and the
// recovery reads. The worker section proves the loop PARKS on a valid proposal
// (no AGENT_LOOP_REQUESTED) while every other outcome is unchanged.
//
// Everything is asserted against the in-memory prisma double, so "restart" here
// means: read the lifecycle back from the store with no transcript parsing. A
// real cold-restart-against-Postgres test is not possible in this environment
// (no reachable database); that gap is called out in the Phase 2 report.

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

jest.mock("@/lib/ai/agent/locks", () => {
  const run = async <T>(_id: string, cb: () => Promise<T>): Promise<T> => cb();
  return {
    withAgentSessionLock: jest.fn(run),
    withToolExecutionLock: jest.fn(run),
  };
});

jest.mock("@/lib/ai/agent/session-service", () => {
  const actual = jest.requireActual("@/lib/ai/agent/session-service");
  return {
    ...actual,
    failAgentSession: jest.fn(),
  };
});

jest.mock("@/lib/ai/agent/services/message-service", () => ({
  createMessage: jest.fn(),
}));

jest.mock("@/lib/ai/agent/outbox", () => ({
  recordAgentEvent: jest.fn(),
}));

jest.mock("@/lib/ai/agent/status", () => ({
  publishAgentStatus: jest.fn(),
}));

jest.mock("@/lib/ai/agent/services/tool-execution-service", () => ({
  getToolExecutionForWorker: jest.fn(),
  markToolExecutionRunning: jest.fn(),
  failToolExecution: jest.fn(),
  abandonToolExecution: jest.fn(),
  heartbeatToolExecution: jest.fn(async () => true),
}));

import { AgentProposalState } from "@prisma/client";

import {
  prismaDouble,
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

import { recordAgentEvent } from "@/lib/ai/agent/outbox";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";
import { failAgentSession } from "@/lib/ai/agent/session-service";
import { publishAgentStatus } from "@/lib/ai/agent/status";
import {
  failToolExecution,
  getToolExecutionForWorker,
  heartbeatToolExecution,
  markToolExecutionRunning,
} from "@/lib/ai/agent/services/tool-execution-service";
import { computeProposalCorrelationId } from "@/lib/ai/agent/tools/generate-workflow/execute";
import {
  comparePendingProposalRecency,
  computeProposalRevision,
  deriveProposalLifecycle,
  getPendingProposal,
  hasPendingProposal,
  persistExecutionOutcome,
  reconcileActiveProposal,
  recordClarificationAnswer,
  recordCriticalityDecision,
} from "@/lib/ai/agent/services/proposal-service";

const tx = prismaDouble as unknown as Parameters<
  typeof persistExecutionOutcome
>[0];

const SESSION_ID = "clxsessionproposalaaaaaaa";
const EXECUTION_ID = "clxexecproposalppppppppp";
const TOOL_CALL_ID = "call_prop_0001";

const PROJECT_ID = "clxyz0000000000000000000a";

function step(overrides: Record<string, unknown> = {}) {
  return {
    action: "task.create",
    inputs: { title: "Create the onboarding task", projectId: PROJECT_ID },
    dependsOn: [] as string[],
    ...overrides,
  };
}

const VALID_PROPOSAL = {
  name: "Onboard a client",
  description: "Kick off the onboarding.",
  steps: {
    kickoff: step(),
    follow: step({
      inputs: { title: "Follow up on kickoff", projectId: PROJECT_ID },
      dependsOn: ["kickoff"],
    }),
  },
};

function seedExecution(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: EXECUTION_ID,
    sessionId: SESSION_ID,
    toolCallId: TOOL_CALL_ID,
    toolName: "generateWorkflow",
    status: "RUNNING",
    result: null,
    proposalState: null,
    proposalFingerprint: null,
    proposalRevision: null,
    clarificationAnswer: null,
    criticalityDecisions: null,
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
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("deriveProposalLifecycle", () => {
  it("ignores every tool that is not generateWorkflow", () => {
    expect(deriveProposalLifecycle("createTask", { ok: true })).toBeNull();
    expect(deriveProposalLifecycle("", VALID_PROPOSAL)).toBeNull();
  });

  it("classifies a valid proposal as AWAITING_CRITICALITY with a fingerprint", () => {
    const lifecycle = deriveProposalLifecycle("generateWorkflow", {
      ok: true,
      proposal: VALID_PROPOSAL,
    });

    expect(lifecycle?.state).toBe(AgentProposalState.AWAITING_CRITICALITY);
    // The fingerprint is the SAME value the criticality service re-derives from
    // the transcript, so the two always agree on revision identity.
    expect(lifecycle?.fingerprint).toBe(
      computeProposalCorrelationId(VALID_PROPOSAL),
    );
  });

  it("classifies a clarification as NEEDS_CLARIFICATION", () => {
    const lifecycle = deriveProposalLifecycle("generateWorkflow", {
      ok: false,
      code: "NEEDS_USER_INPUT",
      correlationId: "corr_1",
    });

    expect(lifecycle?.state).toBe(AgentProposalState.NEEDS_CLARIFICATION);
    expect(lifecycle?.fingerprint).toBe("corr_1");
  });

  it("classifies a compiler rejection as INVALID", () => {
    const lifecycle = deriveProposalLifecycle("generateWorkflow", {
      ok: false,
      code: "INVALID_INPUT",
    });

    expect(lifecycle?.state).toBe(AgentProposalState.INVALID);
    expect(lifecycle?.fingerprint).toBeNull();
  });

  it("refuses to guess a state for a success envelope that does not parse", () => {
    expect(
      deriveProposalLifecycle("generateWorkflow", {
        ok: true,
        proposal: { name: "no steps" },
      }),
    ).toBeNull();
  });

  it("returns null for a non-object or null payload", () => {
    expect(deriveProposalLifecycle("generateWorkflow", null)).toBeNull();
    expect(deriveProposalLifecycle("generateWorkflow", "nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Revision ranking
// ---------------------------------------------------------------------------

describe("computeProposalRevision", () => {
  it("ranks by (createdAt, id) and breaks same-millisecond ties by id", () => {
    const rows = [
      { id: "c", createdAt: new Date(5) },
      { id: "a", createdAt: new Date(1) },
      { id: "b", createdAt: new Date(1) },
    ];

    expect(computeProposalRevision(rows, "a")).toBe(1);
    expect(computeProposalRevision(rows, "b")).toBe(2);
    expect(computeProposalRevision(rows, "c")).toBe(3);
  });

  it("ranks an execution that is not yet in the list last", () => {
    const rows = [{ id: "a", createdAt: new Date(1) }];

    expect(computeProposalRevision(rows, "unknown")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Durable persistence (compare-and-set)
// ---------------------------------------------------------------------------

describe("persistExecutionOutcome", () => {
  it("writes the result, state, fingerprint and revision from RUNNING", async () => {
    seedExecution();

    const ok = await persistExecutionOutcome(tx, {
      executionId: EXECUTION_ID,
      result: { ok: true },
      lifecycle: {
        state: AgentProposalState.AWAITING_CRITICALITY,
        fingerprint: "fp_1",
      },
      revision: 1,
    });

    expect(ok).toBe(true);
    const row = store.executions[0]!;
    expect(row.result).toEqual({ ok: true });
    expect(row.proposalState).toBe(AgentProposalState.AWAITING_CRITICALITY);
    expect(row.proposalFingerprint).toBe("fp_1");
    expect(row.proposalRevision).toBe(1);
    // F-1: the terminal status lands in the SAME compare-and-set as the result,
    // so a crash can never leave a finished, parked proposal stuck RUNNING.
    expect(row.status).toBe("COMPLETED");
    expect(row.error).toBeNull();
  });

  it("loses the compare-and-set and does not overwrite a row that already advanced", async () => {
    seedExecution({ status: "COMPLETED" });

    const ok = await persistExecutionOutcome(tx, {
      executionId: EXECUTION_ID,
      result: { ok: true },
      lifecycle: {
        state: AgentProposalState.AWAITING_CRITICALITY,
        fingerprint: "fp_1",
      },
      revision: 1,
    });

    expect(ok).toBe(false);
    expect(store.executions[0]!.proposalState).toBeNull();
    expect(store.executions[0]!.result).toBeNull();
  });

  it("leaves the proposal state unset for a non-proposal tool", async () => {
    seedExecution({ toolName: "createTask" });

    const ok = await persistExecutionOutcome(tx, {
      executionId: EXECUTION_ID,
      result: { ok: true },
      lifecycle: null,
      revision: null,
    });

    expect(ok).toBe(true);
    expect(store.executions[0]!.proposalState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describe("reconcileActiveProposal", () => {
  const byId = (id: string) => store.executions.find((row) => row.id === id)!;

  it("retires older pending proposals but keeps non-pending and other sessions", async () => {
    seedExecution({
      id: "this_proposal",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
    });
    seedExecution({
      id: "old_awaiting",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 1,
    });
    seedExecution({
      id: "old_invalid",
      proposalState: AgentProposalState.INVALID,
      proposalRevision: 0,
    });
    seedExecution({
      id: "other_session",
      sessionId: "someone_else",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 1,
    });

    const outcome = await reconcileActiveProposal(tx, {
      sessionId: SESSION_ID,
      executionId: "this_proposal",
      revision: 2,
    });

    expect(outcome).toBe("active");
    expect(byId("this_proposal").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
    expect(byId("old_awaiting").proposalState).toBe(
      AgentProposalState.SUPERSEDED,
    );
    expect(byId("old_invalid").proposalState).toBe(AgentProposalState.INVALID);
    expect(byId("other_session").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
  });

  it("retires THIS proposal when a newer one has already parked (out-of-order)", async () => {
    // F-2: the case `supersedeEarlierProposals` could not express. A newer
    // proposal parked first, so this older one is the late arrival and must
    // retire ITSELF - otherwise two proposals would await a human at once.
    seedExecution({
      id: "late_self",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 1,
    });
    seedExecution({
      id: "newer",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
    });

    const outcome = await reconcileActiveProposal(tx, {
      sessionId: SESSION_ID,
      executionId: "late_self",
      revision: 1,
    });

    expect(outcome).toBe("superseded");
    expect(byId("late_self").proposalState).toBe(
      AgentProposalState.SUPERSEDED,
    );
    expect(byId("newer").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );

    // The invariant: exactly one proposal awaits a human, and it is the newest.
    const pending = await getPendingProposal(SESSION_ID);
    expect(pending?.interactionId).toBe("newer");
  });

  it("retires a legacy pending proposal that carries no revision (37.8.1)", async () => {
    // A row written before the lifecycle columns existed sits at
    // AWAITING_CRITICALITY with proposalRevision NULL. In SQL `NULL < n` is
    // UNKNOWN, never true, so a plain `proposalRevision < n` sweep skips it and
    // it parks beside the proposal that replaced it.
    seedExecution({
      id: "legacy_parked",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: null,
      createdAt: new Date(0),
    });
    seedExecution({
      id: "current",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
      createdAt: new Date(10),
    });

    const outcome = await reconcileActiveProposal(tx, {
      sessionId: SESSION_ID,
      executionId: "current",
      revision: 2,
    });

    expect(outcome).toBe("active");
    expect(byId("legacy_parked").proposalState).toBe(
      AgentProposalState.SUPERSEDED,
    );
    expect(byId("current").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );

    const pending = await getPendingProposal(SESSION_ID);
    expect(pending?.interactionId).toBe("current");
  });

  it("retires a legacy row adopted through the criticality CAS, then supersedes it (37.8.1)", async () => {
    // The audit scenario end to end: a legacy row is decided first - the
    // null-state CAS branch adopts it and deliberately leaves proposalRevision
    // NULL rather than inventing revision history - and only THEN does a newer
    // proposal park. The adopted row must not survive.
    const legacy = seedExecution({
      id: "legacy_adopted",
      proposalState: null,
      proposalRevision: null,
      createdAt: new Date(0),
    });

    const adopted = await recordCriticalityDecision(tx, {
      executionId: legacy.id as string,
      sessionId: SESSION_ID,
      decisions: { kickoff: true },
    });

    expect(adopted).toBe(true);
    expect(byId("legacy_adopted").proposalState).toBe(
      AgentProposalState.AWAITING_APPROVAL,
    );
    // No revision is fabricated for the legacy row.
    expect(byId("legacy_adopted").proposalRevision).toBeNull();

    seedExecution({
      id: "newer_parked",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
      createdAt: new Date(10),
    });

    await reconcileActiveProposal(tx, {
      sessionId: SESSION_ID,
      executionId: "newer_parked",
      revision: 2,
    });

    expect(byId("legacy_adopted").proposalState).toBe(
      AgentProposalState.SUPERSEDED,
    );
    expect(byId("newer_parked").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );

    const pending = await getPendingProposal(SESSION_ID);
    expect(pending?.interactionId).toBe("newer_parked");
  });

  it("sweeps a legacy row even on the out-of-order self-retirement path (37.8.1)", async () => {
    // The newer proposal parked before this one arrived, so its own sweep could
    // not see the legacy row. The out-of-order branch has to sweep too, or the
    // stale legacy proposal is the only thing left on the human's desk.
    seedExecution({
      id: "legacy_parked",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: null,
      createdAt: new Date(0),
    });
    seedExecution({
      id: "late_self",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 1,
      createdAt: new Date(5),
    });
    seedExecution({
      id: "newer",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
      createdAt: new Date(10),
    });

    const outcome = await reconcileActiveProposal(tx, {
      sessionId: SESSION_ID,
      executionId: "late_self",
      revision: 1,
    });

    expect(outcome).toBe("superseded");
    expect(byId("late_self").proposalState).toBe(
      AgentProposalState.SUPERSEDED,
    );
    expect(byId("legacy_parked").proposalState).toBe(
      AgentProposalState.SUPERSEDED,
    );
    expect(byId("newer").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );

    const pending = await getPendingProposal(SESSION_ID);
    expect(pending?.interactionId).toBe("newer");
  });

  it("leaves a null-revision row alone when it is not awaiting a human (37.8.1)", async () => {
    // The sweep must be specific: a legacy row in a non-pending state has
    // already left the lifecycle and is not a candidate for supersession.
    seedExecution({
      id: "legacy_invalid",
      proposalState: AgentProposalState.INVALID,
      proposalRevision: null,
    });
    seedExecution({
      id: "legacy_other_session",
      sessionId: "someone_else",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: null,
    });
    seedExecution({
      id: "current",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
    });

    await reconcileActiveProposal(tx, {
      sessionId: SESSION_ID,
      executionId: "current",
      revision: 2,
    });

    expect(byId("legacy_invalid").proposalState).toBe(
      AgentProposalState.INVALID,
    );
    expect(byId("legacy_other_session").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
    expect(byId("current").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
  });

  it("never sweeps the row it is reconciling, even when that row has no revision (37.8.1)", async () => {
    // The null branch of the sweep matches on `proposalRevision IS NULL`, so
    // without `id: { not: executionId }` the sweep would retire the very
    // proposal this call is meant to leave active. The revisioned case never
    // needed the guard (`n < n` is false); the legacy case does.
    seedExecution({
      id: "self_legacy",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: null,
      createdAt: new Date(0),
    });

    const outcome = await reconcileActiveProposal(tx, {
      sessionId: SESSION_ID,
      executionId: "self_legacy",
      revision: 1,
    });

    expect(outcome).toBe("active");
    expect(byId("self_legacy").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
  });
});

// ---------------------------------------------------------------------------
// In-memory ordering shared with the read route (37.8.1)
// ---------------------------------------------------------------------------

describe("comparePendingProposalRecency", () => {
  const row = (
    id: string,
    proposalRevision: number | null,
    createdAt: number,
  ) => ({ id, proposalRevision, createdAt: new Date(createdAt) });

  it("sorts the highest revision first and NULL revisions last", () => {
    // PostgreSQL's `ORDER BY x DESC` defaults to NULLS FIRST, which is exactly
    // the inversion this comparator exists to rule out.
    const rows = [
      row("legacy", null, 100),
      row("old", 1, 1),
      row("new", 5, 2),
    ];

    const sorted = [...rows]
      .sort(comparePendingProposalRecency)
      .map((r) => r.id);

    expect(sorted).toEqual(["new", "old", "legacy"]);
  });

  it("breaks ties by createdAt then id, newest first", () => {
    const rows = [
      row("legacy_older", null, 1),
      row("legacy_newer", null, 9),
      row("rev_older", 2, 1),
      row("rev_newer", 2, 9),
    ];

    const sorted = [...rows]
      .sort(comparePendingProposalRecency)
      .map((r) => r.id);

    expect(sorted).toEqual(["rev_newer", "rev_older", "legacy_newer", "legacy_older"]);
  });

  it("is a no-op for a single row and total for identical rows", () => {
    expect(comparePendingProposalRecency(row("a", 1, 1), row("a", 1, 1))).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Durable human decisions
// ---------------------------------------------------------------------------

describe("recordCriticalityDecision", () => {
  it("advances AWAITING_CRITICALITY to AWAITING_APPROVAL and stores the decisions", async () => {
    seedExecution({ proposalState: AgentProposalState.AWAITING_CRITICALITY });

    const ok = await recordCriticalityDecision(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      decisions: { kickoff: true, follow: false },
    });

    expect(ok).toBe(true);
    const row = store.executions[0]!;
    expect(row.proposalState).toBe(AgentProposalState.AWAITING_APPROVAL);
    expect(row.criticalityDecisions).toEqual({ kickoff: true, follow: false });
  });

  it("loses the compare-and-set when the proposal is not awaiting criticality", async () => {
    seedExecution({ proposalState: AgentProposalState.AWAITING_APPROVAL });

    const ok = await recordCriticalityDecision(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      decisions: { kickoff: true },
    });

    expect(ok).toBe(false);
    expect(store.executions[0]!.criticalityDecisions).toBeNull();
  });
});

describe("recordClarificationAnswer", () => {
  it("advances NEEDS_CLARIFICATION to CLARIFICATION_ACCEPTED and stores the answer", async () => {
    seedExecution({ proposalState: AgentProposalState.NEEDS_CLARIFICATION });

    const ok = await recordClarificationAnswer(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      answers: { project: "proj_1" },
    });

    expect(ok).toBe(true);
    const row = store.executions[0]!;
    expect(row.proposalState).toBe(AgentProposalState.CLARIFICATION_ACCEPTED);
    expect(row.clarificationAnswer).toEqual({ project: "proj_1" });
  });

  it("loses the compare-and-set when the proposal is not awaiting clarification", async () => {
    seedExecution({ proposalState: AgentProposalState.AWAITING_CRITICALITY });

    const ok = await recordClarificationAnswer(tx, {
      executionId: EXECUTION_ID,
      sessionId: SESSION_ID,
      answers: { project: "proj_1" },
    });

    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recovery reads (the restart contract)
// ---------------------------------------------------------------------------

describe("getPendingProposal / hasPendingProposal", () => {
  it("returns the newest pending proposal by revision, ignoring non-pending states", async () => {
    seedExecution({
      id: "p1",
      proposalState: AgentProposalState.AWAITING_APPROVAL,
      proposalRevision: 1,
      proposalFingerprint: "fp_1",
    });
    seedExecution({
      id: "p2",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
      proposalFingerprint: "fp_2",
    });
    seedExecution({
      id: "p3",
      proposalState: AgentProposalState.INVALID,
      proposalRevision: 9,
    });

    const pending = await getPendingProposal(SESSION_ID);

    expect(pending?.interactionId).toBe("p2");
    expect(pending?.state).toBe(AgentProposalState.AWAITING_CRITICALITY);
    expect(pending?.fingerprint).toBe("fp_2");
    expect(pending?.revision).toBe(2);
  });

  it("returns null when nothing is pending a human", async () => {
    seedExecution({ proposalState: AgentProposalState.INVALID });

    expect(await getPendingProposal(SESSION_ID)).toBeNull();
    expect(await hasPendingProposal(SESSION_ID)).toBe(false);
  });

  it("reports a pending proposal without parsing the transcript", async () => {
    seedExecution({ proposalState: AgentProposalState.AWAITING_CRITICALITY });

    expect(await hasPendingProposal(SESSION_ID)).toBe(true);
  });

  it("never lets a null-revision legacy row outrank the newest proposal (37.8.1)", async () => {
    // The stale legacy row is deliberately the newest by createdAt, so only the
    // explicit NULL-revisions-last rule can keep it from winning.
    seedExecution({
      id: "legacy_null_revision",
      proposalState: AgentProposalState.AWAITING_APPROVAL,
      proposalRevision: null,
      createdAt: new Date(50),
    });
    seedExecution({
      id: "authoritative",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 3,
      createdAt: new Date(10),
    });

    const pending = await getPendingProposal(SESSION_ID);

    expect(pending?.interactionId).toBe("authoritative");
    expect(pending?.revision).toBe(3);
  });

  it("still returns a legacy null-revision proposal when it is the only one pending (37.8.1)", async () => {
    // No revision history is invented for legacy rows: if nothing else is
    // parked, the legacy row genuinely is the thing awaiting a human.
    seedExecution({
      id: "legacy_only",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: null,
      createdAt: new Date(0),
    });

    const pending = await getPendingProposal(SESSION_ID);

    expect(pending?.interactionId).toBe("legacy_only");
    expect(pending?.revision).toBeNull();
    expect(await hasPendingProposal(SESSION_ID)).toBe(true);
  });

  it("breaks ties between two null-revision rows deterministically, newest first (37.8.1)", async () => {
    seedExecution({
      id: "legacy_older",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: null,
      createdAt: new Date(1),
    });
    seedExecution({
      id: "legacy_newer",
      proposalState: AgentProposalState.AWAITING_APPROVAL,
      proposalRevision: null,
      createdAt: new Date(9),
    });

    const pending = await getPendingProposal(SESSION_ID);

    expect(pending?.interactionId).toBe("legacy_newer");
  });
});

// ---------------------------------------------------------------------------
// Worker: the loop PARKS on a valid proposal
// ---------------------------------------------------------------------------

describe("tool worker — proposal parking", () => {
  function stageWorker(input: unknown, overrides: Record<string, unknown> = {}) {
    (getToolExecutionForWorker as jest.Mock).mockResolvedValue({
      id: EXECUTION_ID,
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: "generateWorkflow",
      status: "RUNNING",
      input,
      session: {
        status: "RUNNING",
        currentStep: 2,
        orgId: "org_1",
        userId: "user_a",
      },
      ...overrides,
    });
    (markToolExecutionRunning as jest.Mock).mockResolvedValue(true);
    (heartbeatToolExecution as jest.Mock).mockResolvedValue(true);
  }

  function run() {
    return handleToolExecution({
      event: {
        data: {
          sessionId: SESSION_ID,
          executionId: EXECUTION_ID,
          expectedStep: 3,
        },
      },
    } as never);
  }

  it("persists the proposal and does NOT request another loop turn", async () => {
    seedExecution();
    stageWorker(VALID_PROPOSAL);

    await run();

    const row = store.executions[0]!;
    expect(row.proposalState).toBe(AgentProposalState.AWAITING_CRITICALITY);
    expect(row.proposalRevision).toBe(1);
    expect(row.proposalFingerprint).toBe(
      computeProposalCorrelationId(VALID_PROPOSAL),
    );

    // The load-bearing assertion: a parked proposal must not re-drive the model,
    // or the loop would regenerate the proposal it just made.
    expect(recordAgentEvent).not.toHaveBeenCalled();
    // F-1: the terminal status is committed WITH the result, so a parked
    // proposal is never left RUNNING.
    expect(row.status).toBe("COMPLETED");
  });

  it("retires an older pending proposal when a newer one parks", async () => {
    seedExecution({
      id: "older",
      toolCallId: "call_older",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 1,
      createdAt: new Date(0),
    });
    seedExecution({ createdAt: new Date(1) });
    stageWorker(VALID_PROPOSAL);

    await run();

    const byId = (id: string) =>
      store.executions.find((row) => row.id === id)!;
    expect(byId(EXECUTION_ID).proposalRevision).toBe(2);
    expect(byId(EXECUTION_ID).proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
    expect(byId("older").proposalState).toBe(AgentProposalState.SUPERSEDED);
  });

  it("supersedes itself when a newer proposal already parked (out-of-order, F-2)", async () => {
    // The two executions finish out of order: the newer one parked first, so
    // this late older one must not become a second proposal awaiting a human.
    seedExecution({ createdAt: new Date(0) });
    seedExecution({
      id: "newer",
      toolCallId: "call_newer",
      proposalState: AgentProposalState.AWAITING_CRITICALITY,
      proposalRevision: 2,
      createdAt: new Date(1),
    });
    stageWorker(VALID_PROPOSAL);

    await run();

    const byId = (id: string) =>
      store.executions.find((row) => row.id === id)!;
    expect(byId(EXECUTION_ID).proposalState).toBe(
      AgentProposalState.SUPERSEDED,
    );
    expect(byId("newer").proposalState).toBe(
      AgentProposalState.AWAITING_CRITICALITY,
    );
    // Still a halt: the newer proposal is the one pending a decision.
    expect(recordAgentEvent).not.toHaveBeenCalled();
  });

  it("keeps the committed outcome when the post-commit notification throws", async () => {
    // The status publish is a UI signal, not authoritative. A transport failure
    // after the transaction has committed must not fail the execution, un-park
    // the proposal, or fail the session.
    seedExecution();
    stageWorker(VALID_PROPOSAL);
    (publishAgentStatus as jest.Mock).mockRejectedValueOnce(
      new Error("pusher unavailable"),
    );

    await run();

    const row = store.executions[0]!;
    expect(row.status).toBe("COMPLETED");
    expect(row.proposalState).toBe(AgentProposalState.AWAITING_CRITICALITY);
    expect(failToolExecution).not.toHaveBeenCalled();
    expect(failAgentSession).not.toHaveBeenCalled();
    // The park recorded no continuation, and the notification failure adds none.
    expect(recordAgentEvent).not.toHaveBeenCalled();
  });

  it("still fails the execution and session on a genuine pre-commit error", async () => {
    // A null input makes the real executor throw BEFORE the outcome
    // transaction, so this exercises the unchanged pre-commit failure path.
    seedExecution();
    stageWorker(null);
    (failAgentSession as jest.Mock).mockResolvedValue({ count: 1 });

    await run();

    expect(failToolExecution).toHaveBeenCalledWith(
      EXECUTION_ID,
      expect.any(Error),
    );
    expect(failAgentSession).toHaveBeenCalled();
    const row = store.executions[0]!;
    expect(row.status).toBe("RUNNING");
    expect(row.proposalState).toBeNull();
  });

  it("still requests the loop for an INVALID proposal (the model self-corrects)", async () => {
    seedExecution();
    stageWorker({ name: "Bad", steps: { a: step({ dependsOn: ["ghost"] }) } });

    await run();

    expect(recordAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AGENT_LOOP_REQUESTED" }),
    );
    expect(store.executions[0]!.proposalState).toBe(AgentProposalState.INVALID);
  });
});
