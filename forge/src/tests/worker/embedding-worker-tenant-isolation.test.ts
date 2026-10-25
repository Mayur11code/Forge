// src/tests/worker/embedding-worker-tenant-isolation.test.ts
jest.mock("server-only", () => ({}));

import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";
import { resolveOrganizationGenerativeAiClient } from "@/lib/ai/resolver";
import { prisma } from "@/lib/prisma/extended";
import { getTenantVectorStore } from "@/lib/vector/client";
import { buildSemanticPayload } from "@/lib/vector/text-extractor";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";

jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    task: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    attachment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("@/lib/vector/client", () => ({
  getTenantVectorStore: jest.fn(),
}));

jest.mock("@/lib/vector/text-extractor", () => ({
  buildSemanticPayload: jest.fn(),
  extractPureText: jest.fn((text: string) => text ?? ""),
}));

jest.mock("@/lib/vector/semantic-chunker", () => ({
  chunkTextSemantically: jest.fn(),
}));

jest.mock("@/lib/ai/resolver", () => ({
  resolveOrganizationGenerativeAiClient: jest.fn(),
}));

describe("embedding-worker: Tenant Isolation and IDOR Defense", () => {
  const ORG_A = "org_alpha";
  const ORG_B = "org_beta";
  const TASK_A = "task_alpha_1";
  const TASK_B = "task_beta_1";
  const ATTACHMENT_A = "att_alpha_1";
  const ATTACHMENT_B = "att_beta_1";

  let mockVectorStore: { deleteByTask: jest.Mock; upsert: jest.Mock };
  let mockBatchEmbedContents: jest.Mock;
  let mockAiClient: { getGenerativeModel: jest.Mock };
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    mockVectorStore = {
      deleteByTask: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    (getTenantVectorStore as jest.Mock).mockReturnValue(mockVectorStore);

    mockBatchEmbedContents = jest.fn().mockResolvedValue({
      embeddings: [{ values: new Array(768).fill(0.1) }],
    });

    mockAiClient = {
      getGenerativeModel: jest.fn().mockReturnValue({
        batchEmbedContents: mockBatchEmbedContents,
      }),
    };

    (resolveOrganizationGenerativeAiClient as jest.Mock).mockResolvedValue({
      client: mockAiClient,
      source: "ORGANIZATION",
      fallbackClient: undefined,
    });

    (buildSemanticPayload as jest.Mock).mockReturnValue("Sanitized task payload");
    (chunkTextSemantically as jest.Mock).mockResolvedValue(["Semantic chunk 1"]);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("Org A + Org A task: validates ownership, wipes old vectors, embeds and upserts into Org A namespace", async () => {
    (prisma.task.findFirst as jest.Mock).mockResolvedValueOnce({
      id: TASK_A,
      title: "Alpha Task",
      description: "Description of Alpha Task",
      status: "TODO",
      priority: "HIGH",
      projectId: "project_alpha",
      assigneeId: "user_alpha",
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_1",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: TASK_A,
          type: "TASK",
        },
        time: new Date().toISOString(),
      },
    });

    // 1. Ownership check must be scoped to event orgId
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: {
        id: TASK_A,
        project: { orgId: ORG_A },
      },
      select: expect.objectContaining({
        id: true,
        title: true,
        projectId: true,
      }),
    });

    // 2. Vector store target must match event orgId
    expect(getTenantVectorStore).toHaveBeenCalledWith(ORG_A);

    // 3. Vector deletion must occur only after ownership is verified
    expect(mockVectorStore.deleteByTask).toHaveBeenCalledWith(TASK_A);

    // 4. Batch embeddings and upsert must proceed with correct metadata
    expect(mockBatchEmbedContents).toHaveBeenCalledTimes(1);
    expect(mockVectorStore.upsert).toHaveBeenCalledWith(
      `${TASK_A}#0`,
      expect.any(Array),
      {
        text: "Semantic chunk 1",
        taskId: TASK_A,
        projectId: "project_alpha",
        type: "task",
      },
    );
  });

  it("Org A + Org B task: rejects cross-tenant reference before any vector deletion, embedding, or upsert", async () => {
    // Scoped lookup in Org A returns null
    (prisma.task.findFirst as jest.Mock).mockResolvedValueOnce(null);

    // Unscoped lookup reveals it belongs to Org B
    (prisma.task.findUnique as jest.Mock).mockResolvedValueOnce({
      id: TASK_B,
      project: { orgId: ORG_B },
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_cross_task",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: TASK_B,
          type: "TASK",
        },
        time: new Date().toISOString(),
      },
    });

    // CRITICAL: Vector store must NEVER be wiped or mutated
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();

    // Security warning log must be emitted
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("CROSS_TENANT_RESOURCE_REFERENCE_REJECTED"),
    );
  });

  it("Org A + Org B attachment: rejects cross-tenant attachment before any vector deletion or upsert", async () => {
    // Scoped lookup in Org A returns null
    (prisma.attachment.findFirst as jest.Mock).mockResolvedValueOnce(null);

    // Unscoped lookup reveals it belongs to Org B
    (prisma.attachment.findUnique as jest.Mock).mockResolvedValueOnce({
      id: ATTACHMENT_B,
      task: { project: { orgId: ORG_B } },
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_cross_att",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: ATTACHMENT_B,
          type: "ATTACHMENT",
        },
        time: new Date().toISOString(),
      },
    });

    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("CROSS_TENANT_RESOURCE_REFERENCE_REJECTED"),
    );
  });

  it("Missing task: handles deleted/nonexistent task safely without vector mutation", async () => {
    (prisma.task.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (prisma.task.findUnique as jest.Mock).mockResolvedValueOnce(null);

    await embeddingWorkerHandler({
      event: {
        id: "evt_missing_task",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: "task_nonexistent",
          type: "TASK",
        },
        time: new Date().toISOString(),
      },
    });

    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();
  });

  it("Missing attachment: handles deleted/nonexistent attachment safely without vector mutation", async () => {
    (prisma.attachment.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (prisma.attachment.findUnique as jest.Mock).mockResolvedValueOnce(null);

    await embeddingWorkerHandler({
      event: {
        id: "evt_missing_att",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: "att_nonexistent",
          type: "ATTACHMENT",
        },
        time: new Date().toISOString(),
      },
    });

    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();
  });

  it("Valid attachment ingestion: correctly processes ATTACHMENT and tags vector as document", async () => {
    (prisma.attachment.findFirst as jest.Mock).mockResolvedValueOnce({
      id: ATTACHMENT_A,
      name: "Architecture_Design.pdf",
      size: 4096,
      taskId: TASK_A,
      task: {
        id: TASK_A,
        title: "Design System Architecture",
        projectId: "project_alpha",
      },
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_valid_att",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: ATTACHMENT_A,
          type: "ATTACHMENT",
        },
        time: new Date().toISOString(),
      },
    });

    // 1. Scoped lookup checks task -> project -> orgId
    expect(prisma.attachment.findFirst).toHaveBeenCalledWith({
      where: {
        id: ATTACHMENT_A,
        task: { project: { orgId: ORG_A } },
      },
      select: expect.objectContaining({
        id: true,
        name: true,
        taskId: true,
        task: expect.any(Object),
      }),
    });

    // 2. Wipes old vectors for the attachment
    expect(mockVectorStore.deleteByTask).toHaveBeenCalledWith(ATTACHMENT_A);

    // 3. Upserts with type 'document' and parent taskId
    expect(mockVectorStore.upsert).toHaveBeenCalledWith(
      `${ATTACHMENT_A}#0`,
      expect.any(Array),
      {
        text: "Semantic chunk 1",
        taskId: TASK_A,
        projectId: "project_alpha",
        type: "document",
      },
    );
  });

  it("Rejects unsupported entity types safely without vector mutation", async () => {
    await embeddingWorkerHandler({
      event: {
        id: "evt_invalid_type",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: "unknown_id",
          type: "INVALID" as unknown as "TASK",
        },
        time: new Date().toISOString(),
      },
    });

    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("UNSUPPORTED_EMBEDDING_ENTITY_TYPE"),
    );
  });
});
