import { getOrgAccess } from "@/features/organizations/getOrgAccess";
// import { requireOrgAccess } from "../../../../features/organizations/require-org-access";
import OrgSettingsForm from "@/features/organizations/components/org-settings-form";
import { notFound } from "next/navigation";

export default async function SettingsPage({
  params,
}: { params: Promise<{ orgId : string }> }) {
  const { orgId } = await params;

  // 1️⃣ Authenticate user
  
    // const { organization, membership } = await requireOrgAccess(orgId);
     const access = await getOrgAccess(orgId  );
    if (!access) notFound();
    const { organization, membership } = access;
    console.log("Organization in Settings Page:", organization);

    
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
