// src/tests/workflow/evaluator-failure.test.ts
//
// What happens when the evaluator cannot do its job.
//
// The distinction this file exists to protect: a lock another worker holds is
// COORDINATION, and a Redis connection that is down is a FAULT. Both mean "I did
// not advance the run", and conflating them is how a run gets left with nobody
// looking after it - the code that should have reported a failure instead reports
// "someone else is on it" and schedules nothing.
//
// The three states the evaluator can be in, and what each owes the caller:
//
//   fault      throw, so the worker answers 5xx and QStash redelivers
//   contention resolve, having scheduled a durable re-entry
//   lock lost  resolve, having scheduled nothing further, loudly

jest.mock("server-only", () => ({}));

jest.mock("@/lib/events/queue", () => ({ publishEvent: jest.fn() }));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

jest.mock("@/lib/redis/client", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { redisDouble } = require("./helpers/redis-double");
  return { redis: redisDouble };
});

import { publishEvent } from "@/lib/events/queue";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import {
  holdLock,
  isLocked,
  redisDouble,
  resetRedisDouble,
} from "./helpers/redis-double";
import {
  prismaDouble,
  resetStore,
  restoreWorkflowDouble,
  store,
} from "./helpers/prisma-double";

const publishEventMock = publishEvent as jest.MockedFunction<typeof publishEvent>;

const RUN_ID = "run_1";
const LOCK_KEY = `run_lock:${RUN_ID}`;

const DEFINITION = {
  id: "definition_1",
  name: "linear",
  steps: {
    a: {
      id: "a",
      action: "task.create",
      dependsOn: [],
      kind: "ACTION",
      config: {},
      isCritical: false,
    },
  },
};

function seedRun() {
  resetStore();
  resetRedisDouble();

  store.workflows.push({
    id: "wf_1",
    name: "linear",
    definition: DEFINITION,
    orgId: "org_1",
    eventId: null,
  });

  store.runs.push({
    id: RUN_ID,
    workflowId: "wf_1",
    status: "RUNNING",
    context: {},
    contextVersion: 0,
    lastAdvancedAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
  resetRedisDouble();
  publishEventMock.mockResolvedValue(undefined as never);
});

// ---------------------------------------------------------------------------
// Infrastructure faults propagate
// ---------------------------------------------------------------------------

describe("advanceWorkflow: infrastructure faults", () => {
  it("propagates a Redis failure during lock acquisition", async () => {
    // Before the fix, `acquireLock` sat outside the evaluator's try block, so
    // this rejected out of the function while the catch - which only logged -
    // could never see it. The caller's `.catch(console.error)` turned it into a
    // 200 and the run was never looked at again.
    seedRun();
    redisDouble.set.mockRejectedValueOnce(new Error("redis unreachable"));

    await expect(advanceWorkflow(RUN_ID)).rejects.toThrow(
      /Failed to acquire the run lock/i,
    );
  });

  it("does not report a Redis fault as contention", async () => {
    seedRun();
    redisDouble.set.mockRejectedValueOnce(new Error("redis unreachable"));

    await expect(advanceWorkflow(RUN_ID)).rejects.toThrow();

    // The critical part: nothing was scheduled, because nothing was owned. A
    // re-entry publish here would paper over a fault with a 5s delay and hide it.
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("propagates a publish failure while dispatching steps", async () => {
    // A step row created but never published is the worst outcome available:
    // it is PENDING, so every later pass skips it as "already decided", and the
    // action will never run.
    seedRun();
    publishEventMock.mockRejectedValueOnce(new Error("qstash rejected"));

    await expect(advanceWorkflow(RUN_ID)).rejects.toThrow("qstash rejected");
  });

  it("releases the lock when a pass throws", async () => {
    seedRun();
    publishEventMock.mockRejectedValueOnce(new Error("qstash rejected"));

    await expect(advanceWorkflow(RUN_ID)).rejects.toThrow();

    // A lock leaked by a failed pass blocks every later pass until its TTL
    // lapses, so the whole run stalls behind one transient fault.
    expect(isLocked(LOCK_KEY)).toBe(false);
  });

  it("propagates a missing run rather than reporting nothing to do", async () => {
    resetStore();
    resetRedisDouble();

    await expect(advanceWorkflow("run_missing")).rejects.toThrow(
      /WorkflowRun not found/i,
    );
    expect(isLocked(LOCK_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contention is coordination, not failure
// ---------------------------------------------------------------------------

describe("advanceWorkflow: lock contention", () => {
  it("schedules a re-entry and resolves rather than throwing", async () => {
    seedRun();
    holdLock(LOCK_KEY);

    await expect(advanceWorkflow(RUN_ID)).resolves.toBe("CONTENDED");
  });

  it("propagates a failure to schedule the re-entry", async () => {
    // Contention is only safe to report as success when a re-entry really was
    // scheduled. If the publish fails, nothing is looking after this run, and a
    // 200 would tell QStash to delete the only remaining copy of the intent.
    seedRun();
    holdLock(LOCK_KEY);
    publishEventMock.mockRejectedValueOnce(new Error("qstash rejected"));

    await expect(advanceWorkflow(RUN_ID)).rejects.toThrow("qstash rejected");
  });

  it("leaves the held lock untouched", async () => {
    seedRun();
    holdLock(LOCK_KEY, "the-real-owner");

    await advanceWorkflow(RUN_ID);

    expect(isLocked(LOCK_KEY)).toBe(true);
    expect(redisDouble.eval).not.toHaveBeenCalled();
  });

  it("uses a deduplication id so repeated contention does not pile up messages", async () => {
    seedRun();
    holdLock(LOCK_KEY);

    await advanceWorkflow(RUN_ID);
    await advanceWorkflow(RUN_ID);
    await advanceWorkflow(RUN_ID);

    const ids = publishEventMock.mock.calls.map((call) => call[3]?.deduplicationId);
    expect(new Set(ids).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lock lifetime
// ---------------------------------------------------------------------------

describe("workflow run lock", () => {
  /**
   * Block the evaluator inside its work so the clock can be moved while it is
   * genuinely mid-pass. Gating `publishEvent` is the natural seam: it is the
   * network call the dispatch loop makes, and the one the lock has to survive.
   *
   * The gate opens permanently rather than per-call, so the publishes that come
   * after it - the backstop in particular - resolve normally. A gate that
   * re-armed itself would leave the evaluator blocked on its own backstop and
   * the test would time out having proved nothing.
   */
  function blockPublish() {
    let isOpen = false;
    let signal: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      signal = resolve;
    });

    // The queue's real return value is a QStash receipt; the double only needs
    // to model resolution, so the cast carries no weight.
    const asPublishResult = (value: Promise<void>) =>
      value as unknown as ReturnType<typeof publishEvent>;

    publishEventMock.mockImplementation(() => {
      if (isOpen) return asPublishResult(Promise.resolve());
      return asPublishResult(gate);
    });

    return {
      open: () => {
        isOpen = true;
        signal();
      },
    };
  }

  it("renews the lock while a long pass is in flight", async () => {
    // The reason the heartbeat exists: dispatching is a network round trip per
    // step, and a flat 5s TTL lapses part way through, after which a second
    // evaluator starts and both write.
    jest.useFakeTimers();
    seedRun();

    const block = blockPublish();
    const inFlight = advanceWorkflow(RUN_ID);

    try {
      await jest.advanceTimersByTimeAsync(0);

      // Acquired, but the first heartbeat interval has not elapsed.
      expect(redisDouble.eval).not.toHaveBeenCalled();

      // Several TTLs pass with the pass still in flight.
      await jest.advanceTimersByTimeAsync(20_000);

      // A renewal is the eval carrying a numeric TTL argument; the release
      // script passes only the token.
      const renewals = redisDouble.eval.mock.calls.filter(
        (call) => typeof call[2]?.[1] === "string",
      );
      expect(renewals.length).toBeGreaterThanOrEqual(2);

      block.open();
      await inFlight;
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops scheduling work once the heartbeat reports ownership loss", async () => {
    jest.useFakeTimers();
    seedRun();

    const block = blockPublish();
    const inFlight = advanceWorkflow(RUN_ID);

    try {
      await jest.advanceTimersByTimeAsync(0);

      // The key changes hands mid-pass. Our token no longer matches, so the
      // compare-and-extend correctly refuses.
      holdLock(LOCK_KEY, "someone-else");
      await jest.advanceTimersByTimeAsync(2_000);

      block.open();
      const outcome = await inFlight;

      expect(outcome).toBe("LOCK_LOST");
    } finally {
      jest.useRealTimers();
    }
  });

  it("schedules no re-entry after losing the lock", async () => {
    // The observable consequence of LOCK_LOST. Once exclusivity is gone the
    // winner owns the run; arming a backstop from the loser would have two
    // evaluators scheduling work for the same run.
    jest.useFakeTimers();
    seedRun();

    const block = blockPublish();
    const inFlight = advanceWorkflow(RUN_ID);

    try {
      await jest.advanceTimersByTimeAsync(0);
      holdLock(LOCK_KEY, "someone-else");
      await jest.advanceTimersByTimeAsync(2_000);
      block.open();
      await inFlight;
    } finally {
      jest.useRealTimers();
    }

    const scheduled = publishEventMock.mock.calls.filter(
      ([name]) => name === "ADVANCE_WORKFLOW",
    );
    expect(scheduled).toHaveLength(0);
  });

  it("releases only its own lock", async () => {
    seedRun();

    await advanceWorkflow(RUN_ID);

    // The release is a compare-and-delete: one key, one token argument.
    const releaseCall = redisDouble.eval.mock.calls.at(-1)!;
    expect(releaseCall[1]).toHaveLength(1);
    expect(releaseCall[2]).toHaveLength(1);
  });

  it("does not dispatch a duplicate step when a pass is repeated", async () => {
    seedRun();

    await advanceWorkflow(RUN_ID);
    const createdAfterFirst = prismaDouble.stepRun.create.mock.calls.length;

    await advanceWorkflow(RUN_ID);

    expect(store.stepRuns.filter((row) => row.stepId === "a")).toHaveLength(1);
    expect(prismaDouble.stepRun.create.mock.calls.length).toBe(createdAfterFirst);
  });
});
