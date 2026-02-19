import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";

export async function getOrgAccess(orgSlug: string) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const organization = await db.organization.findUnique({
    where: { slug: orgSlug },
    select: {
      id: true,
      name: true,
      storageLimit: true,
      storageUsed: true,
      logo: true,
      invitations: {
        where: { email: session.user.email || "" },
        select: { role: true },
      },
      memberships: {
        where: { userId },
        select: { role: true },
      },
    },
  });

  const membership = organization?.memberships[0];
  if (!membership) return null;

  return {
    userId,
    organization: {
      id: organization.id,
      name: organization.name,
      storageLimit: organization.storageLimit,
      storageUsed: organization.storageUsed,
      logo : organization.logo,
    },
    membership,
  };
}


//This will replace the requireOrgAccess function in src/features/organizations/require-org-access.ts.
//  It will return null if the user is not authenticated 
// or if they do not have access to the organization. 
// Otherwise, it will return an object containing the userId, organization details, and membership details.
//Will rpalce it slowly in the codebase, and we will update the places where requireOrgAccess is used to use getOrgAccess instead.
//currently i made this for uploadThing