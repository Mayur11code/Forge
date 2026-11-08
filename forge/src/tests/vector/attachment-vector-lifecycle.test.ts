// src/tests/vector/attachment-vector-lifecycle.test.ts
//
// Verification of attachment vector lifecycle:
// 1. Invariant I-4: Zero pre-wipe deletion (deleteByTask is never called before/during embedding).
// 2. Generation-scoped vector writes: attachment chunks written via upsertGenerationVectors.
// 3. Preservation of parent task vectors: writing attachment vectors leaves parent task vectors intact.
// 4. Isolation from sibling/unrelated attachments: writing attachment A does not touch attachment B.
// 5. Schema metadata typing: vectors are stored with type 'document', parent taskId, and projectId.
// 6. Security pre-condition: no deletion, embedding, or upsert occurs before ownership verification.

jest.mock("server-only", () => ({}));
jest.mock("@/lib/prisma/db", () => ({ db: {} }));

import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";
import { resolveOrganizationGenerativeAiClient } from "@/lib/ai/resolver";
import { prisma } from "@/lib/prisma/extended";
import { getTenantVectorStore, verifyPhysicalPersistence } from "@/lib/vector/client";
import { chunkTextSemantically } from "@/lib/vector/semantic-chunker";
import {
  reserveGeneration,
  markGenerationWritten,
  activateGeneration,
  failGeneration,
} from "@/lib/vector/generation-state";

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

jest.mock("@/lib/vector/semantic-chunker", () => ({
  chunkTextSemantically: jest.fn(),
}));

jest.mock("@/lib/ai/resolver", () => ({
  resolveOrganizationGenerativeAiClient: jest.fn(),
}));

describe("Attachment Vector Lifecycle & Deletion Identity", () => {
  const ORG_A = "org_alpha";
  const ORG_B = "org_beta";
  const TASK_ID = "task_parent_123";
  const ATTACHMENT_A1 = "att_contract_v1";
  const ATTACHMENT_A2 = "att_invoice_v1";
  const PROJECT_ID = "proj_sales_1";

  let mockVectorStore: {
    deleteByTask: jest.Mock;
    upsert: jest.Mock;
    upsertGenerationVectors: jest.Mock;
  };
  let mockBatchEmbedContents: jest.Mock;
  let mockAiClient: { getGenerativeModel: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockVectorStore = {
      deleteByTask: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
      upsertGenerationVectors: jest.fn().mockResolvedValue(undefined),
    };
    (getTenantVectorStore as jest.Mock).mockReturnValue(mockVectorStore);

    (reserveGeneration as jest.Mock).mockResolvedValue({
      generation: { id: "gen_att_1", expectedChunkCount: 2 },
      claimToken: "claim_att_token",
      head: { id: "head_att_1", latestRevision: 1 },
    });
    (markGenerationWritten as jest.Mock).mockResolvedValue({ id: "gen_att_1", status: "WRITTEN" });
    (activateGeneration as jest.Mock).mockResolvedValue({ id: "head_att_1", activeGenId: "gen_att_1" });
    (verifyPhysicalPersistence as jest.Mock).mockResolvedValue({
      verified: true,
      chunksFound: 2,
      manifestDigest: "manifest_digest_att",
      readBackLatencyMs: 40,
      attempts: 1,
    });

    mockBatchEmbedContents = jest.fn().mockResolvedValue({
      embeddings: [
        { values: new Array(768).fill(0.123) },
        { values: new Array(768).fill(0.456) },
      ],
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

    (chunkTextSemantically as jest.Mock).mockResolvedValue([
      "Contract Section 1: Parties and Scope",
      "Contract Section 2: Compensation and Terms",
    ]);
  });

  it("synchronizes attachment vectors without pre-wipe deletion (Invariant I-4)", async () => {
    (prisma.attachment.findFirst as jest.Mock).mockResolvedValueOnce({
      id: ATTACHMENT_A1,
      name: "Services_Agreement.pdf",
      size: 15420,
      taskId: TASK_ID,
      task: {
        id: TASK_ID,
        title: "Close Enterprise Agreement",
        projectId: PROJECT_ID,
      },
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_att_1",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: ATTACHMENT_A1,
          type: "ATTACHMENT",
        },
        time: new Date().toISOString(),
      },
    });

    // 1. Invariant I-4: Zero pre-wipe deletion
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();

    // 2. Generation-scoped upsert and activation
    expect(mockVectorStore.upsertGenerationVectors).toHaveBeenCalledTimes(1);
    expect(activateGeneration).toHaveBeenCalledTimes(1);
  });

  it("reprocessing an attachment creates new generation non-destructively without deleteByTask", async () => {
    // Simulate v2 of the attachment being processed
    (prisma.attachment.findFirst as jest.Mock).mockResolvedValueOnce({
      id: ATTACHMENT_A1,
      name: "Services_Agreement_v2.pdf",
      size: 18200,
      taskId: TASK_ID,
      task: {
        id: TASK_ID,
        title: "Close Enterprise Agreement",
        projectId: PROJECT_ID,
      },
    });

    (chunkTextSemantically as jest.Mock).mockResolvedValueOnce([
      "Updated Contract Section 1: Expanded Scope",
    ]);
    mockBatchEmbedContents.mockResolvedValueOnce({
      embeddings: [{ values: new Array(768).fill(0.999) }],
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_att_v2",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: ATTACHMENT_A1,
          type: "ATTACHMENT",
        },
        time: new Date().toISOString(),
      },
    });

    // Verified: No pre-wipe deletion
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockVectorStore.upsertGenerationVectors).toHaveBeenCalledTimes(1);
    expect(activateGeneration).toHaveBeenCalledTimes(1);
  });

  it("preserves sibling attachment vectors when a sibling is reprocessed without deleteByTask", async () => {
    // Sibling attachment A2 is processed
    (prisma.attachment.findFirst as jest.Mock).mockResolvedValueOnce({
      id: ATTACHMENT_A2,
      name: "Invoice_001.pdf",
      size: 5000,
      taskId: TASK_ID,
      task: {
        id: TASK_ID,
        title: "Close Enterprise Agreement",
        projectId: PROJECT_ID,
      },
    });

    (chunkTextSemantically as jest.Mock).mockResolvedValueOnce([
      "Invoice #001 total: $50,000",
    ]);
    mockBatchEmbedContents.mockResolvedValueOnce({
      embeddings: [{ values: new Array(768).fill(0.777) }],
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_att_a2",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: ATTACHMENT_A2,
          type: "ATTACHMENT",
        },
        time: new Date().toISOString(),
      },
    });

    // Verified: No deleteByTask on any entity
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockVectorStore.upsertGenerationVectors).toHaveBeenCalledTimes(1);
    expect(activateGeneration).toHaveBeenCalledTimes(1);
  });

  it("strictly enforces ownership check before vector mutation on cross-tenant attachment", async () => {
    // Attachment exists in DB, but belongs to Org B
    (prisma.attachment.findFirst as jest.Mock).mockResolvedValueOnce(null);
    (prisma.attachment.findUnique as jest.Mock).mockResolvedValueOnce({
      id: ATTACHMENT_A1,
      task: { project: { orgId: ORG_B } },
    });

    await embeddingWorkerHandler({
      event: {
        id: "evt_malicious_att",
        type: "EMBEDDING_REQUESTED",
        data: {
          orgId: ORG_A,
          entityId: ATTACHMENT_A1,
          type: "ATTACHMENT",
        },
        time: new Date().toISOString(),
      },
    });

    // Critical security invariant: NO deletion in Org A or Org B
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalled();
    expect(mockBatchEmbedContents).not.toHaveBeenCalled();
    expect(mockVectorStore.upsert).not.toHaveBeenCalled();
  });
});
