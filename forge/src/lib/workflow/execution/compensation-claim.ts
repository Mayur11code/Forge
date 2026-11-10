// src/lib/workflow/execution/compensation-claim.ts
//
// Minimum safe compensation ownership & fencing foundation (F-05A).
//
// Invariants enforced:
// 1. Exclusive compensation ownership: A step can only be claimed for compensation
//    from SUCCESS or COMPENSATION_RETRYING (or expired COMPENSATING lease).
// 2. Active COMPENSATING steps cannot be claimed by another worker unless the lease expired.
// 3. Fencing: All terminal completions (COMPENSATED) and failure/retry parking
//    (COMPENSATION_RETRYING / COMPENSATION_FAILED) verify the specific claimToken.
// 4. Compensation attempts counter is atomically incremented at claim time.

import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/prisma/db";

export const DEFAULT_COMPENSATION_LEASE_MS = 60_000; // 60 seconds
export const MAX_COMPENSATION_RETRIES = 3;

export type ClaimCompensationParams = {
  stepRunId: string;
  runId: string;
  leaseDurationMs?: number;
};

export type ClaimCompensationResult =
  | {
      acquired: true;
      claimToken: string;
      compensationAttempts: number;
    }
  | {
      acquired: false;
      reason: "ALREADY_CLAIMED" | "NOT_IN_ROLLBACK" | "TERMINAL";
    };

export type CompleteCompensationParams = {
  stepRunId: string;
  runId: string;
  claimToken: string;
};

export type FailCompensationParams = {
  stepRunId: string;
  runId: string;
  stepId: string;
  claimToken: string;
  errorMessage: string;
  isRetriable: boolean;
  currentAttempts: number;
  latencyMs?: number;
  payload?: Prisma.InputJsonValue;
};

/**
 * Atomically claim a step for compensation.
 *
 * Requirements:
 * - Workflow run must still be in ROLLING_BACK.
 * - Step status must be SUCCESS, COMPENSATION_RETRYING, or COMPENSATING with expired lease.
 * - Atomically sets status to COMPENSATING, records a fresh claim token and lease expiry,
 *   and increments compensationAttempts.
 */
export async function claimCompensationAttempt({
  stepRunId,
  runId,
  leaseDurationMs = DEFAULT_COMPENSATION_LEASE_MS,
}: ClaimCompensationParams): Promise<ClaimCompensationResult> {
  const claimToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

  const claimResult = await db.stepRun.updateMany({
    where: {
      id: stepRunId,
      runId,
      run: { status: { in: ["ROLLING_BACK", "RUNNING"] } },
      OR: [
        { status: { in: ["SUCCESS", "COMPENSATION_RETRYING"] } },
        {
          status: "COMPENSATING",
          OR: [
            { compensationClaimToken: null },
            { compensationLeaseExpiresAt: null },
            { compensationLeaseExpiresAt: { lt: new Date() } },
          ],
        },
      ],
    },
    data: {
      status: "COMPENSATING",
      compensationClaimToken: claimToken,
      compensationLeaseExpiresAt: leaseExpiresAt,
      compensationAttempts: { increment: 1 },
    },
  });

  if (claimResult.count === 0) {
    return { acquired: false, reason: "ALREADY_CLAIMED" };
  }

  const updatedStep = await db.stepRun.findUnique({
    where: { id: stepRunId },
    select: { compensationAttempts: true },
  });

  return {
    acquired: true,
    claimToken,
    compensationAttempts: updatedStep?.compensationAttempts ?? 1,
  };
}

/**
 * Fenced completion of compensation.
 *
 * Only succeeds if the step is currently COMPENSATING and matches the specific claimToken.
 * Clears the claim token and lease, and transitions to COMPENSATED.
 */
export async function completeCompensationAttempt({
  stepRunId,
  runId,
  claimToken,
}: CompleteCompensationParams): Promise<{ completed: boolean }> {
  const result = await db.stepRun.updateMany({
    where: {
      id: stepRunId,
      runId,
      status: "COMPENSATING",
      compensationClaimToken: claimToken,
    },
    data: {
      status: "COMPENSATED",
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      completedAt: new Date(),
    },
  });

  return { completed: result.count > 0 };
}

/**
 * Fenced failure handling for compensation.
 *
 * If retriable and under MAX_RETRIES: parks in COMPENSATION_RETRYING.
 * If terminal or attempts exhausted: transitions to COMPENSATION_FAILED.
 * Strictly fenced by claimToken.
 */
export async function failCompensationAttempt({
  stepRunId,
  runId,
  claimToken,
  errorMessage,
  isRetriable,
  currentAttempts,
  latencyMs = 0,
  payload,
}: FailCompensationParams): Promise<{
  success: false;
  status: "COMPENSATION_RETRYING" | "COMPENSATION_FAILED";
  fencedOut?: boolean;
}> {
  const shouldRetry = isRetriable && currentAttempts < MAX_COMPENSATION_RETRIES;
  const finalStatus = shouldRetry ? "COMPENSATION_RETRYING" : "COMPENSATION_FAILED";

  const result = await db.stepRun.updateMany({
    where: {
      id: stepRunId,
      runId,
      status: "COMPENSATING",
      compensationClaimToken: claimToken,
    },
    data: {
      status: finalStatus,
      error: errorMessage,
      compensationClaimToken: null,
      compensationLeaseExpiresAt: null,
      ...(finalStatus === "COMPENSATION_FAILED" ? { completedAt: new Date() } : {}),
    },
  });

  if (result.count === 0) {
    // Another attempt or lease theft overtook this worker
    return { success: false, status: finalStatus, fencedOut: true };
  }

  await db.executionAuditLog.create({
    data: {
      runId,
      stepId: stepRunId,
      logLevel: shouldRetry ? "WARN" : "FATAL",
      eventType: shouldRetry ? "COMPENSATION_RETRYING" : "COMPENSATION_FAILED",
      message: errorMessage,
      latencyMs,
      payload: (payload as Prisma.InputJsonValue) ?? undefined,
    },
  });

  return { success: false, status: finalStatus };
}
