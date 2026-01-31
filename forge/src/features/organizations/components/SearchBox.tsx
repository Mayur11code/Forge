"use client";

import React from "react";
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDebouncedCallback } from 'use-debounce';
import { Search as SearchIcon, XCircle } from "lucide-react"; // Matching our icon style

import { mockTasks } from "@/features/tasks/mockData";
import TaskCard from "@/features/organizations/components/TaskCard";

export default function Search({ filter }: { filter: string }) {
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

  const filteredTasks = mockTasks.filter((task) => {
    const matchesStatus = filter === "ALL" || task.status === filter;
    const matchesSearch = 
      task.title.toLowerCase().includes(query.toLowerCase()) || 
      task.description?.toLowerCase().includes(query.toLowerCase());
    
    return matchesStatus && matchesSearch;
  });

  return (
    <div className="space-y-8">
      {/* Search Input Container */}
      <div className="relative group">
        {/* Decorative background glow on focus */}
        <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl blur opacity-25 group-focus-within:opacity-50 transition duration-1000 group-focus-within:duration-200" />
        
        <div className="relative flex items-center">
          {/* Search Icon */}
          <div className="absolute left-4 text-zinc-500 group-focus-within:text-blue-500 transition-colors">
            <SearchIcon className="w-5 h-5" />
          </div>

          <input
            id="search"
            type="text"
            placeholder="Search tasks, descriptions, or tags..."
            className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 pl-12 pr-4 py-4 rounded-xl outline-none focus:ring-1 focus:ring-zinc-700 transition-all placeholder:text-zinc-600 text-sm shadow-2xl"
            defaultValue={query}
            onChange={(e) => handleSearch(e.target.value)}
          />

          {/* Optional: Clear indicator if text exists */}
          {query && (
            <div className="absolute right-4 text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors">
               <span className="text-[10px] font-mono bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700 uppercase">Esc</span>
            </div>
          )}
        </div>
      </div>

      {/* Task Grid Header */}
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-500">
          Showing {filteredTasks.length} Results
        </h3>
        <div className="h-px flex-1 bg-zinc-800/50 mx-4" />
      </div>

      {/* Results Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredTasks.length > 0 ? (
          filteredTasks.map((task) => (
            // Added an animation wrapper for each card
            <div key={task.id} className="animate-in fade-in zoom-in-95 duration-300">
                <TaskCard task={task} />
            </div>
          ))
        ) : (
          <div className="col-span-full flex flex-col items-center justify-center py-20 bg-zinc-900/20 border border-dashed border-zinc-800 rounded-3xl">
            <XCircle className="w-10 h-10 text-zinc-700 mb-3" />
            <p className="text-zinc-500 font-medium">No tasks found</p>
            <p className="text-zinc-600 text-sm">Try adjusting your filters or search term.</p>
          </div>
        )}
      </div>
    </div>
  );
}