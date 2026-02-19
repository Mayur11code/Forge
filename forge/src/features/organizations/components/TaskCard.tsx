"use client";

import { Task } from "@prisma/client";
import React from "react";
import { Calendar, Clock, CheckCircle2, AlertCircle, ArrowUpRight } from "lucide-react";
import { clsx } from "clsx";
// import { TaskAttachmentsModal } from "@/features/attachments/TaskAttachmentModalClient";
// import { TaskAttachments } from "@/features/attachments/TaskAttachments";
import { TaskAttachmentsModalClient } from "@/features/attachments/TaskAttachmentModalClient";

export default function TaskCard({ task }: { task: Task }) {
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
    <div className="group relative flex flex-col h-full bg-zinc-950/60 border border-zinc-800/60 rounded-lg p-5 transition-all duration-500 ease-out hover:bg-zinc-900/60 hover:border-zinc-700/60 hover:-translate-y-0.5 hover:shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]
">

      {/* Top Decoration: Subtle line */}
      <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-zinc-700/40 to-transparent" />

      {/* Header: Title and Quick Action */}
      <div className="text-zinc-100 font-medium leading-snug tracking-tight transition-colors duration-300 group-hover:text-zinc-300">
        <h3 className="text-zinc-100 font-semibold leading-tight group-hover:text-blue-400 transition-colors">
          {task.title}
        </h3>
          <a href={`./projects/${task.projectId}/tasks/${task.id}`} className="text-zinc-600 hover:text-zinc-400 transition-colors duration-300
  ">
          <ArrowUpRight className="w-4 h-4" />
        </a>
      </div>

      {/* Description: Truncated for layout consistency */}
      <p className="text-zinc-400 text-sm leading-relaxed mb-6 line-clamp-2 flex-grow
">
        {task.description || "No description provided."}
      </p>

      {/* Footer: Status and Meta */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-zinc-800/60">

  {/* Dynamic Status Badge */}
  <div
    className={clsx(
      "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.18em] border",
      statusStyle.bg,
      statusStyle.text,
      statusStyle.border
    )}
  >
    <StatusIcon className="w-3 h-3" />
    {task.status}
  </div>

  {/* Assignee and created At */}
    <div className="flex items-center gap-4 text-xs text-zinc-500 min-w-0">
  <div className="flex items-center gap-1">
    <Calendar className="w-3 h-3" />
    {new Date(task.createdAt).toLocaleDateString()}
  </div>

  <span className="text-zinc-700">•</span>

  <p
  title={task.assigneeId?? "Unassigned"}
  className="text-zinc-400 truncate max-w-[120px]"
>
  {task.assigneeId || "Unassigned"}
</p>


  <span className="text-zinc-700">•</span>

  <TaskAttachmentsModalClient taskId={task.id} />

</div>

</div>

    </div>
  );
}