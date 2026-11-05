// src/tests/vector/retriever-active-gen.test.ts
jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));

import { filterActiveRagCandidates } from "@/lib/vector/retreiver";
import { buildVectorId } from "@/lib/vector/schema";
import { VectorEntityType } from "@prisma/client";

describe("Vector V2 Phase B: PR-3 Retriever Active Generation Enforcement (E2 Suite)", () => {
  const orgId = "org_test";
  const entityId1 = "task_100";
  const activeGenId = "gen_active_123";
  const staleGenId = "gen_stale_000";

  const v2ActiveRecord = {
    id: buildVectorId("task", entityId1, activeGenId, 0),
    score: 0.95,
    metadata: {
      contractVersion: "v2",
      entityType: "task",
      entityId: entityId1,
      generationId: activeGenId,
      sourceRevision: 3,
      chunkIndex: 0,
      chunkCount: 1,
      orgId,
      projectId: "proj_1",
      text: "Active chunk content",
    },
  };

  const v2StaleGenRecord = {
    id: buildVectorId("task", entityId1, staleGenId, 0),
    score: 0.92,
    metadata: {
      contractVersion: "v2",
      entityType: "task",
      entityId: entityId1,
      generationId: staleGenId,
      sourceRevision: 2,
      chunkIndex: 0,
      chunkCount: 1,
      orgId,
      projectId: "proj_1",
      text: "Stale generation chunk content",
    },
  };

  const v2StaleRevRecord = {
    id: buildVectorId("task", entityId1, activeGenId, 0),
    score: 0.91,
    metadata: {
      contractVersion: "v2",
      entityType: "task",
      entityId: entityId1,
      generationId: activeGenId,
      sourceRevision: 2, // Older revision than head's latestRevision (3)
      chunkIndex: 0,
      chunkCount: 1,
      orgId,
      projectId: "proj_1",
      text: "Stale revision chunk content",
    },
  };

  it("accepts candidate when candidate generationId and sourceRevision match active head", async () => {
    const mockPrisma = {
      vectorEntityHead: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: VectorEntityType.TASK,
            entityId: entityId1,
            activeGenId,
            latestRevision: 3,
            isTombstone: false,
          },
        ]),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const results = await filterActiveRagCandidates([v2ActiveRecord], orgId, {
      prismaClient: mockPrisma,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(v2ActiveRecord.id);
  });

  it("rejects candidate when candidate generationId is superseded by a newer active generation", async () => {
    const mockPrisma = {
      vectorEntityHead: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: VectorEntityType.TASK,
            entityId: entityId1,
            activeGenId, // Head points to gen_active_123
            latestRevision: 3,
            isTombstone: false,
          },
        ]),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const results = await filterActiveRagCandidates([v2StaleGenRecord], orgId, {
      prismaClient: mockPrisma,
    });

    expect(results).toHaveLength(0);
  });

  it("rejects candidate when candidate sourceRevision does not equal head latestRevision", async () => {
    const mockPrisma = {
      vectorEntityHead: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: VectorEntityType.TASK,
            entityId: entityId1,
            activeGenId,
            latestRevision: 3, // Candidate claims revision 2
            isTombstone: false,
          },
        ]),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const results = await filterActiveRagCandidates([v2StaleRevRecord], orgId, {
      prismaClient: mockPrisma,
    });

    expect(results).toHaveLength(0);
  });

  it("rejects candidate when head is marked as tombstone", async () => {
    const mockPrisma = {
      vectorEntityHead: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: VectorEntityType.TASK,
            entityId: entityId1,
            activeGenId,
            latestRevision: 3,
            isTombstone: true, // Entity deleted
          },
        ]),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const results = await filterActiveRagCandidates([v2ActiveRecord], orgId, {
      prismaClient: mockPrisma,
    });

    expect(results).toHaveLength(0);
  });

  it("rejects candidate when head has no active generation (activeGenId is null)", async () => {
    const mockPrisma = {
      vectorEntityHead: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: VectorEntityType.TASK,
            entityId: entityId1,
            activeGenId: null,
            latestRevision: 3,
            isTombstone: false,
          },
        ]),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const results = await filterActiveRagCandidates([v2ActiveRecord], orgId, {
      prismaClient: mockPrisma,
    });

    expect(results).toHaveLength(0);
  });

  it("rejects candidate when parsed ID does not match metadata", async () => {
    const mismatchedRecord = {
      ...v2ActiveRecord,
      metadata: {
        ...v2ActiveRecord.metadata,
        generationId: "different_gen_id", // Mismatches ID
      },
    };

    const mockPrisma = {
      vectorEntityHead: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: VectorEntityType.TASK,
            entityId: entityId1,
            activeGenId,
            latestRevision: 3,
            isTombstone: false,
          },
        ]),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const results = await filterActiveRagCandidates([mismatchedRecord], orgId, {
      prismaClient: mockPrisma,
    });

    expect(results).toHaveLength(0);
  });

  it("rejects legacy V1 candidate if entity already has an active V2 generation", async () => {
    const legacyRecord = {
      id: `${entityId1}#0`,
      score: 0.9,
      metadata: {
        type: "task",
        taskId: entityId1,
        text: "Legacy V1 chunk",
      },
    };

    const mockPrisma = {
      vectorEntityHead: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: VectorEntityType.TASK,
            entityId: entityId1,
            activeGenId, // Has active V2 generation
            latestRevision: 1,
            isTombstone: false,
          },
        ]),
      },
      task: { findMany: jest.fn().mockResolvedValue([{ id: entityId1 }]) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const results = await filterActiveRagCandidates([legacyRecord], orgId, {
      prismaClient: mockPrisma,
    });

    expect(results).toHaveLength(0);
  });
});
