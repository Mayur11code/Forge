// forge/src/tests/vector/part2-generation-lifecycle.test.ts
/**
 * Phase B Remediation — Part 2: Generation Worker Lease Lifecycle Acceptance Tests (E2)
 *
 * Verifies all 10 mandatory requirements from UPPR Rev 4:
 * 1. A long-running generation renews its lease.
 * 2. Multiple renewal intervals are exercised during a long-running operation.
 * 3. Renewal failure marks ownership as lost.
 * 4. Ownership loss prevents subsequent embedding batches or generation side effects.
 * 5. Ownership loss prevents activation.
 * 6. A stale generation token cannot activate or overwrite a newer generation.
 * 7. The heartbeat timer is cleaned up after success.
 * 8. The heartbeat timer is cleaned up after an exception.
 * 9. The heartbeat timer is cleaned up after lease loss.
 * 10. No renewal occurs after the generation lease has been released.
 * 11. Heartbeat release boundary between activation and outbox completion triggers zero renewals.
 * 12. Multi-batch embedding halts immediately if ownership is lost before subsequent batch.
 * 13. Ownership lost before the first embedding batch prevents that batch from starting.
 * 14. Ownership lost during the primary Gemini request prevents fallback dispatch.
 */

jest.mock("server-only", () => ({}));

import { embeddingWorkerHandler, EmbeddingEventParams } from "@/app/api/worker/embedding-worker/ew";
import { getTenantVectorStore, verifyPhysicalPersistence } from "@/lib/vector/client";
import { resolveOrganizationGenerativeAiClient } from "@/lib/ai/resolver";
import {
  isGeminiAuthenticationError,
  logCredentialFailover,
} from "@/lib/security/credential-rotation";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";
import {
  reserveGeneration,
  renewGenerationLease,
  markGenerationWritten,
  activateGeneration,
  failGeneration,
} from "@/lib/vector/generation-state";
import { completeVectorOutboxEvent } from "@/lib/vector/outbox";

jest.mock("@/lib/vector/client", () => ({
  getTenantVectorStore: jest.fn(),
  verifyPhysicalPersistence: jest.fn(),
}));

jest.mock("@/lib/ai/resolver", () => ({
  resolveOrganizationGenerativeAiClient: jest.fn(),
}));

jest.mock("@/lib/security/credential-rotation", () => ({
  isGeminiAuthenticationError: jest.fn(() => false),
  logCredentialFailover: jest.fn(),
}));

jest.mock("@/lib/vector/semantic-chunker", () => ({
  chunkTextSemantically: jest.fn(),
}));

jest.mock("@/lib/vector/generation-state", () => ({
  reserveGeneration: jest.fn(),
  renewGenerationLease: jest.fn(),
  markGenerationWritten: jest.fn(),
  activateGeneration: jest.fn(),
  failGeneration: jest.fn(),
}));

jest.mock("@/lib/vector/outbox", () => ({
  completeVectorOutboxEvent: jest.fn(),
}));

// Mock DB with transaction support
const mockTaskFind = jest.fn();
jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    task: { findFirst: (...args: any[]) => mockTaskFind(...args) },
    attachment: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    $transaction: jest.fn(async (cb: any) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ latestRevision: 1, isTombstone: false }]),
      };
      return cb(tx);
    }),
  },
}));

describe("Part 2 Area B: Generation Worker Lease Lifecycle & Fencing (E2)", () => {
  const orgId = "org_gen_lifecycle";
  const taskId = "task_gen_100";
  const genId = "gen_live_999";
  const claimToken = "claim_live_token_abc";
  const headId = "head_live_xyz";

  let mockVectorStore: {
    upsertGenerationVectors: jest.Mock;
    deleteByTask: jest.Mock;
  };
  let mockBatchEmbedContents: jest.Mock;
  let renewalCount = 0;

  beforeEach(() => {
    jest.clearAllMocks();
    renewalCount = 0;

    mockTaskFind.mockResolvedValue({
      id: taskId,
      title: "Real Long-Running Task",
      description: "Testing generation heartbeats",
      status: "TODO",
      priority: "HIGH",
      projectId: "proj_123",
      assigneeId: null,
      updatedAt: new Date(),
    });

    mockVectorStore = {
      upsertGenerationVectors: jest.fn().mockResolvedValue(undefined),
      deleteByTask: jest.fn().mockResolvedValue(undefined),
    };
    (getTenantVectorStore as jest.Mock).mockReturnValue(mockVectorStore);

    (chunkTextSemantically as jest.Mock).mockResolvedValue([
      "Chunk paragraph 1",
      "Chunk paragraph 2",
    ]);

    mockBatchEmbedContents = jest.fn(async () => ({
      embeddings: [
        { values: new Array(768).fill(0.1) },
        { values: new Array(768).fill(0.2) },
      ],
    }));

    (resolveOrganizationGenerativeAiClient as jest.Mock).mockResolvedValue({
      client: {
        getGenerativeModel: () => ({
          batchEmbedContents: mockBatchEmbedContents,
        }),
      },
      fallbackClient: null,
    });

    (reserveGeneration as jest.Mock).mockResolvedValue({
      generation: { id: genId, expectedChunkCount: 2 },
      claimToken,
      head: { id: headId, latestRevision: 1 },
    });

    (renewGenerationLease as jest.Mock).mockImplementation(async () => {
      renewalCount++;
      return { id: genId, status: "WRITING" };
    });

    (markGenerationWritten as jest.Mock).mockResolvedValue({
      id: genId,
      status: "WRITTEN",
    });

    (verifyPhysicalPersistence as jest.Mock).mockResolvedValue({
      verified: true,
      chunksFound: 2,
      manifestDigest: "digest_abc",
      readBackLatencyMs: 25,
    });

    (activateGeneration as jest.Mock).mockResolvedValue({
      activatedGeneration: { id: genId, status: "ACTIVE" },
      obsoletedGenerationId: null,
    });
  });

  function createEmbeddingEvent(): EmbeddingEventParams["event"] {
    return {
      id: "evt_embed_1",
      type: "EMBEDDING_REQUESTED",
      data: {
        orgId,
        entityId: taskId,
        type: "TASK",
        sourceRevision: 1,
      },
      time: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Case 1: Long-Running Generation Renews Its Lease
  // ---------------------------------------------------------------------------
  it("B1: A long-running generation renews its lease during execution", async () => {
    // Simulate long-running embedding call that takes 70ms
    mockBatchEmbedContents.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return {
        embeddings: [
          { values: new Array(768).fill(0.1) },
          { values: new Array(768).fill(0.2) },
        ],
      };
    });

    await embeddingWorkerHandler({
      event: createEmbeddingEvent(),
      options: {
        leaseDurationSeconds: 2,
        heartbeatIntervalMs: 25, // Fires every 25ms
      },
    });

    expect(renewGenerationLease).toHaveBeenCalled();
    expect(renewalCount).toBeGreaterThanOrEqual(1);
    expect(activateGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: genId,
        claimToken,
      })
    );
  });

  // ---------------------------------------------------------------------------
  // Case 2: Multiple Renewal Intervals Exercised
  // ---------------------------------------------------------------------------
  it("B2: Multiple renewal intervals are exercised during extended operations", async () => {
    mockBatchEmbedContents.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        embeddings: [
          { values: new Array(768).fill(0.1) },
          { values: new Array(768).fill(0.2) },
        ],
      };
    });

    await embeddingWorkerHandler({
      event: createEmbeddingEvent(),
      options: {
        leaseDurationSeconds: 2,
        heartbeatIntervalMs: 25,
      },
    });

    expect(renewalCount).toBeGreaterThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Case 3: Renewal Failure Marks Ownership as Lost
  // ---------------------------------------------------------------------------
  it("B3: Renewal failure marks ownership as lost and halts subsequent execution", async () => {
    (renewGenerationLease as jest.Mock).mockRejectedValue(
      new Error("OWNERSHIP_LOST_TOKEN_MISMATCH")
    );

    // AI call takes long enough for timer to fire
    mockBatchEmbedContents.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        embeddings: [
          { values: new Array(768).fill(0.1) },
          { values: new Array(768).fill(0.2) },
        ],
      };
    });

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 2,
          heartbeatIntervalMs: 20,
        },
      })
    ).rejects.toThrow("Generation lease ownership lost");

    // Verified: activation was prevented
    expect(activateGeneration).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 4: Ownership Loss Prevents Subsequent Side Effects (Pinecone Upsert)
  // ---------------------------------------------------------------------------
  it("B4: Ownership loss prevents subsequent vector store mutations and manifests", async () => {
    (renewGenerationLease as jest.Mock).mockRejectedValue(
      new Error("LEASE_EXPIRED_OR_STOLEN")
    );

    mockBatchEmbedContents.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        embeddings: [
          { values: new Array(768).fill(0.1) },
          { values: new Array(768).fill(0.2) },
        ],
      };
    });

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 2,
          heartbeatIntervalMs: 20,
        },
      })
    ).rejects.toThrow("Generation lease ownership lost");

    // Vector store upsert was completely prevented
    expect(mockVectorStore.upsertGenerationVectors).not.toHaveBeenCalled();
    expect(markGenerationWritten).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 5: Ownership Loss Prevents Generation Activation
  // ---------------------------------------------------------------------------
  it("B5: Ownership loss prevents generation activation", async () => {
    // Allow embedding and upsert to finish, but fail renewal right before activation
    let upsertDone = false;
    mockVectorStore.upsertGenerationVectors.mockImplementation(async () => {
      upsertDone = true;
    });

    (renewGenerationLease as jest.Mock).mockImplementation(async () => {
      if (upsertDone) {
        throw new Error("STOLEN_BEFORE_ACTIVATION");
      }
      return { id: genId };
    });

    // Make verification take long enough for heartbeat to fail
    (verifyPhysicalPersistence as jest.Mock).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { verified: true, chunksFound: 2, manifestDigest: "digest_abc" };
    });

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 2,
          heartbeatIntervalMs: 25,
        },
      })
    ).rejects.toThrow("Generation lease ownership lost");

    expect(activateGeneration).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 6: Stale Token Cannot Activate Generation
  // ---------------------------------------------------------------------------
  it("B6: A stale generation token cannot activate or overwrite a newer generation", async () => {
    (activateGeneration as jest.Mock).mockRejectedValue(
      new Error("OwnershipTokenMismatchError: Claim token mismatch")
    );

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 2,
          heartbeatIntervalMs: 200,
        },
      })
    ).rejects.toThrow("OwnershipTokenMismatchError");
  });

  // ---------------------------------------------------------------------------
  // Case 7: Heartbeat Timer Cleaned Up After Success
  // ---------------------------------------------------------------------------
  it("B7: The heartbeat timer is cleaned up after successful completion", async () => {
    await embeddingWorkerHandler({
      event: createEmbeddingEvent(),
      options: {
        leaseDurationSeconds: 2,
        heartbeatIntervalMs: 20,
      },
    });

    const callsAfterSuccess = renewalCount;

    // Wait past multiple heartbeat ticks
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(renewalCount).toBe(callsAfterSuccess);
  });

  // ---------------------------------------------------------------------------
  // Case 8: Heartbeat Timer Cleaned Up After Handler Exception
  // ---------------------------------------------------------------------------
  it("B8: The heartbeat timer is cleaned up in finally after an exception", async () => {
    mockBatchEmbedContents.mockRejectedValue(new Error("Gemini quota exhaustion"));

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 2,
          heartbeatIntervalMs: 20,
        },
      })
    ).rejects.toThrow("Gemini quota exhaustion");

    const callsAfterError = renewalCount;

    // Advance time: timer must not fire anymore
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(renewalCount).toBe(callsAfterError);
  });

  // ---------------------------------------------------------------------------
  // Case 9: Heartbeat Timer Cleaned Up After Lease Loss
  // ---------------------------------------------------------------------------
  it("B9: The heartbeat timer is cleaned up immediately after lease loss", async () => {
    (renewGenerationLease as jest.Mock).mockRejectedValue(new Error("LEASE_LOSS"));

    mockBatchEmbedContents.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { embeddings: [{ values: [] }, { values: [] }] };
    });

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 2,
          heartbeatIntervalMs: 20,
        },
      })
    ).rejects.toThrow("Generation lease ownership lost");

    expect(renewGenerationLease).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(renewGenerationLease).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Case 10: No Renewal Occurs After Generation Lease Released
  // ---------------------------------------------------------------------------
  it("B10: No renewal occurs after the generation lease has been activated/released", async () => {
    await embeddingWorkerHandler({
      event: createEmbeddingEvent(),
      options: {
        leaseDurationSeconds: 2,
        heartbeatIntervalMs: 15,
      },
    });

    expect(activateGeneration).toHaveBeenCalled();
    const finalCount = renewalCount;

    // Wait an extended period to ensure complete cessation
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renewalCount).toBe(finalCount);
  });

  // ---------------------------------------------------------------------------
  // Case 11: Heartbeat Release Boundary Between Activation and Outbox Completion
  // ---------------------------------------------------------------------------
  it("B11: Heartbeat is stopped at activation boundary; artificial delay before outbox completion triggers zero renewals", async () => {
    let renewalsDuringOutboxCompletion = 0;
    let activationFinished = false;

    (activateGeneration as jest.Mock).mockImplementation(async () => {
      activationFinished = true;
      return {
        activatedGeneration: { id: genId, status: "ACTIVE" },
        obsoletedGenerationId: null,
      };
    });

    (completeVectorOutboxEvent as jest.Mock).mockImplementation(async () => {
      // Simulate artificial delay in completing outbox event (100ms)
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    (renewGenerationLease as jest.Mock).mockImplementation(async () => {
      if (activationFinished) {
        renewalsDuringOutboxCompletion++;
      }
      return { id: genId };
    });

    await embeddingWorkerHandler({
      event: {
        ...createEmbeddingEvent(),
        data: {
          ...createEmbeddingEvent().data,
          outboxEventId: "outbox_evt_b11",
        },
      },
      options: {
        leaseDurationSeconds: 2,
        heartbeatIntervalMs: 20, // 20ms ticks would fire 5 times during 100ms delay if timer were not stopped!
      },
    });

    // Verified: zero renewals occurred after activation boundary
    expect(renewalsDuringOutboxCompletion).toBe(0);
    expect(completeVectorOutboxEvent).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 12: Multi-Batch Embedding Fencing
  // ---------------------------------------------------------------------------
  it("B12: Multi-batch embedding halts immediately if ownership is lost before subsequent batch", async () => {
    // Generate 150 chunks so it splits into batch 1 (100) and batch 2 (50)
    const largeChunkList = new Array(150).fill("A paragraph of text");
    (chunkTextSemantically as jest.Mock).mockResolvedValue(largeChunkList);

    let batchCount = 0;
    mockBatchEmbedContents.mockImplementation(async ({ requests }: any) => {
      batchCount++;
      if (batchCount === 1) {
        // Lease renewal fails during batch 1 execution
        (renewGenerationLease as jest.Mock).mockRejectedValue(new Error("OWNERSHIP_LOST_DURING_BATCH_1"));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        embeddings: requests.map(() => ({ values: new Array(768).fill(0.1) })),
      };
    });

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 2,
          heartbeatIntervalMs: 20,
        },
      })
    ).rejects.toThrow("Generation lease ownership lost before embedding batch 2");

    // Verified: batch 2 was NEVER invoked
    expect(batchCount).toBe(1);
    // Verified: zero vectors upserted to Pinecone
    expect(mockVectorStore.upsertGenerationVectors).not.toHaveBeenCalled();
    expect(activateGeneration).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 13: Ownership Lost Before First Embedding Batch (Issue 2)
  // ---------------------------------------------------------------------------
  it("B13: Ownership lost before the first embedding batch prevents that batch from starting", async () => {
    (renewGenerationLease as jest.Mock).mockRejectedValue(new Error("LEASE_EXPIRED_IMMEDIATELY"));

    // Delay during AI resolution so the heartbeat fires and loses ownership before batch 0
    (resolveOrganizationGenerativeAiClient as jest.Mock).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        client: {
          getGenerativeModel: () => ({
            batchEmbedContents: mockBatchEmbedContents,
          }),
        },
        fallbackClient: null,
      };
    });

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 1,
          heartbeatIntervalMs: 15,
        },
      })
    ).rejects.toThrow("Generation lease ownership lost before embedding batch 1");

    // Verified: First batch was never called
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    // Verified: No downstream mutations
    expect(mockVectorStore.upsertGenerationVectors).not.toHaveBeenCalled();
    expect(activateGeneration).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 14: Ownership Lost During Primary Request Prevents Fallback Dispatch (Issue 2)
  // ---------------------------------------------------------------------------
  it("B14: Ownership lost during the primary Gemini request prevents fallback dispatch", async () => {
    (isGeminiAuthenticationError as jest.Mock).mockReturnValue(true);

    const mockFallbackBatchEmbedContents = jest.fn();

    (resolveOrganizationGenerativeAiClient as jest.Mock).mockResolvedValue({
      client: {
        getGenerativeModel: () => ({
          batchEmbedContents: mockBatchEmbedContents,
        }),
      },
      fallbackClient: {
        getGenerativeModel: () => ({
          batchEmbedContents: mockFallbackBatchEmbedContents,
        }),
      },
    });

    mockBatchEmbedContents.mockImplementation(async () => {
      // Lease renewal fails while primary request is in flight
      (renewGenerationLease as jest.Mock).mockRejectedValue(new Error("LEASE_LOST_DURING_PRIMARY"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("API_KEY_INVALID");
    });

    await expect(
      embeddingWorkerHandler({
        event: createEmbeddingEvent(),
        options: {
          leaseDurationSeconds: 1,
          heartbeatIntervalMs: 15,
        },
      })
    ).rejects.toThrow("Generation lease ownership lost before fallback embedding dispatch");

    // Verified: primary was called, but fallback was NEVER dispatched
    expect(mockBatchEmbedContents).toHaveBeenCalledTimes(1);
    expect(mockFallbackBatchEmbedContents).not.toHaveBeenCalled();
    // Verified: zero vectors upserted and zero activations
    expect(mockVectorStore.upsertGenerationVectors).not.toHaveBeenCalled();
    expect(activateGeneration).not.toHaveBeenCalled();
  });
});
