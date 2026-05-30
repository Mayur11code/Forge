"use client";

import { memo, useMemo } from "react";
import {
  Handle,
  Position,
  type NodeProps,
  useStore,
} from "@xyflow/react";
import {
  Settings2,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from "lucide-react";

import type { ActionNodeType } from "@/lib/workflow-types/workflow";
import {
  getAvailableUpstreamOutputs,
  getNodeDefinition,
} from "@/lib/workflow/graph-ui/utils";

import { ActionDef } from "@/lib/workflow-types/registry";
import { StepExecutionStatus } from "@prisma/client";

function ActionNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<ActionNodeType>) {
  // ------------------------------------------------------------------
  // Global Graph State
  // ------------------------------------------------------------------

  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);

  // ------------------------------------------------------------------
  // Action Definition
  // ------------------------------------------------------------------

  const actionDef = getNodeDefinition(
    { type: "action", data } as any
  ) as ActionDef | undefined;

  // ------------------------------------------------------------------
  // Upstream Variable Discovery
  // ------------------------------------------------------------------

  const upstreamOutputs = useMemo(
    () => getAvailableUpstreamOutputs(id, nodes as any, edges as any),
    [id, nodes, edges]
  );

  // ------------------------------------------------------------------
  // Missing Variable Validation
  // ------------------------------------------------------------------

  const missingVariables = useMemo(() => {
    if (!actionDef?.requires) return [];

    const availableKeys = upstreamOutputs.map(
      (out) => out.outputKey
    );

    return actionDef.requires.filter(
      (req) => !availableKeys.includes(req)
    );
  }, [actionDef, upstreamOutputs]);

  // ------------------------------------------------------------------
  // Configuration State
  // ------------------------------------------------------------------

  const hasGraphError = missingVariables.length > 0;
  const isReady = data.isConfigured && !hasGraphError;

  // ------------------------------------------------------------------
  // Runtime Execution State
  // ------------------------------------------------------------------

  const executionStatus =
    data.executionStatus ?? StepExecutionStatus.PENDING;

  const getStatusConfig = () => {
    switch (executionStatus) {
      case StepExecutionStatus.RUNNING:
        return {
          border:
            "border-yellow-500 shadow-[0_0_20px_rgba(234,179,8,0.25)]",
          header: "bg-yellow-500/10 border-yellow-500/20",
          iconWrapper: "bg-yellow-500/20 text-yellow-400",
          handle: "bg-yellow-500",
          text: "text-yellow-400",
          icon: (
            <Loader2 size={18} className="animate-spin" />
          ),
          label: "Running",
        };

      case StepExecutionStatus.SUCCESS:
        return {
          border:
            "border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.25)]",
          header: "bg-emerald-500/10 border-emerald-500/20",
          iconWrapper: "bg-emerald-500/20 text-emerald-400",
          handle: "bg-emerald-500",
          text: "text-emerald-400",
          icon: <CheckCircle2 size={18} />,
          label: "Success",
        };

      case StepExecutionStatus.FAILED:
      case StepExecutionStatus.COMPENSATION_FAILED:
        return {
          border:
            "border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.25)]",
          header: "bg-red-500/10 border-red-500/20",
          iconWrapper: "bg-red-500/20 text-red-400",
          handle: "bg-red-500",
          text: "text-red-400",
          icon: <XCircle size={18} />,
          label: "Failed",
        };

      case StepExecutionStatus.COMPENSATING:
      case StepExecutionStatus.COMPENSATED:
        return {
          border:
            "border-orange-500 shadow-[0_0_20px_rgba(249,115,22,0.25)]",
          header: "bg-orange-500/10 border-orange-500/20",
          iconWrapper: "bg-orange-500/20 text-orange-400",
          handle: "bg-orange-500",
          text: "text-orange-400",
          icon: <RotateCcw size={18} />,
          label:
            executionStatus ===
            StepExecutionStatus.COMPENSATING
              ? "Compensating"
              : "Compensated",
        };

      default:
        return isReady
          ? {
              border: selected
                ? "border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.2)]"
                : "border-zinc-800",
              header: "bg-blue-500/10 border-blue-500/20",
              iconWrapper: "bg-blue-500/20 text-blue-400",
              handle: "bg-blue-500",
              text: "text-blue-400",
              icon: <Settings2 size={18} />,
              label: "Ready",
            }
          : {
              border: "border-rose-500/50",
              header: "bg-rose-500/10 border-rose-500/20",
              iconWrapper: "bg-rose-500/20 text-rose-400",
              handle: "bg-rose-500",
              text: "text-rose-400",
              icon: <AlertCircle size={18} />,
              label: "Needs Setup",
            };
    }
  };

  const status = getStatusConfig();

  return (
    <div
      className={`min-w-[250px] rounded-xl bg-[#121212] border transition-all duration-300 ${status.border}`}
    >
      {/* Target Handle */}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
        className={`h-3 w-3 border-2 border-[#121212] ${status.handle}`}
      />

      {/* Header */}
      <div
        className={`flex items-center gap-3 rounded-t-xl border-b px-4 py-3 transition-colors duration-300 ${status.header}`}
      >
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-300 ${status.iconWrapper}`}
        >
          {status.icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-zinc-100">
              Action
            </h3>

            <span
              className={`rounded-md border border-current/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.text}`}
            >
              {status.label}
            </span>
          </div>

          <p
            className={`truncate text-xs font-medium opacity-90 ${status.text}`}
          >
            {data.label || "Select Action..."}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="space-y-3 rounded-b-xl px-4 py-3">
        <p className="text-xs text-zinc-500">
          Type:{" "}
          <span className="rounded bg-zinc-800/50 px-1 py-0.5 font-mono text-zinc-300">
            {data.actionType || "Unset"}
          </span>
        </p>

        {/* Missing Variables */}
        {hasGraphError && (
          <div className="space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-tight text-rose-400">
              Missing Data
            </p>

            <div className="flex flex-wrap gap-1">
              {missingVariables.map((v) => (
                <span
                  key={v}
                  className="rounded-md border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[9px] text-rose-300"
                >
                  {v}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Source Handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        className={`h-3 w-3 border-2 border-[#121212] ${status.handle}`}
      />
    </div>
  );
}

export default memo(ActionNode);