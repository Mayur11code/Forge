"use server";

// Thin Next.js server-action adapter for task creation.
//
// UI-only concerns live here: NextAuth, org access, rate limiting, cache
// revalidation, and the UI-shaped response.
//
// The actual task business operation (validation, project ownership check,
// the single prisma.task.create, and the TASK_CREATED CDC) lives in
// @/lib/tasks/create-task and is shared with the workflow action and the
// agent tool executor. Do not re-implement the write here.

import { prisma } from "@/lib/prisma/extended";
import { rateLimit } from "@/lib/redis/rate-limit";
import { auth } from "@/lib/auth/auth";
import { createTaskSchema } from "@/core/domain";
import { revalidatePath } from "next/cache";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import { createTaskInOrg } from "@/lib/tasks/create-task";

export async function createTask(input: unknown) {
  // 1️⃣ Auth
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  // 2️⃣ Zod barrier
  const data = createTaskSchema.parse(input);

  // 3️⃣ Resolve the project's org, then confirm this user may act in it.
  //    The UI does not know the org up front: it only has a projectId, so the
  //    org is derived from the project and access is checked against it.
  const project = await prisma.project.findFirst({
    where: {
      id: data.projectId,
    },
    select: {
      orgId: true,
    },
  });

  if (!project) {
    throw new Error("Project not found");
  }

  const organization = await prisma.organization.findUnique({
    where: { id: project.orgId },
    select: { id: true, slug: true },
  });
  if (!organization) {
    throw new Error("Organization not found");
  }

  const access = await getOrgAccess(organization.slug);
  if (!access) notFound();

  // 4️⃣ Rate limit. EXACTLY ONE call, used consistently for the decision and
  //    for the remaining/reset values. (Previously this was called twice,
  //    which consumed the budget twice and mixed the two responses.)
  const { success, remaining, reset } = await rateLimit.limit(session.user.id);

  if (!success) {
    console.warn(`[RATE LIMIT] User ${session.user.id} blocked`);
    return {
      success: false,
      error: "RATE_LIMIT",
      remaining: 0,
      reset,
    };
  }

  // 5️⃣ Canonical task creation.
  //    Trusted org/user are derived above, never taken from `input`.
  const result = await createTaskInOrg(data, {
    orgId: organization.id,
    userId: session.user.id,
  });

  if (!result.success) {
    return {
      success: false,
      error: result.code,
      message: result.error,
      remaining,
      reset,
    };
  }

  // 6️⃣ UI-only cache invalidation. The TASK_CREATED CDC is dispatched by the
  //    extended Prisma hook inside the canonical operation.
  revalidatePath(`/org/${organization.slug}/projects/${data.projectId}`);

  return {
    success: true,
    task: result.task,
    remaining,
    reset,
  };
}
