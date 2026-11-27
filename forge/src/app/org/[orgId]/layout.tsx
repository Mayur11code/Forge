import { notFound } from "next/navigation";
import { OrgProvider } from "@/contexts/OrgContext";
import { getOrgAccess, getUserOrgSummaries } from "@/features/organizations/getOrgAccess";
import { RealtimeListener } from "@/features/organizations/components/pusher/RealtimeListener";
import { Sidebar } from "@/features/organizations/components/Sidebar";
import { WorkspaceContentShell } from "@/features/organizations/components/WorkspaceContentShell";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await getOrgAccess(orgId);

  if (!access) notFound();

  // Fetch all organizations the user belongs to for the switcher
  const orgSummaries = typeof getUserOrgSummaries === "function"
    ? await getUserOrgSummaries(access.userId)
    : [];

  const currentOrg = {
    id: access.organization.id,
    name: access.organization.name,
    slug: orgId,
    role: access.membership.role,
    logo: access.organization.logo,
  };

  return (
    <div className="flex h-screen w-screen bg-[#07070a] text-zinc-100 font-sans antialiased overflow-hidden">
      <RealtimeListener organizationId={access.organization.id} />
      
      {/* Detached Global Navigation Dock */}
      <aside className="p-2 sm:p-2.5 shrink-0 flex items-stretch z-40">
        <Sidebar orgId={orgId} currentOrg={currentOrg} orgSummaries={orgSummaries} />
      </aside>

      {/* Main Workspace Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative">
        <OrgProvider orgSlug={orgId}>
          <WorkspaceContentShell
            orgId={orgId}
            currentOrg={currentOrg}
            orgSummaries={orgSummaries}
          >
            {children}
          </WorkspaceContentShell>
        </OrgProvider>
      </main>
    </div>
  );
}
