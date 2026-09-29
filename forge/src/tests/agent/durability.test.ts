// src/tests/agent/durability.test.ts
//
// Lock heartbeat and orphaned-execution recovery.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/redis/client", () => ({
  redis: { set: jest.fn(), eval: jest.fn() },
}));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/ai/agent/status", () => ({
  publishAgentStatus: jest.fn(),
}));

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

import { redis } from "@/lib/redis/client";
import { publishEvent } from "@/lib/events/queue";
import { publishAgentStatus } from "@/lib/ai/agent/status";
import { prismaDouble, resetStore, restorePrismaDouble, store } from "./helpers/prisma-double";
import { withToolExecutionLock } from "@/lib/ai/agent/locks";
import {
  reapOrphanedToolExecutions,
  redriveStalledSessions,
} from "@/lib/ai/agent/reaper";
import {
  abandonToolExecution,
  heartbeatToolExecution,
} from "@/lib/ai/agent/services/tool-execution-service";

const redisMock = redis as unknown as {
  set: jest.Mock;
  eval: jest.Mock;
};
const publishEventMock = publishEvent as jest.MockedFunction<
  typeof publishEvent
>;
const publishStatusMock =
  publishAgentStatus as jest.MockedFunction<typeof publishAgentStatus>;
const prisma = prismaDouble as unknown as {
  agentToolExecution: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  agentSession: {
    updateMany: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  redisMock.set.mockResolvedValue("OK");
  redisMock.eval.mockResolvedValue(1);
});

describe("lock heartbeat", () => {
  it("renews the lock while the callback is still running", async () => {
    jest.useFakeTimers();

    let release: (() => void) | undefined;

    const work = withToolExecutionLock("exec_1", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });

      return "done";
    });

    try {
      // Let the lock be acquired and the heartbeat armed. Microtasks are not
      // faked, so this flushes the acquisition without skipping past it.
      await jest.advanceTimersByTimeAsync(0);
      expect(redisMock.eval).not.toHaveBeenCalled();

      // Cross one heartbeat interval while the work is still in flight.
      await jest.advanceTimersByTimeAsync(10_000);

      // The renewal script is identified by carrying a numeric TTL argument,
      // which the release script does not.
      const renewals = redisMock.eval.mock.calls.filter(
        (call) => typeof call[2]?.[1] === "string",
      );

      expect(renewals.length).toBeGreaterThanOrEqual(1);

      release?.();
      await jest.advanceTimersByTimeAsync(0);

      await expect(work).resolves.toBe("done");
    } finally {
      jest.useRealTimers();
    }
  });

  it("guards renewal on still owning the lock", async () => {
    // The renewal script must re-check the token before extending the TTL.
    // A blind PEXPIRE would extend a lock another worker already re-acquired,
    // locking that worker out of its own lock.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        require.resolve("@/lib/ai/agent/locks"),
        "utf8",
      ) as string,
    );

    const renewScript = source
      .split("const renewLockScript = `")[1]
      ?.split("`")[0];

    expect(renewScript).toContain('redis.call("GET", KEYS[1]) == ARGV[1]');
    expect(renewScript).toContain("PEXPIRE");
    expect(
      renewScript!.indexOf("GET"),
    ).toBeLessThan(renewScript!.indexOf("PEXPIRE"));
  });

  it("releases only with the matching token", async () => {
    await withToolExecutionLock("exec_1", async () => "done");

    const releaseCall = redisMock.eval.mock.calls.at(-1)!;

    expect(releaseCall[1]).toHaveLength(1);
    expect(releaseCall[2]).toHaveLength(1);
  });

  it("does not run the callback when the lock is already held", async () => {
    redisMock.set.mockResolvedValue(null);

    const callback = jest.fn();

    await expect(
      withToolExecutionLock("exec_1", callback),
    ).resolves.toBeNull();
    expect(callback).not.toHaveBeenCalled();
  });

  it("still releases when the callback throws", async () => {
    await expect(
      withToolExecutionLock("exec_1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(redisMock.eval).toHaveBeenCalled();
  });
});

describe("reaper", () => {
  it("fails a session stranded by an execution stuck in RUNNING", async () => {
    const cutoff = new Date("2026-09-29T00:00:00.000Z");

    prisma.agentToolExecution.findMany.mockResolvedValue([
      { id: "exec_1", sessionId: "sess_1", session: { id: "sess_1" } },
    ]);
    prisma.agentToolExecution.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentSession.updateMany.mockResolvedValue({ count: 1 });

    const result = await reapOrphanedToolExecutions({ now: cutoff });

    expect(result.sessionIds).toEqual(["sess_1"]);
    expect(publishStatusMock).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({ type: "FAILED" }),
    );
  });

  it("skips an execution that a live worker still owns", async () => {
    prisma.agentToolExecution.findMany.mockResolvedValue([
      { id: "exec_1", sessionId: "sess_1", session: { id: "sess_1" } },
    ]);
    // The CAS from RUNNING matched nothing: the worker finished in between.
    prisma.agentToolExecution.updateMany.mockResolvedValue({ count: 0 });

    const result = await reapOrphanedToolExecutions();

    expect(result.sessionIds).toEqual([]);
    expect(prisma.agentSession.updateMany).not.toHaveBeenCalled();
    expect(publishStatusMock).not.toHaveBeenCalled();
  });

  it("only selects executions that are RUNNING, stale and on a live session", async () => {
    prisma.agentToolExecution.findMany.mockResolvedValue([]);

    await reapOrphanedToolExecutions({
      now: new Date("2026-09-29T00:00:00.000Z"),
    });

    expect(prisma.agentToolExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "RUNNING",
          session: { status: "RUNNING" },
        }),
      }),
    );
  });

  it("re-records a confirmed execution that was never picked up", async () => {
    prisma.agentToolExecution.findMany.mockResolvedValue([
      {
        id: "exec_1",
        sessionId: "sess_1",
        session: { orgId: "org_1", currentStep: 3 },
      },
    ]);

    await (
      await import("@/lib/ai/agent/reaper")
    ).redeliverStalledConfirmedExecutions();

    // A durable outbox intent, not a direct publish. Publishing directly here
    // would be the sweep doing the dispatcher's job without the durability,
    // which is exactly the crash-window the outbox exists to close.
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
      sessionId: "sess_1",
      executionId: "exec_1",
      payload: {
        orgId: "org_1",
        sessionId: "sess_1",
        executionId: "exec_1",
        expectedStep: 3,
      },
    });
  });

  it("does not resurrect an already-delivered intent on redelivery", async () => {
    // The normal path already recorded this event when the execution was
    // confirmed. The sweep must collapse onto the existing row rather than
    // queueing a second event or resetting a delivered one to PENDING.
    store.outbox = [
      {
        id: "outbox_1",
        eventType: "AGENT_TOOL_EXECUTION_REQUESTED",
        idempotencyKey: "AGENT_TOOL_EXECUTION_REQUESTED:exec_1",
        messageId: "agent-outbox-1",
        sessionId: "sess_1",
        executionId: "exec_1",
        payload: {},
        status: "PUBLISHED",
        attempts: 1,
        availableAt: new Date(),
        createdAt: new Date(),
        publishedAt: new Date(),
        lastError: null,
      },
    ];

    prisma.agentToolExecution.findMany.mockResolvedValue([
      {
        id: "exec_1",
        sessionId: "sess_1",
        session: { orgId: "org_1", currentStep: 3 },
      },
    ]);

    await (
      await import("@/lib/ai/agent/reaper")
    ).redeliverStalledConfirmedExecutions();

    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].status).toBe("PUBLISHED");
  });

  it("re-checks staleness in the compare-and-set, not only in the read", async () => {
    // The read-then-write gap is the window this sweep is most likely to run
    // in. If the CAS drops the staleness predicate, a heartbeat that lands
    // between the two calls is overwritten and a live execution is cancelled.
    const cutoff = new Date("2026-09-29T00:00:00.000Z");

    prisma.agentToolExecution.findMany.mockResolvedValue([
      { id: "exec_1", sessionId: "sess_1", session: { id: "sess_1" } },
    ]);
    prisma.agentToolExecution.updateMany.mockResolvedValue({ count: 1 });
    prisma.agentSession.updateMany.mockResolvedValue({ count: 1 });

    await reapOrphanedToolExecutions({ now: cutoff });

    expect(prisma.agentToolExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "exec_1",
          status: "RUNNING",
          updatedAt: { lt: new Date(cutoff.getTime() - 10 * 60_000) },
        }),
      }),
    );
  });

  it("reports only the executions it actually cancelled", async () => {
    prisma.agentToolExecution.findMany.mockResolvedValue([
      { id: "exec_1", sessionId: "sess_1", session: { id: "sess_1" } },
      { id: "exec_2", sessionId: "sess_2", session: { id: "sess_2" } },
    ]);
    // Only the first one survives the CAS; the second was heartbeated.
    prisma.agentToolExecution.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.agentToolExecution.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.agentSession.updateMany.mockResolvedValue({ count: 1 });

    const result = await reapOrphanedToolExecutions();

    // Reporting the row count would claim a cancellation that never happened.
    expect(result.swept).toBe(1);
    expect(result.sessionIds).toEqual(["sess_1"]);
  });
});

describe("execution liveness", () => {
  beforeEach(() => {
    // These tests depend on the double actually honouring the CAS `where`
    // clause, which the reaper tests above deliberately stub out.
    restorePrismaDouble();
    resetStore();
  });

  it("closes out a RUNNING row the worker itself claimed", async () => {
    // The worker claims the row before it discovers the session is terminal.
    // If the abandon CAS could not match RUNNING, nothing else ever would:
    // the event is acknowledged and no reaper sweeps this state.
    store.executions = [
      { id: "exec_1", status: "RUNNING", updatedAt: new Date() },
    ];

    await expect(abandonToolExecution("exec_1", "session ended")).resolves.toBe(
      true,
    );
    expect(store.executions[0].status).toBe("CANCELLED");
  });

  it("never overwrites a completed result", async () => {
    store.executions = [
      { id: "exec_1", status: "COMPLETED", updatedAt: new Date() },
    ];

    await expect(abandonToolExecution("exec_1", "late")).resolves.toBe(false);
    expect(store.executions[0].status).toBe("COMPLETED");
  });

  it("heartbeats only while the row is still RUNNING", async () => {
    store.executions = [
      { id: "exec_1", status: "RUNNING", updatedAt: new Date(0) },
    ];

    await expect(heartbeatToolExecution("exec_1")).resolves.toBe(true);
    expect(
      (store.executions[0].updatedAt as Date).getTime(),
    ).toBeGreaterThan(0);
  });

  it("reports a heartbeat that lost the row, so a reaped worker can tell", async () => {
    store.executions = [
      { id: "exec_1", status: "CANCELLED", updatedAt: new Date(0) },
    ];

    await expect(heartbeatToolExecution("exec_1")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stalled session recovery
// ---------------------------------------------------------------------------
//
// The gap the execution reaper structurally cannot cover: a session that is
// RUNNING, has no tool execution at all, and is not going to get one because the
// AGENT_LOOP_REQUESTED that should have driven it was published and then lost.
// There is no orphaned row to sweep and no approval window to close, so without a
// duty of its own the session simply hangs forever.
//
// These tests deliberately use the REAL double rather than stubbing the queries.
// A stubbed `findMany` would return the session it was told to return, so "a
// session with a live execution is skipped" would pass because the row was
// handed over rather than because the predicate excluded it - and the predicate
// is the entire safety argument.

const STALE_AT = new Date("2026-09-29T00:00:00.000Z");
const OLD = new Date(STALE_AT.getTime() - 60 * 60_000);
const FRESH = new Date(STALE_AT.getTime() - 60_000);

function stageSession(overrides: Record<string, unknown> = {}) {
  store.sessions.push({
    id: "sess_1",
    orgId: "org_1",
    userId: "user_1",
    status: "RUNNING",
    currentStep: 0,
    finalResponse: null,
    errorMessage: null,
    terminalReason: null,
    promptVersion: "v1",
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  });
}

function stageExecution(
  sessionId: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  store.executions.push({
    id: `exec_${store.executions.length + 1}`,
    sessionId,
    status,
    toolCallId: `call_${store.executions.length + 1}`,
    toolName: "createTask",
    updatedAt: OLD,
    ...overrides,
  });
}

function stageRedriveRow({
  status,
  attempts,
}: {
  status: string;
  attempts: number;
}) {
  store.outbox.push({
    id: "outbox_redrive",
    eventType: "AGENT_LOOP_REQUESTED",
    // The key recovery uses for (session, step). Staging it is what makes this
    // a repeat sweep rather than a first one.
    idempotencyKey: "AGENT_LOOP_REQUESTED:sess_1#redrive#0",
    messageId: "agent-outbox-redrive",
    sessionId: "sess_1",
    executionId: null,
    payload: {
      orgId: "org_1",
      sessionId: "sess_1",
      expectedStep: 0,
    },
    status,
    attempts,
    availableAt: new Date(0),
    createdAt: new Date(0),
    publishedAt: status === "PUBLISHED" ? new Date(0) : null,
    lastError: null,
  });
}

describe("stalled session recovery", () => {
  beforeEach(() => {
    restorePrismaDouble();
    resetStore();
    redisMock.set.mockResolvedValue("OK");
  });

  it("re-drives a stale session that has no in-flight execution", async () => {
    stageSession();

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(1);
    expect(result.queued).toBe(1);
    expect(result.sessionIds).toEqual(["sess_1"]);
    expect(result.skippedLocked).toBe(0);
    expect(result.skippedStale).toBe(0);

    // A durable outbox intent, not a direct publish. The re-driven turn is
    // delivered by the same dispatcher and claimed by the same CAS as any other
    // turn; a direct publish here would be a second execution path.
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]).toMatchObject({
      eventType: "AGENT_LOOP_REQUESTED",
      sessionId: "sess_1",
      status: "PENDING",
      payload: {
        orgId: "org_1",
        sessionId: "sess_1",
        expectedStep: 0,
      },
    });
  });

  it("leaves a session that is not yet stale alone", async () => {
    // `updatedAt` is a pre-filter, not a verdict. A pass that treated it as one
    // would re-drive every session that happened to be mid-turn.
    stageSession({ updatedAt: FRESH });

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(0);
    expect(result.scanned).toBe(0);
    expect(store.outbox).toHaveLength(0);
  });

  it.each([
    ["PENDING", "queued but not started"],
    ["RUNNING", "a live worker owns it"],
    ["PENDING_CONFIRMATION", "parked waiting for a human"],
  ])("leaves a session with a %s execution alone (%s)", async (status) => {
    // PENDING_CONFIRMATION is the one that matters most: a session awaiting
    // approval is still status RUNNING, so a predicate that only excluded
    // PENDING and RUNNING would drag the model back into a turn the user has
    // not approved.
    stageSession();
    stageExecution("sess_1", status);

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(0);
    expect(result.skippedStale).toBe(0);
    expect(store.outbox).toHaveLength(0);
  });

  it("still re-drives a session whose executions are all terminal", async () => {
    // A tool call that was never followed by a loop continuation is exactly the
    // stall this duty exists for, so a COMPLETED execution must not veto it.
    stageSession();
    stageExecution("sess_1", "COMPLETED");

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(1);
    expect(store.outbox).toHaveLength(1);
  });

  it("does not queue a second event while the first is still undelivered", async () => {
    stageSession();

    await redriveStalledSessions({ now: STALE_AT });
    const second = await redriveStalledSessions({ now: STALE_AT });

    // The re-drive key is unique per (session, step) and the row is still
    // PENDING, so a sweep that keeps finding the same stuck session neither
    // queues a second turn nor re-queues the one already owed. A delivery
    // pending every five minutes is the broker's job, not this duty's.
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].status).toBe("PENDING");
    expect(store.outbox[0].attempts).toBe(0);
    expect(second.rearmed).toBe(0);
    expect(second.queued).toBe(1);
  });

  it("re-arms a re-drive that was already delivered but never acted on", async () => {
    // This is the live failure: the re-drive was published, the consumer refused
    // it because it lost a race for the session lock, and the session is still
    // sitting at the same step. Without a re-arm the row is PUBLISHED forever,
    // every later sweep collapses onto it, and the session is stranded for good.
    stageSession();
    stageRedriveRow({ status: "PUBLISHED", attempts: 1 });

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.rearmed).toBe(1);
    expect(result.queued).toBe(0);
    // Re-armed in place, not replaced: still one row, back in the queue, with the
    // attempt recorded so the cap can eventually stop it.
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].status).toBe("PENDING");
    expect(store.outbox[0].attempts).toBe(2);
  });

  it("fails the session instead of re-driving it once the attempt cap is reached", async () => {
    // A session that cannot advance after the allowed number of deliveries is
    // broken in a way re-driving cannot fix. Terminating it is honest; retrying
    // forever would leave the user watching a spinner that never resolves.
    stageSession();
    stageRedriveRow({ status: "PUBLISHED", attempts: 3 });

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.exhausted).toBe(1);
    expect(result.redriven).toBe(0);
    expect(result.failedSessionIds).toEqual(["sess_1"]);
    expect(store.sessions[0].status).toBe("FAILED");
    expect(store.sessions[0].terminalReason).toBe("ERROR");
    expect(String(store.sessions[0].errorMessage)).toContain("sess_1");
    // Not re-queued: the whole point of the cap is that this is the last one.
    expect(store.outbox[0].status).toBe("PUBLISHED");
    expect(publishStatusMock).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({ type: "FAILED" }),
    );
  });

  it("does not report a session it merely skipped as failed", async () => {
    stageSession();
    stageRedriveRow({ status: "PUBLISHED", attempts: 1 });
    redisMock.set.mockResolvedValue(null);

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.skippedLocked).toBe(1);
    expect(result.exhausted).toBe(0);
    expect(result.failedSessionIds).toEqual([]);
    expect(store.sessions[0].status).toBe("RUNNING");
  });

  it("uses a different re-drive key once the step has advanced", async () => {
    // Per-step, not per-session: a session that stalls again on a later step must
    // be able to be repaired again.
    stageSession();

    await redriveStalledSessions({ now: STALE_AT });
    (store.sessions[0] as Record<string, unknown>).currentStep = 1;
    (store.sessions[0] as Record<string, unknown>).updatedAt = OLD;
    await redriveStalledSessions({ now: STALE_AT });

    expect(store.outbox).toHaveLength(2);
    expect(store.outbox[1]).toMatchObject({ payload: { expectedStep: 1 } });
    expect(store.outbox[0].idempotencyKey).not.toBe(
      store.outbox[1].idempotencyKey,
    );
  });

  it("skips a session whose lock is held, because a worker is mid-turn", async () => {
    // The session lock is the authoritative liveness signal. `updatedAt` cannot
    // be: it only moves when a step is claimed, so a healthy worker in a long
    // Gemini turn is indistinguishable from a dead one by timestamp alone.
    stageSession();
    redisMock.set.mockResolvedValue(null);

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(0);
    expect(result.skippedLocked).toBe(1);
    expect(store.outbox).toHaveLength(0);
    // The callback must not have run, so nothing was re-read or re-driven.
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("skips a session that moved on between the scan and the lock", async () => {
    // The window between the candidate scan and lock acquisition is exactly where
    // a worker could have claimed a step. Re-driving on the pre-lock read would
    // race that turn, which is why the re-read is the authoritative check.
    stageSession();
    prisma.agentSession.findUnique.mockResolvedValueOnce({
      ...(store.sessions[0] as Record<string, unknown>),
      currentStep: 1,
      updatedAt: FRESH,
    });

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(0);
    expect(result.skippedStale).toBe(1);
    expect(store.outbox).toHaveLength(0);
  });

  it("skips a session that reached a terminal state between the scan and the lock", async () => {
    stageSession();
    prisma.agentSession.findUnique.mockResolvedValueOnce({
      ...(store.sessions[0] as Record<string, unknown>),
      status: "COMPLETED",
    });

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(0);
    expect(result.skippedStale).toBe(1);
    expect(store.outbox).toHaveLength(0);
  });

  it("skips a session that acquired an execution between the scan and the lock", async () => {
    // The candidate scan runs against an empty execution table, so the session
    // qualifies. Then the worker finishes its tool call while this pass waits for
    // the lock, and the re-read under the lock is what catches it.
    stageSession();
    prisma.agentToolExecution.count.mockResolvedValueOnce(1);

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(result.redriven).toBe(0);
    expect(result.skippedStale).toBe(1);
    expect(store.outbox).toHaveLength(0);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED", "WAITING_CONFIRMATION"])(
    "never re-drives a %s session",
    async (status) => {
      // A session that has ended has no turn left to continue, and one waiting
      // on a human is owned by the approval sweep, not by this duty.
      stageSession({ status });

      const result = await redriveStalledSessions({ now: STALE_AT });

      expect(result.redriven).toBe(0);
      expect(result.scanned).toBe(0);
      expect(store.outbox).toHaveLength(0);
    },
  );

  it("bounds and orders the candidate scan", async () => {
    stageSession({ id: "sess_old", updatedAt: OLD });
    stageSession({ id: "sess_new", updatedAt: new Date(OLD.getTime() + 1000) });

    const result = await redriveStalledSessions({ now: STALE_AT, limit: 1 });

    expect(result.scanned).toBe(1);
    expect(result.sessionIds).toEqual(["sess_old"]);
  });

  it("returns the same shape as the other duties so the pass can report it", async () => {
    stageSession();

    const result = await redriveStalledSessions({ now: STALE_AT });

    expect(Object.keys(result).sort()).toEqual([
      "durationMs",
      "exhausted",
      "failedSessionIds",
      "queued",
      "rearmed",
      "redriven",
      "scanned",
      "sessionIds",
      "skippedLocked",
      "skippedStale",
    ]);
  });
});
