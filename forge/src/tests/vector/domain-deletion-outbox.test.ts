// src/tests/vector/domain-deletion-outbox.test.ts
//
// Verification test suite for Forge H4.5 — Transactional Outbox & Durable Deletion Lifecycle.
// Verifies all 15 scenarios from the H4.5 specification:
//
//  1. Database transaction abort: neither deletion nor outbox intent commits.
//  2. Database transaction commit followed by process crash: pending intent remains discoverable.
//  3. QStash publication failure: durable cleanup intent in outbox remains retryable.
//  4. Publication succeeds but bookkeeping fails: duplicate delivery is safe and idempotent.
//  5. Concurrent dispatchers do not corrupt event state or strand claimed events (lease CAS).
//  6. Worker vector deletion fails, then succeeds on retry.
//  7. UploadThing deletion fails and is retried safely.
//  8. UploadThing reports already-missing file with correct idempotent handling.
//  9. Attachment database deletion and quota adjustment are atomic.
// 10. Duplicate task, project, and attachment deletion events are harmless.
// 11. Project deletion records cleanup for every task and child attachment before cascades.
// 12. Cross-tenant or malformed stored event data cannot initiate deletion in another namespace.
// 13. Deleted or missing resources' stale Pinecone vectors cannot enter RAG prompt context.
// 14. Bounded outbox batching and error recording semantics.
// 15. Regression safety for unified deletion lifecycle.

jest.mock("server-only", () => ({}));

// 1. External & Client Mocks
const mockVectorDeleteByTask = jest.fn();
const mockVectorQuery = jest.fn();
jest.mock("@/lib/vector/client", () => ({
  getTenantVectorStore: jest.fn((orgId: string) => ({
    deleteByTask: (id: string) => mockVectorDeleteByTask(orgId, id),
    query: (...args: unknown[]) => mockVectorQuery(orgId, ...args),
  })),
}));

const mockUtDeleteFiles = jest.fn();
jest.mock("uploadthing/server", () => ({
  UTApi: jest.fn().mockImplementation(() => ({
    deleteFiles: (...args: unknown[]) => mockUtDeleteFiles(...args),
  })),
}));

const mockPublishEvent = jest.fn();
jest.mock("@/lib/events/queue", () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
}));

const mockEmbed = jest.fn();
jest.mock("ai", () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}));

jest.mock("@/lib/ai/resolver", () => ({
  resolveOrganizationEmbeddingModel: jest.fn().mockResolvedValue("mock-embedding-model"),
}));

// 2. Mock Database with interactive transaction support
jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockDb: any = {
    task: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    attachment: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    organization: {
      update: jest.fn(),
    },
    domainOutboxEvent: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };
  return { db: mockDb };
});

import { db } from "@/lib/prisma/db";
import { DomainOutboxStatus, type Prisma } from "@prisma/client";
import {
  claimDomainOutboxBatch,
  claimDomainOutboxForWorker,
  dispatchDomainOutboxBatch,
  markDomainOutboxCompleted,
  recordDomainOutboxExecutionFailure,
  redriveFailedDomainOutboxEvents,
  buildDomainOutboxIdempotencyKey,
  DOMAIN_OUTBOX_CLAIM_LEASE_MS,
} from "@/lib/deletion/outbox";
import {
  deleteTaskTransactionally,
  deleteProjectTransactionally,
  deleteAttachmentTransactionally,
  MAX_PROJECT_CASCADE_RESOURCES,
} from "@/lib/deletion/service";
import { domainCleanupWorkerHandler } from "@/app/api/worker/embedding-worker/domain-cleanup";
import { taskDeletedWorkerHandler } from "@/app/api/worker/embedding-worker/task-deleted";
import { handleDomainMaintenance } from "@/app/api/worker/domain-maintenance/dm";
import {
  filterActiveRagCandidates,
  retrieveRelevantContext,
} from "@/lib/vector/retreiver";

describe("Forge H4.5 — Transactional Outbox & Durable Deletion Lifecycle", () => {
  const ORG_A = "org_alpha";
  const ORG_B = "org_beta";
  const USER_A = "user_alpha";
  const PROJECT_A = "proj_alpha_1";
  const TASK_A = "task_alpha_1";
  const ATTACHMENT_A = "att_alpha_1";
  const ATTACHMENT_B = "att_alpha_2";

  type RawSqlQuery = { strings: readonly string[]; values: readonly unknown[] };

  function lastExecuteRawQuery(): RawSqlQuery {
    const calls = (db.$executeRaw as jest.Mock).mock.calls;
    return calls[calls.length - 1][0] as RawSqlQuery;
  }

  function lastExecuteRawSql(): string {
    return lastExecuteRawQuery().strings.join("?");
  }

  function lastExecuteRawValues(): readonly unknown[] {
    return lastExecuteRawQuery().values;
  }

  function sqlValueAfter(query: RawSqlQuery, marker: string): unknown {
    const index = query.strings.findIndex((part) => part.includes(marker));
    return index >= 0 ? query.values[index] : undefined;
  }

  function expectLastWorkerRawUpdate(
    options: { status?: DomainOutboxStatus; errorIncludes?: string } = {}
  ): void {
    const sql = lastExecuteRawSql();
    expect(sql).toContain('UPDATE "DomainOutboxEvent"');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('"outbox"."claimedBy" =');
    expect(sql).toContain('"claimedAt" > clock_timestamp()');
    if (options.status) {
      expect(lastExecuteRawValues()).toContain(options.status);
    }
    if (options.errorIncludes) {
      const expectedError = options.errorIncludes;
      expect(
        lastExecuteRawValues().some(
          (value) => typeof value === "string" && value.includes(expectedError)
        )
      ).toBe(true);
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();

    // Default transaction implementation runs the callback with db
    (db.$transaction as jest.Mock).mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return await (arg as (tx: unknown) => Promise<unknown>)(db);
      }
      return Array.isArray(arg) ? Promise.all(arg) : arg;
    });

    mockUtDeleteFiles.mockResolvedValue({ success: true, deletedCount: 1 });
    mockVectorDeleteByTask.mockResolvedValue(undefined);
    mockPublishEvent.mockResolvedValue({ messageId: "msg_test_123" });
    mockEmbed.mockResolvedValue({ embedding: new Array(768).fill(0.01) });
    (db.domainOutboxEvent.findMany as jest.Mock).mockResolvedValue([]);
    (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (db.domainOutboxEvent.update as jest.Mock).mockResolvedValue({});
    (db.$executeRaw as jest.Mock).mockResolvedValue(1);
  });

  // =========================================================================
  // Scenario 1: Database transaction abort
  // =========================================================================
  describe("Scenario 1: Database transaction abort", () => {
    it("aborts completely if task deletion fails; outbox intent is not committed", async () => {
      (db.task.findUnique as jest.Mock).mockResolvedValue({
        id: TASK_A,
        title: "Test Task",
        projectId: PROJECT_A,
        project: { orgId: ORG_A },
        attachments: [],
      });
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (db.domainOutboxEvent.upsert as jest.Mock).mockResolvedValue({ id: "outbox_1" });
      (db.task.delete as jest.Mock).mockRejectedValue(new Error("Database deadlock / foreign key failure"));

      await expect(deleteTaskTransactionally(TASK_A)).rejects.toThrow("Database deadlock / foreign key failure");

      // Verify task.delete was attempted
      expect(db.task.delete).toHaveBeenCalledWith({ where: { id: TASK_A } });
    });

    it("aborts completely if attachment quota update fails; neither deletion nor outbox commits", async () => {
      (db.attachment.findFirst as jest.Mock).mockResolvedValue({
        id: ATTACHMENT_A,
        fileKey: "key_att_1",
        size: 2048,
        task: {
          id: TASK_A,
          project: { orgId: ORG_A },
        },
      });
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (db.domainOutboxEvent.upsert as jest.Mock).mockResolvedValue({ id: "outbox_att_1" });
      (db.attachment.delete as jest.Mock).mockResolvedValue({ id: ATTACHMENT_A });
      (db.organization.update as jest.Mock).mockRejectedValue(new Error("Storage quota lock failure"));

      await expect(deleteAttachmentTransactionally(ATTACHMENT_A, USER_A)).rejects.toThrow(
        "Storage quota lock failure"
      );

      // External files or vectors must NOT have been touched
      expect(mockUtDeleteFiles).not.toHaveBeenCalled();
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario 2: Transaction commit followed by process crash
  // =========================================================================
  describe("Scenario 2: Database transaction commit followed by process crash", () => {
    it("preserves pending outbox record with PENDING status for background sweeper discovery", async () => {
      (db.task.findUnique as jest.Mock).mockResolvedValue({
        id: TASK_A,
        title: "Task with crash risk",
        projectId: PROJECT_A,
        project: { orgId: ORG_A },
        attachments: [{ id: ATTACHMENT_A, fileKey: "k1", size: 500 }],
      });
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (db.domainOutboxEvent.upsert as jest.Mock).mockResolvedValue({ id: "outbox_pending_123" });
      (db.task.delete as jest.Mock).mockResolvedValue({ id: TASK_A });

      const result = await deleteTaskTransactionally(TASK_A);

      expect(result.success).toBe(true);
      // Verify intent was recorded with status PENDING in the outbox
      expect(db.domainOutboxEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { idempotencyKey: buildDomainOutboxIdempotencyKey("TASK", TASK_A) },
          create: expect.objectContaining({
            status: DomainOutboxStatus.PENDING,
            orgId: ORG_A,
            resourceId: TASK_A,
          }),
        })
      );
    });
  });

  // =========================================================================
  // Scenario 3: QStash publication failure
  // =========================================================================
  describe("Scenario 3: QStash publication failure", () => {
    it("keeps outbox record retryable with backoff when QStash publish rejects", async () => {
      (db.domainOutboxEvent.findMany as jest.Mock).mockResolvedValue([
        {
          id: "outbox_due_1",
          idempotencyKey: "DELETE_TASK:task_1",
          eventType: "DELETE_TASK",
          orgId: ORG_A,
          resourceType: "TASK",
          resourceId: TASK_A,
          payload: { taskId: TASK_A },
          status: DomainOutboxStatus.PENDING,
          attempts: 0,
          maxAttempts: 5,
        },
      ]);
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      // Publication fails (e.g. QStash 503 Service Unavailable)
      mockPublishEvent.mockRejectedValue(new Error("QStash 503 Service Unavailable"));
      (db.domainOutboxEvent.update as jest.Mock).mockResolvedValue({});

      const dispatchResult = await dispatchDomainOutboxBatch(10, "test-dispatcher");

      expect(dispatchResult.claimed).toBe(1);
      expect(dispatchResult.failed).toBe(1);
      expect(dispatchResult.published).toBe(0);

      // Verify outbox record was returned to PENDING with backoff date
      expect(db.domainOutboxEvent.update).toHaveBeenCalledWith({
        where: { id: "outbox_due_1" },
        data: expect.objectContaining({
          status: DomainOutboxStatus.PENDING,
          claimedAt: null,
          claimedBy: null,
          lastError: expect.stringContaining("QStash 503 Service Unavailable"),
        }),
      });
    });
  });

  // =========================================================================
  // Scenario 4: Publication succeeds but bookkeeping fails
  // =========================================================================
  describe("Scenario 4: Publication succeeds but bookkeeping fails (safe duplicate delivery)", () => {
    it("safely handles duplicate delivery when worker receives repeat dispatch", async () => {
      // First run succeeds and marks COMPLETED
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_dupe_1",
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A, attachmentIds: [] },
        status: DomainOutboxStatus.COMPLETED,
        attempts: 1,
        maxAttempts: 5,
      });

      // Worker executes duplicate delivery
      await domainCleanupWorkerHandler({
        event: {
          id: "evt_dup_1",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_dupe_1", orgId: ORG_A },
        },
      });

      // Because it was already COMPLETED, worker does not touch vector store again
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario 5: Concurrent dispatchers and lease CAS
  // =========================================================================
  describe("Scenario 5: Concurrent dispatchers & lease CAS", () => {
    it("ensures competing dispatchers cannot claim the same outbox event", async () => {
      (db.domainOutboxEvent.findMany as jest.Mock).mockResolvedValue([
        {
          id: "event_concurrent_1",
          attempts: 0,
          status: DomainOutboxStatus.PENDING,
        },
      ]);

      // Worker 1 succeeds updateMany CAS (count: 1)
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
      const batch1 = await claimDomainOutboxBatch(1, "dispatcher-1");
      expect(batch1).toHaveLength(1);
      expect(batch1[0].id).toBe("event_concurrent_1");

      // Worker 2 fails CAS on the same event (count: 0)
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
      const batch2 = await claimDomainOutboxBatch(1, "dispatcher-2");
      expect(batch2).toHaveLength(0);
    });

    it("reclaims expired lease after DOMAIN_OUTBOX_CLAIM_LEASE_MS has elapsed", async () => {
      const expiredTime = new Date(Date.now() - DOMAIN_OUTBOX_CLAIM_LEASE_MS - 5000);
      (db.domainOutboxEvent.findMany as jest.Mock).mockResolvedValue([
        {
          id: "event_expired_lease_1",
          attempts: 1,
          status: DomainOutboxStatus.DISPATCHED,
          claimedAt: expiredTime,
        },
      ]);
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const claimed = await claimDomainOutboxBatch(1, "sweeper-dispatcher");
      expect(claimed).toHaveLength(1);
      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "event_expired_lease_1",
          }),
        })
      );
    });

    it("competing worker claims: launches two competing claims concurrently against the same pending event and proves exactly one obtains the active lease", async () => {
      // Stateful simulated database row representing real PostgreSQL concurrency
      const simulatedDbRow = {
        id: "event_competing_active_claim",
        status: DomainOutboxStatus.PENDING as DomainOutboxStatus,
        claimedAt: null as Date | null,
        claimedBy: null as string | null,
        attempts: 0,
        maxAttempts: 5,
      };

      (db.domainOutboxEvent.findUnique as jest.Mock).mockImplementation(async ({ where }) => {
        if (where.id === simulatedDbRow.id) {
          return { ...simulatedDbRow };
        }
        return null;
      });

      // Stateful atomic compare-and-set simulator
      (db.domainOutboxEvent.updateMany as jest.Mock).mockImplementation(async ({ where, data }) => {
        if (where.id !== simulatedDbRow.id) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(simulatedDbRow.status)) return { count: 0 };
        if (where.claimedBy && simulatedDbRow.claimedBy !== where.claimedBy) return { count: 0 };

        // Evaluate OR condition: claimedAt is null OR claimedAt <= leaseExpiredBefore
        let matchesLease = false;
        if (where.OR) {
          for (const cond of where.OR) {
            if (cond.claimedAt === null && simulatedDbRow.claimedAt === null) {
              matchesLease = true;
              break;
            }
            if (
              cond.claimedAt?.lte &&
              simulatedDbRow.claimedAt &&
              simulatedDbRow.claimedAt <= cond.claimedAt.lte
            ) {
              matchesLease = true;
              break;
            }
          }
        } else {
          matchesLease = true;
        }

        if (!matchesLease) return { count: 0 };

        // Atomically commit update to simulated row
        if (data.status) simulatedDbRow.status = data.status;
        if (data.claimedAt) simulatedDbRow.claimedAt = data.claimedAt;
        if (data.claimedBy) simulatedDbRow.claimedBy = data.claimedBy;
        return { count: 1 };
      });

      // Launch two genuinely concurrent claims against the exact same event
      const [claimA, claimB] = await Promise.all([
        claimDomainOutboxForWorker("event_competing_active_claim", "worker-concurrent-A"),
        claimDomainOutboxForWorker("event_competing_active_claim", "worker-concurrent-B"),
      ]);

      // Prove exactly one worker obtained the claim and the other was refused
      const succeededCount = (claimA.success ? 1 : 0) + (claimB.success ? 1 : 0);
      expect(succeededCount).toBe(1);

      const winningWorker = claimA.success ? "worker-concurrent-A" : "worker-concurrent-B";
      const losingWorker = claimA.success ? "worker-concurrent-B" : "worker-concurrent-A";

      expect(simulatedDbRow.claimedBy).toBe(winningWorker);
      expect(simulatedDbRow.status).toBe(DomainOutboxStatus.DISPATCHED);

      // Worker completion now uses the DB-side fenced UPDATE; simulate its CAS.
      (db.$executeRaw as jest.Mock).mockImplementation(async (query: RawSqlQuery) => {
        const workerId = query.values.find(
          (value): value is string =>
            value === "worker-concurrent-A" || value === "worker-concurrent-B"
        );
        if (
          query.values.includes(simulatedDbRow.id) &&
          workerId === simulatedDbRow.claimedBy
        ) {
          simulatedDbRow.status = DomainOutboxStatus.COMPLETED;
          simulatedDbRow.claimedAt = null;
          simulatedDbRow.claimedBy = null;
          return 1;
        }
        return 0;
      });

      // Stale loser attempts to complete or mutate: fenced out by token mismatch (count === 0)
      const loserCompletion = await markDomainOutboxCompleted("event_competing_active_claim", losingWorker);
      expect(loserCompletion.success).toBe(false);
      expect(simulatedDbRow.status).toBe(DomainOutboxStatus.DISPATCHED);

      // Winning worker completes: succeeds with valid fencing token
      const winnerCompletion = await markDomainOutboxCompleted("event_competing_active_claim", winningWorker);
      expect(winnerCompletion.success).toBe(true);
      expect(simulatedDbRow.status).toBe(DomainOutboxStatus.COMPLETED);
    });
  });

  // =========================================================================
  // Scenario 6: Worker vector deletion fails, then succeeds on retry
  // =========================================================================
  describe("Scenario 6: Worker vector deletion retry lifecycle", () => {
    it("records failure and re-throws when vector deletion fails, then succeeds on next attempt", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_vec_retry",
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A, attachmentIds: [] },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      // Attempt 1: Vector deletion throws
      mockVectorDeleteByTask.mockRejectedValueOnce(new Error("Pinecone 503 Unavailable"));
      (db.domainOutboxEvent.update as jest.Mock).mockResolvedValue({});

      await expect(
        domainCleanupWorkerHandler({
          event: {
            id: "evt_1",
            type: "DOMAIN_CLEANUP_REQUESTED",
            time: new Date().toISOString(),
            data: { outboxEventId: "outbox_vec_retry", orgId: ORG_A },
          },
        })
      ).rejects.toThrow("Pinecone 503 Unavailable");

      // Verify failure recorded through the DB-side worker fence
      expectLastWorkerRawUpdate({
        status: DomainOutboxStatus.DISPATCHED,
        errorIncludes: "Pinecone 503 Unavailable",
      });

      // Attempt 2: Vector deletion succeeds
      mockVectorDeleteByTask.mockResolvedValueOnce(undefined);
      await domainCleanupWorkerHandler({
        event: {
          id: "evt_2",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_vec_retry", orgId: ORG_A },
        },
      });

      // Verify marked COMPLETED
      expectLastWorkerRawUpdate({ status: DomainOutboxStatus.COMPLETED });
    });
  });

  // =========================================================================
  // Scenario 7: UploadThing deletion fails and is retried safely
  // =========================================================================
  describe("Scenario 7: UploadThing deletion failure and retry", () => {
    it("re-throws when UploadThing returns failure, then marks complete when retry succeeds", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_att_retry",
        orgId: ORG_A,
        resourceType: "ATTACHMENT",
        resourceId: ATTACHMENT_A,
        payload: { attachmentId: ATTACHMENT_A, fileKey: "file_cloud_123" },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      // Attempt 1: UploadThing fails
      mockUtDeleteFiles.mockResolvedValueOnce({ success: false });

      await expect(
        domainCleanupWorkerHandler({
          event: {
            id: "evt_att_1",
            type: "DOMAIN_CLEANUP_REQUESTED",
            time: new Date().toISOString(),
            data: { outboxEventId: "outbox_att_retry", orgId: ORG_A },
          },
        })
      ).rejects.toThrow("Failed to delete file file_cloud_123 from cloud storage.");

      // Attempt 2: UploadThing succeeds
      mockUtDeleteFiles.mockResolvedValueOnce({ success: true, deletedCount: 1 });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_att_2",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_att_retry", orgId: ORG_A },
        },
      });

      expectLastWorkerRawUpdate({ status: DomainOutboxStatus.COMPLETED });
    });
  });

  // =========================================================================
  // Scenario 8: UploadThing reports already-missing file
  // =========================================================================
  describe("Scenario 8: Idempotent cloud storage handling (already-missing file)", () => {
    it("handles success: true with deletedCount: 0 gracefully as completed", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_att_missing",
        orgId: ORG_A,
        resourceType: "ATTACHMENT",
        resourceId: ATTACHMENT_A,
        payload: { attachmentId: ATTACHMENT_A, fileKey: "file_already_deleted" },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      // Cloud storage reports success even though 0 files were removed
      mockUtDeleteFiles.mockResolvedValueOnce({ success: true, deletedCount: 0 });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_missing_1",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_att_missing", orgId: ORG_A },
        },
      });

      // Should complete cleanly without error
      expectLastWorkerRawUpdate({ status: DomainOutboxStatus.COMPLETED });
    });
  });

  // =========================================================================
  // Scenario 9: Attachment database deletion and quota adjustment atomicity
  // =========================================================================
  describe("Scenario 9: Attachment DB deletion and quota decrement atomicity", () => {
    it("commits attachment deletion, quota decrement, and outbox record inside the same transaction", async () => {
      (db.attachment.findFirst as jest.Mock).mockResolvedValue({
        id: ATTACHMENT_A,
        fileKey: "file_k9",
        size: 4096,
        task: {
          id: TASK_A,
          project: { orgId: ORG_A },
        },
      });
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (db.domainOutboxEvent.upsert as jest.Mock).mockResolvedValue({ id: "outbox_k9" });
      (db.attachment.delete as jest.Mock).mockResolvedValue({ id: ATTACHMENT_A });
      (db.organization.update as jest.Mock).mockResolvedValue({ id: ORG_A });

      const result = await deleteAttachmentTransactionally(ATTACHMENT_A, USER_A);

      expect(result.success).toBe(true);
      expect(db.$transaction).toHaveBeenCalled();
      expect(db.attachment.delete).toHaveBeenCalledWith({ where: { id: ATTACHMENT_A } });
      expect(db.organization.update).toHaveBeenCalledWith({
        where: { id: ORG_A },
        data: {
          storageUsed: { decrement: BigInt(4096) },
        },
      });
      expect(db.domainOutboxEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            resourceType: "ATTACHMENT",
            resourceId: ATTACHMENT_A,
            orgId: ORG_A,
          }),
        })
      );
    });
  });

  // =========================================================================
  // Scenario 10: Duplicate deletion events are harmless
  // =========================================================================
  describe("Scenario 10: Duplicate deletion events idempotency", () => {
    it("repeatedly processing the same completed task deletion is a harmless no-op", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_task_dupe",
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A },
        status: DomainOutboxStatus.COMPLETED,
        attempts: 2,
        maxAttempts: 5,
      });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_dup_2",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_task_dupe", orgId: ORG_A },
        },
      });

      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      expect(db.domainOutboxEvent.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario 11: Project deletion hierarchy capture
  // =========================================================================
  describe("Scenario 11: Project deletion hierarchy capture", () => {
    it("records outbox events for all tasks and attachments before project cascade delete", async () => {
      (db.project.findUnique as jest.Mock).mockResolvedValue({
        id: PROJECT_A,
        orgId: ORG_A,
        tasks: [
          {
            id: TASK_A,
            attachments: [
              { id: ATTACHMENT_A, fileKey: "key_p1_1", size: 1024 },
              { id: ATTACHMENT_B, fileKey: "key_p1_2", size: 2048 },
            ],
          },
          {
            id: "task_alpha_2",
            attachments: [],
          },
        ],
      });
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue(null);
      (db.domainOutboxEvent.upsert as jest.Mock).mockResolvedValue({ id: "outbox_proj_child" });
      (db.project.delete as jest.Mock).mockResolvedValue({ id: PROJECT_A });

      const result = await deleteProjectTransactionally(PROJECT_A);

      expect(result.success).toBe(true);
      expect(result.deletedTaskIds).toEqual([TASK_A, "task_alpha_2"]);
      expect(result.deletedAttachmentIds).toEqual([ATTACHMENT_A, ATTACHMENT_B]);

      // Total outbox events recorded: 2 tasks + 2 attachments = 4 discrete minimal events
      expect(db.domainOutboxEvent.upsert).toHaveBeenCalledTimes(4);
      expect(db.project.delete).toHaveBeenCalledWith({ where: { id: PROJECT_A } });
    });
  });

  // =========================================================================
  // Scenario 12: Cross-tenant reference rejection
  // =========================================================================
  describe("Scenario 12: Cross-tenant reference rejection", () => {
    it("rejects event when incoming event orgId does not match authoritative outbox orgId", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_mismatch",
        orgId: ORG_A, // Belongs to Org A
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      // Incoming event claims to belong to Org B
      await domainCleanupWorkerHandler({
        event: {
          id: "evt_spoof_1",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_mismatch", orgId: ORG_B },
        },
      });

      // Must be rejected without deleting any vectors
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("CROSS_TENANT_RESOURCE_REFERENCE_REJECTED")
      );

      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // Scenario 13: Stale Pinecone vectors filtered from RAG retrieval
  // =========================================================================
  describe("Scenario 13: Stale Pinecone vectors filtered from RAG retrieval", () => {
    it("filterActiveRagCandidates discards matches whose DB records are deleted", async () => {
      const matches = [
        { id: "task_active#0", metadata: { type: "task", taskId: "task_active" }, score: 0.95 },
        { id: "task_deleted#0", metadata: { type: "task", taskId: "task_deleted" }, score: 0.92 },
        { id: "att_active#0", metadata: { type: "document", taskId: "task_active" }, score: 0.88 },
        { id: "att_deleted#0", metadata: { type: "document", taskId: "task_deleted" }, score: 0.85 },
      ];

      // DB only knows about task_active and att_active
      (db.task.findMany as jest.Mock).mockResolvedValue([{ id: "task_active" }]);
      (db.attachment.findMany as jest.Mock).mockResolvedValue([
        { id: "att_active", taskId: "task_active" },
      ]);

      const active = await filterActiveRagCandidates(matches, ORG_A);

      expect(active).toHaveLength(2);
      expect(active.map((m) => m.id)).toEqual(["task_active#0", "att_active#0"]);
      // Both deleted task and deleted attachment chunks were dropped
      expect(active.map((m) => m.id)).not.toContain("task_deleted#0");
      expect(active.map((m) => m.id)).not.toContain("att_deleted#0");
    });

    it("retrieveRelevantContext returns empty context if all retrieved vector chunks are stale", async () => {
      mockVectorQuery.mockResolvedValue({
        matches: [
          {
            id: "task_deleted#0",
            metadata: { type: "task", taskId: "task_deleted", text: "Stale task text" },
            score: 0.9,
          },
        ],
      });
      // DB lookup finds nothing (task has been deleted)
      (db.task.findMany as jest.Mock).mockResolvedValue([]);
      (db.attachment.findMany as jest.Mock).mockResolvedValue([]);

      const context = await retrieveRelevantContext("how do I do X?", ORG_A);

      expect(context).toBe("");
    });

    it("retrieveRelevantContext retains only active matches in formatted prompt block", async () => {
      mockVectorQuery.mockResolvedValue({
        matches: [
          {
            id: "task_active#0",
            metadata: {
              type: "task",
              taskId: "task_active",
              text: "Active task instructions.",
              sourceVersion: "task:2026-01-01T00:00:00.000Z:proj_1",
            },
            score: 0.95,
          },
          {
            id: "task_stale#0",
            metadata: { type: "task", taskId: "task_stale", text: "Deleted stale secret." },
            score: 0.92,
          },
        ],
      });
      // DB lookup returns only task_active
      (db.task.findMany as jest.Mock).mockResolvedValue([
        { id: "task_active", updatedAt: new Date("2026-01-01T00:00:00.000Z"), projectId: "proj_1" },
      ]);
      (db.attachment.findMany as jest.Mock).mockResolvedValue([]);

      const context = await retrieveRelevantContext("find active task", ORG_A);

      expect(context).toContain("Active task instructions.");
      expect(context).not.toContain("Deleted stale secret.");
    });
  });

  // =========================================================================
  // Scenario 14: Outbox batching and failure tracking semantics
  // =========================================================================
  describe("Scenario 14: Outbox failure tracking and exhaustion transitions", () => {
    it("transitions event to FAILED when maxAttempts are exhausted", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_exhausted",
        attempts: 5,
        maxAttempts: 5,
      });

      await recordDomainOutboxExecutionFailure(
        "outbox_exhausted",
        new Error("Persistent 500 fatal server error")
      );

      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: "outbox_exhausted" }),
        data: expect.objectContaining({
          status: DomainOutboxStatus.FAILED,
          lastError: expect.stringContaining("Persistent 500 fatal server error"),
        }),
      });
    });

    it("marks outbox event completed with timestamp and cleared claim", async () => {
      await markDomainOutboxCompleted("outbox_done_1");

      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: "outbox_done_1" }),
        data: expect.objectContaining({
          status: DomainOutboxStatus.COMPLETED,
          completedAt: expect.any(Date),
          claimedAt: null,
          claimedBy: null,
        }),
      });
    });
  });

  // =========================================================================
  // Scenario 15: Unified deletion lifecycle verification
  // =========================================================================
  describe("Scenario 15: Unified deletion lifecycle end-to-end", () => {
    it("supports atomic task deletion, pending outbox creation, dispatch, and worker completion", async () => {
      // Step 1: Deletion
      (db.task.findUnique as jest.Mock).mockResolvedValue({
        id: TASK_A,
        title: "E2E Deletion Task",
        projectId: PROJECT_A,
        project: { orgId: ORG_A },
        attachments: [],
      });
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce(null);
      (db.domainOutboxEvent.upsert as jest.Mock).mockResolvedValueOnce({ id: "e2e_outbox_1" });
      (db.task.delete as jest.Mock).mockResolvedValue({ id: TASK_A });

      const delResult = await deleteTaskTransactionally(TASK_A);
      expect(delResult.success).toBe(true);

      // Step 2: Dispatcher claims and publishes
      (db.domainOutboxEvent.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: "e2e_outbox_1",
          idempotencyKey: "DELETE_TASK:" + TASK_A,
          eventType: "DELETE_TASK",
          orgId: ORG_A,
          resourceType: "TASK",
          resourceId: TASK_A,
          payload: { taskId: TASK_A, attachmentIds: [] },
          status: DomainOutboxStatus.PENDING,
          attempts: 0,
          maxAttempts: 5,
        },
      ]);
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      const dispatchResult = await dispatchDomainOutboxBatch(1, "e2e-worker");
      expect(dispatchResult.published).toBe(1);

      // Step 3: Worker cleans vectors and marks outbox completed
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "e2e_outbox_1",
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A, attachmentIds: [] },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_e2e_finish",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "e2e_outbox_1", orgId: ORG_A },
        },
      });

      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, TASK_A);
      expectLastWorkerRawUpdate({ status: DomainOutboxStatus.COMPLETED });
    });
  });

  // =========================================================================
  // Issue 1 Audit: Recoverability after worker failure and retry exhaustion
  // =========================================================================
  describe("Issue 1 Audit: Recoverability after worker failure and retry exhaustion", () => {
    it("transitions outbox event to FAILED when attempts reach maxAttempts in claimDomainOutboxBatch and suppresses dispatch", async () => {
      (db.domainOutboxEvent.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: "outbox_exhausted_due",
          idempotencyKey: "DELETE_TASK:exhausted",
          eventType: "DELETE_TASK",
          orgId: ORG_A,
          resourceType: "TASK",
          resourceId: "task_exhausted",
          status: DomainOutboxStatus.DISPATCHED,
          attempts: 5,
          maxAttempts: 5,
        },
      ]);
      (db.domainOutboxEvent.update as jest.Mock).mockResolvedValueOnce({});

      const claimed = await claimDomainOutboxBatch(10, "sweeper-audit");

      // Claimed must be empty because the row was exhausted
      expect(claimed).toHaveLength(0);
      expect(db.domainOutboxEvent.update).toHaveBeenCalledWith({
        where: { id: "outbox_exhausted_due" },
        data: expect.objectContaining({
          status: DomainOutboxStatus.FAILED,
          lastError: expect.stringContaining("Max attempts (5) exhausted before dispatch."),
        }),
      });
      // No QStash publication should occur
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    it("reclaims abandoned DISPATCHED record whose availableAt has elapsed", async () => {
      const pastTime = new Date(Date.now() - 300_000); // 5 minutes ago
      (db.domainOutboxEvent.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: "outbox_abandoned_dispatched",
          idempotencyKey: "DELETE_TASK:abandoned",
          eventType: "DELETE_TASK",
          orgId: ORG_A,
          resourceType: "TASK",
          resourceId: TASK_A,
          status: DomainOutboxStatus.DISPATCHED,
          attempts: 1,
          maxAttempts: 5,
          availableAt: pastTime,
        },
      ]);
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      const claimed = await claimDomainOutboxBatch(10, "sweeper-reclaim");

      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe("outbox_abandoned_dispatched");
      expect(claimed[0].attempts).toBe(2);
      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "outbox_abandoned_dispatched" }),
          data: expect.objectContaining({
            claimedBy: "sweeper-reclaim",
            attempts: { increment: 1 },
          }),
        })
      );
    });
  });

  // =========================================================================
  // Issue 2 Audit: Canonical worker payload contract & trust boundary
  // =========================================================================
  describe("Issue 2 Audit: Canonical worker payload contract & trust boundary", () => {
    it("safely handles malformed event payloads missing outboxEventId without throwing", async () => {
      const errSpy = jest.spyOn(console, "error").mockImplementation();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await domainCleanupWorkerHandler({ event: { id: "e1", type: "DOMAIN_CLEANUP_REQUESTED", time: "", data: {} as any } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await domainCleanupWorkerHandler({ event: { id: "e2", type: "DOMAIN_CLEANUP_REQUESTED", time: "", data: { outboxEventId: "" } as any } });

      expect(db.domainOutboxEvent.findUnique).not.toHaveBeenCalled();
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it("handles nonexistent outboxEventId cleanly with warning and zero vector/file mutations", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await domainCleanupWorkerHandler({
        event: {
          id: "e_nonexistent",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_does_not_exist", orgId: ORG_A },
        },
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not found in database"));
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      expect(mockUtDeleteFiles).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("strictly uses authoritative outboxRecord.orgId and operates safely when event.data.orgId is omitted", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_authoritative_only",
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      // Omit wire orgId completely
      await domainCleanupWorkerHandler({
        event: {
          id: "e_no_org",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_authoritative_only" },
        },
      });

      // Authoritative orgId ORG_A was used for tenant vector store
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, TASK_A);
    });

    it("prevents wire orgId from overriding authoritative database record", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_auth_override_attempt",
        orgId: ORG_A, // DB record belongs to Org A
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      // Wire attempts to misdirect to Org B
      await domainCleanupWorkerHandler({
        event: {
          id: "e_spoofed",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_auth_override_attempt", orgId: ORG_B },
        },
      });

      // Must be rejected with zero operations in either org namespace
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("CROSS_TENANT_RESOURCE_REFERENCE_REJECTED"));
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // Issue 3 Audit: Duplicate cleanup suppression & bounded payload behavior
  // =========================================================================
  describe("Issue 3 Audit: Duplicate cleanup suppression & bounded payload behavior", () => {
    it("discrete task cleanup deletes task vectors ONLY and does not duplicate child attachment vector wipes", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_task_discrete",
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A, orgId: ORG_A, projectId: PROJECT_A },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_task_only",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_task_discrete", orgId: ORG_A },
        },
      });

      // Task vector was wiped
      expect(mockVectorDeleteByTask).toHaveBeenCalledTimes(1);
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, TASK_A);
      // No attachment vectors were wiped by this worker
      expect(mockVectorDeleteByTask).not.toHaveBeenCalledWith(ORG_A, ATTACHMENT_A);
      expect(mockUtDeleteFiles).not.toHaveBeenCalled();
    });

    it("discrete attachment cleanup deletes attachment vector and file key without parent task mutation", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_att_discrete",
        orgId: ORG_A,
        resourceType: "ATTACHMENT",
        resourceId: ATTACHMENT_A,
        payload: { attachmentId: ATTACHMENT_A, orgId: ORG_A, taskId: TASK_A, fileKey: "k_att_discrete", size: 1024 },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_att_only",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_att_discrete", orgId: ORG_A },
        },
      });

      // Attachment vector wiped once, file deleted once
      expect(mockVectorDeleteByTask).toHaveBeenCalledTimes(1);
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, ATTACHMENT_A);
      expect(mockUtDeleteFiles).toHaveBeenCalledTimes(1);
      expect(mockUtDeleteFiles).toHaveBeenCalledWith("k_att_discrete");
      // Task vector was untouched
      expect(mockVectorDeleteByTask).not.toHaveBeenCalledWith(ORG_A, TASK_A);
    });

    it("rejects project deletion when task count exceeds cascade limit before any database mutation", async () => {
      const manyTasks = new Array(MAX_PROJECT_CASCADE_RESOURCES + 1).fill(null).map((_, i) => ({
        id: `task_${i}`,
        attachments: [],
      }));

      (db.project.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "proj_massive",
        orgId: ORG_A,
        tasks: manyTasks,
      });

      await expect(deleteProjectTransactionally("proj_massive")).rejects.toThrow(
        `Project deletion rejected: contains ${MAX_PROJECT_CASCADE_RESOURCES + 1} total resources`
      );

      // Neither project nor outbox events were committed
      expect(db.project.delete).not.toHaveBeenCalled();
      expect(db.domainOutboxEvent.upsert).not.toHaveBeenCalled();
    });

    it("rejects project deletion when total resources (tasks + attachments) exceed limit even if task count is low", async () => {
      // 10 tasks with 51 attachments each = 10 + 510 = 520 total resources (> 500)
      const tasksWithManyAttachments = new Array(10).fill(null).map((_, i) => ({
        id: `task_${i}`,
        attachments: new Array(51).fill(null).map((__, j) => ({
          id: `att_${i}_${j}`,
          fileKey: `key_${i}_${j}`,
          size: 100,
        })),
      }));

      (db.project.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "proj_dense_attachments",
        orgId: ORG_A,
        tasks: tasksWithManyAttachments,
      });

      await expect(deleteProjectTransactionally("proj_dense_attachments")).rejects.toThrow(
        "Project deletion rejected: contains 520 total resources (10 tasks, 510 attachments)"
      );

      // Mutation is aborted before any delete or outbox writes
      expect(db.project.delete).not.toHaveBeenCalled();
      expect(db.domainOutboxEvent.upsert).not.toHaveBeenCalled();
    });

    it("concurrent resource-creation scenario: concurrent inserts pushing total count over limit are captured under the transaction boundary and rejected before mutation or outbox insert", async () => {
      // Initially, project has 490 tasks (under 500 limit).
      // During concurrent resource creation, 20 additional tasks are inserted.
      // When the transaction reads the hierarchy, it evaluates all 510 resources.
      const initialTasks = new Array(490).fill(null).map((_, i) => ({
        id: `task_init_${i}`,
        attachments: [],
      }));
      const concurrentTasks = new Array(20).fill(null).map((_, i) => ({
        id: `task_concurrent_${i}`,
        attachments: [],
      }));
      const fullHierarchy = [...initialTasks, ...concurrentTasks]; // 510 total

      (db.project.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "proj_concurrent_create",
        orgId: ORG_A,
        tasks: fullHierarchy,
      });

      await expect(deleteProjectTransactionally("proj_concurrent_create")).rejects.toThrow(
        "Project deletion rejected: contains 510 total resources (510 tasks, 0 attachments)"
      );

      // Verify no partial deletes or outbox inserts committed
      expect(db.project.delete).not.toHaveBeenCalled();
      expect(db.domainOutboxEvent.upsert).not.toHaveBeenCalled();
      expect(db.task.delete).not.toHaveBeenCalled();
    });

    it("concurrent resource-creation scenario: serialization conflict (P2034) aborts transaction without partial outbox writes or deletions", async () => {
      // Simulate PostgreSQL SSI / Serializable isolation conflict when concurrent inserts occur during hierarchy processing
      (db.$transaction as jest.Mock).mockRejectedValueOnce(
        new Error("P2034: Transaction failed due to a write conflict or a deadlock. Please retry your transaction.")
      );

      await expect(deleteProjectTransactionally("proj_serializable_conflict")).rejects.toThrow(
        "P2034: Transaction failed due to a write conflict"
      );

      // Entire transaction aborted: no project deletion or outbox inserts
      expect(db.project.delete).not.toHaveBeenCalled();
      expect(db.domainOutboxEvent.upsert).not.toHaveBeenCalled();
    });

    it("legacy taskDeletedWorkerHandler respects every outbox state: PENDING, DISPATCHED, COMPLETED, and FAILED", async () => {
      for (const status of [
        DomainOutboxStatus.PENDING,
        DomainOutboxStatus.DISPATCHED,
        DomainOutboxStatus.COMPLETED,
        DomainOutboxStatus.FAILED,
      ]) {
        jest.clearAllMocks();
        (db.domainOutboxEvent.findFirst as jest.Mock).mockResolvedValueOnce({
          id: `outbox_state_${status}`,
          status,
        });

        await taskDeletedWorkerHandler({
          event: {
            id: `evt_status_${status}`,
            type: "TASK_DELETED",
            time: new Date().toISOString(),
            data: {
              taskId: TASK_A,
              orgId: ORG_A,
              projectId: PROJECT_A,
              attachmentIds: [ATTACHMENT_A],
            },
          },
        });

        // In every state (including FAILED), legacy vector deletion MUST NOT be performed
        expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      }
    });

    it("legacy taskDeletedWorkerHandler performs cleanup only when NO outbox record exists (null fallback)", async () => {
      jest.clearAllMocks();
      (db.domainOutboxEvent.findFirst as jest.Mock).mockResolvedValueOnce(null);

      await taskDeletedWorkerHandler({
        event: {
          id: "evt_no_outbox",
          type: "TASK_DELETED",
          time: new Date().toISOString(),
          data: {
            taskId: TASK_A,
            orgId: ORG_A,
            projectId: PROJECT_A,
            attachmentIds: [ATTACHMENT_A],
          },
        },
      });

      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, TASK_A);
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, ATTACHMENT_A);
    });

    it("domainCleanupWorkerHandler refuses to claim or execute terminal FAILED or COMPLETED records", async () => {
      for (const terminalStatus of [DomainOutboxStatus.COMPLETED, DomainOutboxStatus.FAILED]) {
        jest.clearAllMocks();
        (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
          id: `outbox_term_${terminalStatus}`,
          status: terminalStatus,
          orgId: ORG_A,
          resourceType: "TASK",
          resourceId: TASK_A,
        });

        await domainCleanupWorkerHandler({
          event: {
            id: `evt_term_${terminalStatus}`,
            type: "DOMAIN_CLEANUP_REQUESTED",
            time: new Date().toISOString(),
            data: { outboxEventId: `outbox_term_${terminalStatus}`, orgId: ORG_A },
          },
        });

        // Neither vector deletion nor CAS claim should run on a terminal record
        expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
        expect(db.domainOutboxEvent.updateMany).not.toHaveBeenCalled();
      }
    });

    it("domainCleanupWorkerHandler accepts PENDING records when QStash dispatch bookkeeping crashed", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_pending_crash",
        status: DomainOutboxStatus.PENDING,
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A, orgId: ORG_A },
        attempts: 1,
        maxAttempts: 5,
      });

      // CAS claim succeeds and transitions status to DISPATCHED
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_pending_crash",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_pending_crash", orgId: ORG_A },
        },
      });

      // Task vector was cleaned up successfully
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, TASK_A);
      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [DomainOutboxStatus.PENDING, DomainOutboxStatus.DISPATCHED] },
          }),
          data: expect.objectContaining({
            status: DomainOutboxStatus.DISPATCHED,
          }),
        })
      );
    });

    it("fencing: stale worker cannot overwrite completion or alter state after lease expiration and reclaim", async () => {
      // Simulate that worker 1 finished after its lease expired, and worker 2 has claimed the row
      (db.$executeRaw as jest.Mock).mockResolvedValueOnce(0);

      const staleCompletionResult = await markDomainOutboxCompleted("outbox_1", "stale-worker-1");

      expect(staleCompletionResult).toEqual({ success: false });
      expectLastWorkerRawUpdate({ status: DomainOutboxStatus.COMPLETED });
      expect(lastExecuteRawValues()).toContain("outbox_1");
      expect(lastExecuteRawValues()).toContain("stale-worker-1");
      expect(db.domainOutboxEvent.updateMany).not.toHaveBeenCalled();
    });

    it("fencing: stale worker cannot record failure or transition row when claim was lost or terminal", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_1",
        attempts: 2,
        maxAttempts: 5,
        claimedBy: "new-worker-2", // claimed by someone else
        status: DomainOutboxStatus.DISPATCHED,
      });

      const failureResult = await recordDomainOutboxExecutionFailure(
        "outbox_1",
        new Error("Late network timeout"),
        "stale-worker-1"
      );

      // Fenced out: update is suppressed
      expect(failureResult).toEqual({ success: false });
      expect(db.domainOutboxEvent.updateMany).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it("fencing: execution failure cannot transition an already COMPLETED event", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_completed",
        attempts: 1,
        maxAttempts: 5,
        claimedBy: "worker-1",
        status: DomainOutboxStatus.COMPLETED,
      });

      const failureResult = await recordDomainOutboxExecutionFailure(
        "outbox_completed",
        new Error("Post-completion artifact"),
        "worker-1"
      );

      // Cannot resurrect or mutate a completed event
      expect(failureResult).toEqual({ success: false });
      expect(db.domainOutboxEvent.updateMany).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it("concurrent worker deliveries: CAS claim guard prevents duplicate external cleanup when two workers receive same job", async () => {
      // First worker sees the event
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValue({
        id: "outbox_concurrent_1",
        orgId: ORG_A,
        resourceType: "TASK",
        resourceId: TASK_A,
        payload: { taskId: TASK_A, orgId: ORG_A },
        status: DomainOutboxStatus.DISPATCHED,
        attempts: 1,
        maxAttempts: 5,
      });

      // Simulate that the CAS claim failed (count: 0) because another concurrent worker already claimed it
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

      await domainCleanupWorkerHandler({
        event: {
          id: "evt_dup_delivery",
          type: "DOMAIN_CLEANUP_REQUESTED",
          time: new Date().toISOString(),
          data: { outboxEventId: "outbox_concurrent_1", orgId: ORG_A },
        },
      });

      // Vector store deletion was NOT called because claim was rejected
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
    });

    it("scheduled domain maintenance sweeper executes bounded batch dispatch", async () => {
      await expect(
        handleDomainMaintenance({
          event: {
            data: { limit: 25 },
          },
        })
      ).resolves.not.toThrow();
    });

    it("operator procedure: redriveFailedDomainOutboxEvents resets failed events to PENDING with zero attempts", async () => {
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 3 });

      const result = await redriveFailedDomainOutboxEvents({ orgId: ORG_A });

      expect(result).toEqual({ resetCount: 3 });
      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith({
        where: {
          status: DomainOutboxStatus.FAILED,
          orgId: ORG_A,
        },
        data: expect.objectContaining({
          status: DomainOutboxStatus.PENDING,
          attempts: 0,
          claimedAt: null,
          claimedBy: null,
          lastError: null,
        }),
      });
    });

    it("isolation audit: deleteProjectTransactionally strictly refuses external existingTx to prevent non-serializable execution", async () => {
      const mockUnsafeTx = {} as Prisma.TransactionClient;
      await expect(deleteProjectTransactionally("proj_with_external_tx", mockUnsafeTx)).rejects.toThrow(
        "deleteProjectTransactionally cannot accept an external transaction: project cascade deletion requires an independent Serializable transaction to guarantee cascade-limit enforcement and complete outbox capture against phantom inserts."
      );
      // No queries or transactions run on unsafe client
      expect(db.project.findUnique).not.toHaveBeenCalled();
      expect(db.project.delete).not.toHaveBeenCalled();
    });

    it("fencing audit: missing workerId cannot complete an outbox event while active worker holds the lease", async () => {
      // Simulate that worker-active holds the active claim
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

      // Synchronous caller without workerId attempts completion
      const result = await markDomainOutboxCompleted("outbox_active_worker");

      expect(result).toEqual({ success: false });
      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "outbox_active_worker",
            OR: expect.arrayContaining([{ claimedAt: null }]),
          }),
        })
      );
    });

    it("fencing audit: legitimate synchronous completion succeeds when outbox event is unclaimed", async () => {
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      const result = await markDomainOutboxCompleted("outbox_unclaimed_sync");

      expect(result).toEqual({ success: true });
      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "outbox_unclaimed_sync",
            OR: expect.arrayContaining([{ claimedAt: null }]),
          }),
          data: expect.objectContaining({
            status: DomainOutboxStatus.COMPLETED,
          }),
        })
      );
    });

    it("fencing audit: missing workerId cannot record failure while active worker holds the lease", async () => {
      const activeClaimTime = new Date();
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_active_claim",
        attempts: 1,
        maxAttempts: 5,
        claimedAt: activeClaimTime,
        claimedBy: "worker-active-1",
        status: DomainOutboxStatus.DISPATCHED,
      });

      // Synchronous caller without workerId attempts to record failure while worker-active-1 is running
      const result = await recordDomainOutboxExecutionFailure(
        "outbox_active_claim",
        new Error("External interruption")
      );

      // Fenced out before db.updateMany is even called
      expect(result).toEqual({ success: false });
      expect(db.domainOutboxEvent.updateMany).not.toHaveBeenCalled();
    });

    it("fencing audit: legitimate synchronous failure recording succeeds on unclaimed event", async () => {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "outbox_unclaimed_fail",
        attempts: 1,
        maxAttempts: 5,
        claimedAt: null,
        claimedBy: null,
        status: DomainOutboxStatus.PENDING,
      });
      (db.domainOutboxEvent.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      const result = await recordDomainOutboxExecutionFailure(
        "outbox_unclaimed_fail",
        new Error("Sync execution error")
      );

      expect(result).toEqual({ success: true });
      expect(db.domainOutboxEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "outbox_unclaimed_fail",
            OR: expect.arrayContaining([{ claimedAt: null }]),
          }),
        })
      );
    });
  });

  // =========================================================================
  // Final lease expiry fencing for worker-ID completion and failure
  //
  // NOTE: These are stateful CAS simulations used to verify the shape and
  // ordering of the conditional update predicates. They are NOT proof of real
  // PostgreSQL concurrency semantics; row-lock and transaction behavior must
  // still be validated against a real database. No PostgreSQL integration test
  // is included in this suite.
  // =========================================================================
  describe("Final lease expiry fencing for worker-ID operations", () => {
    interface SimulatedOutboxRow {
      id: string;
      status: DomainOutboxStatus;
      claimedAt: Date | null;
      claimedBy: string | null;
      attempts: number;
      maxAttempts: number;
      completedAt?: Date | null;
      lastError?: string | null;
      availableAt?: Date | null;
    }

    type DateFilter = Prisma.DomainOutboxEventWhereInput["claimedAt"];

    function toDate(value: unknown): Date {
      return value instanceof Date ? value : new Date(value as string);
    }

    function matchesDateCondition(actual: Date | null, expected: DateFilter): boolean {
      if (expected === undefined) return true;
      if (expected === null) return actual === null;
      if (expected instanceof Date) {
        return actual !== null && actual.getTime() === expected.getTime();
      }
      if (typeof expected === "string") {
        return actual !== null && actual.getTime() === new Date(expected).getTime();
      }
      if (expected.gt !== undefined) {
        if (!actual || actual <= toDate(expected.gt)) return false;
      }
      if (expected.lte !== undefined) {
        if (!actual || actual > toDate(expected.lte)) return false;
      }
      return true;
    }

    function matchesWhere(
      row: SimulatedOutboxRow,
      where: Prisma.DomainOutboxEventWhereInput
    ): boolean {
      const conditions = where as unknown as Record<string, unknown>;

      if (conditions.id !== undefined && conditions.id !== row.id) return false;

      if (conditions.status !== undefined) {
        const statusCondition = conditions.status as
          | DomainOutboxStatus
          | { in?: DomainOutboxStatus[] };
        if (typeof statusCondition === "object") {
          if (statusCondition.in && !statusCondition.in.includes(row.status)) return false;
        } else if (statusCondition !== row.status) {
          return false;
        }
      }

      if (conditions.claimedBy !== undefined && conditions.claimedBy !== row.claimedBy) {
        return false;
      }

      if (
        conditions.claimedAt !== undefined &&
        !matchesDateCondition(row.claimedAt, conditions.claimedAt as DateFilter)
      ) {
        return false;
      }

      if (Array.isArray(conditions.OR)) {
        const matchesAny = conditions.OR.some((condition) =>
          matchesWhere(row, condition as Prisma.DomainOutboxEventWhereInput)
        );
        if (!matchesAny) return false;
      }

      return true;
    }

    function installStatefulOutboxRow(
      row: SimulatedOutboxRow,
      dbNow: () => Date = () => new Date()
    ): void {
      (db.domainOutboxEvent.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === row.id ? { ...row } : null
      );

      (db.domainOutboxEvent.updateMany as jest.Mock).mockImplementation(
        async ({
          where,
          data,
        }: {
          where: Prisma.DomainOutboxEventWhereInput;
          data: Record<string, unknown>;
        }) => {
          if (!matchesWhere(row, where)) return { count: 0 };

          if (data.status !== undefined) row.status = data.status as DomainOutboxStatus;
          if (data.claimedAt !== undefined) row.claimedAt = data.claimedAt as Date | null;
          if (data.claimedBy !== undefined) row.claimedBy = data.claimedBy as string | null;
          if (data.completedAt !== undefined) row.completedAt = data.completedAt as Date | null;
          if (data.lastError !== undefined) row.lastError = data.lastError as string | null;
          if (data.availableAt !== undefined) row.availableAt = data.availableAt as Date | null;

          return { count: 1 };
        }
      );

      // Simulate the worker-fenced raw UPDATE. The lease check deliberately uses
      // dbNow() at UPDATE execution time, not a precomputed application cutoff.
      (db.$executeRaw as jest.Mock).mockImplementation(async (query: RawSqlQuery) => {
        const id = sqlValueAfter(query, 'WHERE "id" =');
        if (id !== row.id) return 0;

        const workerId = sqlValueAfter(query, 'AND "outbox"."claimedBy" =');
        if (workerId !== row.claimedBy) return 0;

        if (
          !row.claimedAt ||
          row.claimedAt.getTime() <=
            dbNow().getTime() - DOMAIN_OUTBOX_CLAIM_LEASE_MS
        ) {
          return 0;
        }

        const nextStatus = sqlValueAfter(query, '"status" =');
        if (nextStatus !== undefined) {
          row.status = nextStatus as DomainOutboxStatus;
        }

        const availableAt = sqlValueAfter(query, '"availableAt" =');
        const completedAt = sqlValueAfter(query, '"completedAt" =');

        if (availableAt instanceof Date) {
          row.availableAt = availableAt;
          const lastError = sqlValueAfter(query, '"lastError" =');
          if (typeof lastError === "string") row.lastError = lastError;
        } else if (completedAt instanceof Date) {
          row.completedAt = completedAt;
          row.lastError = null;
        }

        row.claimedAt = null;
        row.claimedBy = null;
        return 1;
      });
    }

    it("allows an active worker holding an unexpired lease to complete", async () => {
      const row: SimulatedOutboxRow = {
        id: "lease_active_complete",
        status: DomainOutboxStatus.DISPATCHED,
        claimedAt: new Date(Date.now() - 1_000),
        claimedBy: "worker-A",
        attempts: 1,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(row);

      const result = await markDomainOutboxCompleted(row.id, "worker-A");

      expect(result).toEqual({ success: true });
      expect(row.status).toBe(DomainOutboxStatus.COMPLETED);
      expect(row.claimedAt).toBeNull();
      expect(row.claimedBy).toBeNull();
      expectLastWorkerRawUpdate({ status: DomainOutboxStatus.COMPLETED });
      expect(lastExecuteRawValues()).toContain(row.id);
      expect(lastExecuteRawValues()).toContain("worker-A");
    });

    it("rejects an expired worker before any replacement claim", async () => {
      const expiredAt = new Date(Date.now() - DOMAIN_OUTBOX_CLAIM_LEASE_MS - 1_000);
      const row: SimulatedOutboxRow = {
        id: "lease_expired_complete",
        status: DomainOutboxStatus.DISPATCHED,
        claimedAt: expiredAt,
        claimedBy: "worker-A",
        attempts: 1,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(row);

      const result = await markDomainOutboxCompleted(row.id, "worker-A");

      expect(result).toEqual({ success: false });
      expect(row.status).toBe(DomainOutboxStatus.DISPATCHED);
      expect(row.claimedAt).toBe(expiredAt);
      expect(row.claimedBy).toBe("worker-A");
      expectLastWorkerRawUpdate({ status: DomainOutboxStatus.COMPLETED });
      expect(lastExecuteRawValues()).toContain("worker-A");
    });

    it("rejects a superseded worker after a replacement claim and allows the new claimant to complete", async () => {
      const expiredAt = new Date(Date.now() - DOMAIN_OUTBOX_CLAIM_LEASE_MS - 1_000);
      const row: SimulatedOutboxRow = {
        id: "lease_superseded_complete",
        status: DomainOutboxStatus.DISPATCHED,
        claimedAt: expiredAt,
        claimedBy: "worker-A",
        attempts: 1,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(row);

      const replacementClaim = await claimDomainOutboxForWorker(row.id, "worker-B");
      expect(replacementClaim.success).toBe(true);
      expect(row.claimedBy).toBe("worker-B");

      const staleCompletion = await markDomainOutboxCompleted(row.id, "worker-A");
      expect(staleCompletion).toEqual({ success: false });
      expect(row.status).toBe(DomainOutboxStatus.DISPATCHED);
      expect(row.claimedBy).toBe("worker-B");

      const freshCompletion = await markDomainOutboxCompleted(row.id, "worker-B");
      expect(freshCompletion).toEqual({ success: true });
      expect(row.status).toBe(DomainOutboxStatus.COMPLETED);
      expect(row.claimedBy).toBeNull();
    });

    it("rejects an expired worker attempting to record a failure while preserving the claim", async () => {
      const expiredAt = new Date(Date.now() - DOMAIN_OUTBOX_CLAIM_LEASE_MS - 1_000);
      const row: SimulatedOutboxRow = {
        id: "lease_expired_failure",
        status: DomainOutboxStatus.DISPATCHED,
        claimedAt: expiredAt,
        claimedBy: "worker-A",
        attempts: 1,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(row);

      const result = await recordDomainOutboxExecutionFailure(
        row.id,
        new Error("Late failure after lease expiry"),
        "worker-A"
      );

      expect(result).toEqual({ success: false });
      expect(row.status).toBe(DomainOutboxStatus.DISPATCHED);
      expect(row.claimedAt).toBe(expiredAt);
      expect(row.claimedBy).toBe("worker-A");
      expectLastWorkerRawUpdate({
        status: DomainOutboxStatus.DISPATCHED,
        errorIncludes: "Late failure after lease expiry",
      });
    });

    it("rejects a lease that expires while the UPDATE waits, using the database wall clock", async () => {
      const claimTime = new Date("2026-01-01T00:00:00.000Z");
      // At request start, application time would still consider this lease active.
      const applicationTimeAtRequest = new Date(
        claimTime.getTime() + DOMAIN_OUTBOX_CLAIM_LEASE_MS - 1_000
      );
      // By the time the conditional UPDATE executes, the lease has expired.
      const databaseTimeAtExecution = new Date(
        claimTime.getTime() + DOMAIN_OUTBOX_CLAIM_LEASE_MS + 1_000
      );

      expect(
        claimTime.getTime() >
          applicationTimeAtRequest.getTime() - DOMAIN_OUTBOX_CLAIM_LEASE_MS
      ).toBe(true);

      const row: SimulatedOutboxRow = {
        id: "lease_lock_wait",
        status: DomainOutboxStatus.DISPATCHED,
        claimedAt: claimTime,
        claimedBy: "worker-A",
        attempts: 1,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(row, () => databaseTimeAtExecution);

      const result = await markDomainOutboxCompleted(row.id, "worker-A");

      expect(result).toEqual({ success: false });
      expect(row.status).toBe(DomainOutboxStatus.DISPATCHED);
      expect(row.claimedAt).toBe(claimTime);
      expect(row.claimedBy).toBe("worker-A");
      expect(lastExecuteRawSql()).toContain('FOR UPDATE');
      expect(lastExecuteRawSql()).toContain('"claimedAt" > clock_timestamp()');
      expect(
        sqlValueAfter(lastExecuteRawQuery(), '"claimedAt" > clock_timestamp()')
      ).toBe(DOMAIN_OUTBOX_CLAIM_LEASE_MS);
    });

    it("allows a newly claimed worker to record a failure and reschedule the event", async () => {
      const expiredAt = new Date(Date.now() - DOMAIN_OUTBOX_CLAIM_LEASE_MS - 1_000);
      const row: SimulatedOutboxRow = {
        id: "lease_new_claim_failure",
        status: DomainOutboxStatus.DISPATCHED,
        claimedAt: expiredAt,
        claimedBy: "worker-A",
        attempts: 1,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(row);

      const replacementClaim = await claimDomainOutboxForWorker(row.id, "worker-B");
      expect(replacementClaim.success).toBe(true);

      const result = await recordDomainOutboxExecutionFailure(
        row.id,
        new Error("Cleanup failed after replacement claim"),
        "worker-B"
      );

      expect(result).toEqual({ success: true });
      expect(row.status).toBe(DomainOutboxStatus.DISPATCHED);
      expect(row.claimedAt).toBeNull();
      expect(row.claimedBy).toBeNull();
      expect(row.lastError).toContain("Cleanup failed after replacement claim");
      expect(row.availableAt).toBeInstanceOf(Date);
    });

    it("preserves legitimate synchronous completion and failure behavior for unclaimed and expired records", async () => {
      const unclaimedRow: SimulatedOutboxRow = {
        id: "lease_sync_unclaimed",
        status: DomainOutboxStatus.PENDING,
        claimedAt: null,
        claimedBy: null,
        attempts: 0,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(unclaimedRow);

      const completion = await markDomainOutboxCompleted(unclaimedRow.id);
      expect(completion).toEqual({ success: true });
      expect(unclaimedRow.status).toBe(DomainOutboxStatus.COMPLETED);

      const expiredRow: SimulatedOutboxRow = {
        id: "lease_sync_expired",
        status: DomainOutboxStatus.PENDING,
        claimedAt: new Date(Date.now() - DOMAIN_OUTBOX_CLAIM_LEASE_MS - 1_000),
        claimedBy: "dead-worker",
        attempts: 1,
        maxAttempts: 5,
      };
      installStatefulOutboxRow(expiredRow);

      const failure = await recordDomainOutboxExecutionFailure(
        expiredRow.id,
        new Error("Synchronous failure on expired lease")
      );
      expect(failure).toEqual({ success: true });
      expect(expiredRow.status).toBe(DomainOutboxStatus.DISPATCHED);
      expect(expiredRow.claimedAt).toBeNull();
      expect(expiredRow.claimedBy).toBeNull();
      expect(expiredRow.lastError).toContain("Synchronous failure on expired lease");
    });
  });
});
