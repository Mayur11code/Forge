"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDebouncedCallback } from "use-debounce";
import { Search as SearchIcon, XCircle } from "lucide-react";
import { Task } from "@prisma/client";
import TaskCard from "@/features/organizations/components/TaskCard";

export default function Search({
  initialtasks,
}: {
  initialtasks: Task[];
}) {
  const pathname = usePathname();
  const { replace } = useRouter();
  const searchParams = useSearchParams();

  const query = searchParams.get("query") || "";

  const handleSearch = useDebouncedCallback((searchTerm: string) => {
    const params = new URLSearchParams(searchParams);

    if (searchTerm) {
      params.set("query", searchTerm);
    } else {
      params.delete("query");
    }

    replace(`${pathname}?${params.toString()}`);
  }, 300);

  return (
    <div className="space-y-10">
      {/* Search Input */}
      <div className="relative">
        <SearchIcon className="absolute left-4 top-4 w-5 h-5 text-zinc-600" />

        <input
          type="text"
          defaultValue={query}
          placeholder="Search tasks..."
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-12 pr-4 py-4 w-full rounded-2xl bg-zinc-950 border border-zinc-800"
        />
      </div>

      {/* Results Count */}
      <h3>
        Showing {initialtasks.length} Results
      </h3>

      {/* Render Tasks */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-7">
        {initialtasks.length > 0 ? (
          initialtasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))
        ) : (
          <p>No tasks found</p>
        )}
      </div>
    </div>
  );
}
