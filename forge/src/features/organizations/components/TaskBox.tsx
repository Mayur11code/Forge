'use client';

import React, { startTransition, useOptimistic, useState } from "react";
import SearchBox from "@/features/organizations/components/SearchBox";
import { ListFilter, CheckCircle2, Clock, PlayCircle, Layers } from "lucide-react";
import { clsx } from "clsx";
import { Task } from "@prisma/client";
import CreateTaskForm from "./CreateTaskForm";
import { createTask } from "@/app/actions/createTask";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type ProjectModeProps = {
  mode: "project";
  param: { orgId: string };
  projectId: string;
  initialtasks: Task[];
};

type OrgModeProps = {
  mode: "org";
  param: { orgId: string };
  initialtasks: Task[];
};

type TaskBoxProps = ProjectModeProps | OrgModeProps;

export default function TaskBox(props: TaskBoxProps) {
  const isProjectMode = props.mode === "project";
  
  // 1. Move hooks to the top level
  const pathname = usePathname();
  const { replace } = useRouter();
  const searchParams = useSearchParams();

  // Get initial filter from URL or default to ALL
  const currentFilter = searchParams.get("filter") || "ALL";

  const [optimisticTasks, updateOptimisticTasks] = useOptimistic(
    props.initialtasks,
    (state: Task[], action: { type: "add" | "replace"; task: Task; tempId?: string }) => {
      if (action.type === "add") return [...state, action.task];
      if (action.type === "replace") {
        return state.map((t) => (t.id === action.tempId ? action.task : t));
      }
      return state;
    }
  );

  // 2. Corrected filter handler
  function handleFilterChange(filterId: string) {
    const newParams = new URLSearchParams(searchParams.toString());
    if (filterId !== "ALL") {
      newParams.set("filter", filterId);
    } else {
      newParams.delete("filter");
    }
    replace(`${pathname}?${newParams.toString()}`);
  }

  async function handleAddTask(title: string) {
    if (!isProjectMode) return;

    const tempId = Math.random().toString();
    const tempTask: Task = {
      id: tempId,
      title,
      status: "TODO",
      priority: "MEDIUM",
      projectId: props.projectId, // Safe because of isProjectMode check
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: "No description provided.",
    };

    startTransition(async () => {
      updateOptimisticTasks({ type: "add", task: tempTask });
      try {
        const result = await createTask({ title, projectId: props.projectId });
        // Usually, you replace the temp object with the real one from the DB
        updateOptimisticTasks({
          type: "replace",
          task: result, 
          tempId,
        });
      } catch (e) {
        console.error(e);
      }
    });
  }

  const filterOptions = [
    { id: "ALL", label: "All", icon: Layers },
    { id: "TODO", label: "Pending", icon: Clock },
    { id: "IN_PROGRESS", label: "In Progress", icon: PlayCircle },
    { id: "DONE", label: "Completed", icon: CheckCircle2 },
  ];

  return (
    <section className="animate-in fade-in duration-700">
      <div className="max-w-7xl mx-auto space-y-10">
        <header className="space-y-2">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-100">
            Tasks
            <span className="ml-2 text-sm font-medium text-zinc-400">
              · {props.param.orgId}
            </span>
          </h2>
        </header>

        <div className="relative overflow-hidden rounded-2xl border border-zinc-800/60 bg-gradient-to-br from-zinc-900/80 to-zinc-950/80 shadow-2xl backdrop-blur-xl">
          <div className="p-6 space-y-8">
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                <ListFilter className="h-3.5 w-3.5" />
                Filter
              </label>

              <div className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/70 p-1">
                {filterOptions.map((opt) => {
                  const Icon = opt.icon;
                  const isActive = currentFilter === opt.id;

                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleFilterChange(opt.id)}
                      className={clsx(
                        "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all",
                        isActive
                          ? "bg-white/10 text-white shadow-md"
                          : "text-zinc-400 hover:bg-zinc-800/60"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {isProjectMode && (
              <div className="pt-2 border-t border-zinc-800">
                <CreateTaskForm onCreate={handleAddTask} />
              </div>
            )}

            <div className="pt-2">
              <SearchBox initialtasks={optimisticTasks} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}