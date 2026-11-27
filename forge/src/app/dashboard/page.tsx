import { auth } from "@/lib/auth/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/prisma/db";

export default async function DashboardRedirectPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  // Find user's active organization membership
  const membership = await db.membership.findFirst({
    where: { userId: session.user.id },
    include: { organization: true },
    orderBy: { createdAt: "desc" },
  });

  if (membership?.organization?.slug) {
    redirect(`/org/${membership.organization.slug}/dashboard`);
  }

  redirect("/onboarding");
}
