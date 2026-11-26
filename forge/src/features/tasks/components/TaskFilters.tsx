"use client";

import React, { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDebouncedCallback } from "use-debounce";
import {
  Search,
  X,
  Layers,
  Clock,
  PlayCircle,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  User,
} from "lucide-react";
import { clsx } from "clsx";

export interface TaskFilterMember {
  id: string;
  name: string;
  email?: string;
}

interface TaskFiltersProps {
  totalCount: number;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  members?: TaskFilterMember[];
}

const STATUS_FILTERS = [
  { id: "ALL", label: "All Status", icon: Layers },
  { id: "TODO", label: "Pending", icon: Clock },
  { id: "IN_PROGRESS", label: "In Progress", icon: PlayCircle },
  { id: "BLOCKED", label: "Blocked", icon: Ban },
  { id: "DONE", label: "Completed", icon: CheckCircle2 },
];

const PRIORITY_FILTERS = [
  { id: "ALL", label: "All Priority" },
  { id: "LOW", label: "Low" },
  { id: "MEDIUM", label: "Medium" },
  { id: "HIGH", label: "High" },
];

export default function TaskFilters({
  totalCount,
  currentPage,
  totalPages,
  pageSize,
  members,
}: TaskFiltersProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentQuery = searchParams.get("query") || "";
  const currentStatus = searchParams.get("status") || searchParams.get("filter") || "ALL";
  const currentPriority = searchParams.get("priority") || "ALL";
  const currentAssignee = searchParams.get("assignee") || "ALL";

  const hasActiveFilters =
    Boolean(currentQuery) ||
    (currentStatus !== "ALL" && Boolean(currentStatus)) ||
    (currentPriority !== "ALL" && Boolean(currentPriority)) ||
    (currentAssignee !== "ALL" && Boolean(currentAssignee));

  // Update URL search parameters preserving unchanged params and resetting page to 1
  const updateQueryParam = useCallback(
    (key: string, value: string | null, resetPage = true) => {
      const params = new URLSearchParams(searchParams.toString());

      if (value && value !== "ALL") {
        params.set(key, value);
      } else {
        params.delete(key);
      }

      // Also clean up legacy "filter" param if setting "status"
      if (key === "status") {
        params.delete("filter");
      }

      if (resetPage) {
        params.delete("page");
      }

      startTransition(() => {
        const queryString = params.toString();
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, {
          scroll: false,
        });
      });
    },
    [pathname, router, searchParams]
  );

  // 300ms Debounce for text search
  const handleSearchChange = useDebouncedCallback((term: string) => {
    updateQueryParam("query", term.trim() || null, true);
  }, 300);

  const handleResetFilters = () => {
    startTransition(() => {
      router.replace(pathname, { scroll: false });
    });
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > totalPages || newPage === currentPage) return;
    const params = new URLSearchParams(searchParams.toString());
    if (newPage === 1) {
      params.delete("page");
    } else {
      params.set("page", String(newPage));
    }
    startTransition(() => {
      const queryString = params.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, {
        scroll: false,
      });
    });
  };

  const startRecord = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endRecord = Math.min(currentPage * pageSize, totalCount);

  return (
    <div className="space-y-4">
      {/* Search and Priority Bar */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            defaultValue={currentQuery}
            placeholder="Search tasks by title or description..."
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-zinc-950/80 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
          />
          {currentQuery && (
            <button
              type="button"
              onClick={() => updateQueryParam("query", null, true)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-300"
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Priority & Assignee Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Priority Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mr-1 shrink-0">
              Priority:
            </span>
            {PRIORITY_FILTERS.map((p) => {
              const isActive = currentPriority === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => updateQueryParam("priority", p.id, true)}
                  className={clsx(
                    "px-2.5 py-1 text-xs rounded-lg font-medium transition-colors shrink-0",
                    isActive
                      ? "bg-zinc-800 text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* Assignee Filter Dropdown */}
          {members && members.length > 0 && (
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mr-1 shrink-0 flex items-center gap-1">
                <User className="w-3 h-3" />
                Assignee:
              </span>
              <select
                aria-label="Filter tasks by assignee"
                value={currentAssignee}
                onChange={(e) => updateQueryParam("assignee", e.target.value, true)}
                className="px-2.5 py-1 text-xs rounded-lg font-medium bg-zinc-900 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-zinc-600 transition-colors cursor-pointer"
              >
                <option value="ALL">All Assignees</option>
                <option value="UNASSIGNED">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-zinc-900 transition-colors ml-1"
              title="Reset all filters"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* Status Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar border-b border-zinc-800/80 pb-3">
        {STATUS_FILTERS.map((s) => {
          const Icon = s.icon;
          const isActive = currentStatus === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => updateQueryParam("status", s.id, true)}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-medium transition-all shrink-0",
                isActive
                  ? "bg-white/10 text-white border border-zinc-700/60 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-transparent"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>

      {/* Pagination HUD & Count Header */}
      <div className="flex items-center justify-between text-xs text-zinc-400 pt-1">
        <p>
          Showing <span className="text-zinc-200 font-medium">{startRecord}–{endRecord}</span> of{" "}
          <span className="text-zinc-200 font-medium">{totalCount}</span> tasks
          {isPending && <span className="ml-2 text-zinc-500 animate-pulse">(updating...)</span>}
        </p>

        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">
              Page {currentPage} of {totalPages}
            </span>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1 || isPending}
                className="p-1 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Previous page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages || isPending}
                className="p-1 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Next page"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
