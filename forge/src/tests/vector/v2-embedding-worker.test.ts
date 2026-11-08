// src/tests/vector/v2-embedding-worker.test.ts
jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";
import { prisma } from "@/lib/prisma/extended";
import { db } from "@/lib/prisma/db";
import { getTenantVectorStore, verifyPhysicalPersistence } from "@/lib/vector/client";
import { resolveOrganizationGenerativeAiClient } from "@/lib/ai/resolver";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";
import {
  reserveGeneration,
  markGenerationWritten,
  activateGeneration,
  failGeneration,
} from "@/lib/vector/generation-state";
import { completeVectorOutboxEvent } from "@/lib/vector/outbox";
import { VectorEntityType } from "@prisma/client";

jest.mock("@/lib/vector/client", () => ({
  getTenantVectorStore: jest.fn(),
  verifyPhysicalPersistence: jest.fn(),
}));

jest.mock("@/lib/ai/resolver", () => ({
  resolveOrganizationGenerativeAiClient: jest.fn(),
}));

jest.mock("@/lib/vector/semantic-chunker", () => ({
  chunkTextSemantically: jest.fn(),
}));

jest.mock("@/lib/vector/generation-state", () => ({
  reserveGeneration: jest.fn(),
  markGenerationWritten: jest.fn(),
  activateGeneration: jest.fn(),
  failGeneration: jest.fn(),
}));

jest.mock("@/lib/vector/outbox", () => ({
  completeVectorOutboxEvent: jest.fn(),
}));

describe("Vector V2 Phase B: PR-4 Distributed Embedding Worker Lifecycle (E2 Suite)", () => {
  const orgId = "org_worker_test";
  const taskId = "task_worker_100";
  const genId = "gen_worker_123";
  const claimToken = "claim_worker_token";
  const headId = "head_worker_abc";

  let mockVectorStore: {
    upsertGenerationVectors: jest.Mock;
    deleteByTask: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockVectorStore = {
      upsertGenerationVectors: jest.fn().mockResolvedValue(undefined),
      deleteByTask: jest.fn().mockResolvedValue(undefined),
    };
    (getTenantVectorStore as jest.Mock).mockReturnValue(mockVectorStore);

    (chunkTextSemantically as jest.Mock).mockResolvedValue([
      "Chunk 0 text content",
      "Chunk 1 text content",
    ]);

    (resolveOrganizationGenerativeAiClient as jest.Mock).mockResolvedValue({
      client: {
        getGenerativeModel: () => ({
          batchEmbedContents: jest.fn().mockResolvedValue({
            embeddings: [
              { values: new Array(768).fill(0.1) },
              { values: new Array(768).fill(0.2) },
            ],
          }),
        }),
      },
      fallbackClient: null,
    });

    (reserveGeneration as jest.Mock).mockResolvedValue({
      generation: { id: genId, expectedChunkCount: 2 },
      claimToken,
      head: { id: headId, latestRevision: 1 },
    });

    (markGenerationWritten as jest.Mock).mockResolvedValue({
      id: genId,
      status: "WRITTEN",
    });

    (verifyPhysicalPersistence as jest.Mock).mockResolvedValue({
      verified: true,
      chunksFound: 2,
      manifestDigest: "digest_123",
      readBackLatencyMs: 150,
      attempts: 1,
    });

    (activateGeneration as jest.Mock).mockResolvedValue({
      activatedGeneration: { id: genId, status: "ACTIVE" },
      obsoletedGenerationId: null,
      head: { id: headId, activeGenId: genId },
    });

    (completeVectorOutboxEvent as jest.Mock).mockResolvedValue(true);

    // Mock interactive db.$transaction
    (db as unknown as { $transaction: jest.Mock }).$transaction = jest.fn().mockImplementation(async (callback) => {
      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ latestRevision: 1, isTombstone: false }]),
      };
      return callback(mockTx);
    });
  });

  it("executes the full V2 pipeline without deleteByTask pre-wipe and activates generation", async () => {
    (prisma as unknown as { task: unknown }).task = {
      findFirst: jest.fn().mockResolvedValue({
        id: taskId,
        title: "Durable Outbox Worker Task",
        description: "Task description",
        status: "TODO",
        priority: "HIGH",
        projectId: "proj_1",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    };

    const event = {
      id: "evt_1",
      type: "EMBEDDING_REQUESTED" as const,
      data: {
        orgId,
        entityId: taskId,
        type: "TASK" as const,
        outboxEventId: "outbox_row_1",
        sourceRevision: 1,
      },
      time: new Date().toISOString(),
    };

    await embeddingWorkerHandler({ event });

    // Assert: NEVER calls deleteByTask
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();

    // Assert: calls reserveGeneration
    expect(reserveGeneration).toHaveBeenCalledTimes(1);

    // Assert: calls upsertGenerationVectors with 2 generation-scoped records
    expect(mockVectorStore.upsertGenerationVectors).toHaveBeenCalledTimes(1);
    const upsertedRecords = mockVectorStore.upsertGenerationVectors.mock.calls[0][0];
    expect(upsertedRecords).toHaveLength(2);
    expect(upsertedRecords[0].id).toContain(genId);

    // Assert: calls markGenerationWritten with write receipt
    expect(markGenerationWritten).toHaveBeenCalledTimes(1);

    // Assert: calls verifyPhysicalPersistence
    expect(verifyPhysicalPersistence).toHaveBeenCalledTimes(1);

    // Assert: calls activateGeneration and completeVectorOutboxEvent
    expect(activateGeneration).toHaveBeenCalledTimes(1);
    expect(completeVectorOutboxEvent).toHaveBeenCalledWith({
      db: expect.anything(),
      outboxEventId: "outbox_row_1",
    });
  });

  it("rejects cross-tenant references with zero vector mutations", async () => {
    // Scoped query returns null
    (prisma as unknown as { task: unknown }).task = {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({
        id: taskId,
        project: { orgId: "different_org" }, // Cross-tenant leak
      }),
    };

    const event = {
      id: "evt_2",
      type: "EMBEDDING_REQUESTED" as const,
      data: {
        orgId,
        entityId: taskId,
        type: "TASK" as const,
      },
      time: new Date().toISOString(),
    };

    await embeddingWorkerHandler({ event });

    // Zero side-effects
    expect(reserveGeneration).not.toHaveBeenCalled();
    expect(mockVectorStore.upsertGenerationVectors).not.toHaveBeenCalled();
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(activateGeneration).not.toHaveBeenCalled();
  });

  it("handles legacy V1 messages non-destructively without deleteByTask", async () => {
    (prisma as unknown as { task: unknown }).task = {
      findFirst: jest.fn().mockResolvedValue({
        id: taskId,
        title: "Legacy V1 Task",
        description: "Legacy task description",
        status: "DONE",
        priority: "LOW",
        projectId: "proj_1",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    };

    // V2 event without outbox row (direct or redriven without outboxEventId)
    const event = {
      id: "evt_v1",
      type: "EMBEDDING_REQUESTED" as const,
      data: {
        orgId,
        entityId: taskId,
        type: "TASK" as const,
        pipelineVersion: "v2",
      },
      time: new Date().toISOString(),
    };

    await embeddingWorkerHandler({ event });

    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(reserveGeneration).toHaveBeenCalledTimes(1);
    expect(mockVectorStore.upsertGenerationVectors).toHaveBeenCalledTimes(1);
    expect(activateGeneration).toHaveBeenCalledTimes(1);
    // completeVectorOutboxEvent is not called since outboxEventId was absent
    expect(completeVectorOutboxEvent).not.toHaveBeenCalled();
  });

  it("fails generation and aborts activation when verifyPhysicalPersistence fails", async () => {
    (prisma as unknown as { task: unknown }).task = {
      findFirst: jest.fn().mockResolvedValue({
        id: taskId,
        title: "Failing Readback Task",
        description: "Task description",
        status: "TODO",
        priority: "HIGH",
        projectId: "proj_1",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    };

    (verifyPhysicalPersistence as jest.Mock).mockResolvedValue({
      verified: false,
      reason: "MANIFEST_DIGEST_MISMATCH",
      attempts: 3,
      elapsedMs: 2000,
    });

    const event = {
      id: "evt_fail",
      type: "EMBEDDING_REQUESTED" as const,
      data: {
        orgId,
        entityId: taskId,
        type: "TASK" as const,
        outboxEventId: "outbox_row_2",
      },
      time: new Date().toISOString(),
    };

    await expect(embeddingWorkerHandler({ event })).rejects.toThrow(
      "Physical persistence verification failed: MANIFEST_DIGEST_MISMATCH"
    );

    expect(failGeneration).toHaveBeenCalledWith({
      generationId: genId,
      claimToken,
      errorMessage: expect.stringContaining("MANIFEST_DIGEST_MISMATCH"),
    });

    expect(activateGeneration).not.toHaveBeenCalled();
    expect(completeVectorOutboxEvent).not.toHaveBeenCalled();
  });
});
