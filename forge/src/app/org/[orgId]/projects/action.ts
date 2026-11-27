"use server";

import { z } from "zod";
import { db } from "@/lib/prisma/db";
// import { requireOrgAccess } from "@/features/organizations/require-org-access";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
import { createProjectInOrg, createProjectInputSchema } from "@/lib/projects/create-project";

/* ----------------------------------------
   1️⃣ Zod Schema (single source of truth)
---------------------------------------- */
const createProjectSchema = createProjectInputSchema;

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/* ----------------------------------------
   2️⃣ Server Action
---------------------------------------- */
export async function createProject(
  orgSlug: string,
  rawData: CreateProjectInput
) {
  // ✅ Validate FIRST (never trust client)
  const data = createProjectSchema.parse(rawData);

  // 3️⃣ Auth + org + membership
  const access = await getOrgAccess(orgSlug);
  if (!access) notFound();

  // 4️⃣ RBAC (write permission)
  if (access.membership.role !== "ADMIN" && access.membership.role !== "MANAGER") {
    throw new Error("Insufficient permissions to create a project.");
  }

  // 5️⃣ Create project via canonical business operation (transactional outbox)
  const result = await createProjectInOrg(data, {
    orgId: access.organization.id,
    userId: access.userId,
    origin: {
      originType: "USER",
    },
  });

  if (!result.success) {
    throw new Error(result.error);
  }

  // 6️⃣ Revalidate & redirect
  revalidatePath(`/org/${orgSlug}/projects`);
  redirect(`/org/${orgSlug}/dashboard`);
}
