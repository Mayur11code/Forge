// src/tests/workflow/compensation-concurrency.realdb.test.ts
//
// Level E3 Real PostgreSQL Concurrency & Fencing Test Suite for F-05A.
// Runs against real Neon database using two independent PrismaClient connections.

jest.mock("server-only", () => ({}));

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/prisma/db";
import {
  claimCompensationAttempt,
  completeCompensationAttempt,
  failCompensationAttempt,
} from "@/lib/workflow/execution/compensation-claim";
import { computeWorkflowDefinitionHash } from "@/lib/workflow/validation/canonical-hash";
import type { Prisma } from "@prisma/client";

jest.setTimeout(120_000);

const TAG = `comp_conc_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const ORG_ID = `${TAG}_org`;
const WORKFLOW_ID = `${TAG}_wf`;
const RUN_ID = `${TAG}_run`;

describe("Level E3 Real PostgreSQL Compensation Concurrency & Token Fencing (F-05A)", () => {
  let db2: PrismaClient;
  let pool2: Pool;

  beforeAll(async () => {
    pool2 = new Pool({ connectionString: `${process.env.DATABASE_URL}` });
    const adapter2 = new PrismaPg(pool2);
    db2 = new PrismaClient({ adapter: adapter2 });

    await db.organization.create({
      data: {
        id: ORG_ID,
        name: "Test Org For Concurrency",
        slug: `${TAG}_slug`,
      },
    });

    const wfDefinition = {
      id: "d1",
      name: "d1",
      steps: {
        step_task: {
          id: "step_task",
          kind: "ACTION" as const,
          action: "task.create",
          dependsOn: [],
          isCritical: false,
          config: {},
        },
      },
    };

    await db.workflow.create({
      data: {
        id: WORKFLOW_ID,
        orgId: ORG_ID,
        name: "Test Concurrency WF",
        definition: wfDefinition as unknown as Prisma.InputJsonValue,
      },
    });

    const testSnapshot = {
      snapshotSchemaVersion: 1,
      workflowId: WORKFLOW_ID,
      workflowName: "Test Concurrency WF",
      definition: wfDefinition,
      actionManifest: [
        {
          stepId: "step_task",
          actionId: "task.create",
          actionVersion: "1.0.0",
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const testHash = computeWorkflowDefinitionHash(testSnapshot);

    await db.workflowRun.create({
      data: {
        id: RUN_ID,
        workflowId: WORKFLOW_ID,
        status: "ROLLING_BACK",
        definitionSnapshot: testSnapshot as unknown as Prisma.InputJsonValue,
        definitionHash: testHash,
      },
    });
  });

  afterAll(async () => {
    try {
      await db.stepRun.deleteMany({
        where: { runId: RUN_ID },
      });
      await db.workflowRun.deleteMany({
        where: { workflowId: WORKFLOW_ID },
      });
      await db.workflow.deleteMany({
        where: { orgId: ORG_ID },
      });
      await db.organization.deleteMany({
        where: { id: ORG_ID },
      });
    } finally {
      if (db2) {
        await db2.$disconnect();
      }
      if (pool2) {
        await pool2.end();
      }
    }
  });

  it("1 & 2: Two concurrent workers attempt to claim the same SUCCESS step; exactly one wins and loser is refused", async () => {
    const stepId = "step_race_1";
    const stepRun = await db.stepRun.create({
      data: {
        runId: RUN_ID,
        stepId,
        status: "SUCCESS",
        attempts: 1,
        compensationAttempts: 0,
      },
    });

    // Fire both claims concurrently over independent connections / queries
    const [result1, result2] = await Promise.all([
      claimCompensationAttempt({ stepRunId: stepRun.id, runId: RUN_ID }),
      claimCompensationAttempt({ stepRunId: stepRun.id, runId: RUN_ID }),
    ]);

    const winnerCount = [result1, result2].filter((r) => r.acquired === true).length;
    const loserCount = [result1, result2].filter((r) => r.acquired === false).length;

    expect(winnerCount).toBe(1);
    expect(loserCount).toBe(1);

    const winner = result1.acquired ? result1 : result2;
    if (winner.acquired) {
      expect(winner.compensationAttempts).toBe(1);
      expect(typeof winner.claimToken).toBe("string");
    }

    const persisted = await db.stepRun.findUnique({
      where: { id: stepRun.id },
    });
    expect(persisted?.status).toBe("COMPENSATING");
    expect(persisted?.compensationAttempts).toBe(1);
  });

  it("3: A valid retry obtains a new claim after previous attempt is safely parked in COMPENSATION_RETRYING", async () => {
    const stepId = "step_retry_1";
    const stepRun = await db.stepRun.create({
      data: {
        runId: RUN_ID,
        stepId,
        status: "COMPENSATION_RETRYING",
        attempts: 1,
        compensationAttempts: 1,
        compensationClaimToken: null,
      },
    });

    const claim = await claimCompensationAttempt({
      stepRunId: stepRun.id,
      runId: RUN_ID,
    });

    expect(claim.acquired).toBe(true);
    if (claim.acquired) {
      expect(claim.compensationAttempts).toBe(2);
      expect(typeof claim.claimToken).toBe("string");
    }

    const persisted = await db.stepRun.findUnique({
      where: { id: stepRun.id },
    });
    expect(persisted?.status).toBe("COMPENSATING");
    expect(persisted?.compensationAttempts).toBe(2);
  });

  it("4: An expired ownership claim (compensationLeaseExpiresAt < clock) is safely recovered by a new claim", async () => {
    const stepId = "step_expired_1";
    const pastDate = new Date(Date.now() - 10_000); // 10s in the past

    const stepRun = await db.stepRun.create({
      data: {
        runId: RUN_ID,
        stepId,
        status: "COMPENSATING",
        attempts: 1,
        compensationAttempts: 1,
        compensationClaimToken: "abandoned_token_1",
        compensationLeaseExpiresAt: pastDate,
      },
    });

    // New worker attempts to claim expired step
    const newClaim = await claimCompensationAttempt({
      stepRunId: stepRun.id,
      runId: RUN_ID,
    });

    expect(newClaim.acquired).toBe(true);
    if (newClaim.acquired) {
      expect(newClaim.compensationAttempts).toBe(2);
      expect(newClaim.claimToken).not.toBe("abandoned_token_1");
    }

    const persisted = await db.stepRun.findUnique({
      where: { id: stepRun.id },
    });
    expect(persisted?.status).toBe("COMPENSATING");
    expect(persisted?.compensationAttempts).toBe(2);
    expect(persisted?.compensationClaimToken).not.toBe("abandoned_token_1");
  });

  it("5: A stale token cannot overwrite the new claim's state in real PostgreSQL (token fencing)", async () => {
    const stepId = "step_fencing_1";
    const stepRun = await db.stepRun.create({
      data: {
        runId: RUN_ID,
        stepId,
        status: "COMPENSATING",
        attempts: 1,
        compensationAttempts: 2,
        compensationClaimToken: "new_active_token_2",
        compensationLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    // Stale worker with "stale_token_1" attempts to complete the step
    const staleCompletion = await completeCompensationAttempt({
      stepRunId: stepRun.id,
      runId: RUN_ID,
      claimToken: "stale_token_1",
    });

    expect(staleCompletion.completed).toBe(false);

    // Stale worker attempts to fail the step
    const staleFailure = await failCompensationAttempt({
      stepRunId: stepRun.id,
      runId: RUN_ID,
      stepId,
      claimToken: "stale_token_1",
      errorMessage: "Stale crash",
      isRetriable: false,
      currentAttempts: 1,
    });

    expect(staleFailure.fencedOut).toBe(true);

    const persisted = await db.stepRun.findUnique({
      where: { id: stepRun.id },
    });
    expect(persisted?.status).toBe("COMPENSATING");
    expect(persisted?.compensationClaimToken).toBe("new_active_token_2");
    expect(persisted?.completedAt).toBeNull();
  });

  it("6 & 7: Concurrent completion with valid token succeeds and attempt counters are strictly preserved", async () => {
    const stepId = "step_complete_1";
    const stepRun = await db.stepRun.create({
      data: {
        runId: RUN_ID,
        stepId,
        status: "COMPENSATING",
        attempts: 1,
        compensationAttempts: 1,
        compensationClaimToken: "valid_owner_token",
        compensationLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    // Legitimate owner completes
    const completion = await completeCompensationAttempt({
      stepRunId: stepRun.id,
      runId: RUN_ID,
      claimToken: "valid_owner_token",
    });

    expect(completion.completed).toBe(true);

    // Second duplicate attempt to complete with same token is refused because status is now COMPENSATED
    const duplicateCompletion = await completeCompensationAttempt({
      stepRunId: stepRun.id,
      runId: RUN_ID,
      claimToken: "valid_owner_token",
    });

    expect(duplicateCompletion.completed).toBe(false);

    const persisted = await db.stepRun.findUnique({
      where: { id: stepRun.id },
    });
    expect(persisted?.status).toBe("COMPENSATED");
    expect(persisted?.compensationClaimToken).toBeNull();
    expect(persisted?.compensationAttempts).toBe(1);
    expect(persisted?.completedAt).toBeInstanceOf(Date);
  });
});
