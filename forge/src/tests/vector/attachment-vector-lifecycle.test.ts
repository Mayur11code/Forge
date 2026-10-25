// src/tests/vector/attachment-vector-lifecycle.test.ts
//
// Verification of attachment vector lifecycle:
// 1. Deletion identity: wipes vectors by attachment ID prefix (not task ID, not org ID).
// 2. Stale-vector cleanup: reprocessing an attachment removes old vectors for that attachment.
// 3. Preservation of parent task vectors: wiping attachment vectors leaves parent task vectors intact.
// 4. Isolation from sibling/unrelated attachments: wiping attachment A does not touch attachment B.
// 5. Schema metadata typing: vectors are stored with type 'document', parent taskId, and projectId.
// 6. Security pre-condition: no deletion, embedding, or upsert occurs before ownership verification.

jest.mock("server-only", () => ({}));

import { embeddingWorkerHandler } from "@/app/api/worker/embedding-worker/ew";
import { resolveOrganizationGenerativeAiClient } from "@/lib/ai/resolver";
import { prisma } from "@/lib/prisma/extended";
import { getTenantVectorStore } from "@/lib/vector/client";
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

  let mockVectorStore: { deleteByTask: jest.Mock; upsert: jest.Mock };
  let mockBatchEmbedContents: jest.Mock;
  let mockAiClient: { getGenerativeModel: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockVectorStore = {
      deleteByTask: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    (getTenantVectorStore as jest.Mock).mockReturnValue(mockVectorStore);

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

  it("wipes vectors using the exact attachment ID prefix without affecting parent task vectors", async () => {
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

    // 1. Deletion identity must target attachment entityId, NOT parent taskId
    expect(mockVectorStore.deleteByTask).toHaveBeenCalledWith(ATTACHMENT_A1);
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalledWith(TASK_ID);

    // 2. Upsert must use deterministic attachment chunk IDs (${attachmentId}#${i})
    expect(mockVectorStore.upsert).toHaveBeenCalledWith(
      `${ATTACHMENT_A1}#0`,
      expect.any(Array),
      expect.objectContaining({
        text: "Contract Section 1: Parties and Scope",
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        type: "document",
      }),
    );
    expect(mockVectorStore.upsert).toHaveBeenCalledWith(
      `${ATTACHMENT_A1}#1`,
      expect.any(Array),
      expect.objectContaining({
        text: "Contract Section 2: Compensation and Terms",
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        type: "document",
      }),
    );
  });

  it("reprocessing an attachment removes stale chunks of that attachment and replaces them", async () => {
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

    // Verified: Wipes stale chunks matching prefix att_contract_v1#
    expect(mockVectorStore.deleteByTask).toHaveBeenCalledWith(ATTACHMENT_A1);
    expect(mockVectorStore.upsert).toHaveBeenCalledTimes(1);
    expect(mockVectorStore.upsert).toHaveBeenCalledWith(
      `${ATTACHMENT_A1}#0`,
      expect.any(Array),
      expect.objectContaining({
        text: "Updated Contract Section 1: Expanded Scope",
        type: "document",
      }),
    );
  });

  it("preserves sibling attachment vectors when a sibling is reprocessed", async () => {
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

    // Verified: only wipes ATTACHMENT_A2, NEVER ATTACHMENT_A1 or TASK_ID
    expect(mockVectorStore.deleteByTask).toHaveBeenCalledWith(ATTACHMENT_A2);
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalledWith(ATTACHMENT_A1);
    expect(mockVectorStore.deleteByTask).not.toHaveBeenCalledWith(TASK_ID);
  });

  it("strictly enforces ownership check before vector deletion on cross-tenant attachment", async () => {
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
