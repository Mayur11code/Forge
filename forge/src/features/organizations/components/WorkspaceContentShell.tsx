"use client";

import React from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { User } from "lucide-react";
import { OrgSwitcher, type OrgSummary } from "./OrgSwitcher";

interface WorkspaceContentShellProps {
  orgId: string;
  currentOrg: OrgSummary;
  orgSummaries: OrgSummary[];
  children: React.ReactNode;
}

export function WorkspaceContentShell({
  orgId,
  currentOrg,
  orgSummaries,
  children,
}: WorkspaceContentShellProps) {
  let pathname = "";
  if (typeof usePathname === "function") {
    try {
      pathname = usePathname() || "";
    } catch {
      pathname = "";
    }
  }

  // Detect if the user is on the visual workflow canvas editor
  const isWorkflowCanvas =
    pathname.includes("/workflows/") &&
    (pathname.endsWith("/new") || pathname.split("/workflows/")[1]?.length > 0);

  if (isWorkflowCanvas) {
    return (
      <div className="flex-1 flex flex-col h-full w-full overflow-hidden relative">
        {children}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
      {/* Top Workspace Header for Standard Pages */}
      <header className="relative z-30 h-16 border-b border-white/[0.08] bg-[#09090e]/80 backdrop-blur-md flex items-center justify-between px-6 sm:px-8 shrink-0">
        <div className="flex items-center gap-3">
          <OrgSwitcher currentOrg={currentOrg} organizations={orgSummaries} />
        </div>

        {/* Right side: User Profile link */}
        <div className="flex items-center gap-3">
          <Link
            href={`/org/${orgId}/user/profile`}
            className="flex items-center gap-2 p-1 rounded-full hover:bg-white/[0.06] border border-white/[0.1] hover:border-white/20 transition-all text-zinc-400 hover:text-white"
            title="Profile & Settings"
          >
            <div className="h-7 w-7 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-semibold text-zinc-300">
              <User className="w-3.5 h-3.5" />
            </div>
          </Link>
        </div>
      </header>

      {/* Scrollable Standard Content Area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar relative z-0">
        <div className="max-w-7xl mx-auto p-6 md:p-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
          {children}
        </div>
      </div>
    </div>
  );
}
