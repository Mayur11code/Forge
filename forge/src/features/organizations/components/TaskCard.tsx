"use client";

import { Task, TaskStatus } from "@prisma/client";
import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Calendar,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  Ban,
  Loader2,
} from "lucide-react";
import { clsx } from "clsx";
import { TaskAttachmentsModalClient } from "@/features/attachments/TaskAttachmentModalClient";
import { updateTaskInOrgAction } from "@/app/actions/Tasks/updateTaskInOrg";

interface TaskCardProps {
  task: Task;
  orgSlug?: string;
  onStatusChange?: (taskId: string, newStatus: TaskStatus) => void;
}

const STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; bg: string; text: string; border: string; icon: React.ElementType }
> = {
  TODO: {
    label: "Pending",
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    border: "border-amber-500/20",
    icon: AlertCircle,
  },
  IN_PROGRESS: {
    label: "In Progress",
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/20",
    icon: Clock,
  },
  BLOCKED: {
    label: "Blocked",
    bg: "bg-rose-500/10",
    text: "text-rose-400",
    border: "border-rose-500/20",
    icon: Ban,
  },
  DONE: {
    label: "Completed",
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/20",
    icon: CheckCircle2,
  },
};

export default function TaskCard({ task, orgSlug, onStatusChange }: TaskCardProps) {
  const params = useParams();
  const resolvedOrgSlug =
    orgSlug || (typeof params?.orgId === "string" ? params.orgId : "");
  const taskHref = resolvedOrgSlug
    ? `/org/${resolvedOrgSlug}/projects/${task.projectId}/tasks/${task.id}`
    : `/projects/${task.projectId}/tasks/${task.id}`;

  const [currentStatus, setCurrentStatus] = useState<TaskStatus>(task.status);
  const [isPending, startTransition] = useTransition();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const statusConfig = STATUS_CONFIG[currentStatus] || STATUS_CONFIG.TODO;
  const StatusIcon = statusConfig.icon;

  const handleStatusTransition = async (newStatus: TaskStatus) => {
    if (newStatus === currentStatus || isPending) return;

    const previousStatus = currentStatus;
    // Optimistic UI update
    setCurrentStatus(newStatus);
    setIsMenuOpen(false);
    setErrorMessage(null);

    startTransition(async () => {
      const result = await updateTaskInOrgAction({
        taskId: task.id,
        status: newStatus,
      });

      if (!result.success) {
        // Rollback on failure
        setCurrentStatus(previousStatus);
        setErrorMessage(result.error || "Failed to update task status.");
      } else {
        if (onStatusChange) {
          onStatusChange(task.id, newStatus);
        }
      }
    });
  };

  return (
    <div className="group relative flex flex-col h-full bg-zinc-950/60 border border-zinc-800/60 rounded-xl p-5 transition-all duration-300 ease-out hover:bg-zinc-900/60 hover:border-zinc-700/60 hover:-translate-y-0.5 hover:shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)]">
      {/* Top Decoration Line */}
      <div className="absolute top-0 left-6 right-6 h-px bg-gradient-to-r from-transparent via-zinc-700/40 to-transparent" />

      {/* Header: Title and Quick Action */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <Link
          href={taskHref}
          className="text-zinc-100 font-semibold leading-snug hover:text-blue-400 transition-colors flex-1"
        >
          {task.title}
        </Link>
        <Link
          href={taskHref}
          className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0 p-0.5"
          title="Open Task"
        >
          <ArrowUpRight className="w-4 h-4" />
        </Link>
      </div>

      {/* Description: Truncated */}
      <p className="text-zinc-400 text-xs leading-relaxed mb-5 line-clamp-2 flex-grow">
        {task.description || "No description provided."}
      </p>

      {/* Error message toast if rollback occurs */}
      {errorMessage && (
        <div className="mb-3 p-2 rounded-lg bg-red-950/60 border border-red-800/60 text-[11px] text-red-300">
          {errorMessage}
        </div>
      )}

      {/* Footer: Interactive Status Dropdown & Metadata */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3.5 border-t border-zinc-800/60 mt-auto">
        {/* Interactive Status Transition Control */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            disabled={isPending}
            className={clsx(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.14em] border transition-all cursor-pointer hover:brightness-110",
              statusConfig.bg,
              statusConfig.text,
              statusConfig.border,
              isPending && "opacity-70 cursor-wait"
            )}
            title="Click to transition task status"
          >
            {isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <StatusIcon className="w-3 h-3" />
            )}
            <span>{statusConfig.label}</span>
            <ChevronDown className="w-2.5 h-2.5 ml-0.5 opacity-60" />
          </button>

          {/* Status Selection Menu */}
          {isMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setIsMenuOpen(false)}
              />
              <div className="absolute left-0 bottom-full mb-1.5 z-40 w-36 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 shadow-xl shadow-black/80">
                {(Object.keys(STATUS_CONFIG) as TaskStatus[]).map((statusKey) => {
                  const cfg = STATUS_CONFIG[statusKey];
                  const Icon = cfg.icon;
                  const isCurrent = currentStatus === statusKey;

                  return (
                    <button
                      key={statusKey}
                      type="button"
                      onClick={() => handleStatusTransition(statusKey)}
                      className={clsx(
                        "w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors text-left",
                        isCurrent
                          ? "bg-zinc-800 text-white"
                          : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                      )}
                    >
                      <Icon className={clsx("w-3.5 h-3.5", cfg.text)} />
                      <span>{cfg.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Assignee, Date, Attachments */}
        <div className="flex items-center gap-2 text-xs text-zinc-500 shrink-0">
          <div className="hidden sm:flex items-center gap-1" title="Created date">
            <Calendar className="w-3 h-3" />
            <span>{new Date(task.createdAt).toLocaleDateString()}</span>
          </div>

          <span className="hidden sm:inline text-zinc-700">•</span>

          <p
            title={task.assigneeId ?? "Unassigned"}
            className="text-zinc-400 truncate max-w-[80px]"
          >
            {task.assigneeId || "Unassigned"}
          </p>

          <span className="text-zinc-700">•</span>

          <TaskAttachmentsModalClient taskId={task.id} taskTitle={task.title} compact />
        </div>
      </div>
    </div>
  );
}
