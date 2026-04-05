// src/app/dashboard/page.tsx
import { auth } from "@/lib/auth/auth";
import { redirect } from "next/navigation";

import { db } from "@/lib/prisma/db";

export default async function DashboardEntryPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  // Fetch memberships (by USER ID)
  const memberships = await db.membership.findMany({
    where: {
      userId: session.user.id,
    },
    include: {
      organization: {
        select: {
          slug: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  // No orgs → onboarding
  if (memberships.length === 0) {
    redirect("/onboarding");
  }

  // One org → auto-redirect
  if (memberships.length === 1) {
    redirect(`/org/${memberships[0].organization.slug}/dashboard`);
  }

  // Multiple orgs → org selector
  redirect("/select-org");
}
