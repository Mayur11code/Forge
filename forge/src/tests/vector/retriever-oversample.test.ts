// src/tests/vector/retriever-oversample.test.ts
jest.mock("server-only", () => ({}));

const mockVectorEntityHeadFindMany = jest.fn();
const mockTaskFindMany = jest.fn();
const mockAttachmentFindMany = jest.fn();

jest.mock("@/lib/prisma/db", () => ({
  db: {
    vectorEntityHead: {
      findMany: (...args: unknown[]) => mockVectorEntityHeadFindMany(...args),
    },
    task: {
      findMany: (...args: unknown[]) => mockTaskFindMany(...args),
    },
    attachment: {
      findMany: (...args: unknown[]) => mockAttachmentFindMany(...args),
    },
  },
}));

import {
  retrieveRelevantContext,
  MAX_SUPPORTED_TOP_K,
} from "@/lib/vector/retreiver";
import { getTenantVectorStore } from "@/lib/vector/client";
import { embed } from "ai";
import { resolveOrganizationEmbeddingModel } from "@/lib/ai/resolver";
import { VectorEntityType } from "@prisma/client";

jest.mock("@/lib/vector/client", () => ({
  getTenantVectorStore: jest.fn(),
}));

jest.mock("ai", () => ({
  embed: jest.fn().mockResolvedValue({
    embedding: new Array(768).fill(0.01),
  }),
}));

jest.mock("@/lib/ai/resolver", () => ({
  resolveOrganizationEmbeddingModel: jest.fn().mockResolvedValue({}),
}));

describe("Vector V2 Phase B: PR-3 Retriever Oversampling & Bounded Query (E2 Suite)", () => {
  const orgId = "org_oversample_test";
  const userQuery = "How to configure vector outbox?";

  let mockQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn();
    (getTenantVectorStore as jest.Mock).mockReturnValue({
      query: mockQuery,
    });
    mockTaskFindMany.mockResolvedValue([]);
    mockAttachmentFindMany.mockResolvedValue([]);
  });

  it("exports MAX_SUPPORTED_TOP_K equal to 25", () => {
    expect(MAX_SUPPORTED_TOP_K).toBe(25);
  });

  it("oversamples candidate pool by 2x for requestedTopK = 5 (queryK = 10)", async () => {
    mockQuery.mockResolvedValueOnce({
      matches: Array.from({ length: 5 }, (_, i) => ({
        id: `task_task_${i}_gen_1#0`,
        score: 0.9,
        metadata: {
          contractVersion: "v2",
          entityType: "task",
          entityId: `task_${i}`,
          generationId: "gen_1",
          sourceRevision: 1,
          chunkIndex: 0,
          chunkCount: 1,
          orgId,
          projectId: "proj_1",
          text: `Text chunk ${i}`,
          sourceVersion: `task:2026:proj_1`,
        },
      })),
    });

    // All 5 heads are active, so no secondary query triggers
    mockVectorEntityHeadFindMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        entityType: VectorEntityType.TASK,
        entityId: `task_${i}`,
        activeGenId: "gen_1",
        latestRevision: 1,
        isTombstone: false,
      }))
    );
    mockTaskFindMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `task_${i}`,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        projectId: "proj_1",
      }))
    );

    await retrieveRelevantContext(userQuery, orgId, undefined, 5);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(Array), 10);
  });

  it("clamps requestedTopK exceeding MAX_SUPPORTED_TOP_K to 25 and queries with K = 50", async () => {
    mockQuery.mockResolvedValueOnce({
      matches: Array.from({ length: 25 }, (_, i) => ({
        id: `task_task_${i}_gen_1#0`,
        score: 0.9,
        metadata: {
          contractVersion: "v2",
          entityType: "task",
          entityId: `task_${i}`,
          generationId: "gen_1",
          sourceRevision: 1,
          chunkIndex: 0,
          chunkCount: 1,
          orgId,
          projectId: "proj_1",
          text: `Text chunk ${i}`,
          sourceVersion: `task:2026:proj_1`,
        },
      })),
    });

    mockVectorEntityHeadFindMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        entityType: VectorEntityType.TASK,
        entityId: `task_${i}`,
        activeGenId: "gen_1",
        latestRevision: 1,
        isTombstone: false,
      }))
    );
    mockTaskFindMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({
        id: `task_${i}`,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        projectId: "proj_1",
      }))
    );

    // Request topK = 100 (exceeds MAX_SUPPORTED_TOP_K = 25)
    await retrieveRelevantContext(userQuery, orgId, undefined, 100);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(Array), 50);
  });

  it("triggers bounded secondary query with K = 50 when active candidates fall below topK / 2", async () => {
    mockQuery
      .mockResolvedValueOnce({
        // Initial query returns 10 hits
        matches: Array.from({ length: 10 }, (_, i) => ({
          id: `task_task_${i}_gen_1#0`,
          score: 0.9,
          metadata: {
            contractVersion: "v2",
            entityType: "task",
            entityId: `task_${i}`,
            generationId: "gen_1",
            sourceRevision: 1,
            chunkIndex: 0,
            chunkCount: 1,
            orgId,
            projectId: "proj_1",
            text: `Initial hit ${i}`,
            sourceVersion: `task:2026:proj_1`,
          },
        })),
      })
      .mockResolvedValueOnce({
        // Secondary query returns 50 hits
        matches: Array.from({ length: 50 }, (_, i) => ({
          id: `task_task_${i + 10}_gen_1#0`,
          score: 0.85,
          metadata: {
            contractVersion: "v2",
            entityType: "task",
            entityId: `task_${i + 10}`,
            generationId: "gen_1",
            sourceRevision: 1,
            chunkIndex: 0,
            chunkCount: 1,
            orgId,
            projectId: "proj_1",
            text: `Secondary hit ${i}`,
            sourceVersion: `task:2026:proj_1`,
          },
        })),
      });

    // First call: only 1 active head returned for task_0
    // Second call: 4 active heads returned for tasks 10..13
    mockVectorEntityHeadFindMany
      .mockResolvedValueOnce([
        {
          entityType: VectorEntityType.TASK,
          entityId: "task_0",
          activeGenId: "gen_1",
          latestRevision: 1,
          isTombstone: false,
        },
      ])
      .mockResolvedValueOnce(
        Array.from({ length: 4 }, (_, i) => ({
          entityType: VectorEntityType.TASK,
          entityId: `task_${i + 10}`,
          activeGenId: "gen_1",
          latestRevision: 1,
          isTombstone: false,
        }))
      );

    mockTaskFindMany.mockResolvedValue([
      {
        id: "task_0",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        projectId: "proj_1",
      },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `task_${i + 10}`,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        projectId: "proj_1",
      })),
    ]);

    await retrieveRelevantContext(userQuery, orgId, undefined, 5);

    // Initial query: K = 10, Secondary query: K = 50
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenNthCalledWith(1, expect.any(Array), 10);
    expect(mockQuery).toHaveBeenNthCalledWith(2, expect.any(Array), 50);
  });

  it("never executes more than 1 secondary query (hard limit of 2 queries total)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        matches: Array.from({ length: 10 }, (_, i) => ({
          id: `task_task_${i}_gen_1#0`,
          metadata: { text: `Hit ${i}` },
        })),
      })
      .mockResolvedValueOnce({
        matches: [{ id: "task_task_2_gen_1#0", metadata: { text: "Hit 2" } }],
      });

    // All heads empty so 0 candidates survive
    mockVectorEntityHeadFindMany.mockResolvedValue([]);

    await retrieveRelevantContext(userQuery, orgId, undefined, 5);

    // Initial query + at most 1 secondary query = 2 queries total
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  describe("Boundary Cases & Clamped Top-K Contract", () => {
    it("clamps requestedTopK = 0 to 1 with queryK = 2", async () => {
      mockQuery.mockResolvedValueOnce({ matches: [] });
      await retrieveRelevantContext(userQuery, orgId, undefined, 0);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(Array), 2);
    });

    it("clamps negative requestedTopK = -10 to 1 with queryK = 2", async () => {
      mockQuery.mockResolvedValueOnce({ matches: [] });
      await retrieveRelevantContext(userQuery, orgId, undefined, -10);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(Array), 2);
    });

    it("defaults invalid/NaN requestedTopK to 5 with queryK = 10", async () => {
      mockQuery.mockResolvedValueOnce({ matches: [] });
      await retrieveRelevantContext(userQuery, orgId, undefined, NaN);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(Array), 10);
    });

    it("clamps requestedTopK = 25 to 25 with queryK = 50", async () => {
      mockQuery.mockResolvedValueOnce({ matches: [] });
      await retrieveRelevantContext(userQuery, orgId, undefined, 25);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(Array), 50);
    });
  });
});
