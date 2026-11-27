'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Search,
  Filter,
  MoreHorizontal,
  ShieldCheck,
  Shield,
  Trash2,
  AlertTriangle,
  Loader2,
  Check,
  X,
} from 'lucide-react';
import { Role } from '@prisma/client';
import { updateMemberRole, removeMember } from '@/app/actions/user/memberActions';

export type MemberItem = {
  id: string;
  userId?: string;
  name: string;
  handle: string;
  role: Role | string;
  roleFormatted: string;
  status: string;
  lastActive: string;
};

const isRoleAdmin = (r?: Role | string) => {
  if (!r) return false;
  return r.toUpperCase() === 'ADMIN';
};

const toRoleEnum = (r?: Role | string): Role => {
  if (!r) return Role.MEMBER;
  const upper = r.toUpperCase();
  if (upper === 'ADMIN') return Role.ADMIN;
  if (upper === 'MANAGER') return Role.MANAGER;
  return Role.MEMBER;
};

interface MembersTableProps {
  initialMembers: MemberItem[];
  orgSlug: string;
  currentUserRole?: string;
  currentUserId?: string;
}

export function MembersTable({
  initialMembers,
  orgSlug,
  currentUserRole = 'MEMBER',
  currentUserId,
}: MembersTableProps) {
  const [members, setMembers] = useState<MemberItem[]>(initialMembers);
  const [query, setQuery] = useState('');
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [roleModalMember, setRoleModalMember] = useState<MemberItem | null>(null);
  const [removeModalMember, setRemoveModalMember] = useState<MemberItem | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>(Role.MEMBER);
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const isAdmin = currentUserRole === 'ADMIN';

  // Keep internal list in sync with props
  useEffect(() => {
    setMembers(initialMembers);
  }, [initialMembers]);

  // Close active menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenuId(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Client-side search filtering
  const filteredMembers = members.filter(
    (member) =>
      member.name.toLowerCase().includes(query.toLowerCase()) ||
      member.handle.toLowerCase().includes(query.toLowerCase()) ||
      member.role.toLowerCase().includes(query.toLowerCase())
  );

  const adminCount = members.filter((m) => isRoleAdmin(m.role)).length;

  const handleOpenRoleModal = (member: MemberItem) => {
    setActiveMenuId(null);
    setRoleModalMember(member);
    setSelectedRole(toRoleEnum(member.role));
    setFeedback(null);
  };

  const handleOpenRemoveModal = (member: MemberItem) => {
    setActiveMenuId(null);
    setRemoveModalMember(member);
    setFeedback(null);
  };

  const handleConfirmRoleChange = async () => {
    if (!roleModalMember) return;
    setIsLoading(true);
    setFeedback(null);

    try {
      const res = await updateMemberRole(orgSlug, roleModalMember.id, selectedRole);
      if (!res.success) {
        setFeedback({ type: 'error', message: res.error || 'Failed to update role.' });
        setIsLoading(false);
        return;
      }

      // Optimistically update local state
      setMembers((prev) =>
        prev.map((m) =>
          m.id === roleModalMember.id
            ? {
                ...m,
                role: selectedRole.charAt(0).toUpperCase() + selectedRole.slice(1).toLowerCase(),
                roleFormatted:
                  selectedRole.charAt(0).toUpperCase() +
                  selectedRole.slice(1).toLowerCase(),
              }
            : m
        )
      );

      setFeedback({ type: 'success', message: res.message || 'Role updated successfully.' });
      setRoleModalMember(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'An unexpected error occurred.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeModalMember) return;
    setIsLoading(true);
    setFeedback(null);

    try {
      const res = await removeMember(orgSlug, removeModalMember.id);
      if (!res.success) {
        setFeedback({ type: 'error', message: res.error || 'Failed to remove member.' });
        setIsLoading(false);
        return;
      }

      // Optimistically remove from local state
      setMembers((prev) => prev.filter((m) => m.id !== removeModalMember.id));
      setFeedback({ type: 'success', message: res.message || 'Member removed successfully.' });
      setRemoveModalMember(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'An unexpected error occurred.',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Feedback Banner */}
      {feedback && (
        <div
          role={feedback.type === 'error' ? 'alert' : 'status'}
          className={`flex items-center justify-between p-3.5 rounded-xl border text-sm animate-in fade-in ${
            feedback.type === 'error'
              ? 'bg-red-500/10 border-red-500/20 text-red-400'
              : 'bg-white/[0.08] border-white/20 text-zinc-100'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <Check className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </div>
          <button
            onClick={() => setFeedback(null)}
            className="text-zinc-500 hover:text-zinc-300 p-0.5"
            aria-label="Dismiss message"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative group flex-1 md:flex-none">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 group-focus-within:text-zinc-300 transition-colors" />
          <input
            type="text"
            placeholder="Search team..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 pl-9 pr-4 bg-zinc-900/50 border border-zinc-800 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700 w-full md:w-64 transition-all"
          />
        </div>
        <button
          className="h-9 w-9 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          aria-label="Filter members"
        >
          <Filter className="w-4 h-4" />
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/20 backdrop-blur-sm overflow-visible">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800/60 text-zinc-500 bg-zinc-900/40">
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">
                User
              </th>
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">
                Role
              </th>
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">
                Last Active
              </th>
              <th className="px-6 py-3 text-right font-medium font-mono text-xs uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/40">
            {filteredMembers.map((member) => {
              const isMenuOpen = activeMenuId === member.id;
              const isSoleAdmin = isRoleAdmin(member.role) && adminCount <= 1;

              return (
                <tr key={member.id} className="group hover:bg-zinc-800/30 transition-colors">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-zinc-700 to-zinc-600 flex items-center justify-center text-xs font-bold text-zinc-100 ring-2 ring-zinc-900 shrink-0">
                        {member.name.charAt(0) || 'U'}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-zinc-200 font-medium group-hover:text-white transition-colors">
                          {member.name}
                        </span>
                        <span className="text-xs text-zinc-500">{member.handle}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2 text-zinc-300">
                      <ShieldCheck className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="capitalize">{member.roleFormatted}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <StatusBadge status={member.status} />
                  </td>
                  <td className="px-6 py-3 text-zinc-500 font-mono text-xs">
                    {member.lastActive}
                  </td>
                  <td className="px-6 py-3 text-right relative">
                    {isAdmin ? (
                      <div className="inline-block text-left" ref={isMenuOpen ? menuRef : undefined}>
                        <button
                          onClick={() => setActiveMenuId(isMenuOpen ? null : member.id)}
                          className="text-zinc-500 hover:text-zinc-200 p-1.5 rounded-lg hover:bg-zinc-800 transition-colors focus:outline-none"
                          aria-label={`Manage ${member.name}`}
                          aria-expanded={isMenuOpen}
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>

                        {/* Action Dropdown Menu */}
                        {isMenuOpen && (
                          <div className="absolute right-6 top-10 w-48 rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl p-1 z-50 animate-in fade-in zoom-in-95 text-left text-xs">
                            <button
                              onClick={() => handleOpenRoleModal(member)}
                              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
                            >
                              <Shield className="w-3.5 h-3.5 text-blue-400" />
                              <span>Change Role</span>
                            </button>

                            <button
                              onClick={() => handleOpenRemoveModal(member)}
                              disabled={isSoleAdmin}
                              title={
                                isSoleAdmin
                                  ? 'Cannot remove the sole administrator of an organization'
                                  : undefined
                              }
                              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Remove Member</span>
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-zinc-600 text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Empty State */}
        {filteredMembers.length === 0 && (
          <div className="py-12 text-center text-zinc-500 text-sm">
            No team members found matching your search.
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-800/60 bg-zinc-900/30 flex items-center justify-between">
          <p className="text-xs text-zinc-500">
            Showing {filteredMembers.length} members ({adminCount} Admins)
          </p>
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
            <button className="hover:text-zinc-100 disabled:opacity-50" disabled>
              Prev
            </button>
            <span className="text-zinc-600">/</span>
            <button className="hover:text-zinc-100">Next</button>
          </div>
        </div>
      </div>

      {/* --- MODAL 1: CHANGE ROLE --- */}
      {roleModalMember && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-5 text-zinc-100">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">Change Member Role</h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Update role and organization permissions for {roleModalMember.name}
                </p>
              </div>
              <button
                onClick={() => setRoleModalMember(null)}
                className="text-zinc-500 hover:text-zinc-300 p-1"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              {[Role.ADMIN, Role.MANAGER, Role.MEMBER].map((r) => {
                const isSelected = selectedRole === r;
                const isDemotingLastAdmin =
                  isRoleAdmin(roleModalMember.role) && adminCount <= 1 && r !== Role.ADMIN;

                return (
                  <label
                    key={r}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-blue-600/15 border-blue-500/40 text-white'
                        : 'bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                    } ${isDemotingLastAdmin ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={isSelected}
                      disabled={isDemotingLastAdmin}
                      onChange={() => setSelectedRole(r)}
                      className="mt-1 accent-blue-600"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm capitalize">
                          {r.toLowerCase()}
                        </span>
                        {r === Role.ADMIN && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">
                            Full Control
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {r === Role.ADMIN
                          ? 'Can invite, modify roles, remove members, and manage workspace settings.'
                          : r === Role.MANAGER
                          ? 'Can create projects, manage tasks, and publish workflows.'
                          : 'Can view tasks, leave comments, and execute authorized workflows.'}
                      </p>
                      {isDemotingLastAdmin && (
                        <p className="text-[11px] text-amber-400 mt-1 flex items-center gap-1 font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Cannot demote the sole administrator of an organization.
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setRoleModalMember(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white transition-colors"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRoleChange}
                disabled={
                  isLoading ||
                  (isRoleAdmin(roleModalMember.role) &&
                    adminCount <= 1 &&
                    selectedRole !== Role.ADMIN)
                }
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
              >
                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>Save Role</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL 2: REMOVE MEMBER CONFIRMATION --- */}
      {removeModalMember && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-5 text-zinc-100">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-white">Remove Team Member</h3>
                <p className="text-xs text-zinc-400">
                  Are you sure you want to remove <strong className="text-white">{removeModalMember.name}</strong> from this organization?
                </p>
              </div>
            </div>

            <div className="p-3.5 bg-zinc-950/60 border border-zinc-800 rounded-xl text-xs text-zinc-400 space-y-1">
              <p className="font-semibold text-zinc-300">Access Revocation:</p>
              <p>
                This member will immediately lose access to all organization workflows, projects, tasks, and data.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setRemoveModalMember(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-white transition-colors"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRemove}
                disabled={isLoading}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-600/20 disabled:opacity-50 transition-all flex items-center gap-2"
              >
                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>Remove Member</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles = {
    active: 'bg-white/[0.08] text-zinc-100 border-white/20',
    pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    inactive: 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50',
  };
  const dotColor = {
    active: 'bg-white shadow-[0_0_8px_rgba(255,255,255,0.7)]',
    pending: 'bg-amber-400',
    inactive: 'bg-zinc-500',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border ${
        styles[status as keyof typeof styles] || styles.inactive
      }`}
    >
      <span
        className={`w-1 h-1 rounded-full ${
          dotColor[status as keyof typeof dotColor] || dotColor.inactive
        }`}
      />
      <span className="capitalize">{status}</span>
    </span>
  );
}
