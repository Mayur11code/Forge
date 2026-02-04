import { db } from "@/lib/prisma/db";

export async function requireOrgAccessCore(
  userId: string,
  orgSlug: string
) {
  const organization = await db.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true },
  });

  if (!organization) {
    return { error: "NOT_FOUND" as const };
  }

  const membership = await db.membership.findUnique({
    where: {
      userId_orgId: {
        userId,
        orgId: organization.id,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    return { error: "FORBIDDEN" as const };
  }

  return { organization, membership };
}
