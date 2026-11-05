// src/tests/worker/embedding-worker-byok.test.ts
jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));

import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";
import { resolveOrganizationGenerativeAiClient, AiResolverError } from "@/lib/ai/resolver";
import { prisma } from "@/lib/prisma/extended";
import { getTenantVectorStore, verifyPhysicalPersistence } from "@/lib/vector/client";
import { buildSemanticPayload } from "@/lib/vector/text-extractor";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";
import {
  reserveGeneration,
  markGenerationWritten,
  activateGeneration,
  failGeneration,
} from "@/lib/vector/generation-state";
import { CredentialPurpose } from "@prisma/client";

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
  verifyPhysicalPersistence: jest.fn(),
}));

jest.mock("@/lib/vector/generation-state", () => ({
  reserveGeneration: jest.fn(),
  markGenerationWritten: jest.fn(),
  activateGeneration: jest.fn(),
  failGeneration: jest.fn(),
}));

jest.mock("@/lib/vector/text-extractor", () => ({
  buildSemanticPayload: jest.fn(),
}));

jest.mock("@/lib/vector/semantic-chunker", () => ({
  chunkTextSemantically: jest.fn(),
}));

jest.mock("@/lib/ai/resolver", () => ({
  resolveOrganizationGenerativeAiClient: jest.fn(),
  AiResolverError: class AiResolverError extends Error {
    public readonly code: string;
    constructor(code: string, message: string) {
      super(`[AI_RESOLVER] [${code}] ${message}`);
      this.name = "AiResolverError";
      this.code = code;
    }
  },
}));

describe("embedding-worker: Organization BYOK Integration", () => {
  const orgId = "org-embedding-tenant";
  const entityId = "task-123";

  let mockVectorStore: {
    deleteByTask: jest.Mock;
    upsert: jest.Mock;
    upsertGenerationVectors: jest.Mock;
  };
  let mockBatchEmbedContents: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockVectorStore = {
      deleteByTask: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
      upsertGenerationVectors: jest.fn().mockResolvedValue(undefined),
    };
    (getTenantVectorStore as jest.Mock).mockReturnValue(mockVectorStore);

    (reserveGeneration as jest.Mock).mockResolvedValue({
      generation: { id: "gen-byok-123", expectedChunkCount: 2 },
      claimToken: "claim-token-123",
      head: { id: "head-123", latestRevision: 1 },
    });
    (markGenerationWritten as jest.Mock).mockResolvedValue({ id: "gen-byok-123", status: "WRITTEN" });
    (activateGeneration as jest.Mock).mockResolvedValue({ id: "head-123", activeGenId: "gen-byok-123" });
    (verifyPhysicalPersistence as jest.Mock).mockResolvedValue({
      verified: true,
      chunksFound: 2,
      manifestDigest: "mock-digest-byok",
      readBackLatencyMs: 30,
      attempts: 1,
    });

    (prisma.task.findFirst as jest.Mock).mockResolvedValue({
      id: entityId,
      title: "Test Task",
      projectId: "project-1",
    });
    (prisma.task.findUnique as jest.Mock).mockResolvedValue({
      id: entityId,
      title: "Test Task",
      projectId: "project-1",
    });

    (buildSemanticPayload as jest.Mock).mockReturnValue("Sample task payload");
    (chunkTextSemantically as jest.Mock).mockResolvedValue(["chunk-1", "chunk-2"]);

    mockBatchEmbedContents = jest.fn().mockResolvedValue({
      embeddings: [
        { values: [0.1, 0.2, 0.3] },
        { values: [0.4, 0.5, 0.6] },
      ],
    });
  });

  it("resolves and uses organization BYOK embedding client when active", async () => {
    const mockOrgClient = {
      getGenerativeModel: jest.fn().mockReturnValue({
        batchEmbedContents: mockBatchEmbedContents,
      }),
    };

    (resolveOrganizationGenerativeAiClient as jest.Mock).mockResolvedValueOnce({
      client: mockOrgClient,
      source: "ORGANIZATION",
      fallbackClient: undefined,
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt-1",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId,
          entityId,
          type: "TASK",
        },
        time: new Date().toISOString(),
      },
    });

    expect(resolveOrganizationGenerativeAiClient).toHaveBeenCalledWith({
      orgId,
      purpose: CredentialPurpose.EMBEDDING,
    });
    expect(mockOrgClient.getGenerativeModel).toHaveBeenCalledWith({
      model: "gemini-embedding-001",
    });
    expect(mockBatchEmbedContents).toHaveBeenCalledTimes(1);
    expect(mockVectorStore.upsertGenerationVectors).toHaveBeenCalledTimes(1);
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
  });

  it("aborts execution when organization has no credential and platform fallback is denied", async () => {
    (resolveOrganizationGenerativeAiClient as jest.Mock).mockRejectedValueOnce(
      new AiResolverError(
        "ORGANIZATION_KEY_REQUIRED",
        "Organization has no configured 'EMBEDDING' key and platform fallback is denied.",
        orgId,
        CredentialPurpose.EMBEDDING
      )
    );

    await expect(
      embeddingWorkerHandler({
        event: {
          id: "evt-2",
          type: "EMBEDDING_REQUESTED",
          data: {
            orgId,
            entityId,
            type: "TASK",
          },
          time: new Date().toISOString(),
        },
      })
    ).rejects.toThrow("ORGANIZATION_KEY_REQUIRED");

    // Invariant I-4: Zero pre-wipe deletion
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsertGenerationVectors).not.toHaveBeenCalled();
  });

  it("uses platform client when organization has no credential and policy permits platform fallback", async () => {
    const mockPlatformClient = {
      getGenerativeModel: jest.fn().mockReturnValue({
        batchEmbedContents: mockBatchEmbedContents,
      }),
    };

    (resolveOrganizationGenerativeAiClient as jest.Mock).mockResolvedValueOnce({
      client: mockPlatformClient,
      source: "PLATFORM",
      fallbackClient: undefined,
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt-3",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId,
          entityId,
          type: "TASK",
        },
        time: new Date().toISOString(),
      },
    });

    expect(resolveOrganizationGenerativeAiClient).toHaveBeenCalledWith({
      orgId,
      purpose: CredentialPurpose.EMBEDDING,
    });
    expect(mockPlatformClient.getGenerativeModel).toHaveBeenCalledWith({
      model: "gemini-embedding-001",
    });
    expect(mockBatchEmbedContents).toHaveBeenCalledTimes(1);
    expect(mockVectorStore.upsertGenerationVectors).toHaveBeenCalledTimes(1);
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
  });

  it("aborts execution when credential is in status INVALID or REVOKED, refusing platform fallback", async () => {
    (resolveOrganizationGenerativeAiClient as jest.Mock).mockRejectedValueOnce(
      new AiResolverError(
        "CREDENTIAL_NOT_ACTIVE",
        "Organization credential for 'EMBEDDING' is in status 'REVOKED'. AI operations cannot proceed until the key is validated and active.",
        orgId,
        CredentialPurpose.EMBEDDING
      )
    );

    await expect(
      embeddingWorkerHandler({
        event: {
          id: "evt-4",
          type: "EMBEDDING_REQUESTED",
          data: {
            orgId,
            entityId,
            type: "TASK",
          },
          time: new Date().toISOString(),
        },
      })
    ).rejects.toThrow("CREDENTIAL_NOT_ACTIVE");

    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsertGenerationVectors).not.toHaveBeenCalled();
  });
});
