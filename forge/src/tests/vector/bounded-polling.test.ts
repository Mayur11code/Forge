// src/tests/vector/bounded-polling.test.ts
jest.mock("server-only", () => ({}));

import { verifyPhysicalPersistence } from "@/lib/vector/client";
import { buildVectorId, computeManifestDigest } from "@/lib/vector/schema";

describe("Vector V2 Phase B: PR-2 Bounded Read-Back Polling & Verification (E2 Suite)", () => {
  const orgId = "org_test";
  const entityId = "task_555";
  const generationId = "gen_999";
  const sourceRevision = 1;
  const chunkCount = 2;

  const id0 = buildVectorId("task", entityId, generationId, 0);
  const id1 = buildVectorId("task", entityId, generationId, 1);

  const validRecord0 = {
    id: id0,
    values: new Array(768).fill(0.01),
    metadata: {
      contractVersion: "v2",
      entityType: "task",
      entityId,
      generationId,
      sourceRevision,
      chunkIndex: 0,
      chunkCount,
      orgId,
      projectId: "proj_1",
      text: "Chunk 0 text",
    },
  };

  const validRecord1 = {
    id: id1,
    values: new Array(768).fill(0.02),
    metadata: {
      contractVersion: "v2",
      entityType: "task",
      entityId,
      generationId,
      sourceRevision,
      chunkIndex: 1,
      chunkCount,
      orgId,
      projectId: "proj_1",
      text: "Chunk 1 text",
    },
  };

  const expectedDigest = computeManifestDigest([
    { chunkIndex: 0, id: id0, text: "Chunk 0 text" },
    { chunkIndex: 1, id: id1, text: "Chunk 1 text" },
  ]);

  it("verifies physical persistence immediately when all chunks are present on attempt 1", async () => {
    const mockFetcher = jest.fn().mockResolvedValue({
      records: {
        [id0]: validRecord0,
        [id1]: validRecord1,
      },
    });

    const result = await verifyPhysicalPersistence({
      orgId,
      generationId,
      entityType: "task",
      entityId,
      sourceRevision,
      expectedChunkCount: chunkCount,
      expectedManifestDigest: expectedDigest,
      fetcher: mockFetcher,
    });

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.attempts).toBe(1);
      expect(result.chunksFound).toBe(2);
      expect(result.manifestDigest).toBe(expectedDigest);
      expect(result.readBackLatencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles eventual consistency by polling until all chunks appear", async () => {
    let callCount = 0;
    const mockFetcher = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Attempt 1: only chunk 0 is visible
        return { records: { [id0]: validRecord0 } };
      }
      // Attempt 2: both chunks visible
      return {
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      };
    });

    const result = await verifyPhysicalPersistence({
      orgId,
      generationId,
      entityType: "task",
      entityId,
      sourceRevision,
      expectedChunkCount: chunkCount,
      expectedManifestDigest: expectedDigest,
      initialDelayMs: 20,
      maxBudgetMs: 5000,
      fetcher: mockFetcher,
    });

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.attempts).toBe(2);
      expect(result.chunksFound).toBe(2);
    }
  });

  it("fails with TIMEOUT_BUDGET_EXCEEDED when records do not appear within budget", async () => {
    const mockFetcher = jest.fn().mockResolvedValue({
      records: { [id0]: validRecord0 }, // id1 never appears
    });

    const result = await verifyPhysicalPersistence({
      orgId,
      generationId,
      entityType: "task",
      entityId,
      sourceRevision,
      expectedChunkCount: chunkCount,
      initialDelayMs: 20,
      maxBudgetMs: 100, // Short budget for test
      fetcher: mockFetcher,
    });

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
      expect(result.missingIds).toEqual([id1]);
      expect(result.attempts).toBeGreaterThanOrEqual(1);
    }
  });

  it("fails with MANIFEST_DIGEST_MISMATCH when actual digest differs from expected", async () => {
    const mockFetcher = jest.fn().mockResolvedValue({
      records: {
        [id0]: validRecord0,
        [id1]: validRecord1,
      },
    });

    const wrongDigest = "0000000000000000000000000000000000000000000000000000000000000000";

    const result = await verifyPhysicalPersistence({
      orgId,
      generationId,
      entityType: "task",
      entityId,
      sourceRevision,
      expectedChunkCount: chunkCount,
      expectedManifestDigest: wrongDigest,
      fetcher: mockFetcher,
    });

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
      expect(result.actualManifestDigest).toBe(expectedDigest);
    }
  });

  it("fails with METADATA_MISMATCH when fetched chunk belongs to wrong generation or revision", async () => {
    const staleRecord = {
      ...validRecord0,
      metadata: {
        ...validRecord0.metadata,
        sourceRevision: 999, // Mismatched revision
      },
    };

    const mockFetcher = jest.fn().mockResolvedValue({
      records: {
        [id0]: staleRecord,
        [id1]: validRecord1,
      },
    });

    const result = await verifyPhysicalPersistence({
      orgId,
      generationId,
      entityType: "task",
      entityId,
      sourceRevision,
      expectedChunkCount: chunkCount,
      fetcher: mockFetcher,
    });

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("METADATA_MISMATCH");
    }
  });

  it("fails with DIMENSION_MISMATCH when vector dimensions do not equal 768", async () => {
    const wrongDimRecord = {
      ...validRecord0,
      values: [0.1, 0.2, 0.3], // length 3 instead of 768
    };

    const mockFetcher = jest.fn().mockResolvedValue({
      records: {
        [id0]: wrongDimRecord,
        [id1]: validRecord1,
      },
    });

    const result = await verifyPhysicalPersistence({
      orgId,
      generationId,
      entityType: "task",
      entityId,
      sourceRevision,
      expectedChunkCount: chunkCount,
      fetcher: mockFetcher,
    });

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("DIMENSION_MISMATCH");
    }
  });
});
