"use client";

import { useState } from "react";
import WorkflowLiveViewer from "./WorkflowLiveViewer";
import type {
  AppNode,
  AppEdge,
} from "@/lib/workflow-types/workflow";

interface Props {
  runId: string;
  initialNodes: AppNode[];
  initialEdges: AppEdge[];
  initialStatus: string;
}

export default function WorkflowRunDashboard({
  runId,
  initialNodes,
  initialEdges,
  initialStatus,
}: Props) {
  const [liveNodes, setLiveNodes] =
    useState(initialNodes);

  const completedCount =
    liveNodes.filter((n) =>
      ["SUCCESS", "COMPENSATED"].includes(
        n.data.executionStatus ?? ""
      )
    ).length;

  const runningCount =
    liveNodes.filter(
      (n) =>
        n.data.executionStatus ===
        "RUNNING"
    ).length;

  const failedCount =
    liveNodes.filter((n) =>
      [
        "FAILED",
        "COMPENSATION_FAILED",
      ].includes(
        n.data.executionStatus ?? ""
      )
    ).length;

  const liveStatus =
    failedCount > 0
      ? "FAILED"
      : runningCount > 0
      ? "RUNNING"
      : completedCount ===
        liveNodes.length
      ? "COMPLETED"
      : initialStatus;

const timeline = liveNodes.map((node) => ({
  id: node.id,
  label: node.data.label,
  status:
    node.data.executionStatus ?? "PENDING",
}));

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-[320px] shrink-0 border-r border-zinc-800 bg-zinc-950 p-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl bg-zinc-900 p-4">
            <span className="text-sm text-zinc-400">
              Nodes
            </span>

            <span className="font-semibold">
              {liveNodes.length}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-zinc-900 p-4">
            <span className="text-sm text-zinc-400">
              Completed
            </span>

            <span className="font-semibold text-emerald-400">
              {completedCount}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-zinc-900 p-4">
            <span className="text-sm text-zinc-400">
              Status
            </span>

            <span className="font-semibold">
              {liveStatus}
            </span>
          </div>
        </div>


        <div className="space-y-3">



  <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 mt-6">
    Execution Timeline
  </h3>

  <div className="space-y-2">
    {timeline.map((step) => (
      <div
        key={step.id}
        className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">
            {step.label}
          </p>

          <p className="truncate text-xs text-zinc-500">
            {step.id}
          </p>
        </div>

        <StatusPill status={step.status} />
      </div>
    ))}
  </div>
</div>
      </aside>

      {/* Graph */}
      <div className="flex-1">
        <WorkflowLiveViewer
          runId={runId}
          initialNodes={initialNodes}
          initialEdges={initialEdges}
          onNodesUpdate={setLiveNodes}
        />
      </div>
    </div>
  );
}


function StatusPill({
  status,
}: {
  status: string;
}) {
  const styles = {
    PENDING:
      "bg-zinc-800 text-zinc-400 border-zinc-700",

    RUNNING:
      "bg-yellow-500/10 text-yellow-400 border-yellow-500/20 animate-pulse",

    SUCCESS:
      "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",

    FAILED:
      "bg-red-500/10 text-red-400 border-red-500/20",

    COMPENSATING:
      "bg-orange-500/10 text-orange-400 border-orange-500/20",

    COMPENSATED:
      "bg-blue-500/10 text-blue-400 border-blue-500/20",
  };

  return (
    <span
      className={`rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
        styles[status as keyof typeof styles] ??
        styles.PENDING
      }`}
    >
      {status}
    </span>
  );
}