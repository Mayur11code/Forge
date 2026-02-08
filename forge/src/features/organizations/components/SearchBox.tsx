"use client";

import React from "react";
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDebouncedCallback } from 'use-debounce';
import { Search as SearchIcon, XCircle } from "lucide-react"; // Matching our icon style
import { Task } from "@prisma/client";
import { mockTasks } from "@/features/tasks/mockData";
import TaskCard from "@/features/organizations/components/TaskCard";

export default function Search({ filter, initialtasks }: { filter: string;     initialtasks: Task[]  }) {
  const pathname = usePathname();
  const { replace } = useRouter();
  const searchParams = useSearchParams();
  
  const query = searchParams.get('query') || '';

  const handleSearch = useDebouncedCallback((searchTerm: string) => {
    const params = new URLSearchParams(searchParams);
    if (searchTerm) {
      params.set('query', searchTerm);
    } else {
      params.delete('query');
    }
    replace(`${pathname}?${params.toString()}`);
  }, 300);

  const filteredTasks = initialtasks.filter((task) => {
    const matchesStatus = filter === "ALL" || task.status === filter;
    const matchesSearch = 
      task.title.toLowerCase().includes(query.toLowerCase()) || false; // Currently only searching by title, can expand to description/tags later
    
    return (matchesStatus && matchesSearch);
  });

  return (
    <div className="space-y-10">
      {/* Search Input Container */}
      <div className="relative group">
        {/* Decorative background glow on focus */}
        <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-zinc-700/30 via-zinc-500/20 to-zinc-700/30 blur-2xl opacity-0 group-focus-within:opacity-100 transition duration-700" />
        
        <div className="relative flex items-center">
          {/* Search Icon */}
          <div className="absolute left-4 text-zinc-600 group-focus-within:text-zinc-300 transition-colors">
            <SearchIcon className="w-5 h-5" />
          </div>

          <input
            id="search"
            type="text"
            placeholder="Search tasks, descriptions, or tags..."
            className="
              w-full
              bg-zinc-950/90
              border border-zinc-800/80
              text-zinc-200
              pl-12 pr-4 py-4
              rounded-2xl
              outline-none
              focus:border-zinc-600
              focus:ring-0
              transition-all
              placeholder:text-zinc-600
              text-sm
              shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]
            "
            defaultValue={query}
            onChange={(e) => handleSearch(e.target.value)}
          />

          {/* Optional: Clear indicator if text exists */}
          {query && (
            <div className="absolute right-4 text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors">
              <span className="text-[10px] font-mono bg-zinc-900/70 px-1.5 py-0.5 rounded border border-zinc-800 uppercase tracking-wider">
                Esc
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Task Grid Header */}
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.3em] text-zinc-500">
          Showing {filteredTasks.length} Results
        </h3>
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-zinc-800/60 to-transparent mx-4" />
      </div>

      {/* Results Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-7">
        {filteredTasks.length > 0 ? (
          filteredTasks.map((task) => (
            // Added an animation wrapper for each card
            <div
              key={task.id}
              className="animate-in fade-in zoom-in-95 duration-500 ease-out"
            >
              <TaskCard task={task} />
            </div>
          ))
        ) : (
          <div className="col-span-full flex flex-col items-center justify-center py-24 rounded-3xl border border-zinc-800/60 bg-zinc-950/40 backdrop-blur-sm">
            <XCircle className="w-10 h-10 text-zinc-700 mb-4" />
            <p className="text-zinc-400 font-medium tracking-wide">
              No tasks found
            </p>
            <p className="text-zinc-600 text-sm mt-1">
              Try adjusting your filters or search term.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
