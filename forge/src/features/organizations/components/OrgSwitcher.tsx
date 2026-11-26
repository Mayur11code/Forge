"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Check,
  Plus,
  Building2,
  Layers,
  Shield,
  ExternalLink,
} from "lucide-react";

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  logo?: string | null;
}

interface OrgSwitcherProps {
  currentOrg: OrgSummary;
  organizations: OrgSummary[];
}

export function OrgSwitcher({ currentOrg, organizations }: OrgSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleSelectOrg = (slug: string) => {
    setIsOpen(false);
    if (slug !== currentOrg.slug) {
      router.push(`/org/${slug}/dashboard`);
    }
  };

  return (
    <div className={`relative ${isOpen ? "z-50" : "z-10"}`} ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/60 transition-all text-left group focus:outline-none focus:ring-2 focus:ring-blue-500/50"
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="Switch organization"
      >
        <div className="w-6 h-6 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 flex items-center justify-center text-xs font-bold uppercase shrink-0">
          {currentOrg.name.charAt(0) || "O"}
        </div>

        <div className="flex flex-col min-w-0 pr-1">
          <span className="text-xs font-semibold text-zinc-100 truncate max-w-[140px] md:max-w-[180px]">
            {currentOrg.name}
          </span>
          <span className="text-[10px] text-zinc-400 font-mono truncate">
            {currentOrg.slug}
          </span>
        </div>

        <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60 hidden sm:inline-block">
          {currentOrg.role}
        </span>

        <ChevronDown
          className={`w-3.5 h-3.5 text-zinc-400 transition-transform duration-200 shrink-0 ${
            isOpen ? "rotate-180 text-zinc-200" : ""
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute left-0 mt-2 w-72 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl p-2 z-[100] animate-in fade-in zoom-in-95 duration-150 text-zinc-100">
          {/* Header */}
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 border-b border-zinc-800/80 mb-1 flex items-center justify-between">
            <span>Workspaces ({organizations.length})</span>
            <Link
              href="/select-org"
              onClick={() => setIsOpen(false)}
              className="text-blue-400 hover:text-blue-300 font-normal normal-case flex items-center gap-1"
            >
              All orgs <ExternalLink className="w-3 h-3" />
            </Link>
          </div>

          {/* Org List */}
          <div className="max-h-64 overflow-y-auto space-y-1 custom-scrollbar py-1">
            {organizations.map((org) => {
              const isSelected = org.slug === currentOrg.slug;
              return (
                <button
                  key={org.id}
                  onClick={() => handleSelectOrg(org.slug)}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-left text-xs transition-colors ${
                    isSelected
                      ? "bg-blue-600/15 text-blue-300 font-semibold border border-blue-500/20"
                      : "hover:bg-zinc-800/70 text-zinc-300 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs uppercase shrink-0 ${
                        isSelected
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700/60"
                      }`}
                    >
                      {org.name.charAt(0) || "O"}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium">{org.name}</span>
                      <span className="text-[10px] text-zinc-500 font-mono truncate">
                        {org.slug}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[9px] uppercase font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                      {org.role}
                    </span>
                    {isSelected && <Check className="w-4 h-4 text-blue-400" />}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Action Footer */}
          <div className="pt-2 mt-1 border-t border-zinc-800/80 space-y-1">
            <Link
              href="/onboarding"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs text-zinc-300 hover:text-white hover:bg-zinc-800/70 transition-colors font-medium"
            >
              <Plus className="w-4 h-4 text-blue-400" />
              <span>Create new organization</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
