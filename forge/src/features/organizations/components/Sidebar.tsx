"use client"; // Required for usePathname and interaction

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from 'clsx';
// Note: I'm adding logical spacing for icons if you choose to add them later
import { LayoutDashboard, CheckSquare, Settings, Command } from "lucide-react"; 

export function Sidebar({ orgId }: { orgId: string }) {
  const pathname = usePathname();

  const links = [ 
    { label: "Dashboard", href: `/org/${orgId}/dashboard`, icon: LayoutDashboard },
    { label: "Tasks", href: `/org/${orgId}/Tasks`, icon: CheckSquare },
    { label: "Settings", href: `/org/${orgId}/settings`, icon: Settings },
  ];

  return (
    <aside className="w-64 flex flex-col h-full bg-zinc-900/50 border-r border-zinc-800/50">
      {/* Brand Section */}
      <div className="p-6 mb-2 flex items-center gap-3">
        <div className="h-8 w-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
          <Command className="text-white w-5 h-5" />
        </div>
        <span className="font-bold tracking-tight text-zinc-100 text-lg">FORGE</span>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-3 space-y-1">
        <p className="px-3 text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-4">
          Main Menu
        </p>
        
        {links.map((link) => {
          const isActive = pathname === link.href;
          const Icon = link.icon;

          return (
            <Link
              key={link.href}
              href={link.href}
              className={clsx(
                "group flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 ease-in-out font-medium text-sm",
                isActive 
                  ? "bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-700/50" 
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50"
              )}
            >
              {/* Icon with dynamic coloring based on active state */}
              <Icon className={clsx(
                "w-5 h-5 transition-colors",
                isActive ? "text-blue-500" : "text-zinc-500 group-hover:text-zinc-300"
              )} />
              
              {link.label}

              {/* Active Indicator Dot */}
              {isActive && (
                <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Sidebar Footer / User section placeholder */}
      <div className="p-4 mt-auto border-t border-zinc-800/50">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg bg-zinc-800/30">
          <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-zinc-700 to-zinc-600 border border-zinc-600" />
          <div className="flex flex-col overflow-hidden">
            <span className="text-xs font-medium text-zinc-200 truncate">John Doe</span>
            <span className="text-[10px] text-zinc-500 truncate">Admin Plan</span>
          </div>
        </div>
      </div>
    </aside>
  );
}