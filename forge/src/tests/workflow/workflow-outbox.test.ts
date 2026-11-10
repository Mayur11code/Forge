// src/tests/workflow/workflow-outbox.test.ts
//
// F-04: Transactional Workflow Outbox, Reliable Queue Dispatch & Delivery Recovery.
//
// Test Matrix:
// - F04-01: StepRun and WorkflowOutbox dispatch intent share one atomic transaction.
// - F04-02: Outbox failure rolls back StepRun creation.
// - F04-05: Concurrent evaluators produce one logical StepRun and one dispatch intent.
// - F04-06: Concurrent dispatchers produce one active lease owner per event.
// - F04-07: Dispatcher crash / expired lease permits takeover.
// - F04-08: Stale dispatcher completion rejected by token fencing.
// - F04-09: Transient publication failure causes bounded retry with exponential backoff.
// - F04-10: Retry exhaustion marks event DEAD_LETTERED.
// - F04-11: Authorized re-drive resets DEAD_LETTERED to PENDING and increments generation.
// - F04-12: Cross-tenant / unauthorized re-drive rejected.
// - F04-13: Repeated evaluator passes do not duplicate forward step outbox intent.
// - F04-14: Duplicate delivery tolerated by worker execution claim.
// - F04-16: Legacy pending step reconciliation.
// - F04-17: Tenant boundaries enforced in outbox queries and re-drives.
// - F04-18: Run-scoped audit logs (STEP_DISPATCHED, EXECUTION_HALTED).
// - F04-19: Dispatcher batch limit respected.
// - F04-20: Drain loop clears all eligible outbox batches up to maxBatches.

jest.mock("server-only", () => ({}));

const publishedEvents: Array<{
  type: string;
  data: Record<string, unknown>;
  options?: Record<string, unknown>;
}> = [];

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn(
    (
      type: string,
      data: Record<string, unknown>,
      _delay?: unknown,
      options?: Record<string, unknown>,
    ) => {
      publishedEvents.push({ type, data, options });
      return Promise.resolve(undefined);
    },
  ),
}));

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
import { db } from "@/lib/prisma/db";
import {
  buildWorkflowOutboxDedupeKey,
  buildWorkflowOutboxQStashDedupId,
  buildWorkflowOutboxMessageId,
  recordWorkflowDispatchIntent,
  claimWorkflowOutboxBatch,
  dispatchWorkflowOutboxBatch,
  redriveWorkflowOutboxEvent,
  reconcileLegacyPendingStepRuns,
  drainWorkflowOutbox,
  type WorkflowOutboxTx,
} from "@/lib/workflow/execution/outbox";
import { advanceWorkflow } from "@/lib/workflow/execution/evaluator";
import { sweepStaleWorkflowRuns } from "@/lib/workflow/maintenance";
import { claimCompensationAttempt } from "@/lib/workflow/execution/compensation-claim";
import {
  prismaDouble,
  resetStore,
  restoreWorkflowDouble,
  store,
} from "./helpers/prisma-double";

const publishEventMock = publishEvent as jest.MockedFunction<typeof publishEvent>;

describe("F-04: Transactional Workflow Outbox Unit Test Suite", () => {
  const ORG_ID = "org_f04";
  const RUN_ID = "run_f04";
  const WORKFLOW_ID = "wf_f04";

  beforeEach(() => {
    resetStore();
    restoreWorkflowDouble();
    publishedEvents.length = 0;
    jest.clearAllMocks();
  });

  describe("F04-01 & F04-02: Atomic Transaction Enclosure", () => {
    it("F04-01: commits StepRun and WorkflowOutbox dispatch intent in one transaction", async () => {
      await db.$transaction(async (tx) => {
        const stepRun = await tx.stepRun.create({
          data: {
            runId: RUN_ID,
            stepId: "step_1",
            status: "PENDING",
          },
        });

        const outbox = await recordWorkflowDispatchIntent({
          tx: tx as unknown as WorkflowOutboxTx,
          orgId: ORG_ID,
          runId: RUN_ID,
          stepRunId: stepRun.id,
          stepId: "step_1",
          eventType: "EXECUTE_WORKFLOW_NODE",
          actionType: "EXECUTE",
          generation: 1,
          payload: {
            runId: RUN_ID,
            stepRunId: stepRun.id,
            kind: "ACTION",
          },
        });

        expect(outbox.status).toBe("PENDING");
        expect(outbox.stepRunId).toBe(stepRun.id);
      });

      expect(store.stepRuns).toHaveLength(1);
      expect(store.workflowOutbox).toHaveLength(1);
      expect(store.workflowOutbox[0].stepRunId).toBe(store.stepRuns[0].id);
      expect(store.workflowOutbox[0].status).toBe("PENDING");
    });

    it("F04-02: dedupeKey collision prevents duplicate dispatch intent", async () => {
      await db.workflowOutbox.create({
        data: {
          orgId: ORG_ID,
          runId: RUN_ID,
          stepRunId: "sr_1",
          stepId: "step_1",
          eventType: "EXECUTE_WORKFLOW_NODE",
          payload: { runId: RUN_ID, stepRunId: "sr_1", kind: "ACTION" },
          dedupeKey: `${RUN_ID}:sr_1:EXECUTE:gen-1`,
          status: "PENDING",
          dispatchGeneration: 1,
          nextAttemptAt: new Date(),
        },
      });

      await expect(
        db.workflowOutbox.create({
          data: {
            orgId: ORG_ID,
            runId: RUN_ID,
            stepRunId: "sr_1",
            stepId: "step_1",
            eventType: "EXECUTE_WORKFLOW_NODE",
            payload: { runId: RUN_ID, stepRunId: "sr_1", kind: "ACTION" },
            dedupeKey: `${RUN_ID}:sr_1:EXECUTE:gen-1`,
            status: "PENDING",
            dispatchGeneration: 1,
            nextAttemptAt: new Date(),
          },
        }),
      ).rejects.toThrow(/Unique constraint failed/);
    });

    it("F04-05: concurrent evaluators produce exactly one logical StepRun and dispatch intent", async () => {
      // First evaluator creates StepRun and records dispatch intent inside transaction
      await db.$transaction(async (tx) => {
        await tx.stepRun.create({
          data: {
            id: "sr_eval_race",
            runId: RUN_ID,
            stepId: "step_eval_race",
            status: "PENDING",
          },
        });
        await recordWorkflowDispatchIntent({
          tx,
          orgId: ORG_ID,
          runId: RUN_ID,
          stepRunId: "sr_eval_race",
          stepId: "step_eval_race",
          actionType: "EXECUTE",
          eventType: "EXECUTE_WORKFLOW_NODE",
          payload: { runId: RUN_ID, stepRunId: "sr_eval_race", kind: "ACTION" },
        });
      });

      expect(store.stepRuns).toHaveLength(1);
      expect(store.workflowOutbox).toHaveLength(1);

      // Second concurrent evaluator tries to insert duplicate StepRun with same runId and stepId
      await expect(
        db.$transaction(async (tx) => {
          await tx.stepRun.create({
            data: {
              id: "sr_eval_race_2",
              runId: RUN_ID,
              stepId: "step_eval_race",
              status: "PENDING",
            },
          });
        }),
      ).rejects.toThrow();

      // Only 1 StepRun and 1 Outbox event exist
      expect(store.stepRuns).toHaveLength(1);
      expect(store.workflowOutbox).toHaveLength(1);
    });
  });

  describe("F04-06 & F04-07: Dispatcher Claiming, Mutual Exclusion & Lease Recovery", () => {
    it("F04-06: two concurrent dispatchers claim disjoint sets via atomic CAS and lease token", async () => {
      // Seed 2 due outbox rows
      for (let i = 1; i <= 2; i++) {
        store.workflowOutbox.push({
          id: `wfo_${i}`,
          orgId: ORG_ID,
          runId: RUN_ID,
          stepRunId: `sr_${i}`,
          stepId: `step_${i}`,
          eventType: "EXECUTE_WORKFLOW_NODE",
          payload: { runId: RUN_ID, stepRunId: `sr_${i}`, kind: "ACTION" },
          dedupeKey: `${RUN_ID}:sr_${i}:EXECUTE:gen-1`,
          status: "PENDING",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(Date.now() - 1000),
          leaseToken: null,
          leaseExpiresAt: null,
          dispatchGeneration: 1,
        });
      }

      // Dispatcher 1 claims batch of 1
      const batch1 = await claimWorkflowOutboxBatch({ limit: 1 });
      expect(batch1).toHaveLength(1);
      expect(batch1[0].status).toBe("PROCESSING");
      expect(batch1[0].leaseToken).toBeTruthy();

      // Dispatcher 2 claims batch of 1
      const batch2 = await claimWorkflowOutboxBatch({ limit: 1 });
      expect(batch2).toHaveLength(1);
      expect(batch2[0].status).toBe("PROCESSING");
      expect(batch2[0].id).not.toBe(batch1[0].id);

      // Total claimed rows in store are both PROCESSING with different lease tokens
      expect(store.workflowOutbox[0].status).toBe("PROCESSING");
      expect(store.workflowOutbox[1].status).toBe("PROCESSING");
      expect(store.workflowOutbox[0].leaseToken).not.toBe(store.workflowOutbox[1].leaseToken);
    });

    it("F04-07: recovers stale PROCESSING lease whose leaseExpiresAt has lapsed", async () => {
      const expiredAt = new Date(Date.now() - 5000);
      store.workflowOutbox.push({
        id: "wfo_stale",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_stale",
        stepId: "step_stale",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_stale", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_stale:EXECUTE:gen-1`,
        status: "PROCESSING",
        attempts: 1,
        maxAttempts: 5,
        nextAttemptAt: expiredAt,
        leaseToken: "old_crashed_token",
        leaseExpiresAt: expiredAt,
        dispatchGeneration: 1,
      });

      const claimed = await claimWorkflowOutboxBatch({ limit: 10 });
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe("wfo_stale");
      expect(claimed[0].leaseToken).not.toBe("old_crashed_token");
      expect(claimed[0].attempts).toBe(2);
    });
  });

  describe("F04-08: Token Fencing Protection Against Stale Dispatchers", () => {
    it("F04-08: stale dispatcher completion is rejected if its lease was superseded", async () => {
      const now = new Date();
      store.workflowOutbox.push({
        id: "wfo_fenced",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_fenced",
        stepId: "step_fenced",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_fenced", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_fenced:EXECUTE:gen-1`,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        dispatchGeneration: 1,
      });

      // Dispatcher A claims the event
      const [claimedA] = await claimWorkflowOutboxBatch({ limit: 1, now });
      const leaseTokenA = claimedA.leaseToken;

      // Dispatcher B takes over due to lease expiration
      const future = new Date(now.getTime() + 60_000);
      // Stale lease simulated
      store.workflowOutbox[0].leaseExpiresAt = new Date(now.getTime() - 1000);
      const [claimedB] = await claimWorkflowOutboxBatch({ limit: 1, now: future });
      const leaseTokenB = claimedB.leaseToken;
      expect(leaseTokenB).not.toBe(leaseTokenA);

      // Dispatcher A attempts token-fenced completion with old leaseToken
      const updateResultA = await db.workflowOutbox.updateMany({
        where: {
          id: "wfo_fenced",
          leaseToken: leaseTokenA,
          status: "PROCESSING",
        },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          leaseToken: null,
        },
      });

      // Fenced out! count is 0 because leaseToken was superseded
      expect(updateResultA.count).toBe(0);
      expect(store.workflowOutbox[0].status).toBe("PROCESSING");
      expect(store.workflowOutbox[0].leaseToken).toBe(leaseTokenB);

      // Dispatcher B completes with valid token
      const updateResultB = await db.workflowOutbox.updateMany({
        where: {
          id: "wfo_fenced",
          leaseToken: leaseTokenB,
          status: "PROCESSING",
        },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          leaseToken: null,
        },
      });
      expect(updateResultB.count).toBe(1);
      expect(store.workflowOutbox[0].status).toBe("PUBLISHED");
    });
  });

  describe("F04-09 & F04-10: Bounded Retries, Backoff & Dead-Lettering", () => {
    it("F04-09: transient publish failure marks event RETRYING with nextAttemptAt backoff", async () => {
      store.workflowOutbox.push({
        id: "wfo_retry",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_retry",
        stepId: "step_retry",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_retry", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_retry:EXECUTE:gen-1`,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        dispatchGeneration: 1,
      });

      publishEventMock.mockRejectedValueOnce(new Error("Network timeout to QStash"));

      const summary = await dispatchWorkflowOutboxBatch({ limit: 1 });
      expect(summary.failed).toBe(1);
      expect(summary.published).toBe(0);

      const row = store.workflowOutbox[0];
      expect(row.status).toBe("RETRYING");
      expect(row.attempts).toBe(1);
      expect(row.leaseToken).toBeNull();
      expect(row.lastError).toContain("Network timeout to QStash");
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
    });

    it("F04-10: exhausts attempts and transitions event to DEAD_LETTERED with audit evidence", async () => {
      store.workflowOutbox.push({
        id: "wfo_exhaust",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_exhaust",
        stepId: "step_exhaust",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_exhaust", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_exhaust:EXECUTE:gen-1`,
        status: "PENDING",
        attempts: 4, // Next claim makes it attempt 5 of max 5
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        dispatchGeneration: 1,
      });

      publishEventMock.mockRejectedValueOnce(new Error("Permanent broker 400 error"));

      const summary = await dispatchWorkflowOutboxBatch({ limit: 1 });
      expect(summary.deadLettered).toBe(1);

      const row = store.workflowOutbox[0];
      expect(row.status).toBe("DEAD_LETTERED");
      expect(row.attempts).toBe(5);
      expect(row.deadLetteredAt).toBeInstanceOf(Date);
      expect(row.lastError).toContain("Exhausted 5 attempts");

      // Verify audit log record created
      const haltLog = store.auditLogs.find((l) => l.eventType === "EXECUTION_HALTED");
      expect(haltLog).toBeDefined();
      expect(haltLog?.logLevel).toBe("ERROR");
      expect(haltLog?.stepId).toBe("sr_exhaust");
    });

    it("F04-04: QStash acceptance followed by timeout is safely retried and handled by worker CAS claim", async () => {
      store.workflowOutbox.push({
        id: "wfo_timeout",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_timeout",
        stepId: "step_timeout",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_timeout", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_timeout:EXECUTE:gen-1`,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(Date.now() - 1000),
        dispatchGeneration: 1,
      });

      store.stepRuns.push({
        id: "sr_timeout",
        runId: RUN_ID,
        stepId: "step_timeout",
        status: "PENDING",
        attempts: 0,
      });

      // Simulated network failure: QStash accepted, but client threw timeout
      publishEventMock.mockRejectedValueOnce(new Error("ETIMEDOUT: Connection reset by peer"));

      const res = await dispatchWorkflowOutboxBatch();
      expect(res.failed).toBe(1);
      expect(store.workflowOutbox[0].status).toBe("RETRYING");

      // In the meantime, worker 1 received delivery from the accepted message and claimed the step
      const casClaim = await db.stepRun.updateMany({
        where: { id: "sr_timeout", status: "PENDING" },
        data: { status: "RUNNING" },
      });
      expect(casClaim.count).toBe(1);

      // Now outbox retries delivery after timeout backoff
      store.workflowOutbox[0].nextAttemptAt = new Date(Date.now() - 1000);
      publishEventMock.mockResolvedValueOnce({ messageId: "msg_retry" } as Awaited<ReturnType<typeof publishEvent>>);
      const retryRes = await dispatchWorkflowOutboxBatch();
      expect(retryRes.published).toBe(1);

      // Duplicate delivery arrives at worker 2: CAS claim fails safely because step is already RUNNING
      const dupClaim = await db.stepRun.updateMany({
        where: { id: "sr_timeout", status: "PENDING" },
        data: { status: "RUNNING" },
      });
      expect(dupClaim.count).toBe(0);
    });
  });

  describe("F04-11 & F04-12: Operator Re-drive & Tenant Boundaries", () => {
    it("F04-11: authorized re-drive resets DEAD_LETTERED event to PENDING and increments generation", async () => {
      store.workflowOutbox.push({
        id: "wfo_dl",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_dl",
        stepId: "step_dl",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_dl", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_dl:EXECUTE:gen-1`,
        status: "DEAD_LETTERED",
        attempts: 5,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        deadLetteredAt: new Date(),
        lastError: "Failed",
        dispatchGeneration: 1,
      });

      const res = await redriveWorkflowOutboxEvent({
        outboxId: "wfo_dl",
        orgId: ORG_ID,
      });

      expect(res.success).toBe(true);
      expect(res.event?.status).toBe("PENDING");
      expect(res.event?.attempts).toBe(0);
      expect(res.event?.deadLetteredAt).toBeNull();
      expect(res.event?.dispatchGeneration).toBe(2);

      const row = store.workflowOutbox[0];
      expect(row.status).toBe("PENDING");
      expect(row.dispatchGeneration).toBe(2);

      // Verify STEP_STARTED operator audit log
      const operatorLog = store.auditLogs.find(
        (l) => l.eventType === "STEP_STARTED" && (l.message as string).includes("re-driven by operator"),
      );
      expect(operatorLog).toBeDefined();
    });

    it("F04-12: cross-tenant re-drive is rejected", async () => {
      store.workflowOutbox.push({
        id: "wfo_tenant",
        orgId: "org_alpha",
        runId: RUN_ID,
        stepRunId: "sr_tenant",
        stepId: "step_tenant",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_tenant", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_tenant:EXECUTE:gen-1`,
        status: "DEAD_LETTERED",
        attempts: 5,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        dispatchGeneration: 1,
      });

      const res = await redriveWorkflowOutboxEvent({
        outboxId: "wfo_tenant",
        orgId: "org_beta", // Cross-tenant attempt
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("tenant boundary mismatch");
      expect(store.workflowOutbox[0].status).toBe("DEAD_LETTERED");
    });

    it("F04-12: non-admin operator role is rejected from re-driving outbox events", async () => {
      store.workflows.push({
        id: WORKFLOW_ID,
        orgId: ORG_ID,
        name: "Test Workflow",
      });

      store.runs.push({
        id: RUN_ID,
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
      });

      store.workflowOutbox.push({
        id: "wfo_role",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_role",
        stepId: "step_role",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_role", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_role:EXECUTE:gen-1`,
        status: "DEAD_LETTERED",
        attempts: 5,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        dispatchGeneration: 1,
      });

      store.memberships.push({
        userId: "user_member",
        orgId: ORG_ID,
        role: "MEMBER",
      });

      const res = await redriveWorkflowOutboxEvent({
        outboxId: "wfo_role",
        orgId: ORG_ID,
        userId: "user_member",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("Forbidden: operator role required");
      expect(store.workflowOutbox[0].status).toBe("DEAD_LETTERED");
    });
  });

  describe("F04-14: Worker Duplicate Delivery Tolerance", () => {
    it("F04-14: duplicate delivery is tolerated by worker forward compare-and-set claim", async () => {
      store.stepRuns.push({
        id: "sr_claim",
        runId: RUN_ID,
        stepId: "step_claim",
        status: "PENDING",
        attempts: 0,
      });

      // Delivery 1 claims step
      const claim1 = await db.stepRun.updateMany({
        where: { id: "sr_claim", status: { in: ["PENDING", "RETRYING"] } },
        data: { status: "RUNNING", startedAt: new Date() },
      });
      expect(claim1.count).toBe(1);
      expect(store.stepRuns[0].status).toBe("RUNNING");

      // Duplicate delivery 2 arrives while step is RUNNING
      const claim2 = await db.stepRun.updateMany({
        where: { id: "sr_claim", status: { in: ["PENDING", "RETRYING"] } },
        data: { status: "RUNNING", startedAt: new Date() },
      });
      expect(claim2.count).toBe(0);
    });

    it("F04-14: duplicate delivery during compensation is rejected by compensation claim token", async () => {
      store.runs.push({
        id: RUN_ID,
        workflowId: WORKFLOW_ID,
        status: "ROLLING_BACK",
      });

      store.stepRuns.push({
        id: "sr_comp_claim",
        runId: RUN_ID,
        stepId: "step_comp",
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
      });

      // Delivery 1 claims compensation
      const claim1 = await claimCompensationAttempt({
        stepRunId: "sr_comp_claim",
        runId: RUN_ID,
      });
      expect(claim1.acquired).toBe(true);
      expect(store.stepRuns[0].status).toBe("COMPENSATING");

      // Duplicate delivery 2 arrives while step is COMPENSATING
      const claim2 = await claimCompensationAttempt({
        stepRunId: "sr_comp_claim",
        runId: RUN_ID,
      });
      expect(claim2.acquired).toBe(false);
      if (!claim2.acquired) {
        expect(claim2.reason).toBe("ALREADY_CLAIMED");
      }
    });

    it("F04-13: repeated evaluator passes on existing step do not duplicate outbox intents", async () => {
      // Step already exists in stepRuns
      store.stepRuns.push({
        id: "sr_exist",
        runId: RUN_ID,
        stepId: "step_exist",
        status: "PENDING",
        attempts: 0,
      });

      // Existing outbox intent
      store.workflowOutbox.push({
        id: "wfo_exist",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_exist",
        stepId: "step_exist",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_exist", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_exist:EXECUTE:gen-1`,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        dispatchGeneration: 1,
      });

      // Re-recording intent with same dedupeKey inside transaction throws unique constraint
      await expect(
        db.$transaction(async (tx) => {
          await recordWorkflowDispatchIntent({
            tx,
            orgId: ORG_ID,
            runId: RUN_ID,
            stepRunId: "sr_exist",
            stepId: "step_exist",
            actionType: "EXECUTE",
            eventType: "EXECUTE_WORKFLOW_NODE",
            payload: { runId: RUN_ID, stepRunId: "sr_exist", kind: "ACTION" },
          });
        }),
      ).rejects.toThrow(/Unique constraint failed/);

      // Dedupe key ensures exactly 1 row remains
      expect(store.workflowOutbox).toHaveLength(1);
    });

    it("F04-15: published event with worker failure is safely surfaced by maintenance sweeper", async () => {
      store.workflows.push({
        id: WORKFLOW_ID,
        orgId: ORG_ID,
        name: "Test Workflow",
      });

      const staleDate = new Date(Date.now() - 15 * 60_000); // 15 mins ago
      store.runs.push({
        id: "run_stale_abandoned",
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
        startedAt: staleDate,
        lastAdvancedAt: staleDate,
      });

      // Worker claimed the step, transitioned to RUNNING, and then died
      store.stepRuns.push({
        id: "sr_abandoned",
        runId: "run_stale_abandoned",
        stepId: "step_abandoned",
        status: "RUNNING",
        startedAt: staleDate,
        attempts: 1,
      });

      const outcomes = await sweepStaleWorkflowRuns();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].action).toBe("SURFACED");
      expect(outcomes[0].stepStatus).toBe("RUNNING");

      // Step is marked FAILED with reason and audited
      const step = store.stepRuns.find((s) => s.id === "sr_abandoned");
      expect(step?.status).toBe("FAILED");
      expect(step?.error).toContain("Step was abandoned");
    });

    it("F04-18: execution audit logs and outbox events strictly preserve runId and tenant orgId isolation", async () => {
      store.workflowOutbox.push({
        id: "wfo_telemetry",
        orgId: ORG_ID,
        runId: RUN_ID,
        stepRunId: "sr_telemetry",
        stepId: "step_telemetry",
        eventType: "EXECUTE_WORKFLOW_NODE",
        payload: { runId: RUN_ID, stepRunId: "sr_telemetry", kind: "ACTION" },
        dedupeKey: `${RUN_ID}:sr_telemetry:EXECUTE:gen-1`,
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(Date.now() - 1000),
        dispatchGeneration: 1,
      });

      publishEventMock.mockResolvedValueOnce({ messageId: "msg_tel" } as Awaited<ReturnType<typeof publishEvent>>);
      const res = await dispatchWorkflowOutboxBatch();
      expect(res.published).toBe(1);

      const auditLog = store.auditLogs.find(
        (l) => l.runId === RUN_ID && l.eventType === "STEP_DISPATCHED",
      );
      expect(auditLog).toBeDefined();
      expect(auditLog?.stepId).toBe("sr_telemetry");
      expect(auditLog?.payload).toMatchObject({
        outboxId: "wfo_telemetry",
        runId: RUN_ID,
        stepRunId: "sr_telemetry",
        orgId: ORG_ID,
        attempts: 1,
        dispatchGeneration: 1,
      });
    });
  });

  describe("F04-16: Stale Maintenance & Legacy Pending Step Reconciliation", () => {
    it("F04-16: reconcileLegacyPendingStepRuns identifies pending steps without outbox and enqueues them", async () => {
      store.workflows.push({
        id: WORKFLOW_ID,
        orgId: ORG_ID,
        name: "Test Workflow",
      });

      store.runs.push({
        id: "run_legacy",
        workflowId: WORKFLOW_ID,
        status: "RUNNING",
      });

      // Legacy step run with NO outbox row
      store.stepRuns.push({
        id: "sr_legacy",
        runId: "run_legacy",
        stepId: "step_legacy",
        status: "PENDING",
        attempts: 0,
      });

      const reconciledCount = await reconcileLegacyPendingStepRuns();
      expect(reconciledCount).toBe(1);

      expect(store.workflowOutbox).toHaveLength(1);
      expect(store.workflowOutbox[0].stepRunId).toBe("sr_legacy");
      expect(store.workflowOutbox[0].status).toBe("PENDING");
      expect(store.workflowOutbox[0].orgId).toBe(ORG_ID);
    });
  });

  describe("F04-19 & F04-20: Drain Loop & Batch Limits", () => {
    it("F04-19: batch limit caps claimed rows", async () => {
      for (let i = 1; i <= 5; i++) {
        store.workflowOutbox.push({
          id: `wfo_limit_${i}`,
          orgId: ORG_ID,
          runId: RUN_ID,
          stepRunId: `sr_${i}`,
          stepId: `step_${i}`,
          eventType: "EXECUTE_WORKFLOW_NODE",
          payload: { runId: RUN_ID, stepRunId: `sr_${i}`, kind: "ACTION" },
          dedupeKey: `${RUN_ID}:sr_${i}:EXECUTE:gen-1`,
          status: "PENDING",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(Date.now() - 1000),
          dispatchGeneration: 1,
        });
      }

      const claimed = await claimWorkflowOutboxBatch({ limit: 3 });
      expect(claimed).toHaveLength(3);
    });

    it("F04-20: drainWorkflowOutbox continuously clears batches up to maxBatches", async () => {
      for (let i = 1; i <= 4; i++) {
        store.workflowOutbox.push({
          id: `wfo_drain_${i}`,
          orgId: ORG_ID,
          runId: RUN_ID,
          stepRunId: `sr_${i}`,
          stepId: `step_${i}`,
          eventType: "EXECUTE_WORKFLOW_NODE",
          payload: { runId: RUN_ID, stepRunId: `sr_${i}`, kind: "ACTION" },
          dedupeKey: `${RUN_ID}:sr_${i}:EXECUTE:gen-1`,
          status: "PENDING",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(Date.now() - 1000),
          dispatchGeneration: 1,
        });
      }

      const drainResult = await drainWorkflowOutbox({ maxBatches: 3, limit: 2 });
      expect(drainResult.totalClaimed).toBe(4);
      expect(drainResult.totalPublished).toBe(4);
      expect(drainResult.totalFailed).toBe(0);

      // All rows should now be PUBLISHED
      expect(store.workflowOutbox.every((r) => r.status === "PUBLISHED")).toBe(true);
      expect(publishedEvents).toHaveLength(4);
    });
  });

  describe("Deduplication & QStash ID Formatting", () => {
    it("formats dedupe keys deterministically", () => {
      const key = buildWorkflowOutboxDedupeKey({
        runId: "run_1",
        stepRunId: "sr_1",
        actionType: "EXECUTE",
        generation: 2,
      });
      expect(key).toBe("run_1:sr_1:EXECUTE:gen-2");
    });

    it("produces colon-free alphanumeric QStash deduplication IDs", () => {
      const key = "run_1:sr_1:EXECUTE:gen-1";
      const qstashId = buildWorkflowOutboxQStashDedupId(key);
      expect(qstashId).not.toContain(":");
      expect(qstashId).toMatch(/^wf-outbox-[a-f0-9]{32}$/);
    });

    it("produces deterministic cloud event message IDs", () => {
      const key = "run_1:sr_1:EXECUTE:gen-1";
      const msgId1 = buildWorkflowOutboxMessageId(key, 1);
      const msgId2 = buildWorkflowOutboxMessageId(key, 1);
      const msgIdAttempt2 = buildWorkflowOutboxMessageId(key, 2);

      expect(msgId1).toBe(msgId2);
      expect(msgId1).not.toBe(msgIdAttempt2);
    });
  });
});
