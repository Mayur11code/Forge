import { auth } from "@/lib/auth/auth";
import { notFound } from "next/navigation";
import { db } from "@/lib/prisma/db";
import OrgSettingsForm from "@/features/organizations/components/org-settings-form";

export default async function SettingsPage({
  params,
}: { params: Promise<{ orgId : string }> }) {
  const { orgId } = await params;

  // 1️⃣ Authenticate user
  const session = await auth();
  console.log("Session in Org Settings Page:", session?.user.id);

  if (!session?.user?.id) {
    notFound();
  }

  console.log("User ID:", session.user.id);

  const userId = session.user.id;

  // 2️⃣ Fetch organization
  const organization = await db.organization.findUnique({
    where: {
    //   id: orgId, ==> gives error, ebcause findUnique needs unique field
      slug: orgId,
    },
    select: {
      id: true,
      name: true,
    },
  });

  console.log("Organization fetched:", organization);

  if (!organization) {
    notFound();
  }

  // 3️⃣ Fetch membership (read-level authorization)
const membership = await db.membership.findUnique({
  where: {
    userId_orgId: {
      userId,
      orgId: organization.id,
    },
  },
  select: {
    role: true,
  },
});


  // 4️⃣ Block cross-tenant access
  if (!membership) {
    notFound();
  }

  // 5️⃣ Render settings page with form
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Organization Settings</h1>

      <OrgSettingsForm
        orgId={organization.id}
        initialName={organization.name}
        role={membership.role}
      />
    </div>
  );
}
