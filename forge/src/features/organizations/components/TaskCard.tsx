"use client";

import { Task } from "@/core/domain";
import React from "react";
import { Calendar, Clock, CheckCircle2, AlertCircle, ArrowUpRight } from "lucide-react";
import { clsx } from "clsx";

export default function TaskCard({ task }: { task : Task }) {
  // Helper to determine status styles and icons based on task state
  const getStatusStyles = (status: string) => {
    switch (status.toLowerCase()) {
      case "completed":
        return {
          bg: "bg-emerald-500/10",
          text: "text-emerald-500",
          border: "border-emerald-500/20",
          icon: CheckCircle2,
        };
      case "in-progress":
        return {
          bg: "bg-blue-500/10",
          text: "text-blue-500",
          border: "border-blue-500/20",
          icon: Clock,
        };
      default: // pending
        return {
          bg: "bg-amber-500/10",
          text: "text-amber-500",
          border: "border-amber-500/20",
          icon: AlertCircle,
        };
    }
  };

  const statusStyle = getStatusStyles(task.status);
  const StatusIcon = statusStyle.icon;

  return (
    <div className="group relative flex flex-col h-full bg-zinc-900/40 border border-zinc-800/50 rounded-2xl p-5 transition-all duration-300 hover:bg-zinc-800/40 hover:border-zinc-700/50 hover:-translate-y-1 hover:shadow-2xl hover:shadow-blue-500/5">
      
      {/* Top Decoration: Subtle line */}
      <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-zinc-700/50 to-transparent" />

      {/* Header: Title and Quick Action */}
      <div className="flex justify-between items-start mb-3">
        <h3 className="text-zinc-100 font-semibold leading-tight group-hover:text-blue-400 transition-colors">
          {task.title}
        </h3>
        <button className="text-zinc-600 hover:text-zinc-400 transition-colors">
          <ArrowUpRight className="w-4 h-4" />
        </button>
      </div>

      {/* Description: Truncated for layout consistency */}
      <p className="text-zinc-400 text-sm leading-relaxed mb-6 line-clamp-2 flex-grow">
        {task.description || "No description provided for this task."}
      </p>

      {/* Footer: Status and Meta */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-zinc-800/50">
        
        {/* Dynamic Status Badge */}
        <div className={clsx(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider border",
          statusStyle.bg,
          statusStyle.text,
          statusStyle.border
        )}>
          <StatusIcon className="w-3 h-3" />
          {task.status}
        </div>

        {/* Due Date */}
        {task.dueDate && (
          <div className="flex items-center gap-1.5 text-zinc-500 text-xs font-medium">
            <Calendar className="w-3.5 h-3.5" />
            <span>{new Date(task.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          </div>
        )}
      </div>
    </div>
  );
}