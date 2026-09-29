// src/tests/workflow/step-retry.test.ts
//
// Step execution and retry: finding B.
//
// The bug: the workflow route derived the operation with
// `status === "PENDING" ? "EXECUTE" : "COMPENSATE"`. Everything that is not
// PENDING became a compensation - including RETRYING.
//
// That closed off the retry path completely, and silently:
//
//   1. A retriable action failure writes RETRYING and answers 500.
//   2. QStash redelivers, because 500 is the signal to retry.
//   3. The redelivery reads RETRYING, concludes "compensate".
//   4. Compensation claims the step `where status: "SUCCESS"`. RETRYING is not
//      SUCCESS, so nothing matched, and the wrapper reported success.
//   5. The step stays RETRYING. The evaluator skips it forever as "already
//      decided", nothing becomes ready, and the run hangs.
//
// Every step in that chain reported success or "already processed". There was no
// error to find, only a workflow that stopped making progress.

jest.mock("server-only", () => ({}));

jest.mock("@upstash/redis", () => ({
  Redis: { fromEnv: () => ({ set: jest.fn(), eval: jest.fn() }) },
}));

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: { trigger: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("@/lib/workflow-types/action-registry", () => ({
  getAction: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

import { wrapStepOperation } from "@/lib/workflow/execution/wrapper";
import { getAction } from "@/lib/workflow-types/action-registry";
import { resetStore, restoreWorkflowDouble, store } from "./helpers/prisma-double";

const actionRegistryMock = getAction as jest.MockedFunction<typeof getAction>;

const RUN_ID = "run_1";
const STEP_ID = "a";

type Row = Record<string, unknown>;

function seedStep(status: string, extra: Partial<Row> = {}) {
  resetStore();

  store.workflows.push({
    id: "wf_1",
    name: "linear",
    definition: { id: "d", name: "d", steps: {} },
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

  store.stepRuns.push({
    id: "sr_a",
    runId: RUN_ID,
    stepId: STEP_ID,
    status,
    attempts: 0,
    compensationAttempts: 0,
    inputs: { title: "from first attempt" },
    outputs: null,
    error: null,
    startedAt: null,
    completedAt: null,
    ...extra,
  });
}

function step() {
  return store.stepRuns[0];
}

function actionDouble(overrides: Record<string, unknown> = {}) {
  return {
    execute: jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
    compensate: jest.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreWorkflowDouble();
  resetStore();
});

// ---------------------------------------------------------------------------
// The claim: which statuses may be claimed for which operation
// ---------------------------------------------------------------------------

describe("wrapStepOperation: claim semantics", () => {
  it("claims a PENDING step for forward execution", async () => {
    seedStep("PENDING");
    actionRegistryMock.mockReturnValue(actionDouble());

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "ACTION", {}, "EXECUTE");

    expect(step().status).toBe("SUCCESS");
  });

  it("claims a RETRYING step for forward execution", async () => {
    // The core of finding B. Without RETRYING in the claimable set, a retried
    // step fails its own claim and is reported as already done.
    seedStep("RETRYING");
    actionRegistryMock.mockReturnValue(actionDouble());

    const result = await wrapStepOperation(
      RUN_ID,
      STEP_ID,
      "task.create",
      "ACTION",
      {},
      "EXECUTE",
    );

    expect(result.success).toBe(true);
    expect(step().status).toBe("SUCCESS");
  });

  it("actually runs the action when claiming a RETRYING step", async () => {
    // Guards against "fix" the other way: silently treating a retry as already
    // done would pass the status assertion above while never re-running the
    // action, which is not a retry at all.
    seedStep("RETRYING");
    const action = actionDouble();
    actionRegistryMock.mockReturnValue(action);

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "ACTION", {}, "EXECUTE");

    expect((action as { execute: jest.Mock }).execute).toHaveBeenCalledTimes(1);
  });

  it("claims a SUCCESS step for compensation", async () => {
    seedStep("SUCCESS");
    const action = actionDouble();
    actionRegistryMock.mockReturnValue(action);

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "ACTION", undefined, "COMPENSATE");

    expect(step().status).toBe("COMPENSATED");
    expect((action as { compensate: jest.Mock }).compensate).toHaveBeenCalledTimes(1);
  });

  it("claims a COMPENSATING step for a retried compensation", async () => {
    // Same bug, mirror image. A retriable compensation failure parks the step in
    // COMPENSATING, and the old `status: "SUCCESS"` claim could never match it.
    seedStep("COMPENSATING");
    const action = actionDouble();
    actionRegistryMock.mockReturnValue(action);

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "ACTION", undefined, "COMPENSATE");

    expect(step().status).toBe("COMPENSATED");
  });

  it("refuses to claim a step another delivery already holds", async () => {
    // RUNNING means a concurrent delivery owns it. The compare-and-set must
    // refuse, and the action must not run.
    seedStep("RUNNING");
    const action = actionDouble();
    actionRegistryMock.mockReturnValue(action);

    const result = await wrapStepOperation(
      RUN_ID,
      STEP_ID,
      "task.create",
      "ACTION",
      {},
      "EXECUTE",
    );

    expect((action as { execute: jest.Mock }).execute).not.toHaveBeenCalled();
    expect(step().status).toBe("RUNNING");
    expect(result.success).toBe(true);
  });

  it("refuses to compensate a step that never succeeded", async () => {
    // Compensation reads the step's recorded outputs to undo its effect. A step
    // in FAILED has none, so compensating it is meaningless at best.
    seedStep("FAILED");
    const action = actionDouble();
    actionRegistryMock.mockReturnValue(action);

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "ACTION", undefined, "COMPENSATE");

    expect((action as { compensate: jest.Mock }).compensate).not.toHaveBeenCalled();
  });

  it("auto-completes a TRIGGER without running an action", async () => {
    seedStep("PENDING");
    const action = actionDouble();
    actionRegistryMock.mockReturnValue(action);

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "TRIGGER", {}, "EXECUTE");

    expect(step().status).toBe("SUCCESS");
    expect((action as { execute: jest.Mock }).execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Retry accounting
// ---------------------------------------------------------------------------

describe("wrapStepOperation: retry accounting", () => {
  it("parks a retriable failure in RETRYING and reports it for broker retry", async () => {
    seedStep("PENDING", { attempts: 0 });
    actionRegistryMock.mockReturnValue(
      actionDouble({
        execute: jest
          .fn()
          .mockResolvedValue({ success: false, error: "upstream 503", isRetriable: true }),
      }),
    );

    const result = await wrapStepOperation(
      RUN_ID,
      STEP_ID,
      "task.create",
      "ACTION",
      {},
      "EXECUTE",
    );

    expect(result).toEqual({
      success: false,
      status: "RETRYING",
      error: "upstream 503",
    });
    expect(step().status).toBe("RETRYING");
    expect(step().attempts).toBe(1);
  });

  it("fails a non-retriable failure immediately", async () => {
    seedStep("PENDING");
    actionRegistryMock.mockReturnValue(
      actionDouble({
        execute: jest
          .fn()
          .mockResolvedValue({ success: false, error: "validation failed", isRetriable: false }),
      }),
    );

    const result = await wrapStepOperation(
      RUN_ID,
      STEP_ID,
      "task.create",
      "ACTION",
      {},
      "EXECUTE",
    );

    expect(result).toMatchObject({ success: false, status: "FAILED" });
    expect(step().status).toBe("FAILED");
    expect(step().completedAt).toBeInstanceOf(Date);
  });

  it("fails out once the attempt cap is reached", async () => {
    // Two prior attempts have already happened. This one must be terminal, or
    // the broker retries until it gives up and the step strands in RETRYING.
    seedStep("PENDING", { attempts: 2 });
    actionRegistryMock.mockReturnValue(
      actionDouble({
        execute: jest
          .fn()
          .mockResolvedValue({ success: false, error: "still 503", isRetriable: true }),
      }),
    );

    const result = await wrapStepOperation(
      RUN_ID,
      STEP_ID,
      "task.create",
      "ACTION",
      {},
      "EXECUTE",
    );

    expect(result).toMatchObject({ success: false, status: "FAILED" });
    expect(step().attempts).toBe(3);
  });

  it("increments the forward attempt counter on a retry, not the compensation one", async () => {
    seedStep("PENDING", { attempts: 1, compensationAttempts: 0 });
    actionRegistryMock.mockReturnValue(
      actionDouble({
        execute: jest
          .fn()
          .mockResolvedValue({ success: false, error: "503", isRetriable: true }),
      }),
    );

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "ACTION", {}, "EXECUTE");

    expect(step().attempts).toBe(2);
    expect(step().compensationAttempts).toBe(0);
  });

  it("writes an audit row for every failure", async () => {
    seedStep("PENDING");
    actionRegistryMock.mockReturnValue(
      actionDouble({
        execute: jest
          .fn()
          .mockResolvedValue({ success: false, error: "503", isRetriable: true }),
      }),
    );

    await wrapStepOperation(RUN_ID, STEP_ID, "task.create", "ACTION", {}, "EXECUTE");

    const events = store.auditLogs.map((row) => row.eventType);
    expect(events).toContain("STEP_STARTED");
    expect(events).toContain("STEP_RETRYING");
  });

  it("treats an uncaught action crash as retriable", async () => {
    // A thrown action is a bug or a transport fault, and neither is improved by
    // not trying again. Classifying it as terminal is how one transient blip
    // becomes a permanently failed step.
    seedStep("PENDING");
    actionRegistryMock.mockReturnValue(
      actionDouble({
        execute: jest.fn().mockRejectedValue(new Error("socket hang up")),
      }),
    );

    const result = await wrapStepOperation(
      RUN_ID,
      STEP_ID,
      "task.create",
      "ACTION",
      {},
      "EXECUTE",
    );

    expect(result).toMatchObject({ success: false, status: "RETRYING" });
  });

  it("fails a step whose action is missing from the registry", async () => {
    seedStep("PENDING");
    actionRegistryMock.mockReturnValue(undefined);

    const result = await wrapStepOperation(
      RUN_ID,
      STEP_ID,
      "task.create",
      "ACTION",
      {},
      "EXECUTE",
    );

    expect(result.success).toBe(false);
    expect(step().status).toBe("FAILED");
  });
});
