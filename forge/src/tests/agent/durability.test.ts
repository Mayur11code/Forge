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

import { redis } from "@/lib/redis/client";
import { publishEvent } from "@/lib/events/queue";
import { publishAgentStatus } from "@/lib/ai/agent/status";
import { prismaDouble, resetStore, restorePrismaDouble, store } from "./helpers/prisma-double";
import { withToolExecutionLock } from "@/lib/ai/agent/locks";
import { reapOrphanedToolExecutions } from "@/lib/ai/agent/reaper";
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
  agentToolExecution: { findMany: jest.Mock; updateMany: jest.Mock };
  agentSession: { updateMany: jest.Mock };
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

  it("re-publishes a confirmed execution that was never picked up", async () => {
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

    expect(publishEventMock).toHaveBeenCalledWith(
      "AGENT_TOOL_EXECUTION_REQUESTED",
      {
        orgId: "org_1",
        sessionId: "sess_1",
        executionId: "exec_1",
        expectedStep: 3,
      },
    );
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
