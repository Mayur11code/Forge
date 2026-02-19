"use server";

import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

export async function createComment({
  orgSlug,
  taskId,
  content,
}: {
  orgSlug: string;
  taskId: string;
  content: string;
}) {
  if (!content.trim()) return;

  const access = await getOrgAccess(orgSlug);
  if (!access) notFound();

  const orgId = access.organization.id;
  const userId = access.userId;

  // Ensure task belongs to this org
  const task = await db.task.findFirst({
    where: {
      id: taskId,
      project: { orgId },
    },
  });

  if (!task) notFound();

  // Create comment
  const comment = await db.comment.create({
    data: {
      content: content.trim(),
      taskId,
      userId,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          
        },
      },
    },
  });

  revalidatePath(`/org/${orgSlug}/projects/${task.projectId}/tasks/${taskId}`);
  return comment;
}
