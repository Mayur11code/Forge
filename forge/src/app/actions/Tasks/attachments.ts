"use server";

import { UTApi } from "uploadthing/server";
import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
const utapi = new UTApi();

// S1 (security) — TENANT SCOPE.
//
// Every export here used to run with no authentication and no organization
// scope: any caller could read any tenant's attachment metadata, mint a signed
// download URL for any UploadThing key, or write an attachment onto any task.
// These are `"use server"` actions, so they are reachable as HTTP endpoints
// regardless of whether the UI exposes them.
//
// `taskId` and `fileKey` are UNTRUSTED. Authorization is derived server-side:
// the session supplies `userId`, and the row is resolved only if the caller is a
// member of the organization that owns it. A foreign id then resolves to
// nothing, so the denial is indistinguishable from "does not exist".

/**
 * Resolve the caller's user id, or throw. A server action must fail closed:
 * there is no code path below that runs without a verified identity.
 */
async function requireUserId(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }
  return userId;
}

/**
 * Is `taskId` inside an organization the user belongs to?
 *
 * Single predicate for the authorization decision, so a read and a write cannot
 * drift apart. Dropping the membership clause silently restores cross-tenant
 * access.
 */
async function taskInUserOrg(
  taskId: string,
  userId: string,
): Promise<{ id: string; projectId: string } | null> {
  return db.task.findFirst({
    where: {
      id: taskId,
      project: { organization: { memberships: { some: { userId } } } },
    },
    select: { id: true, projectId: true },
  });
}

export async function createAttachment({
  taskId,
  fileKey,
  url,
  name,
  size,
}: {
  taskId: string;
  fileKey: string;
  url: string;
  name: string;
  size: number;
}) {
  if (!fileKey) {
    throw new Error("Missing fileKey");
  }

  const userId = await requireUserId();

  const task = await taskInUserOrg(taskId, userId);
  if (!task) {
    throw new Error("Task not found in this organization.");
  }

  return db.attachment.create({
    data: {
      taskId,
      fileKey,
      url,
      name,
      size,
    },
  });
}



export async function getAttachments(taskId: string) {
  if (!taskId) return [];

  const userId = await requireUserId();

  const task = await taskInUserOrg(taskId, userId);
  if (!task) return [];

  return db.attachment.findMany({
    where: { taskId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      name: true,
      size: true,
      createdAt: true,
      fileKey : true
    },
  });
}




export async function getSignedDownloadUrl(fileKey: string | null) {
  if (!fileKey) {
    throw new Error("Missing fileKey");
  }

  const userId = await requireUserId();

  // The key is UNTRUSTED. A signed URL is only minted for a key that belongs to
  // an Attachment row whose task is in the caller's organization. Otherwise a
  // caller who learned a foreign key could disclose any file in the bucket.
  const attachment = await db.attachment.findFirst({
    where: {
      fileKey,
      task: { project: { organization: { memberships: { some: { userId } } } } },
    },
    select: { id: true },
  });

  if (!attachment) {
    throw new Error("File not found in this organization.");
  }

  const { url } = await utapi.getSignedURL(fileKey, {
    expiresIn: 60, // seconds
  });

  return url;
}
