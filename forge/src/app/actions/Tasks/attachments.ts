"use server";

import { UTApi } from "uploadthing/server";
import { db } from "@/lib/prisma/db";
const utapi = new UTApi();

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

  const { url } = await utapi.getSignedURL(fileKey, {
    expiresIn: 60, // seconds
  });

  return url;
}