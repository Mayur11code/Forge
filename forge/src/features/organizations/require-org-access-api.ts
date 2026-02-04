
import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";

export async function requireOrgAccess(orgSlug: string) {
  const session = await auth();

  if (!session?.user?.id) {
    return { error: "UNAUTHORIZED" as const };
  }

  const organization = await db.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true },
  });

  if (!organization) {
    return { error: "NOT_FOUND" as const };
  }

  const membership = await db.membership.findUnique({
    where: {
      userId_orgId: {
        userId: session.user.id,
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

