"use client";

import { memo, useMemo } from "react";
import {
  Handle,
  Position,
  type NodeProps,
  useStore,
  useReactFlow,
} from "@xyflow/react";
import {
  Settings2,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Trash2,
} from "lucide-react";

import type { ActionNodeType, AppNode, AppEdge } from "@/lib/workflow-types/workflow";
import {
  getAvailableUpstreamOutputs,
  getNodeDefinition,
} from "@/lib/workflow/graph-ui/utils";
import { evaluateWorkflowDiagnostics } from "@/lib/workflow/validation/diagnostics";

import { StepExecutionStatus } from "@prisma/client";

function ActionNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<ActionNodeType>) {
  let deleteElements: ((params: { nodes?: { id: string }[] }) => void) | undefined;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const rf = typeof useReactFlow === "function" ? useReactFlow() : null;
    deleteElements = rf?.deleteElements;
  } catch {
    // Safe fallback for read-only or mocked test environments
  }
  // ------------------------------------------------------------------
  // Global Graph State
  // ------------------------------------------------------------------

  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);

  // ------------------------------------------------------------------
  // Action Definition
  // ------------------------------------------------------------------

  const actionDef = getNodeDefinition({ type: "action", data });

  // ------------------------------------------------------------------
  // Upstream Variable Discovery
  // ------------------------------------------------------------------

  const upstreamOutputs = useMemo(
    () => getAvailableUpstreamOutputs(id, nodes as AppNode[], edges as AppEdge[]),
    [id, nodes, edges]
  );

  // ------------------------------------------------------------------
  // Missing Variable Validation
  // ------------------------------------------------------------------

  const missingVariables = useMemo(() => {
    if (data.inputsComplete) return [];
    if (!actionDef?.requires) return [];

    const availableKeys = upstreamOutputs.map(
      (out) => out.outputKey
    );

    return actionDef.requires.filter((req) => {
      const val = data.config?.[req];
      const isProvided =
        val !== undefined &&
        val !== null &&
        (typeof val !== "string" || val.trim() !== "");
      if (isProvided) return false;

      // If req is 'title', also treat node label as fulfilling the title
      if (req === "title") {
        const configRecord = data.config as Record<string, unknown> | undefined;
        const configTitle = typeof configRecord?.title === "string" ? configRecord.title : undefined;
        const labelVal = data.label || configTitle;
        if (
          labelVal &&
          labelVal.trim() !== "" &&
          labelVal !== "Action" &&
          labelVal !== "New Action" &&
          labelVal !== "Select Action..." &&
          labelVal !== "Create a Task"
        ) {
          return false;
        }
      }

      return !availableKeys.includes(req);
    });
  }, [actionDef, upstreamOutputs, data.config, data.label, data.inputsComplete]);

  const nodeDiagnostics = useMemo(() => {
    if (data.inputsComplete) return [];
    const report = evaluateWorkflowDiagnostics(nodes as AppNode[], edges as AppEdge[]);
    return report.issues.filter((i) => i.nodeId === id);
  }, [id, nodes, edges, data.inputsComplete]);

  const isUnset = !data.actionType || data.actionType === "unset" || !data.isConfigured;
  const diagnosticErrors = nodeDiagnostics.filter(
    (i) => i.severity === "ERROR" && i.code !== 'INVALID_ACTION' && i.code !== 'EMPTY_GRAPH',
  );
  const diagnosticWarnings = nodeDiagnostics.filter((i) => i.severity === "WARNING");

  // ------------------------------------------------------------------
  // Configuration State
  // ------------------------------------------------------------------

  const hasGraphError = !isUnset && (missingVariables.length > 0 || diagnosticErrors.length > 0);
  const hasGraphWarning = !isUnset && !hasGraphError && diagnosticWarnings.length > 0;
  const isReady = data.isConfigured && !hasGraphError && !isUnset;

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
            "border-white shadow-[0_0_30px_rgba(255,255,255,0.45),inset_0_1px_0_rgba(255,255,255,0.4)] ring-1 ring-white/60",
          header: "bg-white/[0.12] border-white/30",
          iconWrapper: "bg-white/20 text-white border border-white/40 shadow-[0_0_15px_rgba(255,255,255,0.35)]",
          handle: "!bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]",
          text: "text-zinc-100",
          icon: (
            <Loader2 size={16} className="animate-spin text-white" />
          ),
          label: "Processing",
        };

      case StepExecutionStatus.SUCCESS:
        return {
          border:
            "border-white/60 shadow-[0_0_25px_rgba(255,255,255,0.18),inset_0_1px_0_rgba(255,255,255,0.3)] ring-1 ring-white/40",
          header: "bg-white/[0.08] border-white/20",
          iconWrapper: "bg-white/[0.12] text-white border border-white/30 shadow-[0_0_12px_rgba(255,255,255,0.15)]",
          handle: "!bg-white",
          text: "text-zinc-100",
          icon: <CheckCircle2 size={16} />,
          label: "Success",
        };

      case StepExecutionStatus.SKIPPED:
        return {
          border: "border-zinc-700/60 border-dashed opacity-60",
          header: "bg-zinc-800/40 border-white/[0.06]",
          iconWrapper: "bg-zinc-800/60 text-zinc-400 border border-zinc-700",
          handle: "!bg-zinc-600",
          text: "text-zinc-500",
          icon: <RotateCcw size={16} className="rotate-90" />,
          label: "Skipped",
        };

      case StepExecutionStatus.FAILED:
      case StepExecutionStatus.COMPENSATION_FAILED:
        return {
          border:
            "border-rose-500 shadow-[0_0_25px_rgba(244,63,94,0.35),inset_0_1px_0_rgba(244,63,94,0.3)] ring-1 ring-rose-500/50",
          header: "bg-rose-500/[0.12] border-rose-500/30",
          iconWrapper: "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.2)]",
          handle: "!bg-rose-500",
          text: "text-rose-300",
          icon: <XCircle size={16} />,
          label: "Failed",
        };

      case StepExecutionStatus.COMPENSATING:
      case StepExecutionStatus.COMPENSATED:
        return {
          border:
            "border-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.35),inset_0_1px_0_rgba(249,115,22,0.3)] ring-1 ring-orange-500/50",
          header: "bg-orange-500/[0.12] border-orange-500/30",
          iconWrapper: "bg-orange-500/20 text-orange-300 border border-orange-500/40 shadow-[0_0_12px_rgba(249,115,22,0.2)]",
          handle: "!bg-orange-500",
          text: "text-orange-300",
          icon: <RotateCcw size={16} />,
          label:
            executionStatus ===
            StepExecutionStatus.COMPENSATING
              ? "Compensating"
              : "Compensated",
        };

      default:
        if (isReady) {
          return {
            border: hasGraphWarning
              ? "border-amber-500/70 shadow-[0_0_20px_rgba(245,158,11,0.2)] ring-1 ring-amber-500/30"
              : selected
              ? "border-white text-white shadow-[0_0_30px_rgba(99,102,241,0.25),inset_0_1px_0_rgba(255,255,255,0.4)] ring-1 ring-white/50"
              : "border-indigo-500/25 hover:border-indigo-500/40 shadow-[0_20px_45px_rgba(0,0,0,0.85)]",
            header: hasGraphWarning
              ? "bg-amber-500/[0.08] border-amber-500/20"
              : "bg-indigo-500/[0.08] border-indigo-500/20",
            iconWrapper: hasGraphWarning
              ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
              : "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shadow-[0_0_10px_rgba(99,102,241,0.2)]",
            handle: hasGraphWarning ? "!bg-amber-400" : "!bg-indigo-400",
            text: hasGraphWarning ? "text-amber-300" : "text-indigo-300",
            icon: <Settings2 size={16} />,
            label: hasGraphWarning ? "Warning" : "Ready",
          };
        }

        // New / Unconfigured Action Node -> Subtle neutral indigo setup state
        return {
          border: selected
            ? "border-white text-white shadow-[0_0_30px_rgba(255,255,255,0.22),inset_0_1px_0_rgba(255,255,255,0.4)] ring-1 ring-white/50"
            : "border-white/[0.12] hover:border-indigo-500/30",
          header: "bg-indigo-500/[0.04] border-white/[0.08]",
          iconWrapper: "bg-indigo-500/10 text-indigo-300/80 border border-indigo-500/20",
          handle: "!bg-indigo-500/60",
          text: "text-zinc-400",
          icon: <Settings2 size={16} />,
          label: "Needs Setup",
        };
    }
  };

  const status = getStatusConfig();

  return (
    <div
      className={`group cursor-pointer min-w-[260px] rounded-2xl bg-gradient-to-b from-[#181824]/95 to-[#0e0e15]/95 backdrop-blur-xl border transition-all duration-300 shadow-[0_20px_45px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.18)] ${status.border}`}
    >
      {/* Target Dock Handle */}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
        className={`!h-3 !w-3 !border-2 !border-[#07070a] ${status.handle} hover:!scale-125 transition-transform shadow-[0_0_8px_rgba(255,255,255,0.2)]`}
      />

      {/* Header */}
      <div
        className={`flex items-center gap-3 rounded-t-2xl border-b px-4 py-3 transition-colors duration-300 ${status.header}`}
      >
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-300 ${status.iconWrapper}`}
        >
          {status.icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-indigo-300 bg-indigo-500/10 border border-indigo-500/25 px-1 py-0.2 rounded">
                [ ACT ]
              </span>
              <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-100">
                Action
              </h3>
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`rounded-md border border-current/25 bg-black/40 px-2 py-0.5 text-[9px] font-mono font-bold uppercase tracking-wider ${status.text}`}
              >
                {status.label}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteElements?.({ nodes: [{ id }] });
                }}
                aria-label="Delete action"
                className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-all"
                title="Delete action node"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>

          <p
            className={`truncate text-xs font-medium opacity-90 mt-0.5 ${status.text}`}
          >
            {data.label || "Select Action..."}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="space-y-3 rounded-b-2xl px-4 py-3">
        <div className="rounded-lg bg-black/50 border border-white/[0.06] px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
          Type:{" "}
          <span className="rounded bg-white/[0.06] border border-white/[0.1] px-1.5 py-0.5 font-mono text-zinc-200">
            {data.actionType || "Unset"}
          </span>
        </div>

        {/* Diagnostics Messages */}
        {diagnosticErrors.length > 0 && (
          <div className="space-y-1 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5">
            <p className="text-[9px] font-mono font-bold uppercase tracking-tight text-rose-300 flex items-center gap-1">
              <AlertCircle size={10} className="shrink-0 text-rose-400" />
              <span>{diagnosticErrors[0].message}</span>
            </p>
          </div>
        )}
        {diagnosticErrors.length === 0 && diagnosticWarnings.length > 0 && (
          <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
            <p className="text-[10px] font-mono font-medium text-amber-300">
              {diagnosticWarnings[0].message}
            </p>
          </div>
        )}

        {/* Missing Variables - only render if there are actually missing variables */}
        {missingVariables.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5">
            <p className="text-[9px] font-mono font-bold uppercase tracking-widest text-rose-400">
              [ MISSING UPSTREAM DATA ]
            </p>

            <div className="flex flex-wrap gap-1">
              {missingVariables.map((v) => (
                <span
                  key={v}
                  className="rounded-md border border-rose-500/30 bg-rose-950/40 px-1.5 py-0.5 font-mono text-[9px] text-rose-300"
                >
                  {v}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Source Dock Handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        className={`!h-3 !w-3 !border-2 !border-[#07070a] ${status.handle} hover:!scale-125 transition-transform shadow-[0_0_8px_rgba(255,255,255,0.2)]`}
      />
    </div>
  );
}

export default memo(ActionNode);
