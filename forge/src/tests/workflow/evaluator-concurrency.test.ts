// src/tests/workflow/evaluator-concurrency.test.ts
//
// The evaluator's lost-wakeup race, and the guarantees that have to hold around it.
//
// The bug under test: when a worker cannot take the run lock it returns
// immediately, and nothing else ever looks at the run again. In a fan-out/fan-in
// graph that is terminal. Two branches A and B run in parallel. A finishes and
// its evaluator pass takes the lock, snapshots a state where B is still RUNNING,
// finds nothing to dispatch, and releases. B then finishes, calls the evaluator,
// and hits a lock that the A pass is still holding. That call is dropped on the
// floor. C is ready, and no process will ever look again.
//
// The fix is NOT "retry harder in the evaluator". The evaluator is the thing
// that lost the race; asking it to notice is asking the wrong process. The fix is
// that a pass which cannot take the lock must leave a durable, idempotent trace
// that re-enters later - a delayed ADVANCE_WORKFLOW publish - so the wakeup
// survives the request that would otherwise have dropped it.
//
// Every test here is deterministic. Contention is expressed by putting the Redis
// key in the state another worker would hold it in, not by racing two promises
// against a timer, because a test that only fails sometimes is a test that will
// be green the next time it matters.

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

/**
 * A fan-out/fan-in graph: `trigger` fans out to `a` and `b`, which both have to
 * land before `c` becomes ready. The race only exists when two branches converge,
 * so a linear graph would make these tests vacuous.
 */
const DEFINITION = {
  id: "definition_1",
  name: "fan in",
  steps: {
    trigger: {
      id: "trigger",
      action: "task.created",
      dependsOn: [],
      kind: "TRIGGER",
      config: {},
      isCritical: false,
    },
    a: {
      id: "a",
      action: "task.create",
      dependsOn: ["trigger"],
      kind: "ACTION",
      config: {},
      isCritical: false,
    },
    b: {
      id: "b",
      action: "task.create",
      dependsOn: ["trigger"],
      kind: "ACTION",
      config: {},
      isCritical: false,
    },
    c: {
      id: "c",
      action: "task.create",
      dependsOn: ["a", "b"],
      kind: "ACTION",
      config: {},
      isCritical: false,
    },
  },
};

type StepSeed = { stepId: string; status: string };

function seedRun(
  stepRuns: StepSeed[],
  runStatus = "RUNNING",
  definition: unknown = DEFINITION,
) {
  resetStore();
  resetRedisDouble();

  store.workflows.push({
    id: "wf_1",
    name: "fan in",
    definition,
    orgId: "org_1",
    eventId: "task.created",
  });

  store.runs.push({
    id: RUN_ID,
    workflowId: "wf_1",
    status: runStatus,
    context: {},
    startedAt: new Date(),
    completedAt: null,
  });

  for (const seed of stepRuns) {
    store.stepRuns.push({
      id: `sr_${seed.stepId}`,
      runId: RUN_ID,
      stepId: seed.stepId,
      status: seed.status,
      attempts: 0,
      compensationAttempts: 0,
      inputs: null,
      outputs: null,
      error: null,
      startedAt: new Date(),
      completedAt: null,
    });
  }
}

/** The three fan-in predecessors, all landed, so `c` is ready. */
function seedReadyFanIn() {
  seedRun([
    { stepId: "trigger", status: "SUCCESS" },
    { stepId: "a", status: "SUCCESS" },
    { stepId: "b", status: "SUCCESS" },
  ]);
}

function stepFor(stepId: string) {
  return store.stepRuns.find((row) => row.stepId === stepId);
}

function advanceCalls() {
  return publishEventMock.mock.calls.filter(
    ([eventName]) => eventName === "ADVANCE_WORKFLOW",
  );
}

function nodeCalls() {
  return publishEventMock.mock.calls.filter(
    ([eventName]) => eventName === "EXECUTE_WORKFLOW_NODE",
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
  resetRedisDouble();
  publishEventMock.mockResolvedValue(undefined as never);
});

// ---------------------------------------------------------------------------
// The lost wakeup
// ---------------------------------------------------------------------------

describe("advanceWorkflow: lost wakeup on lock contention", () => {
  it("schedules a durable re-entry rather than dropping the wakeup when the lock is held", async () => {
    // `c` is ready, but another worker still holds the run lock. This is the
    // exact losing pass that used to vanish.
    seedReadyFanIn();
    holdLock(LOCK_KEY);

    await advanceWorkflow(RUN_ID);

    const scheduled = advanceCalls();
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled[0][1]).toEqual({ runId: RUN_ID });
  });

  it("does not write workflow state it is not the lock owner for", async () => {
    // The re-entry must be a pure hand-off. If the losing pass created `c` it
    // would race the lock holder, which may be mid-publish for the same step.
    seedReadyFanIn();
    holdLock(LOCK_KEY);

    await advanceWorkflow(RUN_ID);

    expect(stepFor("c")).toBeUndefined();
    expect(store.runs[0].status).toBe("RUNNING");
  });

  it("leaves the other worker's lock intact", async () => {
    // Releasing by compare-and-delete only works if the loser never reaches the
    // delete. A plain release would hand the next pass a lock it never owned.
    seedReadyFanIn();
    holdLock(LOCK_KEY, "the-real-owner");

    await advanceWorkflow(RUN_ID);

    expect(isLocked(LOCK_KEY)).toBe(true);
  });

  it("releases its own lock on the pass that takes it", async () => {
    // The counterpart to the above: a pass that DOES take the lock must hand it
    // back, or every later pass is permanently blocked.
    seedReadyFanIn();

    await advanceWorkflow(RUN_ID);

    expect(isLocked(LOCK_KEY)).toBe(false);
  });

  it("makes progress when the re-entry is delivered after the lock frees", async () => {
    // The end-to-end shape: the losing pass schedules the re-entry, the lock
    // clears, the re-entry is delivered, and the ready step is finally
    // dispatched. Without this the unit test above would only prove that a
    // message was published, not that the graph advances.
    seedReadyFanIn();
    holdLock(LOCK_KEY);
    await advanceWorkflow(RUN_ID);

    // The holder finishes and lets go.
    resetRedisDouble();
    await advanceWorkflow(RUN_ID);

    const c = stepFor("c");
    expect(c?.status).toBe("PENDING");
    expect(nodeCalls()).toHaveLength(1);
    expect(nodeCalls()[0][1]).toEqual({
      runId: RUN_ID,
      stepRunId: c?.id,
      kind: "ACTION",
    });
  });

  it("tolerates a duplicate re-entry delivery", async () => {
    // QStash is at-least-once, and the evaluator's own lock makes a second
    // concurrent pass harmless. A duplicate ADVANCE_WORKFLOW therefore must be
    // a no-op rather than a second `c` or a thrown P2002.
    seedReadyFanIn();
    holdLock(LOCK_KEY);
    await advanceWorkflow(RUN_ID);

    resetRedisDouble();
    await advanceWorkflow(RUN_ID);
    await advanceWorkflow(RUN_ID);

    expect(store.stepRuns.filter((row) => row.stepId === "c")).toHaveLength(1);
    expect(nodeCalls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Terminal convergence
// ---------------------------------------------------------------------------

describe("advanceWorkflow: convergence", () => {
  it("completes a run once every step is terminal", async () => {
    seedRun([
      { stepId: "trigger", status: "SUCCESS" },
      { stepId: "a", status: "SUCCESS" },
      { stepId: "b", status: "SUCCESS" },
      { stepId: "c", status: "SUCCESS" },
    ]);

    await advanceWorkflow(RUN_ID);

    expect(store.runs[0].status).toBe("COMPLETED");
    expect(store.runs[0].completedAt).toBeInstanceOf(Date);
  });

  it("marks a run FAILED when a non-critical step failed", async () => {
    // The saga pivot only fires for a CRITICAL failure, so a non-critical one
    // must still terminate the run rather than leaving it spinning.
    seedRun([
      { stepId: "trigger", status: "SUCCESS" },
      { stepId: "a", status: "SUCCESS" },
      { stepId: "b", status: "SUCCESS" },
      { stepId: "c", status: "FAILED" },
    ]);

    await advanceWorkflow(RUN_ID);

    expect(store.runs[0].status).toBe("FAILED");
  });

  it("rolls back instead of completing when a critical step failed", async () => {
    // The saga pivot keys off the definition's `isCritical`, not off the run
    // status, so the graph under test has to declare a critical step. Seeding a
    // failure without flipping that flag would assert the non-critical path
    // while claiming to test the critical one.
    const criticalDefinition = {
      ...DEFINITION,
      steps: {
        ...DEFINITION.steps,
        b: { ...DEFINITION.steps.b, isCritical: true },
      },
    };

    seedRun(
      [
        { stepId: "trigger", status: "SUCCESS" },
        { stepId: "a", status: "SUCCESS" },
        { stepId: "b", status: "FAILED" },
      ],
      "RUNNING",
      criticalDefinition,
    );

    await advanceWorkflow(RUN_ID);

    expect(store.runs[0].status).toBe("ROLLING_BACK");
  });

  it("does not re-drive a run that already completed", async () => {
    seedRun(
      [
        { stepId: "trigger", status: "SUCCESS" },
        { stepId: "a", status: "SUCCESS" },
        { stepId: "b", status: "SUCCESS" },
        { stepId: "c", status: "SUCCESS" },
      ],
      "COMPLETED",
    );

    await advanceWorkflow(RUN_ID);

    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it("throws when the run does not exist", async () => {
    // A missing run is a programming or retention error, not contention. It
    // must not be reported as "another worker has this locked", which is what
    // the old null-token path did.
    resetStore();
    resetRedisDouble();

    await expect(advanceWorkflow("run_missing")).rejects.toThrow(
      /WorkflowRun not found/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Primitives the doubles must actually model
// ---------------------------------------------------------------------------

describe("workflow prisma double", () => {
  it("enforces the unique (runId, stepId) constraint the evaluator relies on", async () => {
    // Deliberately not seeded with a `trigger` step: the first create has to
    // succeed for the test to be about the second one.
    resetStore();
    resetRedisDouble();
    store.runs.push({
      id: RUN_ID,
      workflowId: "wf_1",
      status: "RUNNING",
      context: {},
      startedAt: new Date(),
      completedAt: null,
    });

    await prismaDouble.stepRun.create({
      data: { runId: RUN_ID, stepId: "trigger", status: "PENDING" },
    });

    await expect(
      prismaDouble.stepRun.create({
        data: { runId: RUN_ID, stepId: "trigger", status: "PENDING" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("honours the status predicate on a claim", async () => {
    seedRun([{ stepId: "trigger", status: "SUCCESS" }]);

    const result = await prismaDouble.stepRun.updateMany({
      where: { id: "sr_trigger", status: "PENDING" },
      data: { status: "RUNNING" },
    });

    expect(result.count).toBe(0);
    expect(stepFor("trigger")?.status).toBe("SUCCESS");
  });
});
