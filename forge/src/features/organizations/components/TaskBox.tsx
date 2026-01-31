'use client';

import React from "react";
import SearchBox from "@/features/organizations/components/SearchBox";
import { ListFilter, CheckCircle2, Clock, PlayCircle, Layers } from "lucide-react"; // Matching our icon style
import { clsx } from "clsx";

export default function TasksPage({ param }: { param: { orgId: string } }) { 
    // Logic remains exactly as requested
    const [filter, setFilter] = React.useState<string>("ALL");

    // Helper for beautiful button styles
    const filterOptions = [
        { id: "ALL", label: "All Tasks", icon: Layers },
        { id: "pending", label: "Pending", icon: Clock },
        { id: "in-progress", label: "In-Progress", icon: PlayCircle },
        { id: "completed", label: "Completed", icon: CheckCircle2 },
    ];

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            {/* Header Section */}
            <div className="flex flex-col gap-6">
                <div>
                    <h2 className="text-2xl font-bold text-white tracking-tight">Tasks Management  : {param.orgId}</h2>
                    <p className="text-zinc-400 text-sm mt-1">Manage and track your organization's progress.</p>
                </div>

                {/* Filter & Search Container */}
                <div className="p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 backdrop-blur-md shadow-xl">
                    <div className="space-y-6">
                        {/* Filter Segmented Control */}
                        <div>
                            <label className="flex items-center gap-2 mb-4 text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-500">
                                <ListFilter className="w-3 h-3" />
                                Quick Filter
                            </label>
                            
                            <div className="flex flex-wrap items-center gap-2 p-1.5 bg-zinc-950/50 rounded-xl border border-zinc-800/50 w-fit">
                                {filterOptions.map((opt) => {
                                    const Icon = opt.icon;
                                    const isActive = filter === opt.id;
                                    
                                    return (
                                        <button
                                            key={opt.id}
                                            onClick={() => setFilter(opt.id)}
                                            className={clsx(
                                                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                                                isActive 
                                                    ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20" 
                                                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                                            )}
                                        >
                                            <Icon className={clsx("w-4 h-4", isActive ? "text-white" : "text-zinc-500")} />
                                            {opt.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Search Component Divider */}
                        <div className="h-px bg-zinc-800/50 w-full" />

                        {/* SearchBox - Pass the filter logic down as before */}
                        <SearchBox filter={filter} />
                    </div>
                </div>
            </div>
        </div>
    );
}