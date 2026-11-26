"use client";

import React, { startTransition, useOptimistic } from "react";
import { Task, TaskStatus } from "@prisma/client";
import CreateTaskForm from "./CreateTaskForm";
import TaskCard from "@/features/organizations/components/TaskCard";
import TaskFilters, { TaskFilterMember } from "@/features/tasks/components/TaskFilters";
import { createTask } from "@/app/actions/Tasks/createTask";
import { Layers } from "lucide-react";

type ProjectModeProps = {
  mode: "project";
  param: { orgId: string };
  projectId: string;
  initialtasks: Task[];
  totalCount?: number;
  currentPage?: number;
  totalPages?: number;
  pageSize?: number;
  members?: TaskFilterMember[];
};

type OrgModeProps = {
  mode: "org";
  param: { orgId: string };
  initialtasks: Task[];
  totalCount?: number;
  currentPage?: number;
  totalPages?: number;
  pageSize?: number;
  members?: TaskFilterMember[];
};

type TaskBoxProps = ProjectModeProps | OrgModeProps;

export default function TaskBox(props: TaskBoxProps) {
  const isProjectMode = props.mode === "project";

  const totalCount = props.totalCount ?? props.initialtasks.length;
  const currentPage = props.currentPage ?? 1;
  const pageSize = props.pageSize ?? 12;
  const totalPages = props.totalPages ?? Math.max(1, Math.ceil(totalCount / pageSize));

  const [optimisticTasks, updateOptimisticTasks] = useOptimistic(
    props.initialtasks,
    (
      state: Task[],
      action:
        | { type: "add"; task: Task }
        | { type: "replace"; task: Task; tempId: string }
        | { type: "status"; taskId: string; newStatus: TaskStatus }
    ) => {
      if (action.type === "add") return [action.task, ...state];
      if (action.type === "replace") {
        return state.map((t) => (t.id === action.tempId ? action.task : t));
      }
      if (action.type === "status") {
        return state.map((t) =>
          t.id === action.taskId ? { ...t, status: action.newStatus } : t
        );
      }
      return state;
    }
  );

  async function handleAddTask(title: string) {
    if (!isProjectMode) return { success: false, error: "Not in project mode" };

    const tempId = "temp-" + Date.now();
    const tempTask: Task = {
      id: tempId,
      title,
      status: "TODO",
      priority: "MEDIUM",
      projectId: props.projectId,
      assigneeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      description: "No description provided.",
    };

    startTransition(() => {
      updateOptimisticTasks({ type: "add", task: tempTask });
    });

    try {
      const result = await createTask({ title, projectId: props.projectId });

      if (result.success && result.task) {
        startTransition(() => {
          updateOptimisticTasks({
            type: "replace",
            task: result.task!,
            tempId,
          });
        });
        return result;
      } else {
        console.warn("Task creation failed:", result.error);
        return result;
      }
    } catch (e) {
      console.error(e);
      return { success: false, error: "An unexpected error occurred" };
    }
  }

  const handleTaskStatusChange = (taskId: string, newStatus: TaskStatus) => {
    startTransition(() => {
      updateOptimisticTasks({ type: "status", taskId, newStatus });
    });
  };

  return (
    <section className="animate-in fade-in duration-300">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Main Task Management Container */}
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-6 shadow-2xl backdrop-blur-xl space-y-6">
          {/* Quick Task Creation (in project mode) */}
          {isProjectMode && (
            <div className="pb-4 border-b border-zinc-800/80">
              <CreateTaskForm onCreate={handleAddTask} />
            </div>
          )}

          {/* Filtering, Search & Pagination Controls */}
          <TaskFilters
            totalCount={totalCount}
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            members={props.members}
          />

          {/* Task Grid */}
          {optimisticTasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center">
              <Layers className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
              <p className="text-sm font-medium text-zinc-300">No tasks found</p>
              <p className="text-xs text-zinc-500 mt-1">
                Try adjusting your search query, priority, or status filters.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 pt-2">
              {optimisticTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onStatusChange={handleTaskStatusChange}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
