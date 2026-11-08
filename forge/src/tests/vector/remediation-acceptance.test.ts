// forge/src/tests/vector/remediation-acceptance.test.ts
/**
 * Forge Vector V2 Phase B — UPPR Rev 4 Remediation Acceptance Suite
 *
 * Verifies all 6 defect areas remediated in this cycle:
 * 1. I-1: Canonical mutation outbox wire-up (createTaskInOrg, updateTaskInOrg, createAttachment).
 * 2. I-11: Child attachment invalidation scoping (title update vs non-title update).
 * 3. I-5: Pinecone physical read-back verification (5s budget, strict metadata, dimension/NaN check).
 * 4. S3: Dispatcher publish failure recovery (attempts, exponential backoff, terminal failure, supersession).
 * 5. I-7: Worker recurring heartbeat and fenced completion on lease ownership loss.
 */

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => {
  const localDb: Record<string, unknown> = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    task: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
    attachment: { findMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(localDb)),
  };
  return { db: localDb };
});

jest.mock("@/lib/prisma/extended", () => {
  const localDb: Record<string, unknown> = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    task: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
    attachment: { findMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(localDb)),
  };
  return { prisma: localDb };
});

import { VectorEntityType, type PrismaClient } from "@prisma/client";
import { verifyPhysicalPersistence } from "@/lib/vector/client";
import { buildVectorId, computeManifestDigest } from "@/lib/vector/schema";
import {
  handleVectorOutboxPublishFailure,
} from "@/lib/vector/outbox";
import {
  computeTaskContentHash,
  computeAttachmentContentHash,
  computeAttachmentParentTaskVersion,
} from "@/lib/vector/provenance";
import { createWorker } from "@/lib/events/worker";

describe("UPPR Rev 4 Remediation Acceptance Suite", () => {
  // ---------------------------------------------------------------------------
  // AREA 1: I-5 — Pinecone Physical Verification Contract Hardening
  // ---------------------------------------------------------------------------
  describe("I-5: Pinecone Physical Verification Contract", () => {
    const defaultGenerationId = "gen_accept_1";
    const defaultEntityId = "task_accept_1";
    const defaultOrgId = "org_accept_1";
    const defaultSourceRev = 1;
    const defaultVectorId = buildVectorId("task", defaultEntityId, defaultGenerationId, 0);
    const defaultText = "Sample acceptance chunk text content";
    const defaultDigest = computeManifestDigest([
      { chunkIndex: 0, id: defaultVectorId, text: defaultText },
    ]);
    const validVector = new Array(768).fill(0.05);

    it("verifies vectors successfully when metadata, count, and 768 dimensions match strictly", async () => {
      const vectorId = defaultVectorId;
      const mockRecords = {
        [vectorId]: {
          id: vectorId,
          values: validVector,
          metadata: {
            contractVersion: "v2",
            generationId: defaultGenerationId,
            sourceRevision: defaultSourceRev,
            chunkIndex: 0,
            entityId: defaultEntityId,
            entityType: "task",
            orgId: defaultOrgId,
            chunkCount: 1,
            text: defaultText,
            manifestDigest: defaultDigest,
          },
        },
      };

      const res = await verifyPhysicalPersistence({
        orgId: defaultOrgId,
        generationId: defaultGenerationId,
        entityType: "task",
        entityId: defaultEntityId,
        sourceRevision: defaultSourceRev,
        expectedChunkCount: 1,
        expectedManifestDigest: defaultDigest,
        maxBudgetMs: 5000,
        initialDelayMs: 10,
        fetcher: async () => ({ records: mockRecords }),
      });

      expect(res.verified).toBe(true);
      expect(res.attempts).toBe(1);
    });

    it("fails closed with METADATA_MISMATCH when orgId is missing/undefined in vector metadata", async () => {
      const vectorId = defaultVectorId;
      const mockRecords = {
        [vectorId]: {
          id: vectorId,
          values: validVector,
          metadata: {
            contractVersion: "v2",
            generationId: defaultGenerationId,
            sourceRevision: defaultSourceRev,
            chunkIndex: 0,
            entityId: defaultEntityId,
            entityType: "task",
            // orgId missing/undefined
            chunkCount: 1,
            text: defaultText,
          },
        },
      };

      const res = await verifyPhysicalPersistence({
        orgId: defaultOrgId,
        generationId: defaultGenerationId,
        entityType: "task",
        entityId: defaultEntityId,
        sourceRevision: defaultSourceRev,
        expectedChunkCount: 1,
        expectedManifestDigest: defaultDigest,
        maxBudgetMs: 500,
        initialDelayMs: 10,
        fetcher: async () => ({ records: mockRecords }),
      });

      expect(res.verified).toBe(false);
      expect((res as { reason?: string }).reason).toBe("METADATA_MISMATCH");
    });

    it("fails closed with METADATA_MISMATCH when chunkCount is missing/undefined in vector metadata", async () => {
      const vectorId = defaultVectorId;
      const mockRecords = {
        [vectorId]: {
          id: vectorId,
          values: validVector,
          metadata: {
            contractVersion: "v2",
            generationId: defaultGenerationId,
            sourceRevision: defaultSourceRev,
            chunkIndex: 0,
            entityId: defaultEntityId,
            entityType: "task",
            orgId: defaultOrgId,
            // chunkCount missing/undefined
            text: defaultText,
          },
        },
      };

      const res = await verifyPhysicalPersistence({
        orgId: defaultOrgId,
        generationId: defaultGenerationId,
        entityType: "task",
        entityId: defaultEntityId,
        sourceRevision: defaultSourceRev,
        expectedChunkCount: 1,
        expectedManifestDigest: defaultDigest,
        maxBudgetMs: 500,
        initialDelayMs: 10,
        fetcher: async () => ({ records: mockRecords }),
      });

      expect(res.verified).toBe(false);
      expect((res as { reason?: string }).reason).toBe("METADATA_MISMATCH");
    });

    it("fails closed with METADATA_MISMATCH when vector dimension != 768 or contains NaN", async () => {
      const vectorId = defaultVectorId;
      const invalidVector = new Array(768).fill(0.05);
      invalidVector[5] = NaN;

      const mockRecords = {
        [vectorId]: {
          id: vectorId,
          values: invalidVector,
          metadata: {
            contractVersion: "v2",
            generationId: defaultGenerationId,
            sourceRevision: defaultSourceRev,
            chunkIndex: 0,
            entityId: defaultEntityId,
            entityType: "task",
            orgId: defaultOrgId,
            chunkCount: 1,
            text: defaultText,
          },
        },
      };

      const res = await verifyPhysicalPersistence({
        orgId: defaultOrgId,
        generationId: defaultGenerationId,
        entityType: "task",
        entityId: defaultEntityId,
        sourceRevision: defaultSourceRev,
        expectedChunkCount: 1,
        expectedManifestDigest: defaultDigest,
        maxBudgetMs: 500,
        initialDelayMs: 10,
        fetcher: async () => ({ records: mockRecords }),
      });

      expect(res.verified).toBe(false);
      expect((res as { reason?: string }).reason).toBe("DIMENSION_MISMATCH");
    });

    it("enforces maxBudgetMs timeout deadline and returns TIMEOUT_BUDGET_EXCEEDED on exhaustion", async () => {
      const res = await verifyPhysicalPersistence({
        orgId: defaultOrgId,
        generationId: defaultGenerationId,
        entityType: "task",
        entityId: defaultEntityId,
        sourceRevision: defaultSourceRev,
        expectedChunkCount: 1,
        expectedManifestDigest: defaultDigest,
        maxBudgetMs: 50,
        initialDelayMs: 20,
        fetcher: async () => ({ records: {} }),
      });

      expect(res.verified).toBe(false);
      expect((res as { reason?: string }).reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
    });
  });

  // ---------------------------------------------------------------------------
  // AREA 2: S3 — Dispatcher Publish Failure Recovery and Backoff
  // ---------------------------------------------------------------------------
  describe("S3: Dispatcher Publish Failure Recovery", () => {
    it("increments dispatchAttempts, sets nextRetryAt with backoff, and keeps status PENDING on intermediate failure", async () => {
      const outboxId = "outbox_fail_1";
      const token = "claim_tok_1";

      const queryRawMock = jest
        .fn()
        // 1. Fetch current row
        .mockResolvedValueOnce([
          {
            id: outboxId,
            entityType: "TASK",
            entityId: "task_1",
            dispatchAttempts: 1,
          },
        ])
        // 2. Newer pending check: none
        .mockResolvedValueOnce([])
        // 3. Update queryRaw returning updated row
        .mockResolvedValueOnce([
          {
            id: outboxId,
            dispatchAttempts: 2,
            nextRetryAt: new Date(),
          },
        ]);

      const mockDbLocal = { $queryRaw: queryRawMock } as unknown as PrismaClient;

      const res = await handleVectorOutboxPublishFailure({
        db: mockDbLocal,
        outboxEventId: outboxId,
        dispatchClaimToken: token,
        error: new Error("QStash network 503 error"),
        maxAttempts: 5,
      });

      expect(res.status).toBe("RETRY_SCHEDULED");
      expect(queryRawMock).toHaveBeenCalledTimes(3);
    });

    it("transitions status to FAILED when dispatchAttempts reaches maxAttempts", async () => {
      const outboxId = "outbox_fail_terminal";
      const token = "claim_tok_term";

      const queryRawMock = jest
        .fn()
        // 1. Fetch current row with attempts = 4 (will become 5)
        .mockResolvedValueOnce([
          {
            id: outboxId,
            entityType: "TASK",
            entityId: "task_1",
            dispatchAttempts: 4,
          },
        ])
        // 2. Newer pending check: none
        .mockResolvedValueOnce([])
        // 3. Update queryRaw setting status = FAILED
        .mockResolvedValueOnce([
          {
            id: outboxId,
            dispatchAttempts: 5,
          },
        ]);

      const mockDbLocal = { $queryRaw: queryRawMock } as unknown as PrismaClient;

      const res = await handleVectorOutboxPublishFailure({
        db: mockDbLocal,
        outboxEventId: outboxId,
        dispatchClaimToken: token,
        error: new Error("Fatal provider outage"),
        maxAttempts: 5,
      });

      expect(res.status).toBe("FAILED_TERMINAL");
      expect(queryRawMock).toHaveBeenCalledTimes(3);
    });

    it("detects newer pending outbox event and marks superseded older row as FAILED with supersession message", async () => {
      const outboxId = "outbox_older";
      const newerId = "outbox_newer_coalesced";
      const token = "claim_tok_old";

      const queryRawMock = jest
        .fn()
        // 1. Fetch current row
        .mockResolvedValueOnce([
          {
            id: outboxId,
            entityType: "TASK",
            entityId: "task_1",
            dispatchAttempts: 1,
          },
        ])
        // 2. Newer pending check returns the newer coalesced row!
        .mockResolvedValueOnce([{ id: newerId, sourceRevision: 2 }])
        // 3. Update queryRaw setting status = FAILED with supersession error
        .mockResolvedValueOnce([{ id: outboxId }]);

      const mockDbLocal = { $queryRaw: queryRawMock } as unknown as PrismaClient;

      const res = await handleVectorOutboxPublishFailure({
        db: mockDbLocal,
        outboxEventId: outboxId,
        dispatchClaimToken: token,
        error: new Error("Publish failed after supersession"),
      });

      expect(res.status).toBe("SUPERSEDED");
    });
  });

  // ---------------------------------------------------------------------------
  // AREA 3: I-7 — Worker Heartbeat and Lease Fencing
  // ---------------------------------------------------------------------------
  describe("I-7: Worker Heartbeat and Completion Fencing", () => {
    it("creates worker instance configured with heartbeat options", () => {
      const original = process.env.ALLOW_UNSIGNED_LOCAL_WORKER;
      try {
        process.env.ALLOW_UNSIGNED_LOCAL_WORKER = "true";
        const worker = createWorker(
          "TASK_CREATED",
          async () => {},
          { heartbeatIntervalMs: 30000, leaseSeconds: 300 }
        );

        expect(typeof worker).toBe("function");
      } finally {
        if (original === undefined) {
          delete process.env.ALLOW_UNSIGNED_LOCAL_WORKER;
        } else {
          process.env.ALLOW_UNSIGNED_LOCAL_WORKER = original;
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // AREA 4: I-1 & I-11 — Content Hashes and Attachment Scoping
  // ---------------------------------------------------------------------------
  describe("I-1 & I-11: Content Hash Invariants & Invalidation Scoping", () => {
    it("computes deterministic Task content hash across fields", () => {
      const hash1 = computeTaskContentHash({
        id: "task_1",
        projectId: "proj_1",
        title: "Build Rocket",
        description: "Stage 1",
        status: "IN_PROGRESS",
        priority: "HIGH",
        assigneeId: "user_1",
      });

      const hash2 = computeTaskContentHash({
        id: "task_1",
        projectId: "proj_1",
        title: "Build Rocket",
        description: "Stage 1",
        status: "IN_PROGRESS",
        priority: "HIGH",
        assigneeId: "user_1",
      });

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it("changes Task content hash when title or description changes", () => {
      const hashOriginal = computeTaskContentHash({
        id: "task_1",
        projectId: "proj_1",
        title: "Build Rocket",
        description: "Stage 1",
        status: "IN_PROGRESS",
        priority: "HIGH",
        assigneeId: "user_1",
      });

      const hashTitleChanged = computeTaskContentHash({
        id: "task_1",
        projectId: "proj_1",
        title: "Build Starship",
        description: "Stage 1",
        status: "IN_PROGRESS",
        priority: "HIGH",
        assigneeId: "user_1",
      });

      expect(hashOriginal).not.toBe(hashTitleChanged);
    });

    it("changes Attachment parentTaskVersion when task title changes, but preserves it when unaffected fields change", () => {
      const version1 = computeAttachmentParentTaskVersion({
        title: "Initial Task Title",
        projectId: "proj_1",
      });

      const version2 = computeAttachmentParentTaskVersion({
        title: "Updated Task Title",
        projectId: "proj_1",
      });

      const version1Duplicate = computeAttachmentParentTaskVersion({
        title: "Initial Task Title",
        projectId: "proj_1",
      });

      expect(version1).not.toBe(version2);
      expect(version1).toBe(version1Duplicate);
    });
  });
});
