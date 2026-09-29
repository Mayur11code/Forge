// src/tests/workflow/stale-run-recovery.test.ts
//
// Finding 5: nothing ever looked at a run that had stopped moving.
//
// A run gets stuck when a delivery is LOST rather than failed. QStash exhausts
// its retries, the step sits in RETRYING or RUNNING, and from the run row
// everything looks fine: status RUNNING, no terminal state, no error. The
// evaluator's backstop keeps visiting and keeps finding nothing it can legally do.
//
// The danger in fixing this is fixing it wrong. A sweeper that re-dispatches
// whatever it finds stale cannot tell a step that never started from one whose
// action reached the outside world and then lost its response. For the only
// registered action that is a duplicate database row; for a real integration it
// is a duplicate charge. So this suite is as much about what must NOT be
// re-dispatched as about what must be.

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

jest.mock("@/lib/workflow/execution/evaluator", () => ({
  advanceWorkflow: jest.fn().mockResolvedValue("ADVANCED"),
}));

import { publishEvent } from "@/lib/events/queue";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import {
  WORKFLOW_STALE_RUN_AGE_MS,
  WORKFLOW_SWEEP_BATCH_SIZE,
  sweepStaleWorkflowRuns,
} from "@/lib/workflow/maintenance";
import {
  prismaDouble,
  resetStore,
  restoreWorkflowDouble,
  store,
} from "./helpers/prisma-double";

const publishEventMock = publishEvent as jest.MockedFunction<typeof publishEvent>;
const advanceMock = advanceWorkflow as jest.MockedFunction<typeof advanceWorkflow>;

const NOW = new Date("2026-09-30T12:00:00.000Z");

/** Old enough to be swept. */
function longAgo() {
  return new Date(NOW.getTime() - WORKFLOW_STALE_RUN_AGE_MS - 60_000);
}

function recent() {
  return new Date(NOW.getTime() - 1_000);
}

type StepOverrides = Partial<Record<string, unknown>>;

function seedRun(
  {
    runStatus = "RUNNING",
    lastAdvancedAt = longAgo(),
    completedAt = null,
  }: {
    runStatus?: string;
    lastAdvancedAt?: Date | null;
    completedAt?: Date | null;
  } = {},
  steps: StepOverrides[] = [],
) {
  resetStore();

  store.runs.push({
    id: "run_1",
    workflowId: "wf_1",
    status: runStatus,
    context: {},
    contextVersion: 0,
    lastAdvancedAt,
    startedAt: longAgo(),
    completedAt,
  });

  steps.forEach((overrides, index) => {
    store.stepRuns.push({
      id: `sr_${index}`,
      runId: "run_1",
      stepId: `s${index}`,
      status: "PENDING",
      attempts: 0,
      compensationAttempts: 0,
      startedAt: null,
      completedAt: null,
      error: null,
      ...overrides,
    });
  });
}

function dispatched() {
  return publishEventMock.mock.calls.filter(
    ([name]) => name === "EXECUTE_WORKFLOW_NODE",
  );
}

function stepRow(index: number) {
  return store.stepRuns.find((row) => row.id === `sr_${index}`)!;
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
  publishEventMock.mockResolvedValue(undefined as never);
  advanceMock.mockResolvedValue("ADVANCED");
});

// ---------------------------------------------------------------------------
// Which runs are considered stale at all
// ---------------------------------------------------------------------------

describe("findStaleRuns", () => {
  it("picks up an active run that stopped advancing", async () => {
    seedRun({}, [{ status: "PENDING" }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(outcomes).toHaveLength(1);
  });

  it("leaves a run alone while it is still moving", async () => {
    // The most damaging possible bug here: sweeping a healthy run mid-flight.
    seedRun({ lastAdvancedAt: recent() }, [{ status: "PENDING" }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(outcomes).toEqual([]);
    expect(dispatched()).toHaveLength(0);
  });

  it("leaves a completed run alone", async () => {
    // A finished run is not stuck. Resurrecting one re-runs its steps.
    seedRun(
      { runStatus: "SUCCESS", lastAdvancedAt: longAgo(), completedAt: longAgo() },
      [{ status: "SUCCESS" }],
    );

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(outcomes).toEqual([]);
  });

  it("ignores runs in a terminal status", async () => {
    seedRun({ runStatus: "FAILED", lastAdvancedAt: longAgo() }, [{ status: "FAILED" }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(outcomes).toEqual([]);
  });

  it("sweeps a run that never advanced at all", async () => {
    // A run created and then orphaned before its first pass commits
    // `lastAdvancedAt`. The `lt` predicate cannot see it: `NULL < cutoff` is
    // NULL, not true. Without the explicit `OR` clause this run is invisible
    // forever, and it is the run that has made the least progress of all.
    seedRun({ lastAdvancedAt: null }, [{ status: "PENDING" }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(outcomes).toHaveLength(1);
  });

  it("does not sweep a run that never advanced but only just started", async () => {
    // The other half of the same clause. Falling back to `startedAt` is only
    // safe while that fallback is also aged, otherwise every brand new run is
    // swept on the tick after it is created.
    resetStore();
    store.runs.push({
      id: "run_1",
      workflowId: "wf_1",
      status: "RUNNING",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: null,
      startedAt: recent(),
      completedAt: null,
    });
    store.stepRuns.push({
      id: "sr_0",
      runId: "run_1",
      stepId: "a",
      status: "PENDING",
      attempts: 0,
      startedAt: null,
    });

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(outcomes).toEqual([]);
    expect(dispatched()).toHaveLength(0);
  });

  it("asks the database for never-advanced runs explicitly", async () => {
    // Pins the shape of the query, because the fix is the `OR`. A future edit
    // that folds this back into a single `lt` would pass every behavioural test
    // above and reintroduce the blind spot.
    seedRun({ lastAdvancedAt: null }, [{ status: "PENDING" }]);

    await sweepStaleWorkflowRuns({ now: NOW });

    const where = prismaDouble.workflowRun.findMany.mock.calls[0]![0]!.where as Record<
      string,
      unknown
    >;
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toHaveLength(2);
  });

  it("bounds the batch and orders oldest first", async () => {
    // Unbounded would be a table scan on a maintenance tick. Oldest-first
    // matters more: newest-first starves the oldest stuck run indefinitely,
    // because it is always behind a full batch of healthier rows.
    resetStore();

    for (let index = 0; index < 5; index += 1) {
      store.runs.push({
        id: `run_${index}`,
        workflowId: "wf_1",
        status: "RUNNING",
        context: {},
        contextVersion: 0,
        // run_0 is oldest.
        lastAdvancedAt: new Date(NOW.getTime() - (10 - index) * 60_000),
        startedAt: longAgo(),
        completedAt: null,
      });
      store.stepRuns.push({
        id: `sr_${index}`,
        runId: `run_${index}`,
        stepId: "a",
        status: "PENDING",
        attempts: 0,
        startedAt: null,
      });
    }

    await sweepStaleWorkflowRuns({ now: NOW, limit: 2 });

    const query = prismaDouble.workflowRun.findMany.mock.calls[0]![0]!;
    expect(query.take).toBe(2);
    expect(query.orderBy).toEqual({ lastAdvancedAt: "asc" });
  });

  it("defaults the batch size", () => {
    expect(WORKFLOW_SWEEP_BATCH_SIZE).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Re-drive: safe, because nothing ran
// ---------------------------------------------------------------------------

describe("sweepStaleWorkflowRuns: re-drive", () => {
  it("re-drives a step that was never claimed", async () => {
    seedRun({}, [{ status: "PENDING", startedAt: null }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(dispatched()).toHaveLength(1);
    expect(dispatched()[0][1]).toEqual({
      runId: "run_1",
      stepRunId: "sr_0",
      kind: "ACTION",
    });
    expect(outcomes[0].action).toBe("REDRIVEN");
  });

  it("re-drives a retriable failure that is still under the attempt cap", async () => {
    // Safe because the action itself said so: a retriable failure is a request
    // that provably did not take effect.
    seedRun({}, [{ status: "RETRYING", attempts: 1 }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(dispatched()).toHaveLength(1);
    expect(outcomes[0].action).toBe("REDRIVEN");
  });

  it("does not re-drive a retriable failure that has used its attempts", async () => {
    // Re-driving here restarts a counter the wrapper is already advancing, which
    // turns a bounded retry policy into an unbounded one. The step is surfaced
    // instead, which is a claim the system can actually support.
    seedRun({}, [{ status: "RETRYING", attempts: 3 }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(dispatched()).toHaveLength(0);
    expect(outcomes[0].action).toBe("SURFACED");
  });

  it("does not re-drive a PENDING step that already has a start time", async () => {
    // PENDING with a `startedAt` is a status the wrapper wrote before claiming
    // and then failed to update. It is not proof of anything, so it is not
    // treated as proof that nothing ran.
    seedRun({}, [{ status: "PENDING", startedAt: longAgo() }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(dispatched()).toHaveLength(0);
    expect(outcomes[0].action).toBe("SURFACED");
  });
});

// ---------------------------------------------------------------------------
// Surface: never re-run, because the outcome cannot be known
// ---------------------------------------------------------------------------

describe("sweepStaleWorkflowRuns: ambiguous outcomes", () => {
  it("never re-runs a step abandoned in RUNNING", async () => {
    // The case the whole file is built around. The action may have committed
    // externally before its worker died; the only honest options are to leave it
    // or to fail it with the reason recorded. Re-running is not one of them.
    seedRun({}, [{ status: "RUNNING", startedAt: longAgo() }]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(dispatched()).toHaveLength(0);
    expect(outcomes[0].action).toBe("SURFACED");
  });

  it("never re-runs a step abandoned in COMPENSATING", async () => {
    // The rollback version of the same hazard: a compensation that ran may have
    // already undone the effect, and running it again undoes it twice.
    seedRun({ runStatus: "ROLLING_BACK" }, [
      { status: "COMPENSATING", startedAt: longAgo() },
    ]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(dispatched()).toHaveLength(0);
    expect(outcomes[0].action).toBe("SURFACED");
  });

  it("fails an ambiguous step and records why", async () => {
    seedRun({}, [{ status: "RUNNING", startedAt: longAgo() }]);

    await sweepStaleWorkflowRuns({ now: NOW });

    const row = stepRow(0);
    expect(row.status).toBe("FAILED");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(String(row.error)).toMatch(/may or may not have taken effect/i);
  });

  it("records the ambiguity in the audit log at FATAL", async () => {
    // FATAL because nothing will retry this. A WARN would suggest a system that
    // is still coping, and this is a human decision.
    seedRun({}, [{ status: "RUNNING", startedAt: longAgo() }]);

    await sweepStaleWorkflowRuns({ now: NOW });

    const audit = store.auditLogs.at(-1)!;
    expect(audit.logLevel).toBe("FATAL");
    expect(audit.eventType).toBe("STEP_STALLED_UNKNOWN_OUTCOME");
  });

  it("fails an ambiguous compensation as COMPENSATION_FAILED", async () => {
    seedRun({ runStatus: "ROLLING_BACK" }, [
      { status: "COMPENSATING", startedAt: longAgo() },
    ]);

    await sweepStaleWorkflowRuns({ now: NOW });

    expect(stepRow(0).status).toBe("COMPENSATION_FAILED");
  });

  it("does not touch steps that already reached a terminal state", async () => {
    // The run is lagging, not stuck. Rewriting a settled step would overwrite a
    // real outcome with a guess.
    seedRun({}, [
      { status: "SUCCESS", startedAt: longAgo() },
      { status: "FAILED", startedAt: longAgo() },
      { status: "COMPENSATED", startedAt: longAgo() },
    ]);

    const outcomes = await sweepStaleWorkflowRuns({ now: NOW });

    expect(outcomes).toEqual([]);
    expect(dispatched()).toHaveLength(0);
    expect(store.auditLogs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The run is asked to converge afterwards
// ---------------------------------------------------------------------------

describe("sweepStaleWorkflowRuns: convergence", () => {
  it("re-evaluates a run it acted on", async () => {
    // Surfacing a step is not the end of the job. A newly FAILED critical step
    // has to pivot the run into a rollback, and a non-critical one has to let the
    // run finish as FAILED. Without this the run converges to nothing.
    seedRun({}, [{ status: "RUNNING", startedAt: longAgo() }]);

    await sweepStaleWorkflowRuns({ now: NOW });

    expect(advanceMock).toHaveBeenCalledWith("run_1");
  });

  it("re-evaluates a run it only re-drove", async () => {
    seedRun({}, [{ status: "PENDING", startedAt: null }]);

    await sweepStaleWorkflowRuns({ now: NOW });

    expect(advanceMock).toHaveBeenCalledWith("run_1");
  });

  it("does not touch a run it left alone", async () => {
    seedRun({ lastAdvancedAt: recent() }, [{ status: "RUNNING", startedAt: longAgo() }]);

    await sweepStaleWorkflowRuns({ now: NOW });

    expect(advanceMock).not.toHaveBeenCalled();
  });

  it("does not swallow a failure to re-drive", async () => {
    // A publish that failed means nobody is looking after the step. Reporting
    // success would delete the only remaining copy of the intent.
    seedRun({}, [{ status: "PENDING", startedAt: null }]);
    publishEventMock.mockRejectedValueOnce(new Error("qstash rejected"));

    await expect(sweepStaleWorkflowRuns({ now: NOW })).rejects.toThrow(
      "qstash rejected",
    );
  });

  it("stops at the step whose re-drive failed, without pretending to advance", async () => {
    seedRun({}, [
      { status: "PENDING", startedAt: null },
      { status: "PENDING", startedAt: null },
    ]);
    publishEventMock.mockRejectedValueOnce(new Error("qstash rejected"));

    await expect(sweepStaleWorkflowRuns({ now: NOW })).rejects.toThrow();

    // Advancing after a failed re-drive would let the evaluator see a run whose
    // state no longer matches what the queue was asked to do.
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it("is safe to run twice without re-driving twice in a way that matters", async () => {
    // The tick is periodic and overlapping ticks are possible. The second pass
    // re-reads state; a re-driven step is still PENDING until its worker claims
    // it, so this asserts the sweep is bounded and repeatable rather than
    // accumulating state across runs.
    seedRun({}, [{ status: "PENDING", startedAt: null }]);

    await sweepStaleWorkflowRuns({ now: NOW });
    const first = dispatched().length;
    await sweepStaleWorkflowRuns({ now: NOW });

    expect(first).toBe(1);
    expect(dispatched()).toHaveLength(2);
  });
});
