"use server";

import { db } from "@/lib/prisma/db";

export async function createAttachment({
  taskId,
  url,
  name,
  size,
}: {
  taskId: string;
  url: string;
  name: string;
  size: number;
}) {



  if (!taskId || !url || !name) {
    throw new Error("Missing required attachment data");
  }

  return db.attachment.create({
    data: {
      taskId,
      url,
      name,
      size,
    },
  });
}

/* UploadThing → stores file → gives URL
Server Action → stores metadata → links Task
UI → just orchestrates  */




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
    },
  });
}
