// src/tests/workflow/compensation-claim.test.ts
//
// Production-function tests (E2) for compensation claim ownership and token fencing (F-05A).

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

import {
  claimCompensationAttempt,
  completeCompensationAttempt,
  failCompensationAttempt,
} from "@/lib/workflow/execution/compensation-claim";
import { resetStore, store } from "./helpers/prisma-double";

describe("Compensation Ownership Foundation & Fencing (F-05A)", () => {
  const RUN_ID = "run_f05a_1";
  const STEP_ID = "step_comp_1";
  const STEP_RUN_ID = "sr_comp_1";

  beforeEach(() => {
    resetStore();

    store.runs.push({
      id: RUN_ID,
      workflowId: "wf_1",
      status: "ROLLING_BACK",
      context: {},
      contextVersion: 0,
      lastAdvancedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });
  });

  function seedStepRun(
    status: string,
    extra: Partial<(typeof store.stepRuns)[number]> = {}
  ) {
    store.stepRuns.push({
      id: STEP_RUN_ID,
      runId: RUN_ID,
      stepId: STEP_ID,
      status,
      attempts: 1,
      compensationAttempts: 0,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      inputs: { a: 1 },
      outputs: { b: 2 },
      startedAt: new Date(),
      completedAt: null,
      ...extra,
    });
  }

  it("1. SUCCESS can be claimed for compensation", async () => {
    seedStepRun("SUCCESS");

    const claim = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });

    expect(claim.acquired).toBe(true);
    if (claim.acquired) {
      expect(typeof claim.claimToken).toBe("string");
      expect(claim.compensationAttempts).toBe(1);
    }

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.status).toBe("COMPENSATING");
    expect(row?.compensationClaimToken).toBeDefined();
    expect(row?.compensationAttempts).toBe(1);
  });

  it("2. COMPENSATION_RETRYING can be claimed for compensation", async () => {
    seedStepRun("COMPENSATION_RETRYING", { compensationAttempts: 1 });

    const claim = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });

    expect(claim.acquired).toBe(true);
    if (claim.acquired) {
      expect(claim.compensationAttempts).toBe(2);
    }

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.status).toBe("COMPENSATING");
    expect(row?.compensationAttempts).toBe(2);
  });

  it("3. Active COMPENSATING step with active lease cannot be claimed again", async () => {
    const futureDate = new Date(Date.now() + 60_000);
    seedStepRun("COMPENSATING", {
      compensationClaimToken: "active_token_1",
      compensationLeaseExpiresAt: futureDate,
      compensationAttempts: 1,
    });

    const claim = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });

    expect(claim.acquired).toBe(false);
    if (!claim.acquired) {
      expect(claim.reason).toBe("ALREADY_CLAIMED");
    }

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.compensationAttempts).toBe(1); // Not incremented
    expect(row?.compensationClaimToken).toBe("active_token_1");
  });

  it("4. COMPENSATED cannot be claimed", async () => {
    seedStepRun("COMPENSATED");

    const claim = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });

    expect(claim.acquired).toBe(false);
  });

  it("5. COMPENSATION_FAILED cannot be automatically claimed", async () => {
    seedStepRun("COMPENSATION_FAILED", { compensationAttempts: 3 });

    const claim = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });

    expect(claim.acquired).toBe(false);
  });

  it("6. Retry increments compensationAttempts exactly once", async () => {
    seedStepRun("COMPENSATION_RETRYING", { compensationAttempts: 1 });

    const claim = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });

    expect(claim.acquired).toBe(true);
    if (claim.acquired) {
      expect(claim.compensationAttempts).toBe(2);
    }

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.compensationAttempts).toBe(2);
  });

  it("7. Duplicate delivery cannot increment attempts twice", async () => {
    seedStepRun("SUCCESS");

    // Worker 1 claims
    const claim1 = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });
    expect(claim1.acquired).toBe(true);

    // Worker 2 attempts to claim while worker 1 is active
    const claim2 = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });
    expect(claim2.acquired).toBe(false);

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.compensationAttempts).toBe(1); // exactly 1, not 2
  });

  it("8. Old claim token cannot complete a newer attempt (token fencing)", async () => {
    seedStepRun("COMPENSATING", {
      compensationClaimToken: "newer_token_2",
      compensationAttempts: 2,
    });

    // Stale worker with token "old_token_1" tries to complete
    const result = await completeCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
      claimToken: "old_token_1",
    });

    expect(result.completed).toBe(false);

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.status).toBe("COMPENSATING");
    expect(row?.compensationClaimToken).toBe("newer_token_2");
  });

  it("9. Old claim token cannot mark a newer attempt failed (token fencing)", async () => {
    seedStepRun("COMPENSATING", {
      compensationClaimToken: "newer_token_2",
      compensationAttempts: 2,
    });

    // Stale worker with token "old_token_1" tries to report failure
    const result = await failCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
      stepId: STEP_ID,
      claimToken: "old_token_1",
      errorMessage: "Stale failure",
      isRetriable: false,
      currentAttempts: 1,
    });

    expect(result.fencedOut).toBe(true);

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.status).toBe("COMPENSATING");
    expect(row?.compensationClaimToken).toBe("newer_token_2");
  });

  it("10. Successful completion invalidates further execution and sets COMPENSATED", async () => {
    seedStepRun("COMPENSATING", {
      compensationClaimToken: "valid_token",
      compensationAttempts: 1,
    });

    const result = await completeCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
      claimToken: "valid_token",
    });

    expect(result.completed).toBe(true);

    const row = store.stepRuns.find((s) => s.id === STEP_RUN_ID);
    expect(row?.status).toBe("COMPENSATED");
    expect(row?.compensationClaimToken).toBeNull();
    expect(row?.completedAt).toBeInstanceOf(Date);

    // Another worker tries to claim now that it is COMPENSATED
    const claimAgain = await claimCompensationAttempt({
      stepRunId: STEP_RUN_ID,
      runId: RUN_ID,
    });
    expect(claimAgain.acquired).toBe(false);
  });
});
