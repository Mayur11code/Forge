// forge/src/tests/vector/part1-transactional-outbox.test.ts
/**
 * Phase B Remediation — Part 1: Transactional Outbox Capture Acceptance Tests (E2)
 *
 * Verifies that:
 * 1. Task creation writes the task and outbox intent together.
 * 2. Task update writes the update and corresponding intent together.
 * 3. Attachment creation writes the attachment and intent together.
 * 4. Intent-persistence failure causes each relevant transaction to roll back.
 * 5. No mock-detection fallback can return fabricated success.
 * 6. Unrelated or non-indexing changes do not create unnecessary intents.
 */

jest.mock("server-only", () => ({}));

jest.mock("@/lib/events/event-bus", () => ({
  dispatchEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn().mockResolvedValue({ user: { id: "user_test_1" } }),
}));

// In-memory transactional double that mimics PostgreSQL transaction rollback
class MockTransactionalClient {
  public taskCreated: Record<string, unknown> | null = null;
  public taskUpdated: Record<string, unknown> | null = null;
  public attachmentCreated: Record<string, unknown> | null = null;
  public rawQueries: string[] = [];
  public shouldFailIntent = false;

  public task = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      this.taskCreated = { id: "task_new_1", ...data };
      return this.taskCreated;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      this.taskUpdated = { id: where.id, projectId: "proj_1", ...data };
      return this.taskUpdated;
    }),
    findFirst: jest.fn(async ({ where }: { where?: { id?: string } }) => {
      return { id: where?.id ?? "task_existing_1", projectId: "proj_1", title: "Existing Task" };
    }),
    findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
      return {
        id: where.id,
        title: "Parent Task Title",
        projectId: "proj_1",
        project: { orgId: "org_1" },
      };
    }),
  };

  public project = {
    findFirst: jest.fn(async () => ({ id: "proj_1", orgId: "org_1" })),
  };

  public membership = {
    findFirst: jest.fn(async () => ({ id: "mem_1", orgId: "org_1" })),
  };

  public attachment = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      this.attachmentCreated = { id: "att_new_1", ...data };
      return this.attachmentCreated;
    }),
    findMany: jest.fn(async ({ where }: { where?: { taskId?: string } }) => {
      return [
        { id: "att_child_1", name: "Doc.pdf", size: 1024, fileKey: "key_pdf" },
      ];
    }),
  };

  public $queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (this.shouldFailIntent) {
      throw new Error("DB_OUTBOX_INTENT_PERSISTENCE_FAILED");
    }
    const sql = strings.join("?");
    this.rawQueries.push(sql);

    if (sql.includes("VectorEntityHead")) {
      return [{ id: "head_1", latestRevision: 1 }];
    }
    if (sql.includes("VectorOutboxEvent")) {
      return [{ id: "outbox_evt_1" }];
    }
    return [];
  });
}

let mockTxClient: MockTransactionalClient;

jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        taskCreated: mockTxClient.taskCreated,
        taskUpdated: mockTxClient.taskUpdated,
        attachmentCreated: mockTxClient.attachmentCreated,
      };
      try {
        return await callback(mockTxClient);
      } catch (err) {
        // Realistic rollback on failure
        mockTxClient.taskCreated = snapshot.taskCreated;
        mockTxClient.taskUpdated = snapshot.taskUpdated;
        mockTxClient.attachmentCreated = snapshot.attachmentCreated;
        throw err;
      }
    }),
    task: {
      findFirst: jest.fn(async () => mockTxClient.task.findFirst({})),
    },
    project: {
      findFirst: jest.fn(async () => mockTxClient.project.findFirst()),
    },
    membership: {
      findFirst: jest.fn(async () => mockTxClient.membership.findFirst()),
    },
  },
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        taskCreated: mockTxClient.taskCreated,
        taskUpdated: mockTxClient.taskUpdated,
        attachmentCreated: mockTxClient.attachmentCreated,
      };
      try {
        return await callback(mockTxClient);
      } catch (err) {
        mockTxClient.taskCreated = snapshot.taskCreated;
        mockTxClient.taskUpdated = snapshot.taskUpdated;
        mockTxClient.attachmentCreated = snapshot.attachmentCreated;
        throw err;
      }
    }),
    task: {
      findFirst: jest.fn(async () => mockTxClient.task.findFirst({})),
    },
    attachment: {
      create: jest.fn(async (args: unknown) => mockTxClient.attachment.create(args as { data: Record<string, unknown> })),
    },
  },
}));

import { createTaskInOrg } from "@/lib/tasks/create-task";
import { updateTaskInOrg } from "@/lib/tasks/update-task";
import { createAttachment } from "@/app/actions/Tasks/attachments";
import { recordVectorSyncIntent } from "@/lib/vector/outbox";
import { VectorEntityType, type Prisma } from "@prisma/client";
import { dispatchEvent } from "@/lib/events/event-bus";
import { auth } from "@/lib/auth/auth";

const mockDispatchEvent = dispatchEvent as jest.MockedFunction<typeof dispatchEvent>;
const mockAuth = auth as jest.MockedFunction<typeof auth>;

const VALID_PROJECT_ID = "clh7a1b2c3d4e5f6g7h8i9jk0";
const VALID_TASK_ID = "clh7a1b2c3d4e5f6g7h8i9jk1";

describe("Phase B Remediation Part 1: Mandatory Transactional Outbox Intent Capture (E2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTxClient = new MockTransactionalClient();
    (mockAuth as unknown as jest.Mock).mockResolvedValue({ user: { id: "user_test_1" } });
  });

  // ---------------------------------------------------------------------------
  // 1. Task Creation
  // ---------------------------------------------------------------------------
  it("Task creation writes task and outbox intent together in the same transaction", async () => {
    const res = await createTaskInOrg(
      {
        projectId: VALID_PROJECT_ID,
        title: "Deploy V2 Engine",
        priority: "HIGH",
      },
      { orgId: "org_1", userId: "user_test_1" }
    );

    expect(res.success).toBe(true);
    if (!res.success) return;

    // 1. Task was created in tx
    expect(mockTxClient.taskCreated).not.toBeNull();
    expect(mockTxClient.taskCreated?.title).toBe("Deploy V2 Engine");

    // 2. Vector intent was recorded in tx via raw SQL
    const headUpsert = mockTxClient.rawQueries.some((q) => q.includes("VectorEntityHead"));
    const outboxInsert = mockTxClient.rawQueries.some((q) => q.includes("VectorOutboxEvent"));
    expect(headUpsert).toBe(true);
    expect(outboxInsert).toBe(true);

    // 3. CDC dispatched post-commit
    expect(mockDispatchEvent).toHaveBeenCalledWith(
      "TASK_CREATED",
      expect.objectContaining({
        taskId: res.task.id,
        orgId: "org_1",
      })
    );
  });

  it("Task creation transaction rolls back completely when outbox intent fails", async () => {
    mockTxClient.shouldFailIntent = true;

    const res = await createTaskInOrg(
      {
        projectId: VALID_PROJECT_ID,
        title: "Doomed Task",
        priority: "LOW",
      },
      { orgId: "org_1", userId: "user_test_1" }
    );

    // 1. Enclosing mutation reports failure
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.code).toBe("CREATE_FAILED");
      expect(res.error).toContain("DB_OUTBOX_INTENT_PERSISTENCE_FAILED");
    }

    // 2. Transaction rolled back: created task is reverted
    expect(mockTxClient.taskCreated).toBeNull();

    // 3. CDC event was NOT dispatched
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 2. Task Update
  // ---------------------------------------------------------------------------
  it("Task update writes update and corresponding intent together in the same transaction", async () => {
    const res = await updateTaskInOrg(
      {
        taskId: VALID_TASK_ID,
        title: "Updated Title for Task",
      },
      { orgId: "org_1", userId: "user_test_1" }
    );

    expect(res.success).toBe(true);
    if (!res.success) return;

    // 1. Task updated in tx
    expect(mockTxClient.taskUpdated).not.toBeNull();
    expect(mockTxClient.taskUpdated?.title).toBe("Updated Title for Task");

    // 2. Raw SQL recorded intent for Task AND for child attachment (due to title change)
    const outboxQueries = mockTxClient.rawQueries.filter((q) => q.includes("VectorOutboxEvent"));
    expect(outboxQueries.length).toBeGreaterThanOrEqual(2); // 1 for task, 1 for child attachment

    // 3. CDC dispatched
    expect(mockDispatchEvent).toHaveBeenCalledWith(
      "TASK_UPDATED",
      expect.objectContaining({
        taskId: VALID_TASK_ID,
        orgId: "org_1",
      })
    );
  });

  it("Task update rolls back completely when outbox intent fails", async () => {
    mockTxClient.shouldFailIntent = true;

    const res = await updateTaskInOrg(
      {
        taskId: VALID_TASK_ID,
        title: "Failed Update Title",
      },
      { orgId: "org_1", userId: "user_test_1" }
    );

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.code).toBe("UPDATE_FAILED");
      expect(res.error).toContain("DB_OUTBOX_INTENT_PERSISTENCE_FAILED");
    }

    // Rolled back
    expect(mockTxClient.taskUpdated).toBeNull();
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });

  it("Non-indexing task update does NOT emit child attachment intents", async () => {
    const res = await updateTaskInOrg(
      {
        taskId: VALID_TASK_ID,
        status: "DONE",
        priority: "HIGH",
      },
      { orgId: "org_1", userId: "user_test_1" }
    );

    expect(res.success).toBe(true);
    // Only 1 outbox insert for task, none for child attachment
    const outboxQueries = mockTxClient.rawQueries.filter((q) => q.includes("VectorOutboxEvent"));
    expect(outboxQueries).toHaveLength(1);
    expect(mockTxClient.attachment.findMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 3. Attachment Creation
  // ---------------------------------------------------------------------------
  it("Attachment creation resolves parent task/org and writes attachment and intent together", async () => {
    const attachment = await createAttachment({
      taskId: VALID_TASK_ID,
      fileKey: "key_file_99",
      url: "https://storage.cdn/file99.pdf",
      name: "QuarterlyReport.pdf",
      size: 4096,
    });

    expect(attachment).not.toBeNull();
    expect(attachment.id).toBe("att_new_1");
    expect(mockTxClient.attachmentCreated).not.toBeNull();

    // Outbox query was executed with parent project orgId
    const outboxQueries = mockTxClient.rawQueries.filter((q) => q.includes("VectorOutboxEvent"));
    expect(outboxQueries).toHaveLength(1);
  });

  it("Attachment creation rolls back completely when outbox intent fails", async () => {
    mockTxClient.shouldFailIntent = true;

    await expect(
      createAttachment({
        taskId: VALID_TASK_ID,
        fileKey: "key_file_fail",
        url: "https://storage.cdn/file_fail.pdf",
        name: "Broken.pdf",
        size: 100,
      })
    ).rejects.toThrow("DB_OUTBOX_INTENT_PERSISTENCE_FAILED");

    // Rolled back: attachmentCreated was undone
    expect(mockTxClient.attachmentCreated).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 4. No Mock-Detection Fallback
  // ---------------------------------------------------------------------------
  it("recordVectorSyncIntent fails immediately if tx.$queryRaw is missing (no fabricated mock fallback)", async () => {
    const brokenTx = {} as unknown as Prisma.TransactionClient; // No $queryRaw function

    await expect(
      recordVectorSyncIntent({
        tx: brokenTx,
        orgId: "org_1",
        entityType: VectorEntityType.TASK,
        entityId: "task_1",
        contentHash: "hash123",
      })
    ).rejects.toThrow();
  });
});
