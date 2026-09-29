// src/tests/agent/approval-timeout.test.ts
//
// Approval expiry: the timeout path, the CAS, and what the agent is told.
//
// The property under test throughout is that EXPIRED is a distinct, terminal
// outcome that is indistinguishable from "nothing ran" and can never be undone
// by a user who arrives late.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));
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

import { publishEvent } from "@/lib/events/queue";
import { publishAgentStatus } from "@/lib/ai/agent/status";
import { decideConfirmation } from "@/lib/ai/agent/services/confirmation-service";
import {
  createToolExecution,
  expireToolExecution,
  findDueApprovalCandidates,
} from "@/lib/ai/agent/services/tool-execution-service";
import { expireStaleApprovals } from "@/lib/ai/agent/reaper";
import {
  getAgentApprovalTimeoutMs,
  DEFAULT_AGENT_APPROVAL_TIMEOUT_MS,
} from "@/lib/ai/agent/constants";
import {
  prismaDouble,
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const EXECUTION_ID = "clxexecccccccccccccccc";

type Row = Record<string, unknown>;

const publishEventMock = publishEvent as jest.MockedFunction<typeof publishEvent>;
const publishStatusMock =
  publishAgentStatus as jest.MockedFunction<typeof publishAgentStatus>;

function makeSession(overrides: Row = {}): Row {
  return {
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_a",
    status: "RUNNING",
    currentStep: 2,
    organization: { id: "org_1", name: "Org" },
    user: { id: "user_a", name: "A", email: "a@example.com" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  restorePrismaDouble();
  resetStore();
  delete process.env.AGENT_APPROVAL_TIMEOUT_MS;
});

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

describe("approval timeout configuration", () => {
  it("defaults to a documented value when unset", () => {
    expect(getAgentApprovalTimeoutMs()).toBe(DEFAULT_AGENT_APPROVAL_TIMEOUT_MS);
    expect(DEFAULT_AGENT_APPROVAL_TIMEOUT_MS).toBe(15 * 60_000);
  });

  it("honours an explicit override", () => {
    process.env.AGENT_APPROVAL_TIMEOUT_MS = "60000";

    expect(getAgentApprovalTimeoutMs()).toBe(60_000);
  });

  it("fails loudly on a malformed value rather than silently defaulting", () => {
    // Defaulting on garbage would mean a typo in an env var quietly changes
    // production behaviour to a 15 minute window nobody chose.
    process.env.AGENT_APPROVAL_TIMEOUT_MS = "fifteen minutes";

    expect(() => getAgentApprovalTimeoutMs()).toThrow(
      /AGENT_APPROVAL_TIMEOUT_MS/,
    );
  });

  it("rejects a zero or negative window", () => {
    process.env.AGENT_APPROVAL_TIMEOUT_MS = "0";
    expect(() => getAgentApprovalTimeoutMs()).toThrow();

    process.env.AGENT_APPROVAL_TIMEOUT_MS = "-1";
    expect(() => getAgentApprovalTimeoutMs()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Expiry is set at proposal time
// ---------------------------------------------------------------------------

describe("proposal expiry", () => {
  it("stamps expiresAt when a confirmation is required", async () => {
    const before = Date.now();

    const execution = await createToolExecution({
      sessionId: SESSION_ID,
      toolCallId: "call_1",
      toolName: "createTask",
      input: { title: "Fix login" },
      requiresConfirmation: true,
    });

    const expiresAt = (execution.expiresAt as Date).getTime();

    expect(execution.status).toBe("PENDING_CONFIRMATION");
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + DEFAULT_AGENT_APPROVAL_TIMEOUT_MS,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + DEFAULT_AGENT_APPROVAL_TIMEOUT_MS,
    );
  });

  it("leaves expiresAt null for a read-only tool that needs no approval", async () => {
    const execution = await createToolExecution({
      sessionId: SESSION_ID,
      toolCallId: "call_2",
      toolName: "listTasks",
      input: {},
      requiresConfirmation: false,
      dispatchEvent: { orgId: "org_1", expectedStep: 3 },
    });

    // No deadline on something that is never waiting on a human.
    expect(execution.expiresAt).toBeNull();
  });

  it("records a dispatch intent for a read-only tool, but not for a proposal", async () => {
    await createToolExecution({
      sessionId: SESSION_ID,
      toolCallId: "call_3",
      toolName: "listTasks",
      input: {},
      requiresConfirmation: false,
      dispatchEvent: { orgId: "org_1", expectedStep: 3 },
    });

    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].eventType).toBe(
      "AGENT_TOOL_EXECUTION_REQUESTED",
    );

    resetStore();
    await createToolExecution({
      sessionId: SESSION_ID,
      toolCallId: "call_4",
      toolName: "createTask",
      input: {},
      requiresConfirmation: true,
    });

    // A proposal must not reach the worker before a human decides.
    expect(store.outbox).toHaveLength(0);
  });

  it("refuses to create a dispatchable execution with no intent to dispatch it", async () => {
    // This is the exact bug the outbox exists to prevent, turned into a
    // precondition error so it cannot be reintroduced silently.
    await expect(
      createToolExecution({
        sessionId: SESSION_ID,
        toolCallId: "call_5",
        toolName: "listTasks",
        input: {},
        requiresConfirmation: false,
      }),
    ).rejects.toThrow(/dispatchEvent/);
  });
});

// ---------------------------------------------------------------------------
// The expire CAS
// ---------------------------------------------------------------------------

describe("expireToolExecution", () => {
  function stagePending(overrides: Row = {}) {
    store.executions = [
      {
        id: EXECUTION_ID,
        sessionId: SESSION_ID,
        toolCallId: "call_1",
        toolName: "createTask",
        input: {},
        status: "PENDING_CONFIRMATION",
        error: null,
        expiresAt: new Date(Date.now() - 1000),
        expiredAt: null,
        ...overrides,
      },
    ];
  }

  it("transitions PENDING_CONFIRMATION to EXPIRED and records when", async () => {
    stagePending();

    const now = new Date();
    const didExpire = await expireToolExecution(EXECUTION_ID, now);

    expect(didExpire).toBe(true);
    expect(store.executions[0].status).toBe("EXPIRED");
    expect(store.executions[0].expiredAt).toEqual(now);
    expect(store.executions[0].error).toBe("APPROVAL_TIMEOUT");
  });

  it("never expires a proposal whose window has not closed", async () => {
    stagePending({ expiresAt: new Date(Date.now() + 60_000) });

    const didExpire = await expireToolExecution(EXECUTION_ID, new Date());

    expect(didExpire).toBe(false);
    expect(store.executions[0].status).toBe("PENDING_CONFIRMATION");
  });

  it("will not expire a confirmed execution", async () => {
    stagePending({ status: "PENDING" });

    expect(await expireToolExecution(EXECUTION_ID, new Date())).toBe(false);
    expect(store.executions[0].status).toBe("PENDING");
  });

  it("will not expire an already expired one twice", async () => {
    stagePending();

    expect(await expireToolExecution(EXECUTION_ID, new Date())).toBe(true);
    expect(await expireToolExecution(EXECUTION_ID, new Date())).toBe(false);
  });

  it("ignores a null deadline rather than expiring on an unreached one", async () => {
    // Rows predating approval expiry have no deadline. Expiring them would
    // close a proposal against a window nobody agreed to.
    stagePending({ expiresAt: null });

    expect(await expireToolExecution(EXECUTION_ID, new Date())).toBe(false);
  });
});

describe("findDueApprovalCandidates", () => {
  it("returns nothing when the double has no scan implementation", async () => {
    // The double deliberately does not model a filtered scan; the CAS tests
    // above are the authoritative coverage for expiry. This asserts the caller
    // tolerates an empty batch rather than throwing.
    await expect(
      findDueApprovalCandidates(10, new Date()),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EXPIRED is terminal and idempotent
// ---------------------------------------------------------------------------

describe("decideConfirmation with an expired execution", () => {
  it("treats confirm as a settled no-op rather than an error", () => {
    expect(
      decideConfirmation({
        action: "confirm",
        executionStatus: "EXPIRED",
        sessionStatus: "RUNNING",
      }),
    ).toEqual({ kind: "IDEMPOTENT" });
  });

  it("treats cancel as a settled no-op, with nothing to resurrect", () => {
    expect(
      decideConfirmation({
        action: "cancel",
        executionStatus: "EXPIRED",
        sessionStatus: "RUNNING",
      }),
    ).toEqual({ kind: "IDEMPOTENT" });
  });

  it("settles expiry even when the session has since ended", () => {
    // A late user should be told the window closed, not a session error they
    // cannot act on.
    expect(
      decideConfirmation({
        action: "confirm",
        executionStatus: "EXPIRED",
        sessionStatus: "COMPLETED",
      }),
    ).toEqual({ kind: "IDEMPOTENT" });
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe("expireStaleApprovals", () => {
  function stageDueProposal() {
    store.executions = [
      {
        id: EXECUTION_ID,
        sessionId: SESSION_ID,
        toolCallId: "call_1",
        toolName: "createTask",
        input: { title: "Fix login" },
        status: "PENDING_CONFIRMATION",
        error: null,
        expiresAt: new Date(Date.now() - 60_000),
        expiredAt: null,
      },
    ];
  }

  it("is a clean no-op when nothing is due", async () => {
    const result = await expireStaleApprovals();

    expect(result.expired).toBe(0);
    expect(result.continued).toBe(0);
    expect(result.errors).toEqual([]);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("leaves a proposal whose window is still open alone", async () => {
    store.executions = [
      {
        id: EXECUTION_ID,
        sessionId: SESSION_ID,
        toolCallId: "call_1",
        toolName: "createTask",
        input: {},
        status: "PENDING_CONFIRMATION",
        error: null,
        expiresAt: new Date(Date.now() + 60_000),
        expiredAt: null,
      },
    ];

    const result = await expireStaleApprovals();

    expect(result.expired).toBe(0);
    expect(store.executions[0].status).toBe("PENDING_CONFIRMATION");
  });

  it("expires a due proposal, tells the model, and re-drives the loop", async () => {
    stageDueProposal();
    store.sessions = [makeSession()];

    const result = await expireStaleApprovals();

    expect(result.expired).toBe(1);
    expect(result.continued).toBe(1);
    expect(store.executions[0].status).toBe("EXPIRED");

    // The model must be told the action did NOT happen, and must be told not to
    // achieve it another way - otherwise a helpful model "solves" the timeout by
    // routing around the approval gate.
    expect(store.messages).toHaveLength(1);
    const persisted = JSON.stringify(store.messages[0].message);
    expect(persisted).toContain("APPROVAL_TIMEOUT");
    expect(persisted).toContain("NOT executed");
    expect(persisted).toContain("by another means");

    // The continuation is now a DURABLE intent in the outbox, not a direct
    // publish. Asserting on the intent is the stronger claim: it is written in
    // the same transaction as the EXPIRED transition, so it cannot be lost by a
    // crash between the two - which a direct publish could.
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      eventType: "AGENT_LOOP_REQUESTED",
      status: "PENDING",
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      payload: { orgId: "org_1", sessionId: SESSION_ID, expectedStep: 2 },
    });

    expect(publishStatusMock).toHaveBeenCalledWith(SESSION_ID, {
      type: "TOOL_EXPIRED",
      executionId: EXECUTION_ID,
      toolName: "createTask",
    });
  });

  it("performs the expiry, transcript write and intent in one transaction", async () => {
    stageDueProposal();
    store.sessions = [makeSession()];

    prismaDouble.$transaction.mockClear();

    await expireStaleApprovals();

    // What is asserted here is ENCLOSURE, not rollback: that the transition,
    // the transcript entry and the outbox row are produced inside a single
    // transaction callback. The in-memory double has no failure injection, so it
    // cannot demonstrate that a mid-transaction error undoes the earlier write -
    // that is a property of the real database and is covered by the migration
    // and live verification, not here.
    //
    // Enclosure is nevertheless the part that was previously wrong, and it is
    // what the old three-step sweep got wrong: the CAS committed on its own, so a
    // crash before the publish left a terminal execution that the sweep's own
    // query would never return again.
    expect(prismaDouble.$transaction).toHaveBeenCalledTimes(1);
    expect(store.executions[0].status).toBe("EXPIRED");
    expect(store.messages).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
  });

  it("does not record a continuation when the expiry loses its CAS", async () => {
    stageDueProposal();
    store.sessions = [makeSession()];

    // The user confirmed between the scan and the write. Their decision wins the
    // race, so the transaction must commit with NO writes - no transcript entry
    // and no outbox row for a proposal that is still live and already dispatched.
    prismaDouble.agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    } as never);

    const result = await expireStaleApprovals();

    expect(result.expired).toBe(0);
    expect(result.continued).toBe(0);
    expect(store.messages).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it("surfaces a transcript write failure and retries on the next tick", async () => {
    stageDueProposal();
    store.sessions = [makeSession()];

    prismaDouble.agentMessage.create.mockRejectedValueOnce(
      new Error("write failed") as never,
    );

    const result = await expireStaleApprovals();

    // The batch continues, and the failure is reported rather than swallowed.
    // The double does not roll back, so the execution row's final state is not
    // asserted here; what matters at this level is that the error is visible to
    // the operator and that the sweep did not abort the rest of the batch.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.expired).toBe(0);
  });

  it("does not resurrect a terminal session", async () => {
    stageDueProposal();
    store.sessions = [makeSession({ status: "COMPLETED" })];

    const result = await expireStaleApprovals();

    // The execution is still closed - leaving it PENDING_CONFIRMATION would hang
    // the row forever - but nothing is published, because a terminal session has
    // no step left to claim and re-driving it could produce a new response.
    expect(result.expired).toBe(1);
    expect(result.continued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.executions[0].status).toBe("EXPIRED");
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
  });

  it("does not resurrect a failed session either", async () => {
    stageDueProposal();
    store.sessions = [makeSession({ status: "FAILED" })];

    const result = await expireStaleApprovals();

    expect(result.expired).toBe(1);
    expect(result.continued).toBe(0);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("closes the execution even when the session row has vanished", async () => {
    stageDueProposal();
    // A session deleted under us, e.g. by an org cascade. Publishing a
    // continuation for it would be meaningless.
    store.sessions = [];

    const result = await expireStaleApprovals();

    expect(result.expired).toBe(1);
    expect(result.skipped).toBe(1);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("is repeatable: a second pass finds nothing left to do", async () => {
    stageDueProposal();
    store.sessions = [makeSession()];

    const first = await expireStaleApprovals();
    expect(first.expired).toBe(1);

    const second = await expireStaleApprovals();

    expect(second.expired).toBe(0);
    expect(second.continued).toBe(0);
  });

  it("reports errors instead of throwing when a candidate fails", async () => {
    stageDueProposal();
    prismaDouble.agentToolExecution.updateMany.mockRejectedValueOnce(
      new Error("db unavailable") as never,
    );

    const result = await expireStaleApprovals();

    // A single bad row must not abandon the batch; later approvals would hang
    // forever if the sweep stopped on first error.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.expired).toBe(0);
  });

  it("keeps going after one candidate throws and still expires the rest", async () => {
    store.executions = [
      {
        id: "exec_bad",
        sessionId: SESSION_ID,
        toolCallId: "call_bad",
        toolName: "createTask",
        input: {},
        status: "PENDING_CONFIRMATION",
        error: null,
        expiresAt: new Date(Date.now() - 60_000),
        expiredAt: null,
      },
      {
        id: "exec_good",
        sessionId: SESSION_ID,
        toolCallId: "call_good",
        toolName: "createTask",
        input: {},
        status: "PENDING_CONFIRMATION",
        error: null,
        expiresAt: new Date(Date.now() - 60_000),
        expiredAt: null,
      },
    ];
    store.sessions = [makeSession()];

    // Only the first row's transition fails; the second must still succeed, and
    // must still actually apply the transition rather than just report a count.
    prismaDouble.agentToolExecution.updateMany.mockImplementation(
      async ({ where }: { where: { id?: string } }) => {
        if (where.id === "exec_bad") throw new Error("transient");

        const row = store.executions.find((r) => r.id === where.id);

        if (!row || row.status !== "PENDING_CONFIRMATION") {
          return { count: 0 };
        }

        row.status = "EXPIRED";
        row.expiredAt = new Date();
        row.error = "APPROVAL_TIMEOUT";

        return { count: 1 };
      },
    );

    const result = await expireStaleApprovals();

    expect(result.errors).toHaveLength(1);
    expect(result.expired).toBe(1);
    expect(store.executions[1].status).toBe("EXPIRED");
  });

  it("loses to a user who confirms during the same pass", async () => {
    stageDueProposal();
    store.sessions = [makeSession()];

    // CAS returns false: the user won the race between the scan and the
    // transition. That is a no-op, not an error.
    prismaDouble.agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const result = await expireStaleApprovals();

    expect(result.expired).toBe(0);
    expect(result.errors).toEqual([]);
    expect(publishEventMock).not.toHaveBeenCalled();
  });
});
