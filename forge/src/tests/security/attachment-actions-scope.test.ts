// src/tests/security/attachment-actions-scope.test.ts
//
// S1 (P0) — tenant scope of the Task attachment server actions.
//
// `src/app/actions/Tasks/attachments.ts` is a `"use server"` module, so every
// export is an HTTP endpoint whether or not the UI calls it. None of the three
// exports authenticated or scoped by organization: `getAttachments` read any
// task's attachment metadata, `getSignedDownloadUrl` minted a signed URL for any
// UploadThing key, and `createAttachment` wrote onto any task.
//
// The fix derives authorization server-side. The client supplies only `taskId`
// and `fileKey` (both untrusted); ownership is resolved by requiring the caller
// to be a member of the organization that owns the row. The properties that a
// later refactor must keep:
//
//   1. No session => the action fails closed and never touches the database.
//   2. The read/write predicate carries the membership relation, not just the
//      id. Dropping it restores cross-tenant access.
//   3. A foreign task resolves to nothing: denied indistinguishably from
//      missing, and no write happens.
//   4. A signed URL is only minted for a key that resolves to an attachment in
//      the caller's org — a learned foreign key yields nothing.
//   5. The same-org positive paths still function.

jest.mock("server-only", () => ({}));

const mockVectorDeleteByTask = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/vector/client", () => ({
  getTenantVectorStore: jest.fn(() => ({
    deleteByTask: mockVectorDeleteByTask,
  })),
}));

jest.mock("@/lib/auth/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    task: { findFirst: jest.fn() },
    attachment: {
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    organization: { update: jest.fn() },
    domainOutboxEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: "outbox_1" }),
      update: jest.fn().mockResolvedValue({ id: "outbox_1" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("uploadthing/server", () => ({
  UTApi: jest.fn().mockImplementation(() => ({
    getSignedURL: jest.fn(),
    deleteFiles: jest.fn(),
  })),
}));

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { UTApi } from "uploadthing/server";
import {
  createAttachment,
  getAttachments,
  getSignedDownloadUrl,
} from "@/app/actions/Tasks/attachments";
import { deleteAttachment } from "@/app/api/uploadthing/deleteAttachment";

const authMock = auth as jest.MockedFunction<typeof auth>;
const taskFindFirst = db.task.findFirst as jest.Mock;
const attachmentFindMany = db.attachment.findMany as jest.Mock;
const attachmentCreate = db.attachment.create as jest.Mock;
const attachmentFindFirst = db.attachment.findFirst as jest.Mock;

// UTApi is instantiated once per importing module at load time. Capture the
// instances NOW, because `jest.clearAllMocks()` in `beforeEach` also clears
// `mock.results`, so they would otherwise be unreachable later.
const UTAPI_INSTANCES = (UTApi as unknown as jest.Mock).mock.results.map(
  (r) => r.value as Record<string, jest.Mock>,
);

function onlySignedUrlSpy() {
  // The instance `attachments.ts` holds (imported first).
  return UTAPI_INSTANCES[0].getSignedURL;
}

function onlyDeleteSpy() {
  // The instance `deleteAttachment.ts` holds (imported second). Both mock
  // instances define both methods, so index by import order, not by presence.
  return UTAPI_INSTANCES[1].deleteFiles;
}

const USER_ID = "user_1";
const TASK_ID = "task_1";

beforeEach(() => {
  jest.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER_ID } } as never);
});

describe("unauthenticated callers fail closed", () => {
  it("createAttachment throws and never creates a row", async () => {
    authMock.mockResolvedValue(null as never);

    await expect(
      createAttachment({
        taskId: TASK_ID,
        fileKey: "key_1",
        url: "https://cdn/key_1",
        name: "a.txt",
        size: 10,
      }),
    ).rejects.toThrow("Unauthorized");

    expect(taskFindFirst).not.toHaveBeenCalled();
    expect(attachmentCreate).not.toHaveBeenCalled();
  });

  it("getAttachments returns empty and never queries attachments", async () => {
    authMock.mockResolvedValue(null as never);

    await expect(getAttachments(TASK_ID)).rejects.toThrow("Unauthorized");
    expect(attachmentFindMany).not.toHaveBeenCalled();
  });

  it("getSignedDownloadUrl throws and never mints a URL", async () => {
    authMock.mockResolvedValue(null as never);

    await expect(getSignedDownloadUrl("key_1")).rejects.toThrow("Unauthorized");
    expect(onlySignedUrlSpy()).not.toHaveBeenCalled();
  });
});

describe("task resolution is scoped to the caller's organization", () => {
  it("getAttachments scopes the task predicate by membership", async () => {
    taskFindFirst.mockResolvedValue({ id: TASK_ID, projectId: "proj_1" });
    attachmentFindMany.mockResolvedValue([]);

    await getAttachments(TASK_ID);

    expect(taskFindFirst).toHaveBeenCalledWith({
      where: {
        id: TASK_ID,
        project: { organization: { memberships: { some: { userId: USER_ID } } } },
      },
      select: { id: true, projectId: true },
    });
  });

  it("createAttachment refuses a foreign task and creates nothing", async () => {
    // A real database under a membership predicate returns null for a task the
    // caller's org does not own.
    taskFindFirst.mockResolvedValue(null);

    await expect(
      createAttachment({
        taskId: TASK_ID,
        fileKey: "key_1",
        url: "https://cdn/key_1",
        name: "a.txt",
        size: 10,
      }),
    ).rejects.toThrow("not found");

    expect(attachmentCreate).not.toHaveBeenCalled();
  });

  it("getAttachments returns empty for a foreign task instead of its rows", async () => {
    taskFindFirst.mockResolvedValue(null);

    await expect(getAttachments(TASK_ID)).resolves.toEqual([]);
    expect(attachmentFindMany).not.toHaveBeenCalled();
  });
});

describe("signed URL minting is bound to an owned attachment", () => {
  it("only mints a URL for a key that resolves within the caller's org", async () => {
    attachmentFindFirst.mockResolvedValue({ id: "att_1" });
    onlySignedUrlSpy().mockResolvedValue({ url: "https://signed/att_1" });

    const url = await getSignedDownloadUrl("key_1");

    // The predicate ties the key to an attachment whose task is in the caller's
    // org, so a learned foreign key matches nothing.
    expect(attachmentFindFirst).toHaveBeenCalledWith({
      where: {
        fileKey: "key_1",
        task: {
          project: { organization: { memberships: { some: { userId: USER_ID } } } },
        },
      },
      select: { id: true },
    });
    expect(onlySignedUrlSpy()).toHaveBeenCalledWith("key_1", { expiresIn: 60 });
    expect(url).toBe("https://signed/att_1");
  });

  it("refuses a foreign key and never calls the storage API", async () => {
    attachmentFindFirst.mockResolvedValue(null);

    await expect(getSignedDownloadUrl("foreign_key")).rejects.toThrow("not found");
    expect(onlySignedUrlSpy()).not.toHaveBeenCalled();
  });
});

describe("legitimate same-org access still works", () => {
  it("creates an attachment on an owned task", async () => {
    taskFindFirst.mockResolvedValue({ id: TASK_ID, projectId: "proj_1" });
    attachmentCreate.mockResolvedValue({ id: "att_new" });

    const created = await createAttachment({
      taskId: TASK_ID,
      fileKey: "key_1",
      url: "https://cdn/key_1",
      name: "a.txt",
      size: 10,
    });

    expect(created).toEqual({ id: "att_new" });
    expect(attachmentCreate).toHaveBeenCalledWith({
      data: {
        taskId: TASK_ID,
        fileKey: "key_1",
        url: "https://cdn/key_1",
        name: "a.txt",
        size: 10,
      },
    });
  });

  it("returns attachments for an owned task", async () => {
    taskFindFirst.mockResolvedValue({ id: TASK_ID, projectId: "proj_1" });
    attachmentFindMany.mockResolvedValue([{ id: "att_1" }]);

    await expect(getAttachments(TASK_ID)).resolves.toEqual([{ id: "att_1" }]);
    expect(attachmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: TASK_ID } }),
    );
  });
});

// ---------------------------------------------------------------------------
// S9 — deleteAttachment is tenant-scoped and authenticated
// ---------------------------------------------------------------------------
describe("S9 deleteAttachment is authenticated and tenant-scoped", () => {
  const attachmentDelete = db.attachment.delete as jest.Mock;
  const organizationUpdate = db.organization.update as jest.Mock;
  const transaction = db.$transaction as jest.Mock;

  it("refuses an unauthenticated caller and never deletes", async () => {
    authMock.mockResolvedValue(null as never);

    await expect(deleteAttachment("att_1")).rejects.toThrow("Unauthorized");
    expect(attachmentFindFirst).not.toHaveBeenCalled();
    expect(onlyDeleteSpy()).not.toHaveBeenCalled();
  });

  it("scopes the lookup by the caller's membership", async () => {
    attachmentFindFirst.mockResolvedValue({
      fileKey: "key_1",
      size: 10,
      task: { project: { orgId: "org_1" } },
    });
    onlyDeleteSpy().mockResolvedValue({ success: true });
    transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return await (arg as (tx: unknown) => Promise<unknown>)(db);
      }
      return Array.isArray(arg) ? Promise.all(arg) : arg;
    });

    await deleteAttachment("att_1");

    expect(attachmentFindFirst).toHaveBeenCalledWith({
      where: {
        id: "att_1",
        task: {
          project: {
            organization: { memberships: { some: { userId: USER_ID } } },
          },
        },
      },
      select: expect.anything(),
    });
    expect(onlyDeleteSpy()).toHaveBeenCalledWith("key_1");
    expect(attachmentDelete).toHaveBeenCalled();
    expect(organizationUpdate).toHaveBeenCalled();
    expect(mockVectorDeleteByTask).toHaveBeenCalledWith("att_1");
  });

  it("refuses a foreign attachment without touching storage", async () => {
    attachmentFindFirst.mockResolvedValue(null);

    await expect(deleteAttachment("foreign")).rejects.toThrow("not found");
    expect(onlyDeleteSpy()).not.toHaveBeenCalled();
  });
});
