'use client';

import React, { startTransition } from "react";
import SearchBox from "@/features/organizations/components/SearchBox";
import { ListFilter, CheckCircle2, Clock, PlayCircle, Layers } from "lucide-react";
import { clsx } from "clsx";
import { Task } from "@prisma/client";
import { useOptimistic } from "react";
import CreateTaskForm from "./CreateTaskForm";
import { createTask } from "@/app/actions/createTask";

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

export default function TasksPage(props: TaskBoxProps) {
  const isProjectMode = props.mode === "project";

  const [filter, setFilter] = React.useState<string>("ALL");

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

  async function handleAddTask(title: string) {
    if (!isProjectMode) return;

    const tempId = Math.random().toString();

    const tempTask: Task = {
      id: tempId,
      title,
      status: "TODO",
      priority: "MEDIUM",
      projectId: props.projectId,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: "No description provided.",
    };

    startTransition(async () => {
      updateOptimisticTasks({ type: "add", task: tempTask });
      try {
        await createTask({ title, projectId: props.projectId });
        updateOptimisticTasks({
          type: "replace",
          task: { ...tempTask, id: tempId },
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
        {/* Header */}
        <header className="space-y-2">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-100">
            Tasks
            <span className="ml-2 text-sm font-medium text-zinc-400">
              · {props.param.orgId}
            </span>
          </h2>
          <p className="text-sm text-zinc-500">
            Organize, prioritize, and track work across your organization.
          </p>
        </header>

        {/* Control Card */}
        <div className="relative overflow-hidden rounded-2xl border border-zinc-800/60 bg-gradient-to-br from-zinc-900/80 to-zinc-950/80 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="p-6 space-y-8">
            {/* Filter */}
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                <ListFilter className="h-3.5 w-3.5" />
                Filter
              </label>

              <div className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/70 p-1">
                {filterOptions.map((opt) => {
                  const Icon = opt.icon;
                  const isActive = filter === opt.id;

                  return (
                    <button
                      key={opt.id}
                      onClick={() => setFilter(opt.id)}
                      className={clsx(
                        "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all",
                        isActive
                          ? "bg-red-900/25 text-white shadow-md shadow-blue-900/30 glassmorphism"
                          : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                      )}
                    >
                      <Icon
                        className={clsx(
                          "h-4 w-4",
                          isActive ? "text-white" : "text-zinc-500"
                        )}
                      />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="h-px w-full bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />

            {isProjectMode && (
              <div className="pt-2">
                <CreateTaskForm onCreate={handleAddTask} />
              </div>
            )}

            {/* Tasks */}
            <div className="pt-2">
              <SearchBox filter={filter} initialtasks={optimisticTasks} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
