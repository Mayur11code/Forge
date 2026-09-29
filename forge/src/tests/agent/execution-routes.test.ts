// src/tests/agent/execution-routes.test.ts
//
// Route-level coverage for the confirm/cancel endpoints.
//
// These exercise the REAL session service, confirmation guard and tool
// execution service against an in-memory prisma double, so the compare-and-set
// transitions, ownership filtering and sessionId binding are all genuinely
// under test rather than mocked away.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/ai/agent/status", () => ({
  publishAgentStatus: jest.fn(),
}));

jest.mock("@/lib/prisma/extended", () => {
  // Required lazily: jest hoists this factory above the test file's imports,
  // so it cannot close over a const declared here. Requiring the helper module
  // resolves to the same instance the test body imports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");

  return { prisma: prismaDouble };
});

// The transactional outbox paths write through the RAW client, not the extended
// one, so both resolve to the same double. Without this the real db would be
// constructed and these tests would attempt real network I/O.
jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");

  return { db: prismaDouble };
});

import { auth } from "@/lib/auth/auth";
import { publishEvent } from "@/lib/events/queue";
import { publishAgentStatus } from "@/lib/ai/agent/status";
import { decideConfirmation } from "@/lib/ai/agent/services/confirmation-service";
import {
  prismaDouble,
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";
import { POST as confirmPost } from "@/app/api/agent/session/[sessionId]/executions/[executionId]/confirm/route";
import { POST as cancelPost } from "@/app/api/agent/session/[sessionId]/executions/[executionId]/cancel/route";

const authMock = auth as jest.MockedFunction<typeof auth>;
const publishEventMock = publishEvent as jest.MockedFunction<
  typeof publishEvent
>;
const publishStatusMock =
  publishAgentStatus as jest.MockedFunction<typeof publishAgentStatus>;

const SESSION_ID = "clxsessionaaaaaaaaaaaaaa";
const OTHER_SESSION_ID = "clxotherbbbbbbbbbbbbbb";
const EXECUTION_ID = "clxexecccccccccccccccc";

type Row = Record<string, unknown>;

function makeSession(overrides: Row = {}): Row {
  return {
    id: SESSION_ID,
    orgId: "org_1",
    userId: "user_a",
    status: "RUNNING",
    currentStep: 2,
    finalResponse: null,
    errorMessage: null,
    terminalReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeExecution(overrides: Row = {}): Row {
  return {
    id: EXECUTION_ID,
    sessionId: SESSION_ID,
    toolCallId: "call_1",
    toolName: "createTask",
    input: { title: "Fix login", projectName: "Web" },
    status: "PENDING_CONFIRMATION",
    error: null,
    confirmedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function confirm(
  sessionId = SESSION_ID,
  executionId = EXECUTION_ID,
) {
  return confirmPost(new Request("http://localhost"), {
    params: Promise.resolve({ sessionId, executionId }),
  });
}

function cancel(
  sessionId = SESSION_ID,
  executionId = EXECUTION_ID,
) {
  return cancelPost(new Request("http://localhost"), {
    params: Promise.resolve({ sessionId, executionId }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // These tests are only meaningful if the double honours the CAS `where`
  // clause, so any stub left over from a previous test is reinstalled first.
  restorePrismaDouble();
  resetStore();
  store.sessions = [makeSession()];
  store.executions = [makeExecution()];
  store.messages = [];
  authMock.mockResolvedValue({ user: { id: "user_a" } } as never);
});

describe("authentication", () => {
  it("rejects an unauthenticated confirm with 401", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await confirm();

    expect(res.status).toBe(401);
    expect(prismaDouble.agentToolExecution.updateMany).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated cancel with 401", async () => {
    authMock.mockResolvedValue(null as never);

    const res = await cancel();

    expect(res.status).toBe(401);
    expect(store.executions[0].status).toBe("PENDING_CONFIRMATION");
  });
});

describe("ownership and binding", () => {
  it("returns 404 when the session belongs to another user", async () => {
    store.sessions = [makeSession({ userId: "user_b" })];

    const res = await confirm();

    expect(res.status).toBe(404);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the execution belongs to a different session", async () => {
    // The attacker owns the session in the URL; the execution id is someone
    // else's. Binding execution to session is what stops this.
    store.sessions = [makeSession(), makeSession({ id: OTHER_SESSION_ID })];
    store.executions = [
      makeExecution({ sessionId: OTHER_SESSION_ID }),
    ];

    const res = await confirm(SESSION_ID, EXECUTION_ID);

    expect(res.status).toBe(404);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("does not reveal whether an execution id exists elsewhere", async () => {
    store.sessions = [makeSession()];
    store.executions = [];

    const res = await confirm();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });
});

describe("terminal session protection", () => {
  it("refuses to confirm on a completed session", async () => {
    store.sessions = [makeSession({ status: "COMPLETED" })];

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(store.executions[0].status).toBe("PENDING_CONFIRMATION");
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("refuses to cancel on a failed session", async () => {
    store.sessions = [makeSession({ status: "FAILED" })];

    const res = await cancel();

    expect(res.status).toBe(409);
    expect(store.executions[0].status).toBe("PENDING_CONFIRMATION");
  });

  it("still reports the real state for an execution that already settled", async () => {
    // Ordering matters: an execution that already left the gate cannot be
    // changed by a dead session, so its outcome is reported rather than
    // masked by a SESSION_NOT_RUNNING the user cannot act on.
    store.sessions = [makeSession({ status: "COMPLETED" })];
    store.executions = [makeExecution({ status: "COMPLETED" })];

    const res = await confirm();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("COMPLETED");
    expect(body.idempotent).toBe(true);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("reports a cancelled execution as cancelled after the session ended", async () => {
    store.sessions = [makeSession({ status: "CANCELLED" })];
    store.executions = [makeExecution({ status: "CANCELLED" })];

    const res = await confirm();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_CANCELLED");
  });
});

describe("decideConfirmation", () => {
  // The real function, not a mock: the ordering rule is the thing under test.
  it("dispatches only an undecided proposal on a live session", () => {
    expect(
      decideConfirmation({
        action: "confirm",
        executionStatus: "PENDING_CONFIRMATION",
        sessionStatus: "RUNNING",
      }),
    ).toEqual({ kind: "TRANSITION" });
  });

  it("refuses an undecided proposal once the session ended", () => {
    const decision = decideConfirmation({
      action: "cancel",
      executionStatus: "PENDING_CONFIRMATION",
      sessionStatus: "COMPLETED",
    });

    expect(decision).toMatchObject({ kind: "CONFLICT" });
  });

  it("is idempotent for a repeat confirm regardless of session status", () => {
    for (const sessionStatus of ["RUNNING", "COMPLETED", "FAILED"] as const) {
      expect(
        decideConfirmation({
          action: "confirm",
          executionStatus: "COMPLETED",
          sessionStatus,
        }),
      ).toEqual({ kind: "IDEMPOTENT" });
    }
  });

  it("never confirms a cancelled execution", () => {
    expect(
      decideConfirmation({
        action: "confirm",
        executionStatus: "CANCELLED",
        sessionStatus: "RUNNING",
      }),
    ).toMatchObject({ kind: "CONFLICT", code: "ALREADY_CANCELLED" });
  });

  it("cannot cancel work that is already under way", () => {
    expect(
      decideConfirmation({
        action: "cancel",
        executionStatus: "RUNNING",
        sessionStatus: "RUNNING",
      }),
    ).toMatchObject({ kind: "CONFLICT", code: "NOT_CANCELLABLE" });
  });
});

describe("confirm", () => {
  it("promotes a proposal to PENDING and dispatches exactly the stored row", async () => {
    const res = await confirm();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("PENDING");
    expect(store.executions[0].status).toBe("PENDING");
    expect(store.executions[0].confirmedAt).toBeInstanceOf(Date);

    // The dispatch is no longer a direct publish. Confirming writes the intent
    // to the transactional outbox in the SAME transaction as the state
    // transition, so a crash cannot leave an approved action with nothing to
    // execute it. The outbox dispatcher publishes later.
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      idempotencyKey: `AGENT_TOOL_EXECUTION_REQUESTED:${EXECUTION_ID}`,
      status: "PENDING",
    });
    expect(store.outbox[0].payload).toEqual({
      orgId: "org_1",
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      expectedStep: 2,
    });
  });

  it("accepts no body and never forwards tool arguments", async () => {
    await confirm();

    // The recorded dispatch payload carries ids and the claimed step only.
    // Arguments live on the execution row, so there is no channel through this
    // path to substitute what the user approved.
    const payload = store.outbox[0].payload as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "executionId",
      "expectedStep",
      "orgId",
      "sessionId",
    ]);
  });

  it("is idempotent and does not re-dispatch an already confirmed execution", async () => {
    await confirm();

    // The first confirm is the one that records the dispatch intent.
    const firstOutboxCount = store.outbox.length;
    expect(firstOutboxCount).toBe(1);

    const res = await confirm();

    expect(res.status).toBe(200);
    // The confirm short-circuits before any transition, so no second intent is
    // recorded for an execution that is already dispatched.
    expect(store.outbox).toHaveLength(firstOutboxCount);
  });

  it("refuses to confirm a cancelled execution", async () => {
    store.executions = [
      makeExecution({ status: "CANCELLED", cancelledAt: new Date() }),
    ];

    const res = await confirm();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe("ALREADY_CANCELLED");
    expect(store.outbox).toHaveLength(0);
  });

  it("refuses to confirm an expired execution and schedules nothing", async () => {
    store.executions = [
      makeExecution({
        status: "EXPIRED",
        expiredAt: new Date(),
        error: "APPROVAL_TIMEOUT",
      }),
    ];

    const res = await confirm();
    const body = (await res.json()) as Record<string, unknown>;

    // 200 + idempotent, not 409: the outcome is settled and reporting it
    // truthfully is more useful than reporting an error that implies the user
    // did something wrong by being late.
    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.status).toBe("EXPIRED");
    expect(store.outbox).toHaveLength(0);
    expect(store.executions[0].status).toBe("EXPIRED");
  });

  it("returns 409 when a concurrent request wins the compare-and-set", async () => {
    prismaDouble.agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const res = await confirm();

    expect(res.status).toBe(409);
    // The CAS lost, so the dispatch intent must not have been recorded either.
    expect(store.outbox).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("cancels the proposal and re-drives the loop with a decline result", async () => {
    const res = await cancel();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe("CANCELLED");
    expect(store.executions[0].status).toBe("CANCELLED");
    expect(store.executions[0].cancelledAt).toBeInstanceOf(Date);

    // The transcript must not be left holding an unanswered tool call.
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].toolCallId).toBe("call_1");

    // The loop re-drive is a durable outbox intent written in the same
    // transaction as the cancellation, not a direct publish.
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      eventType: "AGENT_LOOP_REQUESTED",
      status: "PENDING",
      sessionId: SESSION_ID,
      executionId: EXECUTION_ID,
      payload: { orgId: "org_1", sessionId: SESSION_ID, expectedStep: 2 },
    });
  });

  it("records the decline and the continuation in one transaction", async () => {
    // The cancellation, the transcript entry and the intent must be enclosed by
    // a single transaction. Enclosure is what is asserted: the in-memory double
    // has no rollback, so it cannot demonstrate that a mid-transaction failure
    // undoes the earlier write. That is a real-database property, covered by
    // the migration and live verification.
    prismaDouble.$transaction.mockClear();

    await cancel();

    expect(prismaDouble.$transaction).toHaveBeenCalledTimes(1);
    expect(store.executions[0].status).toBe("CANCELLED");
    expect(store.messages).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
  });

  it("records nothing when the cancellation loses its CAS", async () => {
    // A confirm that already dispatched the execution must not also leave a
    // decline in the transcript, because the model would see the action as both
    // approved and refused.
    prismaDouble.agentToolExecution.updateMany.mockResolvedValueOnce({
      count: 0,
    });

    const res = await cancel();

    expect(res.status).toBe(409);
    expect(store.messages).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it("is idempotent for an already cancelled execution", async () => {
    await cancel();
    publishEventMock.mockClear();

    const res = await cancel();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(1);
  });

  it("cannot cancel an expired execution back to life", async () => {
    store.executions = [
      makeExecution({
        status: "EXPIRED",
        expiredAt: new Date(),
        error: "APPROVAL_TIMEOUT",
      }),
    ];

    const res = await cancel();
    const body = (await res.json()) as Record<string, unknown>;

    // 200 + idempotent: EXPIRED is already settled, so there is nothing to
    // cancel and nothing to undo. Reporting a conflict here would imply the
    // system timed out because of a cancellation that never happened.
    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.status).toBe("EXPIRED");
    expect(store.executions[0].status).toBe("EXPIRED");
    // No continuation: the session was already re-driven when it expired.
    expect(store.messages).toHaveLength(0);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("cannot cancel an execution that already ran", async () => {
    store.executions = [makeExecution({ status: "COMPLETED" })];

    const res = await cancel();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe("NOT_CANCELLABLE");
  });

  it("cannot cancel an execution that is already dispatched", async () => {
    store.executions = [makeExecution({ status: "PENDING" })];

    const res = await cancel();

    expect(res.status).toBe(409);
  });

  it("cannot cancel an execution already in flight", async () => {
    store.executions = [makeExecution({ status: "RUNNING" })];

    const res = await cancel();

    expect(res.status).toBe(409);
  });
});

describe("published status", () => {
  it("announces the proposal outcome to the client channel", async () => {
    await cancel();

    expect(publishStatusMock).toHaveBeenCalledWith(SESSION_ID, {
      type: "TOOL_CANCELLED",
      executionId: EXECUTION_ID,
      toolName: "createTask",
    });
  });

  it("announces confirmation before dispatch", async () => {
    await confirm();

    expect(publishStatusMock).toHaveBeenCalledWith(SESSION_ID, {
      type: "TOOL_CONFIRMED",
      executionId: EXECUTION_ID,
      toolName: "createTask",
    });
  });
});
