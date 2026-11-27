"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import mainlogo from "@/lib/icons/mainlogo.png";
import { clsx } from "clsx";
import { signOut, useSession } from "next-auth/react";
import {
  LayoutDashboard,
  CheckSquare,
  Settings,
  Users,
  Workflow,
  Sparkles,
  ShieldCheck,
  Briefcase,
  User,
  LogOut,
  Building2,
  ChevronRight,
  Menu,
  X,
} from "lucide-react";
import { OrgSwitcher, type OrgSummary } from "./OrgSwitcher";

interface SidebarProps {
  orgId: string;
  currentOrg?: OrgSummary;
  orgSummaries?: OrgSummary[];
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  group: "work" | "intelligence" | "admin";
}

export function Sidebar({ orgId, currentOrg, orgSummaries = [] }: SidebarProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [isOrgFlyoutOpen, setIsOrgFlyoutOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const flyoutRef = useRef<HTMLDivElement>(null);

  // Close org flyout on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (flyoutRef.current && !flyoutRef.current.contains(event.target as Node)) {
        setIsOrgFlyoutOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close mobile drawer on route change
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setIsMobileMenuOpen(false);
  }

  const navItems: NavItem[] = [
    // Core Workspace
    { label: "Dashboard", href: `/org/${orgId}/dashboard`, icon: LayoutDashboard, group: "work" },
    { label: "Projects", href: `/org/${orgId}/projects`, icon: Briefcase, group: "work" },
    { label: "Tasks", href: `/org/${orgId}/Tasks`, icon: CheckSquare, group: "work" },
    { label: "Workflow", href: `/org/${orgId}/workflows`, icon: Workflow, group: "work" },

    // Intelligence & Governance
    { label: "AI Assistant", href: `/org/${orgId}/ai`, icon: Sparkles, group: "intelligence" },
    { label: "Audit Logs", href: `/org/${orgId}/audit`, icon: ShieldCheck, group: "intelligence" },

    // Team & System
    { label: "Members", href: `/org/${orgId}/members`, icon: Users, group: "admin" },
    { label: "Settings", href: `/org/${orgId}/settings`, icon: Settings, group: "admin" },
  ];

  const workItems = navItems.filter((i) => i.group === "work");
  const intelligenceItems = navItems.filter((i) => i.group === "intelligence");
  const adminItems = navItems.filter((i) => i.group === "admin");

  const orgInitial = currentOrg?.name?.charAt(0)?.toUpperCase() || orgId.charAt(0).toUpperCase();

  return (
    <>
      {/* =========================================================================
          DESKTOP DETACHED NAVIGATION DOCK (68px wide)
          ========================================================================= */}
      <nav
        aria-label="Global Application Dock"
        data-testid="sidebar"
        data-org-id={orgId}
        className="hidden md:flex flex-col items-center w-[68px] h-full rounded-2xl border border-white/[0.08] bg-[#0c0c12]/95 backdrop-blur-2xl py-3 px-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.65)] select-none shrink-0 relative z-40"
      >
        {/* 1. Brand Logo */}
        <div className="group relative flex items-center justify-center mb-2">
          <Link
            href={`/org/${orgId}/dashboard`}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-b from-white/[0.08] to-white/[0.02] border border-white/[0.1] hover:border-white/30 transition-all shadow-inner group-hover:scale-105"
            aria-label="Forge Dashboard"
          >
            <img
              src={mainlogo.src}
              alt="Forge Logo"
              className="h-6 w-6 object-contain filter drop-shadow-[0_0_8px_rgba(255,255,255,0.2)]"
            />
          </Link>
          <div
            role="tooltip"
            className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-[#14141e] border border-white/10 text-[11px] font-mono text-zinc-100 shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all duration-150 z-50 whitespace-nowrap -translate-x-1 group-hover:translate-x-0"
          >
            Forge Workspace
          </div>
        </div>

        {/* 2. Organization Context Icon Button & Flyout */}
        <div className="relative group w-full flex flex-col items-center my-1" ref={flyoutRef}>
          <button
            type="button"
            onClick={() => setIsOrgFlyoutOpen((v) => !v)}
            aria-label={`Current Organization: ${currentOrg?.name || orgId}`}
            aria-expanded={isOrgFlyoutOpen}
            className={clsx(
              "flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 border text-xs font-mono font-bold uppercase",
              isOrgFlyoutOpen
                ? "border-white/30 bg-white/[0.1] text-white shadow-[0_0_12px_rgba(255,255,255,0.15)]"
                : "border-white/[0.1] bg-white/[0.03] text-zinc-300 hover:text-white hover:border-white/25 hover:bg-white/[0.07]",
            )}
          >
            {orgInitial}
          </button>

          {/* Org Tooltip */}
          {!isOrgFlyoutOpen && (
            <div
              role="tooltip"
              className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-[#14141e] border border-white/10 text-[11px] font-mono text-zinc-100 shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all duration-150 z-50 whitespace-nowrap -translate-x-1 group-hover:translate-x-0"
            >
              <div className="font-semibold text-white">{currentOrg?.name || orgId}</div>
              <div className="text-[9px] text-zinc-400 font-normal uppercase">
                {currentOrg?.role || "Member"} · Click to switch
              </div>
            </div>
          )}

          {/* Org Switcher Flyout Panel */}
          {isOrgFlyoutOpen && currentOrg && (
            <div className="absolute left-full ml-3 top-0 w-72 rounded-2xl bg-[#0e0e16]/98 border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.85)] p-3 z-50 backdrop-blur-2xl animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between border-b border-white/[0.08] pb-2 mb-2">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                  Switch Workspace
                </span>
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/[0.06] text-zinc-300 border border-white/[0.1]">
                  {currentOrg.role}
                </span>
              </div>
              <OrgSwitcher currentOrg={currentOrg} organizations={orgSummaries} />
            </div>
          )}
        </div>

        {/* Separator */}
        <div className="h-[1px] w-7 bg-white/[0.08] my-2" />

        {/* 3. Primary Work Navigation Group */}
        <div className="flex flex-col gap-1 w-full items-center">
          {workItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;

            return (
              <div key={item.href} className="group relative flex items-center justify-center w-full">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  className={clsx(
                    "relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200",
                    isActive
                      ? "bg-white/[0.1] text-white border border-white/[0.18] shadow-[0_0_12px_rgba(255,255,255,0.08)]"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]",
                  )}
                >
                  {/* Subtle Active Indicator Bar */}
                  {isActive && (
                    <span className="absolute -left-1 w-1 h-5 rounded-r bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                  )}
                  <Icon className={clsx("w-5 h-5 transition-colors", isActive ? "text-white" : "")} />
                </Link>

                {/* Tooltip */}
                <div
                  role="tooltip"
                  className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-[#14141e] border border-white/10 text-[11px] font-mono text-zinc-200 shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-150 z-50 whitespace-nowrap -translate-x-1 group-hover:translate-x-0"
                >
                  {item.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* Separator */}
        <div className="h-[1px] w-5 bg-white/[0.06] my-2" />

        {/* 4. Intelligence & Governance Group */}
        <div className="flex flex-col gap-1 w-full items-center">
          {intelligenceItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;

            return (
              <div key={item.href} className="group relative flex items-center justify-center w-full">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  className={clsx(
                    "relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200",
                    isActive
                      ? "bg-white/[0.1] text-white border border-white/[0.18] shadow-[0_0_12px_rgba(255,255,255,0.08)]"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]",
                  )}
                >
                  {isActive && (
                    <span className="absolute -left-1 w-1 h-5 rounded-r bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                  )}
                  <Icon className={clsx("w-5 h-5 transition-colors", isActive ? "text-white" : "")} />
                </Link>

                <div
                  role="tooltip"
                  className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-[#14141e] border border-white/10 text-[11px] font-mono text-zinc-200 shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-150 z-50 whitespace-nowrap -translate-x-1 group-hover:translate-x-0"
                >
                  {item.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* Separator */}
        <div className="h-[1px] w-5 bg-white/[0.06] my-2" />

        {/* 5. Team & Admin Group */}
        <div className="flex flex-col gap-1 w-full items-center">
          {adminItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;

            return (
              <div key={item.href} className="group relative flex items-center justify-center w-full">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  className={clsx(
                    "relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200",
                    isActive
                      ? "bg-white/[0.1] text-white border border-white/[0.18] shadow-[0_0_12px_rgba(255,255,255,0.08)]"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]",
                  )}
                >
                  {isActive && (
                    <span className="absolute -left-1 w-1 h-5 rounded-r bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                  )}
                  <Icon className={clsx("w-5 h-5 transition-colors", isActive ? "text-white" : "")} />
                </Link>

                <div
                  role="tooltip"
                  className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-[#14141e] border border-white/10 text-[11px] font-mono text-zinc-200 shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-150 z-50 whitespace-nowrap -translate-x-1 group-hover:translate-x-0"
                >
                  {item.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* Spacer to push Profile & Sign Out to the bottom */}
        <div className="flex-1 min-h-2" />

        {/* Separator */}
        <div className="h-[1px] w-7 bg-white/[0.08] my-2" />

        {/* 6. Profile & Sign Out Footer */}
        <div className="flex flex-col gap-1 w-full items-center">
          {/* User Profile */}
          <div className="group relative flex items-center justify-center w-full">
            <Link
              href={`/org/${orgId}/user/profile`}
              aria-label="User Profile"
              className={clsx(
                "flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200",
                pathname.includes("/user/profile")
                  ? "bg-white/[0.12] text-white border border-white/20"
                  : "text-zinc-400 hover:text-white hover:bg-white/[0.05]",
              )}
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-800 border border-zinc-700 text-xs font-mono font-semibold text-zinc-300">
                <User size={14} />
              </div>
            </Link>

            <div
              role="tooltip"
              className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-[#14141e] border border-white/10 text-[11px] font-mono text-zinc-200 shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all duration-150 z-50 whitespace-nowrap -translate-x-1 group-hover:translate-x-0"
            >
              <span>{session?.user?.name || "Profile"}</span>
              <span className="text-[10px] text-zinc-400 block font-normal">
                {session?.user?.email || "Account Settings"}
              </span>
            </div>
          </div>

          {/* Sign Out */}
          <div className="group relative flex items-center justify-center w-full">
            <button
              type="button"
              onClick={() => signOut({ redirectTo: "/login" })}
              aria-label="Sign Out"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              <LogOut size={16} />
            </button>

            <div
              role="tooltip"
              className="absolute left-full ml-3 px-2.5 py-1 rounded-lg bg-[#14141e] border border-white/10 text-[11px] font-mono text-rose-300 shadow-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all duration-150 z-50 whitespace-nowrap -translate-x-1 group-hover:translate-x-0"
            >
              Sign Out
            </div>
          </div>
        </div>
      </nav>

      {/* =========================================================================
          MOBILE COMPACT NAVIGATION BAR (< md)
          ========================================================================= */}
      <div className="md:hidden fixed top-0 inset-x-0 h-14 bg-[#0a0a10]/95 backdrop-blur-xl border-b border-white/[0.08] px-4 flex items-center justify-between z-50">
        <Link href={`/org/${orgId}/dashboard`} className="flex items-center gap-2">
          <img src={mainlogo.src} alt="Forge" className="h-6 w-6 object-contain" />
          <span className="font-mono font-bold text-sm text-white">FORGE</span>
        </Link>

        <button
          type="button"
          onClick={() => setIsMobileMenuOpen((v) => !v)}
          className="p-2 rounded-lg border border-white/10 bg-white/[0.04] text-zinc-300 hover:text-white"
          aria-label="Toggle navigation menu"
        >
          {isMobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {/* Mobile Slide-Out Drawer */}
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 top-14 bg-black/90 backdrop-blur-2xl z-40 p-4 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-white/[0.08] border border-white/20 flex items-center justify-center font-mono font-bold text-xs text-white">
                {orgInitial}
              </div>
              <span className="font-mono text-sm font-semibold text-white truncate max-w-[200px]">
                {currentOrg?.name || orgId}
              </span>
            </div>
            <span className="text-[10px] font-mono text-zinc-400 uppercase">
              {currentOrg?.role || "Member"}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            {navItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    "flex items-center gap-3 px-3 py-2.5 rounded-xl font-mono text-xs transition-colors",
                    isActive
                      ? "bg-white/[0.1] text-white border border-white/15 font-semibold"
                      : "text-zinc-400 hover:text-white hover:bg-white/[0.04]",
                  )}
                >
                  <Icon className="w-4 h-4 text-zinc-300" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>

          <div className="mt-auto border-t border-white/10 pt-3 flex items-center justify-between">
            <Link
              href={`/org/${orgId}/user/profile`}
              className="flex items-center gap-2 text-xs font-mono text-zinc-400 hover:text-white"
            >
              <User size={14} />
              <span>{session?.user?.name || "Profile"}</span>
            </Link>

            <button
              type="button"
              onClick={() => signOut({ redirectTo: "/login" })}
              className="flex items-center gap-1.5 text-xs font-mono text-rose-400 hover:text-rose-300"
            >
              <LogOut size={14} />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
