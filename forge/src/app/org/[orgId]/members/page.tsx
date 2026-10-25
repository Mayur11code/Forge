import React from 'react';
import { notFound } from 'next/navigation';
import { db } from '@/lib/prisma/db';
import { getOrgAccess } from '@/features/organizations/getOrgAccess';
import { MembersTable } from '@/features/organizations/components/invitation/members-table';
import InviteMemberModal from '@/features/organizations/components/invitation/InviteMemberModal';

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  // 1. Authenticate and Authorize against verified organization membership
  const access = await getOrgAccess(orgId);
  if (!access) {
    notFound();
  }

  // 2. Fetch actual memberships strictly scoped to the authorized organization
  const memberships = await db.membership.findMany({
    where: {
      orgId: access.organization.id,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
    },
    orderBy: [
      { role: "asc" },
      { createdAt: "asc" },
    ],
  });

  // 3. Transform to Member shape for client table
  const members = memberships.map((m) => {
    const userName = m.user?.name?.trim() || m.user?.email?.split('@')[0] || "Unknown User";
    const userHandle = m.user?.email ? `@${m.user.email.split('@')[0]}` : "@unknown";
    const roleFormatted = m.role.charAt(0).toUpperCase() + m.role.slice(1).toLowerCase();

    return {
      id: m.id,
      name: userName,
      handle: userHandle,
      role: roleFormatted,
      status: "active",
      lastActive: "Active",
    };
  });

  // Role-based visibility: only ADMINs can issue invitations
  const canInvite = access.membership.role === "ADMIN";

  return (
    <div className="w-full max-w-[1600px] mx-auto space-y-8 animate-in fade-in duration-500">
      {/* --- SECTION 1: INVITES (Admin Only) --- */}
      {canInvite && (
        <section className="w-full">
          <div className="p-1">
            <div className="w-full h-40 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20 flex flex-col items-center justify-center text-zinc-500 gap-2">
              <InviteMemberModal orgSlug={orgId} />
            </div>
          </div>
        </section>
      )}

      {/* --- SECTION 2: MEMBERS HEADER --- */}
      <section className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-1">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Team Members</h2>
            <p className="text-sm text-zinc-400 mt-1">
              Manage access, roles, and status for {access.organization.name}.
            </p>
          </div>
        </div>

        {/* --- SECTION 3: MEMBERS TABLE --- */}
        <MembersTable initialMembers={members} />
      </section>
    </div>
  );
}
