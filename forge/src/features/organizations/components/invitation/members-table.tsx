'use client';

import React, { useState } from 'react';
import { Search, Filter, MoreHorizontal, ShieldCheck } from 'lucide-react';

type Member = {
  id: string;
  name: string;
  handle: string;
  role: string;
  status: string;
  lastActive: string;
};

export function MembersTable({ initialMembers }: { initialMembers: Member[] }) {
  const [query, setQuery] = useState('');

  // Client-side filtering
  const filteredMembers = initialMembers.filter((member) =>
    member.name.toLowerCase().includes(query.toLowerCase()) ||
    member.handle.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="space-y-4">
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
        <button className="h-9 w-9 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors">
            <Filter className="w-4 h-4" />
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/20 backdrop-blur-sm overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800/60 text-zinc-500 bg-zinc-900/40">
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">User</th>
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">Role</th>
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 font-medium font-mono text-xs uppercase tracking-wider">Last Active</th>
              <th className="px-6 py-3 text-right font-medium font-mono text-xs uppercase tracking-wider">Edit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/40">
            {filteredMembers.map((member) => (
              <tr key={member.id} className="group hover:bg-zinc-800/30 transition-colors">
                <td className="px-6 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-zinc-700 to-zinc-600 flex items-center justify-center text-xs font-bold text-zinc-100 ring-2 ring-zinc-900">
                      {member.name.charAt(0)}
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
                    <span>{member.role}</span>
                  </div>
                </td>
                <td className="px-6 py-3">
                  <StatusBadge status={member.status} />
                </td>
                <td className="px-6 py-3 text-zinc-500 font-mono text-xs">
                  {member.lastActive}
                </td>
                <td className="px-6 py-3 text-right">
                  <button className="text-zinc-500 hover:text-zinc-200 p-1 rounded hover:bg-zinc-800 transition-colors">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {/* Pagination Footer */}
        <div className="px-6 py-3 border-t border-zinc-800/60 bg-zinc-900/30 flex items-center justify-between">
          <p className="text-xs text-zinc-500">Showing {filteredMembers.length} members</p>
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
              <button className="hover:text-zinc-100 disabled:opacity-50" disabled>Prev</button>
              <span className="text-zinc-600">/</span>
              <button className="hover:text-zinc-100">Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles = {
    active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    inactive: "bg-zinc-800/50 text-zinc-400 border-zinc-700/50",
  };
  const dotColor = {
    active: "bg-emerald-400",
    pending: "bg-amber-400",
    inactive: "bg-zinc-500",
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border ${styles[status as keyof typeof styles] || styles.inactive}`}>
      <span className={`w-1 h-1 rounded-full ${dotColor[status as keyof typeof dotColor] || dotColor.inactive}`} />
      <span className="capitalize">{status}</span>
    </span>
  );
}