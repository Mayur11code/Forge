import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import OrgSettingsForm from "@/features/organizations/components/org-settings-form";
import ApiKeyManagementCard from "@/features/organizations/components/ApiKeyManagementCard";
import { listOrganizationCredentials } from "@/lib/security/vault";
import { notFound } from "next/navigation";

export default async function SettingsPage({
  params,
}: { params: Promise<{ orgId : string }> }) {
  const { orgId } = await params;

  // 1️⃣ Authenticate user and verify organization access
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  const { organization, membership } = access;

  // 2️⃣ Fetch safe credentials metadata (never plaintext secrets)
  const initialKeys = await listOrganizationCredentials(organization.id);

  // 3️⃣ Render settings page with forms
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Organization Settings</h1>

      <OrgSettingsForm
        orgId={organization.id}
        initialName={organization.name}
        role={membership.role}
        orgSlug={orgId}
        initialLogo={organization.logo}
      />

      <ApiKeyManagementCard
        orgId={organization.id}
        orgSlug={orgId}
        role={membership.role}
        initialKeys={initialKeys}
      />
    </div>
  );
}
