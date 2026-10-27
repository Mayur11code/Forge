// src/tests/vector/deletion-time-vector-cleanup.test.ts
//
// Verification test suite for Forge H4.3 & H4.4 — Deletion-Time Vector Cleanup,
// Event Durability & Cascade Closure.
// Tests:
// 1. Deleting an attachment removes only its own vectors in the tenant's namespace.
// 2. Deleting a task removes its own vectors and child attachments' vectors.
// 3. Deleting one attachment preserves parent-task and sibling-attachment vectors.
// 4. Repeated/duplicate deletion events are idempotent.
// 5. Cross-tenant resource references cannot trigger deletion in foreign namespaces.
// 6. Missing resources are handled safely without crashing.
// 7. Vector-store failure is observable and re-thrown / propagated.
// 8. Event bus routes TASK_DELETED to worker and analytics.
// 9. Event publication failure cannot silently be treated as successful durable cleanup.
// 10. Partial failure in attachment deletion is safely recoverable on retry.
// 11. Project cascade deletion cleans up all child tasks and attachment vectors.

jest.mock("server-only", () => ({}));

// 1. Mocks
const mockVectorDeleteByTask = jest.fn();
const mockGetTenantVectorStore = jest.fn((orgId: string) => ({
  deleteByTask: (id: string) => mockVectorDeleteByTask(orgId, id),
}));

jest.mock("@/lib/vector/client", () => ({
  getTenantVectorStore: (orgId: string) => mockGetTenantVectorStore(orgId),
}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

const mockDeleteFiles = jest.fn().mockResolvedValue({ success: true });
jest.mock("uploadthing/server", () => ({
  UTApi: jest.fn().mockImplementation(() => ({
    deleteFiles: (...args: unknown[]) => mockDeleteFiles(...args),
  })),
}));

jest.mock("@/lib/events/queue", () => ({
  publishEvent: jest.fn().mockResolvedValue({ messageId: "msg_test_123" }),
}));

// Mock DB with $extends hook so extended.ts can be tested directly
jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockDb: any = {
    attachment: {
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    organization: {
      update: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    task: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    domainOutboxEvent: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $extends: jest.fn((ext: any) => ({
      ...mockDb,
      _extensions: ext,
      task: {
        ...mockDb.task,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete: (args: any) => ext.query.task.delete({ args, query: mockDb.task.delete }),
      },
      project: {
        ...mockDb.project,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete: (args: any) => ext.query.project.delete({ args, query: mockDb.project.delete }),
      },
    })),
  };
  return { db: mockDb };
});

import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
import { deleteAttachment } from "@/app/api/uploadthing/deleteAttachment";
import { taskDeletedWorkerHandler } from "@/app/api/worker/embedding-worker/task-deleted";
import { dispatchEvent } from "@/lib/events/event-bus";
import { publishEvent } from "@/lib/events/queue";
import { prisma as extendedPrisma } from "@/lib/prisma/extended";

const mockAttachmentFindFirst = db.attachment.findFirst as jest.Mock;
const mockAttachmentDelete = db.attachment.delete as jest.Mock;
const mockProjectFindUnique = db.project.findUnique as jest.Mock;
const mockProjectDelete = db.project.delete as jest.Mock;
const mockTaskFindUnique = db.task.findUnique as jest.Mock;
const mockTaskDelete = db.task.delete as jest.Mock;
const mockOutboxFindUnique = db.domainOutboxEvent.findUnique as jest.Mock;
const mockOutboxUpsert = db.domainOutboxEvent.upsert as jest.Mock;
const mockOutboxUpdate = db.domainOutboxEvent.update as jest.Mock;
const mockOutboxUpdateMany = db.domainOutboxEvent.updateMany as jest.Mock;
const mockOutboxFindMany = db.domainOutboxEvent.findMany as jest.Mock;
const mockTransaction = db.$transaction as jest.Mock;

const publishEventMock = publishEvent as jest.Mock;
const authMock = auth as jest.MockedFunction<typeof auth>;

describe("Forge H4.3 & H4.4 — Deletion-Time Vector Cleanup, Durability & Cascades", () => {
  const ORG_A = "org_alpha";
  const ORG_B = "org_beta";
  const USER_A = "user_alpha";
  const TASK_A = "task_alpha_123";
  const TASK_B = "task_alpha_456";
  const ATTACHMENT_1 = "att_alpha_001";
  const ATTACHMENT_2 = "att_alpha_002";
  const PROJECT_A = "proj_alpha_999";

  beforeEach(() => {
    jest.clearAllMocks();
    mockVectorDeleteByTask.mockResolvedValue(undefined);
    mockDeleteFiles.mockResolvedValue({ success: true });
    publishEventMock.mockResolvedValue({ messageId: "msg_test_123" });
    mockOutboxFindUnique.mockResolvedValue(null);
    mockOutboxUpsert.mockResolvedValue({ id: "outbox_123" });
    mockOutboxUpdate.mockResolvedValue({ id: "outbox_123" });
    mockOutboxUpdateMany.mockResolvedValue({ count: 1 });
    mockOutboxFindMany.mockResolvedValue([]);
    mockTransaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return await (arg as (tx: unknown) => Promise<unknown>)(db);
      }
      return Array.isArray(arg) ? Promise.all(arg) : arg;
    });
  });

  describe("Attachment Deletion Vector Cleanup & Recovery (deleteAttachment)", () => {
    it("deleting an attachment removes only its own vectors in the verified tenant namespace", async () => {
      authMock.mockResolvedValue({ user: { id: USER_A } } as never);
      mockAttachmentFindFirst.mockResolvedValue({
        id: ATTACHMENT_1,
        fileKey: "file_key_1",
        size: 1024,
        task: {
          select: { id: TASK_A },
          project: { orgId: ORG_A },
        },
      });

      const result = await deleteAttachment(ATTACHMENT_1);

      expect(authMock).toHaveBeenCalled();
      expect(mockGetTenantVectorStore).toHaveBeenCalledWith(ORG_A);
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, ATTACHMENT_1);
      expect(mockDeleteFiles).toHaveBeenCalledWith("file_key_1");
      expect(mockTransaction).toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, message: "File deleted and quota updated." });
    });

    it("partial failure recovery: if cloud storage fails on attempt 1, outbox intent is preserved and retry succeeds cleanly", async () => {
      authMock.mockResolvedValue({ user: { id: USER_A } } as never);
      mockAttachmentFindFirst.mockResolvedValue({
        id: ATTACHMENT_1,
        fileKey: "file_key_1",
        size: 1024,
        task: {
          id: TASK_A,
          project: { orgId: ORG_A },
        },
      });

      // Attempt 1: DB transaction commits outbox intent, but Cloud Storage delete fails
      mockDeleteFiles.mockResolvedValueOnce({ success: false });

      await expect(deleteAttachment(ATTACHMENT_1)).rejects.toThrow(
        "Failed to delete file from cloud storage."
      );

      // Verify DB transaction committed outbox intent, and vector delete ran
      expect(mockTransaction).toHaveBeenCalled();
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, ATTACHMENT_1);

      // Attempt 2: Caller retries; cloud storage recovers and completes
      mockDeleteFiles.mockResolvedValueOnce({ success: true });

      const retryResult = await deleteAttachment(ATTACHMENT_1);

      // Re-executing vector delete is safe and idempotent
      expect(mockVectorDeleteByTask).toHaveBeenCalledTimes(2);
      expect(retryResult.success).toBe(true);
    });

    it("sibling vector isolation: deleting attachment 1 does not affect attachment 2 or parent task vectors", async () => {
      authMock.mockResolvedValue({ user: { id: USER_A } } as never);
      mockAttachmentFindFirst.mockResolvedValue({
        id: ATTACHMENT_1,
        fileKey: "file_key_1",
        size: 2048,
        task: {
          select: { id: TASK_A },
          project: { orgId: ORG_A },
        },
      });

      await deleteAttachment(ATTACHMENT_1);

      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, ATTACHMENT_1);
      const allDeletedCalls = mockVectorDeleteByTask.mock.calls;
      expect(allDeletedCalls.some((call) => call[1] === TASK_A)).toBe(false);
      expect(allDeletedCalls.some((call) => call[1] === ATTACHMENT_2)).toBe(false);
    });

    it("cross-tenant reference is rejected before vector store call", async () => {
      authMock.mockResolvedValue({ user: { id: USER_A } } as never);
      mockAttachmentFindFirst.mockResolvedValue(null);

      await expect(deleteAttachment("foreign_att")).rejects.toThrow(
        "Attachment record not found in database."
      );

      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      expect(mockAttachmentDelete).not.toHaveBeenCalled();
    });

    it("missing attachment is handled safely without touching vector store", async () => {
      authMock.mockResolvedValue({ user: { id: USER_A } } as never);
      mockAttachmentFindFirst.mockResolvedValue(null);

      await expect(deleteAttachment("nonexistent")).rejects.toThrow("not found");
      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
    });

    it("vector-store failure is observable and throws out of deleteAttachment", async () => {
      authMock.mockResolvedValue({ user: { id: USER_A } } as never);
      mockAttachmentFindFirst.mockResolvedValue({
        id: ATTACHMENT_1,
        fileKey: "file_key_1",
        size: 512,
        task: { id: TASK_A, project: { orgId: ORG_A } },
      });
      mockVectorDeleteByTask.mockRejectedValue(new Error("Pinecone connection timeout"));

      await expect(deleteAttachment(ATTACHMENT_1)).rejects.toThrow("Pinecone connection timeout");
      // DB record and outbox intent are committed so background retry can recover
      expect(mockTransaction).toHaveBeenCalled();
    });
  });

  describe("Task Deletion Vector Worker (taskDeletedWorkerHandler)", () => {
    it("deleting a task removes its own vectors and all child attachments' vectors", async () => {
      mockProjectFindUnique.mockResolvedValue({ id: PROJECT_A, orgId: ORG_A });

      await taskDeletedWorkerHandler({
        event: {
          id: "evt_1",
          type: "TASK_DELETED",
          time: new Date().toISOString(),
          data: {
            orgId: ORG_A,
            taskId: TASK_A,
            projectId: PROJECT_A,
            attachmentIds: [ATTACHMENT_1, ATTACHMENT_2],
          },
        },
      });

      expect(mockGetTenantVectorStore).toHaveBeenCalledWith(ORG_A);
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, TASK_A);
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, ATTACHMENT_1);
      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, ATTACHMENT_2);
    });

    it("task with no child attachments deletes only the task vectors", async () => {
      mockProjectFindUnique.mockResolvedValue({ id: PROJECT_A, orgId: ORG_A });

      await taskDeletedWorkerHandler({
        event: {
          id: "evt_2",
          type: "TASK_DELETED",
          time: new Date().toISOString(),
          data: {
            orgId: ORG_A,
            taskId: TASK_A,
            projectId: PROJECT_A,
            attachmentIds: [],
          },
        },
      });

      expect(mockVectorDeleteByTask).toHaveBeenCalledWith(ORG_A, TASK_A);
      expect(mockVectorDeleteByTask).toHaveBeenCalledTimes(1);
    });

    it("cross-tenant project mismatch is rejected without vector mutation", async () => {
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      // Project belongs to ORG_B, but event claims ORG_A
      mockProjectFindUnique.mockResolvedValue({ id: PROJECT_A, orgId: ORG_B });

      await taskDeletedWorkerHandler({
        event: {
          id: "evt_mismatch",
          type: "TASK_DELETED",
          time: new Date().toISOString(),
          data: {
            orgId: ORG_A,
            taskId: TASK_A,
            projectId: PROJECT_A,
            attachmentIds: [ATTACHMENT_1],
          },
        },
      });

      expect(mockVectorDeleteByTask).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("CROSS_TENANT_RESOURCE_REFERENCE_REJECTED")
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("REJECTED_WITHOUT_VECTOR_MUTATION")
      );

      consoleWarnSpy.mockRestore();
    });

    it("duplicate deletion events are idempotent", async () => {
      mockProjectFindUnique.mockResolvedValue({ id: PROJECT_A, orgId: ORG_A });

      const eventPayload = {
        event: {
          id: "evt_idempotent",
          type: "TASK_DELETED" as const,
          time: new Date().toISOString(),
          data: {
            orgId: ORG_A,
            taskId: TASK_A,
            projectId: PROJECT_A,
            attachmentIds: [ATTACHMENT_1],
          },
        },
      };

      await taskDeletedWorkerHandler(eventPayload);
      expect(mockVectorDeleteByTask).toHaveBeenCalledTimes(2);

      // Duplicate delivery (QStash at-least-once redelivery)
      await taskDeletedWorkerHandler(eventPayload);
      expect(mockVectorDeleteByTask).toHaveBeenCalledTimes(4);
    });

    it("vector-store failure re-throws to enable QStash retries", async () => {
      mockProjectFindUnique.mockResolvedValue({ id: PROJECT_A, orgId: ORG_A });
      mockVectorDeleteByTask.mockRejectedValue(new Error("Pinecone cluster unreachable"));

      await expect(
        taskDeletedWorkerHandler({
          event: {
            id: "evt_fail",
            type: "TASK_DELETED",
            time: new Date().toISOString(),
            data: {
              orgId: ORG_A,
              taskId: TASK_A,
              projectId: PROJECT_A,
            },
          },
        })
      ).rejects.toThrow("Pinecone cluster unreachable");
    });
  });

  describe("Event Bus & Interceptor Durability (extended.ts & event-bus.ts)", () => {
    it("routes TASK_DELETED to durable queue and analytics event", async () => {
      publishEventMock.mockClear();

      const res = await dispatchEvent("TASK_DELETED", {
        taskId: TASK_A,
        orgId: ORG_A,
        projectId: PROJECT_A,
        userId: "system-cdc",
        subject: "Task Deleted",
        body: "Task deleted",
        attachmentIds: [ATTACHMENT_1],
      });

      expect(res.ok).toBe(true);
      expect(publishEventMock).toHaveBeenCalledTimes(2);

      expect(publishEventMock).toHaveBeenCalledWith(
        "TASK_DELETED",
        expect.objectContaining({
          orgId: ORG_A,
          taskId: TASK_A,
          projectId: PROJECT_A,
          attachmentIds: [ATTACHMENT_1],
        })
      );

      expect(publishEventMock).toHaveBeenCalledWith(
        "ANALYTICS_EVENT",
        expect.objectContaining({
          orgId: ORG_A,
          eventName: "TASK_DELETED",
          metadata: {
            taskId: TASK_A,
            projectId: PROJECT_A,
          },
        })
      );
    });

    it("event publication failure cannot silently be treated as successful durable cleanup", async () => {
      publishEventMock.mockRejectedValueOnce(new Error("QStash 503 Service Unavailable"));

      mockTaskFindUnique.mockResolvedValue({
        id: TASK_A,
        title: "Test Task",
        projectId: PROJECT_A,
        project: { orgId: ORG_A },
        attachments: [{ id: ATTACHMENT_1 }],
      });
      mockTaskDelete.mockResolvedValue({ id: TASK_A, title: "Test Task", projectId: PROJECT_A });

      // extendedPrisma.task.delete must fail loudly if event publication fails
      await expect(
        extendedPrisma.task.delete({ where: { id: TASK_A } })
      ).rejects.toThrow("Failed to publish deletion event for task task_alpha_123");
    });

    it("task deletion captures child attachment IDs before relational cascade", async () => {
      publishEventMock.mockClear().mockResolvedValue({ messageId: "msg_ok" });

      mockTaskFindUnique.mockResolvedValue({
        id: TASK_A,
        title: "Test Task",
        projectId: PROJECT_A,
        project: { orgId: ORG_A },
        attachments: [{ id: ATTACHMENT_1 }, { id: ATTACHMENT_2 }],
      });
      mockTaskDelete.mockResolvedValue({ id: TASK_A, title: "Test Task", projectId: PROJECT_A });

      await extendedPrisma.task.delete({ where: { id: TASK_A } });

      expect(publishEventMock).toHaveBeenCalledWith(
        "TASK_DELETED",
        expect.objectContaining({
          taskId: TASK_A,
          orgId: ORG_A,
          attachmentIds: [ATTACHMENT_1, ATTACHMENT_2],
        })
      );
    });

    it("project deletion cascades cleanup to all child tasks and their attachments", async () => {
      publishEventMock.mockClear().mockResolvedValue({ messageId: "msg_ok" });

      mockProjectFindUnique.mockResolvedValue({
        id: PROJECT_A,
        orgId: ORG_A,
        tasks: [
          {
            id: TASK_A,
            attachments: [{ id: ATTACHMENT_1 }],
          },
          {
            id: TASK_B,
            attachments: [{ id: ATTACHMENT_2 }],
          },
        ],
      });
      mockProjectDelete.mockResolvedValue({ id: PROJECT_A, orgId: ORG_A });

      await extendedPrisma.project.delete({ where: { id: PROJECT_A } });

      // Dispatched TASK_DELETED for both tasks under the deleted project
      expect(publishEventMock).toHaveBeenCalledWith(
        "TASK_DELETED",
        expect.objectContaining({
          taskId: TASK_A,
          orgId: ORG_A,
          projectId: PROJECT_A,
          attachmentIds: [ATTACHMENT_1],
        })
      );

      expect(publishEventMock).toHaveBeenCalledWith(
        "TASK_DELETED",
        expect.objectContaining({
          taskId: TASK_B,
          orgId: ORG_A,
          projectId: PROJECT_A,
          attachmentIds: [ATTACHMENT_2],
        })
      );
    });
  });
});
