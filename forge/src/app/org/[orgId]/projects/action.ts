"use server";

import { z } from "zod";
import { db } from "@/lib/prisma/db";
// import { requireOrgAccess } from "@/features/organizations/require-org-access";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { notFound } from "next/navigation";
/* ----------------------------------------
   1️⃣ Zod Schema (single source of truth)
---------------------------------------- */
const createProjectSchema = z.object({
  name: z
    .string()
    .min(1, "Project name is required")
    .max(100, "Project name is too long"),
  description: z
    .string()
    .max(500, "Description is too long")
    .optional()
    .or(z.literal("")),
});

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
  // const { organization, membership } = await requireOrgAccess(orgSlug);
   const access = await getOrgAccess(orgSlug);
  if (!access) notFound();
  

  // 4️⃣ RBAC (write permission)
  if (access.membership.role !== "ADMIN" && access.membership.role !== "MANAGER") {
    throw new Error("Insufficient permissions to create a project.");
  }

  // 5️⃣ Create project (org-scoped, safe)
  const project = await db.project.create({
    data: {
      name: data.name.trim(),
      description: data.description?.trim() || null,
      orgId: access.organization.id,
    },
  });

  // 6️⃣ Revalidate & redirect
  revalidatePath(`/org/${orgSlug}/projects`);
  redirect(`/org/${orgSlug}/dashboard`);
}
