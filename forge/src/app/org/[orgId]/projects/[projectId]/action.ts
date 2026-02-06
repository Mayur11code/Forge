"use server";

import { db } from "@/lib/prisma/db";
import { auth } from "@/lib/auth/auth";
import { createTaskSchema } from "@/core/domain";
import { requireOrgAccess } from "@/features/organizations/require-org-access";
import { revalidatePath } from "next/cache";

export async function createTask(input: unknown) {
  // 1️⃣ Auth
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  // 2️⃣ Zod barrier
  const data = createTaskSchema.parse(input);

  // 3️⃣ Org access check (via project → org)
  const project = await db.project.findFirst({
    where: {
      id: data.projectId,
    },
    select: {
      orgId: true,
    },
  });
//   await new Promise(resolve => setTimeout(resolve, 3000));

  if (!project) {
    throw new Error("Project not found");
  }
  console.log("🚀 Creating task in project:", data.projectId, "with title:", data.title);
  const organization = await db.organization.findUnique({
    where: { id: project.orgId }
  });
  if (!organization) {
    throw new Error("Organization not found");
  }
  console.log("💕 Found organization for task:", organization.name);
  await requireOrgAccess(organization.slug);
console.log("💕 User has access to organization:", organization.name);
  // 4️⃣ Create task
  const task = await db.task.create({
    data: {
      title: data.title,
      projectId: data.projectId,
      priority: data.priority,
      assigneeId: data.assigneeId ?? null,
    },
  });

  revalidatePath(`/org/${organization.slug}/projects/${data.projectId}`);
  return task;
}
