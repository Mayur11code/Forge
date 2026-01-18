'use client';
import { mockTasks } from "@/features/tasks/mockData";
import TaskCard from "@/features/organizations/components/TaskCard";
import React from "react";
import SearchBox from "@/features/organizations/components/SearchBox";

export default function TasksPage({ param

}: { param: { orgId: string } }) { 
  
    const [filter , setFilter] = React.useState<string>("ALL");
    return (
        <div className="space-y-4">
          <div className="border rounded shadow-sm bg-black p-4">
             <div className="mb-4">
                <label htmlFor="filter" className="block mb-2 text-sm font-medium text-gray-300">Filter Tasks:</label>
                <button onClick={() => setFilter("ALL")} className="mr-2 bg-gray-700 text-white px-3 py-1 rounded">All</button>
                <button onClick={() => setFilter("pending")} className="mr-2 bg-gray-700 text-white px-3 py-1 rounded">Pending</button>
                <button onClick={() => setFilter("completed")} className="bg-gray-700 text-white px-3 py-1 rounded">Completed</button>
            <button onClick={() => setFilter("in-progress")} className="ml-2 bg-gray-700 text-white px-3 py-1 rounded">In-Progress</button>
            </div>

                <SearchBox filter={filter} />
                        
            </div>
        </div>
    );
}