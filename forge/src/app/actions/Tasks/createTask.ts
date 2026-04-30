"use server";

import { db } from "@/lib/prisma/db";
import { rateLimit } from "@/lib/redis/rate-limit";
import { dispatchEvent } from "@/lib/events/event-bus";
import { auth } from "@/lib/auth/auth";
import { createTaskSchema } from "@/core/domain";
// import { requireOrgAccess } from "@/features/organizations/require-org-access";
import { revalidatePath } from "next/cache";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import { User } from "lucide-react";


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

  const organization = await db.organization.findUnique({
    where: { id: project.orgId }
  });
  if (!organization) {
    throw new Error("Organization not found");
  }
  // await requireOrgAccess(organization.slug);
  const access = await getOrgAccess(organization.slug);
  if (!access) notFound();

  const { success, limit, remaining, reset } =
    await rateLimit.limit(session.user.id);
const result = await rateLimit.limit(session.user.id);

console.log("RATE LIMIT RESULT:", result.remaining, "remaining out of", result.limit, "Limit reset in", result.reset, "seconds");
  // 3. BLOCK IF EXCEEDED
  if (!success) {
    console.warn(`[RATE LIMIT] User ${session.user.id} blocked`);
    return{
      success: false,
    error: "RATE_LIMIT",
    remaining: 0,
    reset: result.reset,
    }
    // throw new Error("You are doing that too fast. Please wait 10 seconds.");
  }

  // 4️⃣ Create task
  const task = await db.task.create({
    data: {
      title: data.title,
      projectId: data.projectId,
      priority: data.priority,
      assigneeId: data.assigneeId ?? null,
    },
  });

  // 🔥 EVENT EMISSION
  await dispatchEvent("TASK_CREATED", {
    orgId: organization.id,
    taskId: task.id,
    userId: session.user.id,
    projectId: data.projectId,
    subject: "New Task Added",
    body: `A new task "${task.title}" has been added to your project.`,
  });

  //REFACTOR LATER TO INCLUDE OUTBOX PATTERN TO AVOID DUAL WRITE PROBLEMS

  revalidatePath(`/org/${organization.slug}/projects/${data.projectId}`);
  return {
  success: true,
  task,
  remaining: result.remaining,
  reset: result.reset,
};
}
