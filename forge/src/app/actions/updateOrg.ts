"use server";

import { auth } from "@/lib/auth/auth";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma/db";

// -----------------------------
// Helpers
// -----------------------------
function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

// -----------------------------
// Zod validation schema
// -----------------------------
const updateOrgNameSchema = z.object({
  orgId: z.string().min(1), // INTERNAL ID
  newName: z
    .string()
    .trim()
    .min(1, "Organization name is required")
    .max(50, "Organization name must be 50 characters or less")
    .regex(/^[a-zA-Z0-9\s-]+$/, "Invalid characters in organization name"),
});

// -----------------------------
// Server Action
// -----------------------------
export async function updateOrgName(
  orgId: string,
  newName: string
) {
  // 1️⃣ Authenticate
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  // 2️⃣ Validate input
  const parsed = updateOrgNameSchema.safeParse({
    orgId,
    newName,
  });

  if (!parsed.success) {
    throw new Error("Invalid organization name");
  }

  const userId = session.user.id;

  // 3️⃣ Membership lookup (RBAC)
  const membership = await db.membership.findUnique({
    where: {
      userId_orgId: {
        userId,
        orgId,
      },
    },
    select: { role: true },
  });

  if (!membership || membership.role !== "ADMIN") {
    throw new Error("Forbidden");
  }

  // 4️⃣ Generate new slug
  const newSlug = slugify(parsed.data.newName);

  // 5️⃣ Ensure slug uniqueness
  const existingOrg = await db.organization.findUnique({
    where: { slug: newSlug },
    select: { id: true },
  });

  if (existingOrg && existingOrg.id !== orgId) {
    throw new Error("Organization name already in use");
  }

  // 6️⃣ Update organization
  const updatedOrg = await db.organization.update({
    where: { id: orgId },
    data: {
      name: parsed.data.newName,
      slug: newSlug,
    },
    select: {
      slug: true,
    },
  });

  // 7️⃣ Cache invalidation
  revalidatePath(`/org/${updatedOrg.slug}`);
  revalidatePath(`/org/${updatedOrg.slug}/settings`);

  // 8️⃣ Redirect using SLUG (correct)
  redirect(`/org/${updatedOrg.slug}/settings`);
}
