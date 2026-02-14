import React from 'react';
import { MembersTable } from '@/features/organizations/components/invitation/members-table'; // We'll create this below
import { UserPlus } from 'lucide-react';
import InviteMemberModal from '@/features/organizations/components/invitation/InviteMemberModal';




// Mock Data Fetching (Replace with your DB call)
async function getMembers() {
  // Simulate DB delay
  await new Promise((resolve) => setTimeout(resolve, 100));
  
  return [
    { id: '1', name: 'Elara Vossen', handle: '@elara', role: 'Owner', status: 'active', lastActive: 'Just now' },
    { id: '2', name: 'Jaxon Kade', handle: '@jaxdev', role: 'Admin', status: 'active', lastActive: '2h ago' },
    { id: '3', name: 'Sarah Chen', handle: '@schen_ui', role: 'Editor', status: 'pending', lastActive: '-' },
    { id: '4', name: 'Mike Ross', handle: '@mross', role: 'Viewer', status: 'inactive', lastActive: '3d ago' },
    { id: '5', name: 'Davina Claire', handle: '@davina', role: 'Admin', status: 'active', lastActive: '5h ago' },
  ];
}

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const members = await getMembers();
  const { orgId } = await params;

  return (
    <div className="w-full max-w-[1600px] mx-auto space-y-8 animate-in fade-in duration-500">
      
      {/* --- SECTION 1: INVITES (Static Placement) --- */}
      <section className="w-full">
        <div className="p-1">
            {/* <InvitesComponent /> */}
            <div className="w-full h-40 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20 flex flex-col items-center justify-center text-zinc-500 gap-2">
                <InviteMemberModal orgSlug={orgId} />
            </div>
        </div>
      </section>

      {/* --- SECTION 2: MEMBERS HEADER (Static) --- */}
      <section className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-1">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Team Members</h2>
            <p className="text-sm text-zinc-400 mt-1">Manage access, roles, and status.</p>
          </div>
          
          {/* Action button can be static or client depending on modal needs */}
          <button className="h-9 px-4 flex items-center gap-2 bg-zinc-100 text-zinc-900 hover:bg-zinc-200 rounded-lg text-sm font-medium transition-colors">
              <UserPlus className="w-4 h-4" />
              <span>Add Member</span>
          </button>
        </div>

        {/* --- SECTION 3: MEMBERS TABLE (Client Island) --- */}
        {/* We pass the data down so the page allows SEO/Server rendering, 
            but the table can still filter/sort on the client. */}
        <MembersTable initialMembers={members} />
      </section>
    </div>
  );
}