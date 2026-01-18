"use client"; // Required for hooks and event handlers

import React from "react";
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDebouncedCallback } from 'use-debounce';

import { mockTasks } from "@/features/tasks/mockData";
import TaskCard from "@/features/organizations/components/TaskCard";

export default function Search({ filter }: { filter: string }) {
  const pathname = usePathname();
  const { replace } = useRouter();
  const searchParams = useSearchParams();
  
  // Get the current query from URL safely
  const query = searchParams.get('query') || '';

  const handleSearch = useDebouncedCallback((searchTerm: string) => {
    const params = new URLSearchParams(searchParams);
    if (searchTerm) {
      params.set('query', searchTerm);
    } else {
      params.delete('query');
    }
    // Updates the URL without refreshing the page
    replace(`${pathname}?${params.toString()}`);
  }, 300);

  // Filter tasks logic moved out of JSX for readability
  const filteredTasks = mockTasks.filter((task) => {
    const matchesStatus = filter === "ALL" || task.status === filter;
    const matchesSearch = 
      task.title.toLowerCase().includes(query.toLowerCase()) || 
      task.description?.toLowerCase().includes(query.toLowerCase());
    
    return matchesStatus && matchesSearch;
  });

  return (
    <div className="space-y-6">
      <div className="border rounded shadow-sm bg-black p-4">
        <label htmlFor="search" className="block mb-2 text-sm font-medium text-gray-300">
          Search Tasks:
        </label>
        <input
          id="search"
          placeholder="Search by title or description..."
          className="w-full border rounded shadow-sm bg-gray-800 p-2 text-white focus:ring-2 focus:ring-blue-500 outline-none"
          defaultValue={query}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {/* The grid container is OUTSIDE the map */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredTasks.length > 0 ? (
          filteredTasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))
        ) : (
          <p className="text-gray-400 col-span-full text-center py-10">
            No tasks found matching your criteria.
          </p>
        )}
      </div>
    </div>
  );
}