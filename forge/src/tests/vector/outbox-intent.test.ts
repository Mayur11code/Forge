// src/tests/vector/outbox-intent.test.ts
jest.mock("server-only", () => ({}));

import {
  computeTaskContentHash,
  computeAttachmentContentHash,
  computeAttachmentParentTaskVersion,
  PIPELINE_CONTRACT_VERSION,
} from "@/lib/vector/provenance";
import {
  recordVectorSyncIntent,
  claimVectorOutboxBatch,
  markVectorOutboxDispatched,
  completeVectorOutboxEvent,
} from "@/lib/vector/outbox";
import { VectorEntityType, VectorOutboxStatus } from "@prisma/client";

describe("Vector V2 Phase B: PR-1 Outbox Intent & Content Hashing (E2 Unit Suite)", () => {
  describe("Canonical Content Hashing", () => {
    const baseTask = {
      id: "task_100",
      projectId: "proj_abc",
      title: "Fix vector indexing bug",
      description: "<p>Ensure outbox events are atomic.</p>",
      status: "IN_PROGRESS",
      priority: "HIGH",
      assigneeId: "user_42",
    };

    it("produces deterministic SHA-256 hashes for identical task content", () => {
      const hash1 = computeTaskContentHash(baseTask);
      const hash2 = computeTaskContentHash({ ...baseTask });
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("normalizes HTML formatting in task title and description via extractPureText", () => {
      const taskHtml = {
        ...baseTask,
        title: "  Fix <b>vector</b> indexing bug  ",
        description: "<div>Ensure outbox events are atomic.</div>",
      };
      // extractPureText strips html tags and trims whitespace
      const hashClean = computeTaskContentHash(baseTask);
      const hashHtml = computeTaskContentHash(taskHtml);
      expect(hashHtml).toBe(hashClean);
    });

    it("changes task content hash when any canonical field changes", () => {
      const baseHash = computeTaskContentHash(baseTask);

      expect(computeTaskContentHash({ ...baseTask, title: "New title" })).not.toBe(baseHash);
      expect(computeTaskContentHash({ ...baseTask, description: "New description" })).not.toBe(baseHash);
      expect(computeTaskContentHash({ ...baseTask, status: "DONE" })).not.toBe(baseHash);
      expect(computeTaskContentHash({ ...baseTask, priority: "LOW" })).not.toBe(baseHash);
      expect(computeTaskContentHash({ ...baseTask, assigneeId: "user_99" })).not.toBe(baseHash);
      expect(computeTaskContentHash({ ...baseTask, projectId: "proj_xyz" })).not.toBe(baseHash);
      expect(computeTaskContentHash(baseTask, "v2:custom-embed:1024")).not.toBe(baseHash);
    });

    const baseAttachment = {
      id: "att_200",
      name: "architecture-spec.pdf",
      size: 1048576,
      fileKey: "files/arch-spec.pdf",
      taskId: "task_100",
    };

    it("produces deterministic SHA-256 hashes for identical attachment content", () => {
      const hash1 = computeAttachmentContentHash(baseAttachment);
      const hash2 = computeAttachmentContentHash({ ...baseAttachment });
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("changes attachment content hash when any canonical field changes", () => {
      const baseHash = computeAttachmentContentHash(baseAttachment);

      expect(computeAttachmentContentHash({ ...baseAttachment, name: "other.pdf" })).not.toBe(baseHash);
      expect(computeAttachmentContentHash({ ...baseAttachment, size: 2048 })).not.toBe(baseHash);
      expect(computeAttachmentContentHash({ ...baseAttachment, fileKey: "files/other.pdf" })).not.toBe(baseHash);
      expect(computeAttachmentContentHash({ ...baseAttachment, taskId: "task_999" })).not.toBe(baseHash);
      expect(computeAttachmentContentHash(baseAttachment, "v2:custom-pipeline")).not.toBe(baseHash);
    });

    it("computes deterministic attachment parent task version and detects changes", () => {
      const parent = { title: "Parent Task Title", projectId: "proj_123" };
      const v1 = computeAttachmentParentTaskVersion(parent);
      const v2 = computeAttachmentParentTaskVersion({ ...parent });
      expect(v1).toBe(v2);
      expect(v1).toMatch(/^[0-9a-f]{64}$/);

      expect(computeAttachmentParentTaskVersion({ title: "Different Title", projectId: "proj_123" })).not.toBe(v1);
      expect(computeAttachmentParentTaskVersion({ title: "Parent Task Title", projectId: "proj_other" })).not.toBe(v1);
    });
  });

  describe("recordVectorSyncIntent", () => {
    it("successfully records intent and increments sourceRevision monotonically", async () => {
      const mockTx = {
        $queryRaw: jest
          .fn()
          // 1st query: VectorEntityHead upsert
          .mockResolvedValueOnce([{ id: "head_123", latestRevision: 4 }])
          // 2nd query: VectorOutboxEvent insert or coalesce
          .mockResolvedValueOnce([{ id: "outbox_456" }]),
      } as any;

      const result = await recordVectorSyncIntent({
        tx: mockTx,
        orgId: "org_test",
        entityType: VectorEntityType.TASK,
        entityId: "task_100",
        contentHash: "hash_abc_123",
      });

      expect(mockTx.$queryRaw).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        outboxEventId: "outbox_456",
        sourceRevision: 4,
        headId: "head_123",
      });
    });

    it("throws when VectorEntityHead upsert fails to return rows", async () => {
      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValueOnce([]),
      } as any;

      await expect(
        recordVectorSyncIntent({
          tx: mockTx,
          orgId: "org_test",
          entityType: VectorEntityType.TASK,
          entityId: "task_100",
          contentHash: "hash_abc_123",
        })
      ).rejects.toThrow("Failed to upsert VectorEntityHead for TASK:task_100");
    });

    it("throws when VectorOutboxEvent upsert fails to return rows", async () => {
      const mockTx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: "head_123", latestRevision: 1 }])
          .mockResolvedValueOnce([]),
      } as any;

      await expect(
        recordVectorSyncIntent({
          tx: mockTx,
          orgId: "org_test",
          entityType: VectorEntityType.TASK,
          entityId: "task_100",
          contentHash: "hash_abc_123",
        })
      ).rejects.toThrow("Failed to record VectorOutboxEvent for TASK:task_100");
    });
  });

  describe("Outbox Lifecycle Operations", () => {
    it("claims a batch of pending or expired outbox rows with SKIP LOCKED", async () => {
      const mockDb = {
        $queryRaw: jest.fn().mockResolvedValueOnce([
          {
            id: "outbox_1",
            orgId: "org_1",
            entityType: VectorEntityType.TASK,
            entityId: "task_1",
            sourceRevision: 2,
            contentHash: "hash_1",
            pipelineVersion: PIPELINE_CONTRACT_VERSION,
            parentTaskVersion: null,
            dispatchClaimToken: "token_abc",
          },
        ]),
      } as any;

      const claimed = await claimVectorOutboxBatch({
        db: mockDb,
        batchSize: 10,
        leaseSeconds: 60,
        claimToken: "token_abc",
      });

      expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
      expect(claimed.rows).toHaveLength(1);
      expect(claimed.rows[0].id).toBe("outbox_1");
      expect(claimed.claimToken).toBe("token_abc");
    });

    it("marks outbox event DISPATCHED via compare-and-swap on claimToken", async () => {
      const mockDb = {
        $queryRaw: jest.fn().mockResolvedValueOnce([{ id: "outbox_1", status: VectorOutboxStatus.DISPATCHED }]),
      } as any;

      const result = await markVectorOutboxDispatched({
        db: mockDb,
        outboxEventId: "outbox_1",
        dispatchClaimToken: "token_abc",
      });

      expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, status: "DISPATCHED" });
    });

    it("returns false from markVectorOutboxDispatched when claimToken does not match and row is not completed", async () => {
      const mockDb = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([]) // CAS returned 0 rows
          .mockResolvedValueOnce([{ status: VectorOutboxStatus.CLAIMED }]), // current row status is still CLAIMED
      } as any;

      const result = await markVectorOutboxDispatched({
        db: mockDb,
        outboxEventId: "outbox_1",
        dispatchClaimToken: "wrong_token",
      });

      expect(mockDb.$queryRaw).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: false, reason: "CLAIM_LOST_OR_EXPIRED" });
    });

    it("completes outbox event by setting status to COMPLETED and clearing claimToken", async () => {
      const mockDb = {
        $queryRaw: jest.fn().mockResolvedValueOnce([{ id: "outbox_1" }]),
      } as any;

      const success = await completeVectorOutboxEvent({
        db: mockDb,
        outboxEventId: "outbox_1",
      });

      expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
      expect(success).toBe(true);
    });
  });
});
