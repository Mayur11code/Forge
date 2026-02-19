import { getOrgAccess } from "@/features/organizations/getOrgAccess";

import { db } from "@/lib/prisma/db";
import { notFound } from "next/navigation";
import ProfileForm from "@/features/organizations/components/user/ProfileForm";

export default async function ProfilePage({ params }: { params: Promise<{ orgId: string } >}) {
  const access = await getOrgAccess((await params).orgId);
    if (!access) notFound();

  const user = await db.user.findUnique({
    where: { id: access.userId },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
    },
  });

  if (!user) notFound();

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="text-3xl font-bold text-white">
        Profile Settings
      </h1>

      <ProfileForm user={{ ...user, slug: (await params).orgId }} />
    </div>
  );
}
