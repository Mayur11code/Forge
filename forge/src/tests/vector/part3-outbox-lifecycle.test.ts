// forge/src/tests/vector/part3-outbox-lifecycle.test.ts
/**
 * Forge Vector V2 — Phase B Remediation: Part 3
 * Outbox Dispatch State Machine & Forward Migration Unit / Controlled Production-Path Suite (E2)
 *
 * Verifies all 17 mandatory acceptance cases from Section 7.1:
 *
 * Claim lifecycle (cases 1–4):
 *   1. One dispatcher successfully claims an eligible event.
 *   2. Concurrent dispatchers cannot both own the same valid claim.
 *   3. An expired claim can be reclaimed according to contract.
 *   4. A stale token cannot renew or mutate the new owner's claim.
 *
 * Publish outcomes (cases 5–8):
 *   5. Successful publication records the correct durable state.
 *   6. An uncertain publish result is handled without creating a second logical event.
 *   7. A delayed failure cannot reopen an event completed by the worker.
 *   8. A duplicate failure callback cannot increment retry accounting twice.
 *
 * Retry lifecycle (cases 9–13):
 *   9. First failure schedules the exact canonical delay (5s).
 *  10. Subsequent failures schedule the exact exponential progression (10s, 20s, 40s).
 *  11. The retry cap is respected (maxAttempts = 5).
 *  12. Maximum-attempt exhaustion produces the correct terminal state.
 *  13. A stale dispatcher cannot reschedule or overwrite a newer retry.
 *
 * Supersession and idempotency (cases 14–17):
 *  14. A genuinely newer pending revision can supersede older work according to contract.
 *  15. Older work cannot supersede a newer revision.
 *  16. Duplicate delivery of the same outboxEventId does not create duplicate logical processing.
 *  17. A SUCCESS EventLog cannot be reopened by a delayed dispatcher failure.
 */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn().mockResolvedValue({ messageId: "msg_mock_123" }),
}));

import { VectorEntityType, VectorOutboxStatus } from "@prisma/client";
import {
  claimVectorOutboxBatch,
  renewVectorOutboxClaimLease,
  markVectorOutboxDispatched,
  completeVectorOutboxEvent,
  handleVectorOutboxPublishFailure,
  dispatchVectorOutboxBatch,
} from "@/lib/vector/outbox";
import { publishEvent } from "@/lib/events/queue";

interface OutboxRow {
  id: string;
  orgId: string;
  entityType: VectorEntityType;
  entityId: string;
  sourceRevision: number;
  contentHash: string;
  pipelineVersion: string;
  parentTaskVersion: string | null;
  status: VectorOutboxStatus;
  dispatchClaimToken: string | null;
  dispatchLeaseExpiresAt: Date | null;
  dispatchAttempts: number;
  nextRetryAt: Date | null;
  terminalError: string | null;
  lastDispatchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

class MockOutboxDb {
  public rows = new Map<string, OutboxRow>();
  public currentTime: number = Date.now();

  public advanceTime(ms: number) {
    this.currentTime += ms;
  }

  public insert(row: Partial<OutboxRow> & { id: string; orgId: string; entityType: VectorEntityType; entityId: string }) {
    const fullRow: OutboxRow = {
      id: row.id,
      orgId: row.orgId,
      entityType: row.entityType,
      entityId: row.entityId,
      sourceRevision: row.sourceRevision ?? 1,
      contentHash: row.contentHash ?? "hash_init",
      pipelineVersion: row.pipelineVersion ?? "v2",
      parentTaskVersion: row.parentTaskVersion ?? null,
      status: row.status ?? "PENDING",
      dispatchClaimToken: row.dispatchClaimToken ?? null,
      dispatchLeaseExpiresAt: row.dispatchLeaseExpiresAt ?? null,
      dispatchAttempts: row.dispatchAttempts ?? 0,
      nextRetryAt: row.nextRetryAt ?? null,
      terminalError: row.terminalError ?? null,
      lastDispatchedAt: row.lastDispatchedAt ?? null,
      createdAt: row.createdAt ?? new Date(this.currentTime),
      updatedAt: row.updatedAt ?? new Date(this.currentTime),
    };
    this.rows.set(row.id, fullRow);
    return fullRow;
  }

  public $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join("?");
    const now = new Date(this.currentTime);

    // 1. claimVectorOutboxBatch
    if (sql.includes('WITH candidates AS') && sql.includes('FOR UPDATE SKIP LOCKED')) {
      const batchSize = parseInt(values[0], 10) || 25;
      const claimToken = values[1];
      const leaseSeconds = parseInt(values[2], 10) || 60;

      const candidates: OutboxRow[] = [];
      for (const row of Array.from(this.rows.values()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
        const isEligiblePending =
          row.status === "PENDING" && (!row.nextRetryAt || row.nextRetryAt.getTime() <= this.currentTime);
        const isExpiredClaim =
          row.status === "CLAIMED" && row.dispatchLeaseExpiresAt !== null && row.dispatchLeaseExpiresAt.getTime() < this.currentTime;

        if (isEligiblePending || isExpiredClaim) {
          candidates.push(row);
          if (candidates.length >= batchSize) break;
        }
      }

      const claimed: any[] = [];
      for (const row of candidates) {
        row.status = "CLAIMED";
        row.dispatchClaimToken = claimToken;
        row.dispatchLeaseExpiresAt = new Date(this.currentTime + leaseSeconds * 1000);
        row.updatedAt = now;
        claimed.push({
          id: row.id,
          orgId: row.orgId,
          entityType: row.entityType,
          entityId: row.entityId,
          sourceRevision: row.sourceRevision,
          contentHash: row.contentHash,
          pipelineVersion: row.pipelineVersion,
          parentTaskVersion: row.parentTaskVersion,
          dispatchAttempts: row.dispatchAttempts,
        });
      }
      return claimed;
    }

    // 2. renewVectorOutboxClaimLease
    if (sql.includes('UPDATE "VectorOutboxEvent"') && sql.includes('"dispatchLeaseExpiresAt" = clock_timestamp() +') && !sql.includes('SET "status" =')) {
      const extensionSeconds = parseInt(values[0], 10) || 60;
      const outboxEventId = values[1];
      const claimToken = values[2];

      const row = this.rows.get(outboxEventId);
      if (
        row &&
        row.status === "CLAIMED" &&
        row.dispatchClaimToken === claimToken &&
        row.dispatchLeaseExpiresAt &&
        row.dispatchLeaseExpiresAt.getTime() > this.currentTime
      ) {
        row.dispatchLeaseExpiresAt = new Date(this.currentTime + extensionSeconds * 1000);
        row.updatedAt = now;
        return [{ id: row.id }];
      }
      return [];
    }

    // 3. markVectorOutboxDispatched
    if (sql.includes('UPDATE "VectorOutboxEvent"') && sql.includes('"status" = \'DISPATCHED\'::"VectorOutboxStatus"')) {
      const leaseSeconds = parseInt(values[0], 10) || 600;
      const outboxEventId = values[1];
      const claimToken = values[2];

      const row = this.rows.get(outboxEventId);
      if (
        row &&
        row.status === "CLAIMED" &&
        row.dispatchClaimToken === claimToken &&
        row.dispatchLeaseExpiresAt &&
        row.dispatchLeaseExpiresAt.getTime() > this.currentTime
      ) {
        row.status = "DISPATCHED";
        row.dispatchLeaseExpiresAt = new Date(this.currentTime + leaseSeconds * 1000);
        row.lastDispatchedAt = now;
        row.updatedAt = now;
        return [{ id: row.id, status: row.status }];
      }
      return [];
    }

    // 4. completeVectorOutboxEvent
    if (sql.includes('UPDATE "VectorOutboxEvent"') && sql.includes('"status" = \'COMPLETED\'::"VectorOutboxStatus"')) {
      const outboxEventId = values[0];
      const row = this.rows.get(outboxEventId);
      if (row && row.status !== "COMPLETED") {
        row.status = "COMPLETED";
        row.dispatchClaimToken = null;
        row.dispatchLeaseExpiresAt = null;
        row.updatedAt = now;
        return [{ id: row.id }];
      }
      return [];
    }

    // 5. handleVectorOutboxPublishFailure — Check initial claimed row
    if (sql.includes('SELECT id, "entityType", "entityId", "sourceRevision", "dispatchAttempts"') && sql.includes('FROM "VectorOutboxEvent"') && sql.includes('WHERE id =')) {
      const outboxEventId = values[0];
      const dispatchClaimToken = values[1];
      const row = this.rows.get(outboxEventId);
      if (
        row &&
        row.status === "CLAIMED" &&
        row.dispatchClaimToken === dispatchClaimToken &&
        row.dispatchLeaseExpiresAt &&
        row.dispatchLeaseExpiresAt.getTime() > this.currentTime
      ) {
        return [{
          id: row.id,
          entityType: row.entityType,
          entityId: row.entityId,
          sourceRevision: row.sourceRevision,
          dispatchAttempts: row.dispatchAttempts,
        }];
      }
      return [];
    }

    // 6. handleVectorOutboxPublishFailure — Newer pending supersession check
    if (sql.includes('FROM "VectorOutboxEvent"') && sql.includes('"status" = \'PENDING\'::"VectorOutboxStatus"') && sql.includes('"sourceRevision" >')) {
      const entityType = values[0];
      const entityId = values[1];
      const outboxEventId = values[2];
      const sourceRevision = values[3];

      const newer: any[] = [];
      for (const row of this.rows.values()) {
        if (
          row.entityType === entityType &&
          row.entityId === entityId &&
          row.id !== outboxEventId &&
          row.status === "PENDING" &&
          row.sourceRevision > sourceRevision
        ) {
          newer.push({ id: row.id, sourceRevision: row.sourceRevision });
        }
      }
      return newer;
    }

    // 7. handleVectorOutboxPublishFailure — UPDATE superseded to FAILED
    if (
      sql.includes('UPDATE "VectorOutboxEvent"') &&
      sql.includes('"status" = \'FAILED\'::"VectorOutboxStatus"') &&
      !sql.includes('"dispatchAttempts" =')
    ) {
      const terminalError = values[0];
      const outboxEventId = values[1];
      const claimToken = values[2];

      const row = this.rows.get(outboxEventId);
      if (
        row &&
        row.status === "CLAIMED" &&
        row.dispatchClaimToken === claimToken &&
        row.dispatchLeaseExpiresAt &&
        row.dispatchLeaseExpiresAt.getTime() > this.currentTime
      ) {
        row.status = "FAILED";
        row.dispatchClaimToken = null;
        row.dispatchLeaseExpiresAt = null;
        row.terminalError = terminalError;
        row.updatedAt = now;
        return [{ id: row.id }];
      }
      return [];
    }

    // 8. handleVectorOutboxPublishFailure — UPDATE terminal FAILED (maxAttempts exhausted)
    if (sql.includes('UPDATE "VectorOutboxEvent"') && sql.includes('"status" = \'FAILED\'::"VectorOutboxStatus"') && sql.includes('"dispatchAttempts" =')) {
      const newAttempts = values[0];
      const terminalError = values[1];
      const outboxEventId = values[2];
      const claimToken = values[3];

      const row = this.rows.get(outboxEventId);
      if (
        row &&
        row.status === "CLAIMED" &&
        row.dispatchClaimToken === claimToken &&
        row.dispatchLeaseExpiresAt &&
        row.dispatchLeaseExpiresAt.getTime() > this.currentTime
      ) {
        row.status = "FAILED";
        row.dispatchClaimToken = null;
        row.dispatchLeaseExpiresAt = null;
        row.dispatchAttempts = newAttempts;
        row.terminalError = terminalError;
        row.updatedAt = now;
        return [{ id: row.id, dispatchAttempts: row.dispatchAttempts }];
      }
      return [];
    }

    // 9. handleVectorOutboxPublishFailure — UPDATE retry PENDING with canonical backoff
    if (sql.includes('UPDATE "VectorOutboxEvent"') && sql.includes('"status" = \'PENDING\'::"VectorOutboxStatus"') && sql.includes('"nextRetryAt" = clock_timestamp() +')) {
      const newAttempts = values[0];
      const backoffSeconds = values[1];
      const terminalError = values[2];
      const outboxEventId = values[3];
      const claimToken = values[4];

      const row = this.rows.get(outboxEventId);
      if (
        row &&
        row.status === "CLAIMED" &&
        row.dispatchClaimToken === claimToken &&
        row.dispatchLeaseExpiresAt &&
        row.dispatchLeaseExpiresAt.getTime() > this.currentTime
      ) {
        row.status = "PENDING";
        row.dispatchClaimToken = null;
        row.dispatchLeaseExpiresAt = null;
        row.dispatchAttempts = newAttempts;
        row.nextRetryAt = new Date(this.currentTime + backoffSeconds * 1000);
        row.terminalError = terminalError;
        row.updatedAt = now;
        return [{ id: row.id, dispatchAttempts: row.dispatchAttempts, nextRetryAt: row.nextRetryAt }];
      }
      return [];
    }

    // 10. Check current status fallback
    if (sql.includes('SELECT "status" FROM "VectorOutboxEvent" WHERE id =')) {
      const outboxEventId = values[0];
      const row = this.rows.get(outboxEventId);
      if (!row) return [];
      return [{ status: row.status }];
    }

    throw new Error(`Unhandled SQL in MockOutboxDb: ${sql}`);
  });
}

describe("Part 3 — Outbox Dispatch State Machine Production Lifecycle (E2)", () => {
  let mockDb: MockOutboxDb;

  beforeEach(() => {
    mockDb = new MockOutboxDb();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // AREA 1: CLAIM LIFECYCLE (Cases 1–4)
  // ===========================================================================
  describe("Area 1: Claim Lifecycle", () => {
    it("1. One dispatcher successfully claims an eligible event", async () => {
      mockDb.insert({
        id: "evt_claim_1",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_1",
        status: "PENDING",
      });

      const token = "disp_worker_1";
      const { rows, claimToken } = await claimVectorOutboxBatch({
        db: mockDb as any,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: token,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("evt_claim_1");
      expect(claimToken).toBe(token);

      const saved = mockDb.rows.get("evt_claim_1");
      expect(saved?.status).toBe("CLAIMED");
      expect(saved?.dispatchClaimToken).toBe(token);
      expect(saved?.dispatchLeaseExpiresAt?.getTime()).toBeGreaterThan(mockDb.currentTime);
    });

    it("2. Concurrent dispatchers cannot both own the same valid claim", async () => {
      mockDb.insert({
        id: "evt_claim_2",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_2",
        status: "PENDING",
      });

      // Dispatcher A claims
      const claimA = await claimVectorOutboxBatch({
        db: mockDb as any,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: "token_A",
      });
      expect(claimA.rows).toHaveLength(1);
      expect(claimA.rows[0].id).toBe("evt_claim_2");

      // Dispatcher B attempts to claim while A's lease is active
      const claimB = await claimVectorOutboxBatch({
        db: mockDb as any,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: "token_B",
      });
      expect(claimB.rows).toHaveLength(0);

      // Ownership remains with Dispatcher A
      const saved = mockDb.rows.get("evt_claim_2");
      expect(saved?.dispatchClaimToken).toBe("token_A");
    });

    it("3. An expired claim can be reclaimed according to contract", async () => {
      mockDb.insert({
        id: "evt_claim_3",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_3",
        status: "CLAIMED",
        dispatchClaimToken: "crashed_worker_token",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 30_000),
      });

      // Before expiry: cannot be reclaimed
      const earlyReclaim = await claimVectorOutboxBatch({
        db: mockDb as any,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: "new_worker_token",
      });
      expect(earlyReclaim.rows).toHaveLength(0);

      // Advance time past the lease expiration
      mockDb.advanceTime(35_000);

      // After expiry: successfully reclaimed by new worker
      const lateReclaim = await claimVectorOutboxBatch({
        db: mockDb as any,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: "new_worker_token",
      });
      expect(lateReclaim.rows).toHaveLength(1);
      expect(lateReclaim.rows[0].id).toBe("evt_claim_3");

      const saved = mockDb.rows.get("evt_claim_3");
      expect(saved?.status).toBe("CLAIMED");
      expect(saved?.dispatchClaimToken).toBe("new_worker_token");
    });

    it("4. A stale token cannot renew or mutate the new owner's claim", async () => {
      mockDb.insert({
        id: "evt_claim_4",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_4",
        status: "CLAIMED",
        dispatchClaimToken: "original_stale_token",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 10_000),
      });

      // Lease expires and worker B steals it
      mockDb.advanceTime(15_000);
      await claimVectorOutboxBatch({
        db: mockDb as any,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: "new_owner_token",
      });

      // 1. Stale token renewal fails
      const renewed = await renewVectorOutboxClaimLease({
        db: mockDb as any,
        outboxEventId: "evt_claim_4",
        dispatchClaimToken: "original_stale_token",
      });
      expect(renewed).toBe(false);

      // 2. Stale token markDispatched fails
      const marked = await markVectorOutboxDispatched({
        db: mockDb as any,
        outboxEventId: "evt_claim_4",
        dispatchClaimToken: "original_stale_token",
      });
      expect(marked.ok).toBe(false);
      expect((marked as any).reason).toBe("CLAIM_LOST_OR_EXPIRED");

      // Verify ownership remains strictly with new_owner_token
      const saved = mockDb.rows.get("evt_claim_4");
      expect(saved?.dispatchClaimToken).toBe("new_owner_token");
      expect(saved?.status).toBe("CLAIMED");
    });
  });

  // ===========================================================================
  // AREA 2: PUBLISH OUTCOMES (Cases 5–8)
  // ===========================================================================
  describe("Area 2: Publish Outcomes", () => {
    it("5. Successful publication records the correct durable state", async () => {
      mockDb.insert({
        id: "evt_pub_5",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_5",
        status: "CLAIMED",
        dispatchClaimToken: "active_dispatcher_tok",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
      });

      const res = await markVectorOutboxDispatched({
        db: mockDb as any,
        outboxEventId: "evt_pub_5",
        dispatchClaimToken: "active_dispatcher_tok",
        leaseSeconds: 600,
      });

      expect(res.ok).toBe(true);
      expect((res as any).status).toBe("DISPATCHED");

      const saved = mockDb.rows.get("evt_pub_5");
      expect(saved?.status).toBe("DISPATCHED");
      expect(saved?.lastDispatchedAt).not.toBeNull();
      expect(saved?.dispatchLeaseExpiresAt?.getTime()).toBe(mockDb.currentTime + 600_000);
      // Successful publication does NOT increment failure dispatchAttempts
      expect(saved?.dispatchAttempts).toBe(0);
    });

    it("6. An uncertain publish result is handled without creating a second logical event", async () => {
      const originalEventId = "evt_pub_6";
      mockDb.insert({
        id: originalEventId,
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_6",
        sourceRevision: 1,
        contentHash: "hash_task_6",
        status: "CLAIMED",
        dispatchClaimToken: "disp_tok_6",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 0,
      });

      // Simulate network timeout / ambiguous publish outcome
      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: originalEventId,
        dispatchClaimToken: "disp_tok_6",
        error: new Error("Network timeout: publish ACK lost"),
        maxAttempts: 5,
      });

      expect(res.status).toBe("RETRY_SCHEDULED");
      expect((res as any).attempts).toBe(1);

      // Verify the SAME logical event ID was preserved, NO duplicate record created
      expect(mockDb.rows.size).toBe(1);
      const saved = mockDb.rows.get(originalEventId);
      expect(saved?.id).toBe(originalEventId);
      expect(saved?.status).toBe("PENDING");
      expect(saved?.dispatchAttempts).toBe(1);
    });

    it("7. A delayed failure cannot reopen an event completed by the worker", async () => {
      mockDb.insert({
        id: "evt_pub_7",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_7",
        status: "CLAIMED",
        dispatchClaimToken: "disp_tok_7",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 0,
      });

      // Downstream worker completes the event first
      await completeVectorOutboxEvent({
        db: mockDb as any,
        outboxEventId: "evt_pub_7",
      });

      const completedRow = mockDb.rows.get("evt_pub_7");
      expect(completedRow?.status).toBe("COMPLETED");

      // Delayed dispatcher publish failure arrives AFTER worker completed
      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_pub_7",
        dispatchClaimToken: "disp_tok_7",
        error: new Error("Delayed publish ack failure"),
      });

      // Must detect ALREADY_COMPLETED and never reopen to PENDING or FAILED
      expect(res.status).toBe("ALREADY_COMPLETED");
      const saved = mockDb.rows.get("evt_pub_7");
      expect(saved?.status).toBe("COMPLETED");
      expect(saved?.dispatchAttempts).toBe(0);
    });

    it("8. A duplicate failure callback cannot increment retry accounting twice", async () => {
      mockDb.insert({
        id: "evt_pub_8",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_8",
        status: "CLAIMED",
        dispatchClaimToken: "disp_tok_8",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 0,
      });

      // First failure callback arrives
      const res1 = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_pub_8",
        dispatchClaimToken: "disp_tok_8",
        error: new Error("Publish 500 error"),
        maxAttempts: 5,
      });
      expect(res1.status).toBe("RETRY_SCHEDULED");
      expect((res1 as any).attempts).toBe(1);

      // Row status is now PENDING and dispatchClaimToken was cleared
      const rowAfterFirst = mockDb.rows.get("evt_pub_8");
      expect(rowAfterFirst?.status).toBe("PENDING");
      expect(rowAfterFirst?.dispatchClaimToken).toBeNull();

      // Duplicate / delayed failure callback arrives with the old token
      const res2 = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_pub_8",
        dispatchClaimToken: "disp_tok_8",
        error: new Error("Duplicate publish failure"),
        maxAttempts: 5,
      });

      // Fails closed: claim was lost/cleared
      expect(res2.status).toBe("CLAIM_LOST");

      // Verify attempts remains exactly 1 (not double incremented)
      const finalRow = mockDb.rows.get("evt_pub_8");
      expect(finalRow?.dispatchAttempts).toBe(1);
    });
  });

  // ===========================================================================
  // AREA 3: RETRY LIFECYCLE (Cases 9–13)
  // ===========================================================================
  describe("Area 3: Retry Lifecycle", () => {
    it("9. First failure schedules the exact canonical delay (5s)", async () => {
      mockDb.insert({
        id: "evt_retry_9",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_9",
        status: "CLAIMED",
        dispatchClaimToken: "tok_9",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 0, // 0 prior failures
      });

      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_retry_9",
        dispatchClaimToken: "tok_9",
        error: new Error("Initial failure"),
        maxAttempts: 5,
      });

      expect(res.status).toBe("RETRY_SCHEDULED");
      expect((res as any).attempts).toBe(1);

      const saved = mockDb.rows.get("evt_retry_9");
      expect(saved?.nextRetryAt?.getTime()).toBe(mockDb.currentTime + 5_000); // Exactly 5 seconds
    });

    it("10. Subsequent failures schedule the exact exponential progression (10s, 20s, 40s)", async () => {
      const delays: number[] = [10, 20, 40];

      for (let priorAttempts = 1; priorAttempts <= 3; priorAttempts++) {
        const id = `evt_retry_10_${priorAttempts}`;
        const tok = `tok_10_${priorAttempts}`;
        mockDb.insert({
          id,
          orgId: "org_alpha",
          entityType: "TASK",
          entityId: `task_10_${priorAttempts}`,
          status: "CLAIMED",
          dispatchClaimToken: tok,
          dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
          dispatchAttempts: priorAttempts,
        });

        const res = await handleVectorOutboxPublishFailure({
          db: mockDb as any,
          outboxEventId: id,
          dispatchClaimToken: tok,
          error: new Error(`Failure on attempt ${priorAttempts + 1}`),
          maxAttempts: 5,
        });

        const expectedDelaySec = delays[priorAttempts - 1];
        expect(res.status).toBe("RETRY_SCHEDULED");
        expect((res as any).attempts).toBe(priorAttempts + 1);

        const saved = mockDb.rows.get(id);
        expect(saved?.nextRetryAt?.getTime()).toBe(mockDb.currentTime + expectedDelaySec * 1000);
      }
    });

    it("11. The retry cap is respected (maxAttempts = 5)", async () => {
      mockDb.insert({
        id: "evt_retry_11",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_11",
        status: "CLAIMED",
        dispatchClaimToken: "tok_11",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 3, // next will be attempt 4 (within cap < 5)
      });

      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_retry_11",
        dispatchClaimToken: "tok_11",
        error: new Error("4th failure"),
        maxAttempts: 5,
      });

      expect(res.status).toBe("RETRY_SCHEDULED");
      expect((res as any).attempts).toBe(4);
    });

    it("12. Maximum-attempt exhaustion produces the correct terminal state", async () => {
      mockDb.insert({
        id: "evt_retry_12",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_12",
        status: "CLAIMED",
        dispatchClaimToken: "tok_12",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 4, // next will be attempt 5 (exhausts maxAttempts = 5)
      });

      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_retry_12",
        dispatchClaimToken: "tok_12",
        error: new Error("Final 5th failure — broker persistent outage"),
        maxAttempts: 5,
      });

      expect(res.status).toBe("FAILED_TERMINAL");
      expect((res as any).attempts).toBe(5);

      const saved = mockDb.rows.get("evt_retry_12");
      expect(saved?.status).toBe("FAILED");
      expect(saved?.dispatchAttempts).toBe(5);
      expect(saved?.dispatchClaimToken).toBeNull();
      expect(saved?.dispatchLeaseExpiresAt).toBeNull();
      expect(saved?.terminalError).toContain("Final 5th failure");
    });

    it("13. A stale dispatcher cannot reschedule or overwrite a newer retry", async () => {
      mockDb.insert({
        id: "evt_retry_13",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_13",
        status: "CLAIMED",
        dispatchClaimToken: "tok_stale",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 5_000),
        dispatchAttempts: 1,
      });

      // Lease expires and Dispatcher B claims it
      mockDb.advanceTime(10_000);
      await claimVectorOutboxBatch({
        db: mockDb as any,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: "tok_new_dispatcher",
      });

      // Dispatcher A (stale) now attempts to execute failure callback
      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_retry_13",
        dispatchClaimToken: "tok_stale",
        error: new Error("Stale failure callback"),
        maxAttempts: 5,
      });

      expect(res.status).toBe("CLAIM_LOST");

      // Verify Dispatcher B's active claim was not overwritten or reverted
      const saved = mockDb.rows.get("evt_retry_13");
      expect(saved?.status).toBe("CLAIMED");
      expect(saved?.dispatchClaimToken).toBe("tok_new_dispatcher");
      expect(saved?.dispatchAttempts).toBe(1); // Not incremented by stale caller
    });
  });

  // ===========================================================================
  // AREA 4: SUPERSESSION AND IDEMPOTENCY (Cases 14–17)
  // ===========================================================================
  describe("Area 4: Supersession and Idempotency", () => {
    it("14. A genuinely newer pending revision can supersede older work according to contract", async () => {
      // Older revision (rev 1)
      mockDb.insert({
        id: "evt_older_rev1",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_supersede",
        sourceRevision: 1,
        status: "CLAIMED",
        dispatchClaimToken: "tok_old",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 1,
      });

      // Newer revision (rev 2) pending in outbox for same entity
      mockDb.insert({
        id: "evt_newer_rev2",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_supersede",
        sourceRevision: 2,
        status: "PENDING",
      });

      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_older_rev1",
        dispatchClaimToken: "tok_old",
        error: new Error("Old revision publish failed"),
      });

      expect(res.status).toBe("SUPERSEDED");

      const olderSaved = mockDb.rows.get("evt_older_rev1");
      expect(olderSaved?.status).toBe("FAILED");
      expect(olderSaved?.terminalError).toContain("Superseded by newer pending outbox event evt_newer_rev2 (rev 2)");
      expect(olderSaved?.dispatchClaimToken).toBeNull();

      // Newer revision remains unaffected and pending
      const newerSaved = mockDb.rows.get("evt_newer_rev2");
      expect(newerSaved?.status).toBe("PENDING");
    });

    it("15. Older work cannot supersede a newer revision", async () => {
      // Newer revision (rev 2) is claimed
      mockDb.insert({
        id: "evt_newer_rev2_claimed",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_supersede_inverse",
        sourceRevision: 2,
        status: "CLAIMED",
        dispatchClaimToken: "tok_rev2",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
        dispatchAttempts: 0,
      });

      // Older revision (rev 1) somehow exists as PENDING
      mockDb.insert({
        id: "evt_older_rev1_pending",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_supersede_inverse",
        sourceRevision: 1,
        status: "PENDING",
      });

      const res = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_newer_rev2_claimed",
        dispatchClaimToken: "tok_rev2",
        error: new Error("Newer revision publish failed"),
        maxAttempts: 5,
      });

      // Must NOT be superseded by the older revision! It schedules a normal retry.
      expect(res.status).toBe("RETRY_SCHEDULED");
      expect((res as any).attempts).toBe(1);

      const saved = mockDb.rows.get("evt_newer_rev2_claimed");
      expect(saved?.status).toBe("PENDING");
    });

    it("16. Duplicate delivery of the same outboxEventId does not create duplicate logical processing", async () => {
      mockDb.insert({
        id: "evt_dedup_16",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_dedup",
        sourceRevision: 3,
        status: "CLAIMED",
        dispatchClaimToken: "sweeper_1",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
      });

      // 1. First completion succeeds
      const completed1 = await completeVectorOutboxEvent({
        db: mockDb as any,
        outboxEventId: "evt_dedup_16",
      });
      expect(completed1).toBe(true);

      const saved1 = mockDb.rows.get("evt_dedup_16");
      expect(saved1?.status).toBe("COMPLETED");

      // 2. Second completion of the same event returns false (idempotent no-op)
      const completed2 = await completeVectorOutboxEvent({
        db: mockDb as any,
        outboxEventId: "evt_dedup_16",
      });
      expect(completed2).toBe(false);

      const saved2 = mockDb.rows.get("evt_dedup_16");
      expect(saved2?.status).toBe("COMPLETED");
    });

    it("17. A SUCCESS EventLog cannot be reopened by a delayed dispatcher failure", async () => {
      mockDb.insert({
        id: "evt_idemp_17",
        orgId: "org_alpha",
        entityType: "TASK",
        entityId: "task_17",
        status: "CLAIMED",
        dispatchClaimToken: "disp_tok_17",
        dispatchLeaseExpiresAt: new Date(mockDb.currentTime + 60_000),
      });

      // Worker executes to completion and completes outbox row
      await completeVectorOutboxEvent({
        db: mockDb as any,
        outboxEventId: "evt_idemp_17",
      });

      // Delayed markVectorOutboxDispatched arrives
      const markRes = await markVectorOutboxDispatched({
        db: mockDb as any,
        outboxEventId: "evt_idemp_17",
        dispatchClaimToken: "disp_tok_17",
      });
      expect(markRes.ok).toBe(true);
      expect((markRes as any).status).toBe("COMPLETED");

      // Delayed handleVectorOutboxPublishFailure arrives
      const failRes = await handleVectorOutboxPublishFailure({
        db: mockDb as any,
        outboxEventId: "evt_idemp_17",
        dispatchClaimToken: "disp_tok_17",
        error: new Error("Delayed error"),
      });
      expect(failRes.status).toBe("ALREADY_COMPLETED");

      // Final state must remain COMPLETED
      const finalRow = mockDb.rows.get("evt_idemp_17");
      expect(finalRow?.status).toBe("COMPLETED");
    });
  });
});
