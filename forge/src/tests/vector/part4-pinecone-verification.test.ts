// src/tests/vector/part4-pinecone-verification.test.ts
/**
 * Forge Vector V2 — Phase B: Part 4 Strict Pinecone Physical Verification Hardening (E2 Suite)
 *
 * Exhaustive verification matrix for verifyPhysicalPersistence:
 * Group A: Valid physical verification
 * Group B: Missing and malformed vector values (16 subcases)
 * Group C: Metadata and tenancy strict validation (11 subcases)
 * Group D: Chunk completeness and physical identity (9 subcases)
 * Group E: Canonical SHA-256 manifest integrity (7 subcases)
 * Group F: Strict 5,000 ms monotonic deadline and provider failures (9 subcases)
 * Group G: Production worker activation gate (success and failure paths)
 */

jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));
jest.mock("@/lib/prisma/extended", () => ({ prisma: {} }));

jest.mock("@/lib/vector/client", () => {
  const actual = jest.requireActual("@/lib/vector/client");
  return {
    ...actual,
    getTenantVectorStore: jest.fn(),
  };
});

import { getTenantVectorStore, verifyPhysicalPersistence } from "@/lib/vector/client";
import { buildVectorId, computeManifestDigest } from "@/lib/vector/schema";
import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";
import { prisma } from "@/lib/prisma/extended";
import { resolveOrganizationGenerativeAiClient } from "@/lib/ai/resolver";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";
import {
  reserveGeneration,
  markGenerationWritten,
  activateGeneration,
  failGeneration,
} from "@/lib/vector/generation-state";
import { completeVectorOutboxEvent } from "@/lib/vector/outbox";

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

describe("Vector V2 Phase B — Part 4: Strict Physical Read-Back Hardening (E2 Suite)", () => {
  const orgId = "org_p4_test";
  const entityId = "task_p4_100";
  const generationId = "gen_p4_777";
  const entityType = "task" as const;
  const sourceRevision = 3;
  const chunkCount = 2;

  const id0 = buildVectorId(entityType, entityId, generationId, 0);
  const id1 = buildVectorId(entityType, entityId, generationId, 1);

  const makeValidVector = (seed: number = 0.05): number[] => {
    return Array.from({ length: 768 }, (_, i) => seed + (i % 10) * 0.001);
  };

  const chunk0Text = "First canonical chunk content for Part 4 verification.";
  const chunk1Text = "Second canonical chunk content for Part 4 verification.";

  const validRecord0 = {
    id: id0,
    values: makeValidVector(0.01),
    metadata: {
      contractVersion: "v2",
      entityType,
      entityId,
      generationId,
      sourceRevision,
      chunkIndex: 0,
      chunkCount,
      orgId,
      projectId: "proj_p4",
      text: chunk0Text,
    },
  };

  const validRecord1 = {
    id: id1,
    values: makeValidVector(0.02),
    metadata: {
      contractVersion: "v2",
      entityType,
      entityId,
      generationId,
      sourceRevision,
      chunkIndex: 1,
      chunkCount,
      orgId,
      projectId: "proj_p4",
      text: chunk1Text,
    },
  };

  const expectedDigest = computeManifestDigest([
    { chunkIndex: 0, id: id0, text: chunk0Text },
    { chunkIndex: 1, id: id1, text: chunk1Text },
  ]);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // GROUP A: Valid Physical Verification
  // ===========================================================================
  describe("Group A: Valid Physical Verification", () => {
    it("verifies physical persistence when all IDs, metadata, 768 dimensions, and manifest match strictly", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 5000,
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
  });

  // ===========================================================================
  // GROUP B: Missing and Malformed Vector Values (16 subcases)
  // ===========================================================================
  describe("Group B: Missing and Malformed Vector Values (Strict Dimension Validation)", () => {
    const runDimensionTest = async (valuesModifier: (record: { values?: unknown }) => void) => {
      const badRecord0 = JSON.parse(JSON.stringify(validRecord0));
      valuesModifier(badRecord0);

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: badRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("DIMENSION_MISMATCH");
      }
    };

    it("rejects when values property is missing", async () => {
      await runDimensionTest((r) => delete r.values);
    });

    it("rejects when values is undefined", async () => {
      await runDimensionTest((r) => (r.values = undefined));
    });

    it("rejects when values is null", async () => {
      await runDimensionTest((r) => (r.values = null));
    });

    it("rejects when values is a string", async () => {
      await runDimensionTest((r) => (r.values = "not-a-vector"));
    });

    it("rejects when values is an object", async () => {
      await runDimensionTest((r) => (r.values = { 0: 0.1, 1: 0.2 }));
    });

    it("rejects when values is empty array (0 dimensions)", async () => {
      await runDimensionTest((r) => (r.values = []));
    });

    it("rejects when values has 767 dimensions (under-dimensioned)", async () => {
      await runDimensionTest((r) => (r.values = makeValidVector().slice(0, 767)));
    });

    it("rejects when values has 769 dimensions (over-dimensioned)", async () => {
      await runDimensionTest((r) => (r.values = [...makeValidVector(), 0.999]));
    });

    it("rejects numeric strings in vector values", async () => {
      await runDimensionTest((r) => {
        r.values = makeValidVector();
        (r.values as unknown[])[50] = "0.05";
      });
    });

    it("rejects null entries in vector values", async () => {
      await runDimensionTest((r) => {
        r.values = makeValidVector();
        (r.values as unknown[])[100] = null;
      });
    });

    it("rejects boolean entries in vector values", async () => {
      await runDimensionTest((r) => {
        r.values = makeValidVector();
        (r.values as unknown[])[200] = true;
      });
    });

    it("rejects object entries in vector values", async () => {
      await runDimensionTest((r) => {
        r.values = makeValidVector();
        (r.values as unknown[])[300] = { nested: 1 };
      });
    });

    it("rejects NaN entries in vector values", async () => {
      await runDimensionTest((r) => {
        const v = makeValidVector();
        v[400] = NaN;
        r.values = v;
      });
    });

    it("rejects positive Infinity entries in vector values", async () => {
      await runDimensionTest((r) => {
        const v = makeValidVector();
        v[500] = Infinity;
        r.values = v;
      });
    });

    it("rejects negative Infinity entries in vector values", async () => {
      await runDimensionTest((r) => {
        const v = makeValidVector();
        v[600] = -Infinity;
        r.values = v;
      });
    });

    it("rejects sparse array with unindexed hole in vector values", async () => {
      await runDimensionTest((r) => {
        const arr = new Array(768).fill(0.05);
        delete arr[42]; // Creates hole at index 42
        r.values = arr;
      });
    });
  });

  // ===========================================================================
  // GROUP C: Metadata and Tenancy (11 subcases)
  // ===========================================================================
  describe("Group C: Metadata and Tenancy Strict Validation", () => {
    const runMetadataTest = async (metadataModifier: (meta: Record<string, unknown>) => void) => {
      const badRecord0 = JSON.parse(JSON.stringify(validRecord0));
      metadataModifier(badRecord0.metadata);

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: badRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("METADATA_MISMATCH");
      }
    };

    it("rejects when orgId is missing", async () => {
      await runMetadataTest((m) => delete m.orgId);
    });

    it("rejects when orgId is mismatched (cross-tenant leakage attempt)", async () => {
      await runMetadataTest((m) => (m.orgId = "other_evil_org"));
    });

    it("rejects when chunkCount is missing", async () => {
      await runMetadataTest((m) => delete m.chunkCount);
    });

    it("rejects when chunkCount is mismatched", async () => {
      await runMetadataTest((m) => (m.chunkCount = 99));
    });

    it("rejects when generationId is mismatched", async () => {
      await runMetadataTest((m) => (m.generationId = "gen_stale_888"));
    });

    it("rejects when sourceRevision provenance is mismatched", async () => {
      await runMetadataTest((m) => (m.sourceRevision = 999));
    });

    it("rejects when entityType is mismatched", async () => {
      await runMetadataTest((m) => (m.entityType = "attachment"));
    });

    it("rejects when entityId is mismatched", async () => {
      await runMetadataTest((m) => (m.entityId = "task_other_999"));
    });

    it("rejects when contractVersion is not 'v2'", async () => {
      await runMetadataTest((m) => (m.contractVersion = "v1"));
    });

    it("rejects when chunkIndex is a string instead of number (no coercion allowed)", async () => {
      await runMetadataTest((m) => { m.chunkIndex = "0" as unknown as number; });
    });

    it("rejects when text metadata is empty or missing", async () => {
      await runMetadataTest((m) => (m.text = ""));
    });
  });

  // ===========================================================================
  // GROUP D: Chunk Completeness and Physical Identity (9 subcases)
  // ===========================================================================
  describe("Group D: Chunk Completeness and Physical Identity", () => {
    it("fails with TIMEOUT_BUDGET_EXCEEDED when first chunk (index 0) is missing", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: { [id1]: validRecord1 },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        initialDelayMs: 10,
        maxBudgetMs: 80,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
        expect(result.missingIds).toEqual([id0]);
      }
    });

    it("fails with TIMEOUT_BUDGET_EXCEEDED when middle chunk is missing (3 chunks total)", async () => {
      const id2 = buildVectorId(entityType, entityId, generationId, 2);
      const validRecord2 = {
        ...validRecord1,
        id: id2,
        metadata: { ...validRecord1.metadata, chunkIndex: 2, chunkCount: 3 },
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: { ...validRecord0, metadata: { ...validRecord0.metadata, chunkCount: 3 } },
          [id2]: validRecord2,
        }, // id1 is missing
      });

      const digest3 = computeManifestDigest([
        { chunkIndex: 0, id: id0, text: chunk0Text },
        { chunkIndex: 1, id: id1, text: chunk1Text },
        { chunkIndex: 2, id: id2, text: chunk1Text },
      ]);

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: 3,
        expectedManifestDigest: digest3,
        initialDelayMs: 10,
        maxBudgetMs: 80,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
        expect(result.missingIds).toEqual([id1]);
      }
    });

    it("fails with TIMEOUT_BUDGET_EXCEEDED when final chunk is missing", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: { [id0]: validRecord0 },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        initialDelayMs: 10,
        maxBudgetMs: 80,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
        expect(result.missingIds).toEqual([id1]);
      }
    });

    it("rejects when record ID property does not match expected ID (rec.id !== id)", async () => {
      const corruptedRecord0 = {
        ...validRecord0,
        id: "task_spoofed_id_0",
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: corruptedRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("CORRUPTED_ID");
      }
    });

    it("rejects when record ID property is missing completely (Correction A)", async () => {
      const corruptedRecord0 = JSON.parse(JSON.stringify(validRecord0));
      delete corruptedRecord0.id;

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: corruptedRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("CORRUPTED_ID");
      }
    });

    it("rejects when record ID is explicitly undefined (Correction A)", async () => {
      const corruptedRecord0 = {
        ...validRecord0,
        id: undefined as unknown as string,
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: corruptedRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("CORRUPTED_ID");
      }
    });

    it("rejects when record ID is a non-string number (Correction A)", async () => {
      const corruptedRecord0 = {
        ...validRecord0,
        id: 12345 as unknown as string,
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: corruptedRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("CORRUPTED_ID");
      }
    });

    it("rejects when record ID is non-string null (Correction A)", async () => {
      const corruptedRecord0 = {
        ...validRecord0,
        id: null as unknown as string,
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: corruptedRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("CORRUPTED_ID");
      }
    });

    it("rejects when response contains unexpected additional IDs", async () => {
      const extraId = buildVectorId(entityType, entityId, generationId, 99);
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
          [extraId]: { ...validRecord0, id: extraId },
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("CORRUPTED_ID");
      }
    });

    it("rejects when chunk vector ID cannot be parsed", async () => {
      const unparseableId = "corrupted-unparseable-vector-id";
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId: "gen_invalid!@#",
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
      }
    });

    it("rejects when exact count is satisfied but returned record belongs to another generation", async () => {
      const otherGenId = buildVectorId(entityType, entityId, "gen_different_000", 0);
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [otherGenId]: { ...validRecord1, id: otherGenId },
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        initialDelayMs: 10,
        maxBudgetMs: 80,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
        expect(result.missingIds).toEqual([id1]);
      }
    });

    it("rejects when correct IDs exist but metadata chunk index is reversed", async () => {
      const swappedRecord0 = {
        ...validRecord0,
        metadata: { ...validRecord0.metadata, chunkIndex: 1 },
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: swappedRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("METADATA_MISMATCH");
      }
    });

    it("rejects when record object is null or not an object", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: null as unknown as { id: string },
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("CORRUPTED_ID");
      }
    });
  });

  // ===========================================================================
  // GROUP E: Canonical SHA-256 Manifest Integrity (7 subcases)
  // ===========================================================================
  describe("Group E: Canonical SHA-256 Manifest Integrity", () => {
    it("successfully reconstructs canonical manifest digest matching expected", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 5000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(true);
      if (result.verified) {
        expect(result.manifestDigest).toBe(expectedDigest);
      }
    });

    it("fails with MANIFEST_DIGEST_MISMATCH on single-character text modification", async () => {
      const modifiedRecord0 = {
        ...validRecord0,
        metadata: {
          ...validRecord0.metadata,
          text: chunk0Text + "X", // 1 char altered
        },
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: modifiedRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.expectedManifestDigest).toBe(expectedDigest);
        expect(result.actualManifestDigest).not.toBe(expectedDigest);
      }
    });

    it("fails with METADATA_MISMATCH when text metadata is empty", async () => {
      const emptyTextRecord = {
        ...validRecord0,
        metadata: {
          ...validRecord0.metadata,
          text: "",
        },
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: emptyTextRecord,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("METADATA_MISMATCH");
      }
    });

    it("reconstructs manifest strictly by chunkIndex regardless of provider response map key order", async () => {
      // Return records with id1 first, then id0 in object keys
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id1]: validRecord1,
          [id0]: validRecord0,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 5000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(true);
      if (result.verified) {
        expect(result.manifestDigest).toBe(expectedDigest);
      }
    });

    it("fails with MANIFEST_DIGEST_MISMATCH on modified UTF-8 multi-byte characters", async () => {
      const unicodeRecord0 = {
        ...validRecord0,
        metadata: {
          ...validRecord0.metadata,
          text: "Unicode altered chunk: \u00A9 \u2603",
        },
      };

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: unicodeRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
      }
    });

    it("fails with MANIFEST_DIGEST_MISMATCH when expected digest does not match recomputed digest", async () => {
      const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: wrongDigest,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.expectedManifestDigest).toBe(wrongDigest);
        expect(result.actualManifestDigest).toBe(expectedDigest);
      }
    });

    it("fails closed without calling fetcher when expectedManifestDigest is undefined (Correction B)", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: undefined as unknown as string,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      expect(mockFetcher).not.toHaveBeenCalled();
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.attempts).toBe(0);
      }
    });

    it("fails closed without calling fetcher when expectedManifestDigest is null (Correction B)", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: null as unknown as string,
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      expect(mockFetcher).not.toHaveBeenCalled();
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.attempts).toBe(0);
      }
    });

    it("fails closed without calling fetcher when expectedManifestDigest is empty string (Correction B)", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: "",
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      expect(mockFetcher).not.toHaveBeenCalled();
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.attempts).toBe(0);
      }
    });

    it("fails closed without calling fetcher when expectedManifestDigest is whitespace-only (Correction B)", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: "   \t\n  ",
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      expect(mockFetcher).not.toHaveBeenCalled();
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.attempts).toBe(0);
      }
    });

    it("fails closed without calling fetcher when expectedManifestDigest is malformed non-hex format (Correction B)", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: "invalid-non-sha256-string",
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      expect(mockFetcher).not.toHaveBeenCalled();
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.attempts).toBe(0);
      }
    });

    it("fails closed without calling fetcher when expectedManifestDigest has uppercase hex characters (Correction B)", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest.toUpperCase(),
        maxBudgetMs: 1000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      expect(mockFetcher).not.toHaveBeenCalled();
      if (!result.verified) {
        expect(result.reason).toBe("MANIFEST_DIGEST_MISMATCH");
        expect(result.attempts).toBe(0);
      }
    });
  });

  // ===========================================================================
  // GROUP F: Strict 5,000 ms Monotonic Deadline & Provider Failures (9 subcases)
  // ===========================================================================
  describe("Group F: Strict 5,000 ms Monotonic Deadline & Provider Failures", () => {
    it("completes verification successfully well within 5,000 ms budget", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 5000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(true);
      if (result.verified) {
        expect(result.readBackLatencyMs).toBeLessThan(5000);
      }
    });

    it("handles eventual consistency by retrying within budget and succeeding on attempt 2", async () => {
      let callCount = 0;
      const mockFetcher = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { records: { [id0]: validRecord0 } };
        }
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
        entityType,
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

    it("bounds a hanging fetch request using bounded perRequestTimeoutMs", async () => {
      let callCount = 0;
      const mockFetcher = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Return a promise that hangs longer than bounded timeout
          return new Promise((resolve) => setTimeout(() => resolve({ records: {} }), 1000));
        }
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
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        initialDelayMs: 10,
        maxBudgetMs: 500,
        perRequestTimeoutMs: 50, // Fast timeout for hanging call
        fetcher: mockFetcher,
      });

      // Second attempt succeeds after first attempt times out
      expect(result.verified).toBe(true);
      if (result.verified) {
        expect(result.attempts).toBe(2);
      }
    });

    it("fails closed with TIMEOUT_BUDGET_EXCEEDED when fetch returns after deadline", async () => {
      // Fetcher simulates latency exceeding maxBudgetMs
      const mockFetcher = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
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
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 50, // Deadline is 50ms, fetch takes 150ms
        perRequestTimeoutMs: 200,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
      }
    });

    it("retries on transient network errors while budget remains", async () => {
      let callCount = 0;
      const mockFetcher = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("ECONNRESET: Pinecone transient network glitch");
        }
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
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        initialDelayMs: 10,
        maxBudgetMs: 2000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(true);
      if (result.verified) {
        expect(result.attempts).toBe(2);
      }
    });

    it("fails immediately without retry on fatal Pinecone 401 Unauthorized", async () => {
      const mockFetcher = jest.fn().mockRejectedValue({
        status: 401,
        message: "Unauthorized: Invalid Pinecone API key",
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 5000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("METADATA_MISMATCH");
        expect(result.detail).toContain("Fatal Pinecone authentication error");
        expect(result.attempts).toBe(1); // No retries
      }
    });

    it("aborts with TIMEOUT_BUDGET_EXCEEDED when remaining budget is shorter than polling delay threshold", async () => {
      const mockFetcher = jest.fn().mockResolvedValue({ records: {} });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        initialDelayMs: 200,
        maxBudgetMs: 60, // Less than initialDelayMs + 50ms buffer
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
      }
    });

    it("never returns verified: true if deadline expires during fetch settling", async () => {
      let nowTime = 0;
      jest.spyOn(performance, "now").mockImplementation(() => {
        nowTime += 3000; // First call 3000ms, second call 6000ms (exceeding 5000ms budget)
        return nowTime;
      });

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 5000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
      }
    });

    it("never returns verified: true if deadline expires immediately before manifest return", async () => {
      let callIndex = 0;
      const t0 = 1000;
      jest.spyOn(performance, "now").mockImplementation(() => {
        callIndex++;
        // Allow fetch to settle within budget, but totalElapsed hits 5100ms before returning
        if (callIndex === 1) return t0; // startTime
        if (callIndex <= 4) return t0 + 2000; // during fetch
        return t0 + 5100; // right before manifest return (5100ms elapsed >= 5000ms maxBudget)
      });

      const mockFetcher = jest.fn().mockResolvedValue({
        records: {
          [id0]: validRecord0,
          [id1]: validRecord1,
        },
      });

      const result = await verifyPhysicalPersistence({
        orgId,
        generationId,
        entityType,
        entityId,
        sourceRevision,
        expectedChunkCount: chunkCount,
        expectedManifestDigest: expectedDigest,
        maxBudgetMs: 5000,
        fetcher: mockFetcher,
      });

      expect(result.verified).toBe(false);
      if (!result.verified) {
        expect(result.reason).toBe("TIMEOUT_BUDGET_EXCEEDED");
      }
    });
  });

  // ===========================================================================
  // GROUP G: Worker Activation Gate (Production Path)
  // ===========================================================================
  describe("Group G: Production Worker Activation Gate", () => {
    const workerTaskId = "task_worker_p4";
    const workerGenId = "gen_worker_p4";
    const workerClaimToken = "claim_worker_p4_token";
    const workerHeadId = "head_worker_p4";

    let mockVectorStore: {
      upsertGenerationVectors: jest.Mock;
      fetchGenerationVectors: jest.Mock;
      deleteByTask: jest.Mock;
    };

    beforeEach(() => {
      jest.clearAllMocks();

      mockVectorStore = {
        upsertGenerationVectors: jest.fn().mockResolvedValue(undefined),
        fetchGenerationVectors: jest.fn(),
        deleteByTask: jest.fn().mockResolvedValue(undefined),
      };
      (getTenantVectorStore as jest.Mock).mockReturnValue(mockVectorStore);

      (chunkTextSemantically as jest.Mock).mockResolvedValue([
        "Worker chunk 0 content",
        "Worker chunk 1 content",
      ]);

      (resolveOrganizationGenerativeAiClient as jest.Mock).mockResolvedValue({
        client: {
          getGenerativeModel: () => ({
            batchEmbedContents: jest.fn().mockResolvedValue({
              embeddings: [
                { values: makeValidVector(0.1) },
                { values: makeValidVector(0.2) },
              ],
            }),
          }),
        },
        fallbackClient: null,
      });

      (reserveGeneration as jest.Mock).mockResolvedValue({
        generation: { id: workerGenId, expectedChunkCount: 2 },
        claimToken: workerClaimToken,
        head: { id: workerHeadId, latestRevision: 1 },
      });

      (markGenerationWritten as jest.Mock).mockResolvedValue({
        id: workerGenId,
        status: "WRITTEN",
      });

      (prisma as unknown as { task: unknown }).task = {
        findFirst: jest.fn().mockResolvedValue({
          id: workerTaskId,
          title: "Production Worker Part 4 Task",
          description: "Task description",
          status: "TODO",
          priority: "HIGH",
          projectId: "proj_worker_p4",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      };
    });

    it("permits generation activation when real verifyPhysicalPersistence succeeds", async () => {
      const wId0 = buildVectorId("task", workerTaskId, workerGenId, 0);
      const wId1 = buildVectorId("task", workerTaskId, workerGenId, 1);

      const wExpectedDigest = computeManifestDigest([
        { chunkIndex: 0, id: wId0, text: "Worker chunk 0 content" },
        { chunkIndex: 1, id: wId1, text: "Worker chunk 1 content" },
      ]);

      mockVectorStore.fetchGenerationVectors.mockResolvedValue({
        records: {
          [wId0]: {
            id: wId0,
            values: makeValidVector(0.1),
            metadata: {
              contractVersion: "v2",
              entityType: "task",
              entityId: workerTaskId,
              generationId: workerGenId,
              sourceRevision: 1,
              chunkIndex: 0,
              chunkCount: 2,
              orgId,
              projectId: "proj_worker_p4",
              text: "Worker chunk 0 content",
            },
          },
          [wId1]: {
            id: wId1,
            values: makeValidVector(0.2),
            metadata: {
              contractVersion: "v2",
              entityType: "task",
              entityId: workerTaskId,
              generationId: workerGenId,
              sourceRevision: 1,
              chunkIndex: 1,
              chunkCount: 2,
              orgId,
              projectId: "proj_worker_p4",
              text: "Worker chunk 1 content",
            },
          },
        },
      });

      const event = {
        id: "evt_worker_success",
        type: "EMBEDDING_REQUESTED" as const,
        data: {
          orgId,
          entityId: workerTaskId,
          type: "TASK" as const,
          outboxEventId: "outbox_worker_success_row",
        },
        time: new Date().toISOString(),
      };

      await expect(embeddingWorkerHandler({ event })).resolves.toBeUndefined();

      expect(activateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          generationId: workerGenId,
          claimToken: workerClaimToken,
          headId: workerHeadId,
        })
      );
      expect(markGenerationWritten).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt: expect.objectContaining({
            generationId: workerGenId,
            claimToken: workerClaimToken,
            manifestDigest: wExpectedDigest,
          }),
        })
      );
      expect(completeVectorOutboxEvent).toHaveBeenCalled();
      expect(failGeneration).not.toHaveBeenCalled();
    });

    it("prevents activation and invokes failGeneration when real verifyPhysicalPersistence fails on bad vector dimensions", async () => {
      const wId0 = buildVectorId("task", workerTaskId, workerGenId, 0);
      const wId1 = buildVectorId("task", workerTaskId, workerGenId, 1);

      // Return chunk 0 with corrupted dimensions (e.g., NaN at position 10)
      const badValues = makeValidVector(0.1);
      badValues[10] = NaN;

      mockVectorStore.fetchGenerationVectors.mockResolvedValue({
        records: {
          [wId0]: {
            id: wId0,
            values: badValues,
            metadata: {
              contractVersion: "v2",
              entityType: "task",
              entityId: workerTaskId,
              generationId: workerGenId,
              sourceRevision: 1,
              chunkIndex: 0,
              chunkCount: 2,
              orgId,
              projectId: "proj_worker_p4",
              text: "Worker chunk 0 content",
            },
          },
          [wId1]: {
            id: wId1,
            values: makeValidVector(0.2),
            metadata: {
              contractVersion: "v2",
              entityType: "task",
              entityId: workerTaskId,
              generationId: workerGenId,
              sourceRevision: 1,
              chunkIndex: 1,
              chunkCount: 2,
              orgId,
              projectId: "proj_worker_p4",
              text: "Worker chunk 1 content",
            },
          },
        },
      });

      const event = {
        id: "evt_worker_fail_dim",
        type: "EMBEDDING_REQUESTED" as const,
        data: {
          orgId,
          entityId: workerTaskId,
          type: "TASK" as const,
          outboxEventId: "outbox_worker_fail_row",
        },
        time: new Date().toISOString(),
      };

      await expect(embeddingWorkerHandler({ event })).rejects.toThrow(
        "Physical persistence verification failed: DIMENSION_MISMATCH"
      );

      // Verify that failGeneration was executed
      expect(failGeneration).toHaveBeenCalledWith({
        generationId: workerGenId,
        claimToken: workerClaimToken,
        errorMessage: expect.stringContaining("DIMENSION_MISMATCH"),
      });

      // Verify that activateGeneration was NEVER called
      expect(activateGeneration).not.toHaveBeenCalled();
      expect(completeVectorOutboxEvent).not.toHaveBeenCalled();
    });
  });
});
