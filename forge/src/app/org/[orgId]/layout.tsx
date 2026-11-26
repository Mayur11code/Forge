import { notFound } from "next/navigation";
import Link from "next/link";
import { User } from "lucide-react";
import { OrgProvider } from "@/contexts/OrgContext";
import { getOrgAccess, getUserOrgSummaries } from "@/features/organizations/getOrgAccess";
import { RealtimeListener } from "@/features/organizations/components/pusher/RealtimeListener";
import { Sidebar } from "@/features/organizations/components/Sidebar";
import { OrgSwitcher } from "@/features/organizations/components/OrgSwitcher";

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
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans antialiased">
      <RealtimeListener organizationId={access.organization.id} />
      
      {/* Sidebar */}
      <aside className="border-r border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl">
        <Sidebar orgId={orgId} />
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Header with OrgSwitcher and Profile controls */}
        <header className="relative z-30 h-16 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-md flex items-center justify-between px-8 shrink-0">
          <div className="flex items-center gap-3">
            <OrgSwitcher currentOrg={currentOrg} organizations={orgSummaries} />
          </div>

          {/* Right side: User Profile link */}
          <div className="flex items-center gap-4">
            <Link
              href={`/org/${orgId}/user/profile`}
              className="flex items-center gap-2 p-1.5 rounded-full hover:bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all text-zinc-400 hover:text-white"
              title="Profile & Settings"
            >
              <div className="h-8 w-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-semibold text-zinc-300">
                <User className="w-4 h-4" />
              </div>
            </Link>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar relative z-0">
          <div className="max-w-7xl mx-auto p-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
            <OrgProvider orgSlug={orgId}>
              {children}
            </OrgProvider>
          </div>
        </div>
      </main>
    </div>
  );
}
