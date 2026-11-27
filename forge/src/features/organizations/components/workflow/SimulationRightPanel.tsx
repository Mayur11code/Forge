"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  SkipForward,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { AVAILABLE_TRIGGERS } from "@/lib/workflow-types/registry";
import { simulateWorkflowRunAction } from "@/app/actions/workflows/workflow-run";
import type { WorkflowSimulationResult } from "@/lib/workflow/execution/simulator";
import type { AppNode, AppEdge } from "@/lib/workflow-types/workflow";

interface SimulationRightPanelProps {
  isOpen: boolean;
  onClose: () => void;
  workflowId: string;
  orgId: string;
  triggerEventId?: string | null;
  publishedVersionNumber?: number | null;
  hasUnsavedChanges?: boolean;
  currentNodes?: AppNode[];
  currentEdges?: AppEdge[];
  onSimulationStart?: () => void;
  onSimulationComplete?: (result: WorkflowSimulationResult) => void;
  onResetSimulation?: () => void;
}

function buildDefaultTriggerPayload(eventId?: string | null): string {
  const triggerDef = AVAILABLE_TRIGGERS.find((t) => t.id === eventId);
  if (!triggerDef) {
    return JSON.stringify(
      {
        taskId: "task_sample_1",
        projectId: "proj_sample_1",
      },
      null,
      2,
    );
  }

  const sample: Record<string, string> = {};
  for (const field of triggerDef.outputs) {
    if (field === "email") {
      sample[field] = "member@example.com";
    } else if (field === "orgId") {
      sample[field] = "org_sample_1";
    } else {
      sample[field] = `${field.replace(/Id$/, "")}_sample_1`;
    }
  }
  return JSON.stringify(sample, null, 2);
}

export function SimulationRightPanel({
  isOpen,
  onClose,
  workflowId,
  orgId,
  triggerEventId,
  publishedVersionNumber = null,
  hasUnsavedChanges = false,
  currentNodes,
  currentEdges,
  onSimulationStart,
  onSimulationComplete,
  onResetSimulation,
}: SimulationRightPanelProps) {
  const defaultPayload = useMemo(
    () => buildDefaultTriggerPayload(triggerEventId),
    [triggerEventId],
  );

  const [target, setTarget] = useState<"draft" | "published">("draft");
  const [payloadJson, setPayloadJson] = useState(defaultPayload);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [result, setResult] = useState<{
    target: "draft" | "published";
    versionNumber: number | null;
    simulation: WorkflowSimulationResult;
  } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPayloadJson(defaultPayload);
      setError(null);
    }
  }, [isOpen, defaultPayload]);

  useEffect(() => {
    if (publishedVersionNumber === null && target === "published") {
      setTarget("draft");
    }
  }, [publishedVersionNumber, target]);

  if (!isOpen) return null;

  const handleRunSimulation = async () => {
    if (isRunning) return;
    setError(null);

    try {
      if (payloadJson.trim() !== "") {
        JSON.parse(payloadJson);
      }
    } catch {
      setError("Invalid trigger payload JSON. Please fix syntax errors before running.");
      return;
    }

    setIsRunning(true);
    onSimulationStart?.();

    try {
      const response = await simulateWorkflowRunAction({
        workflowId,
        orgslug: orgId,
        target,
        triggerPayloadJson: payloadJson,
        currentNodes,
        currentEdges,
      });

      if (!response.success) {
        setError(response.error);
        onResetSimulation?.();
        return;
      }

      setResult({
        target: response.target,
        versionNumber: response.versionNumber,
        simulation: response.simulation,
      });

      onSimulationComplete?.(response.simulation);
    } catch {
      setError("Network error while running simulation.");
      onResetSimulation?.();
    } finally {
      setIsRunning(false);
    }
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
    onResetSimulation?.();
  };

  return (
    <aside className="w-96 h-full border-l border-white/[0.08] bg-[#0c0c14]/98 backdrop-blur-2xl flex flex-col shrink-0 z-30 shadow-[-12px_0_35px_rgba(0,0,0,0.7)] animate-in slide-in-from-right duration-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] p-4 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.08] text-zinc-100 border border-white/20 shadow-sm">
            <FlaskConical size={14} />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-300 bg-white/[0.06] border border-white/[0.12] px-1 py-0.2 rounded">
                [ SIMULATOR ]
              </span>
              <span className="text-xs font-mono font-bold text-zinc-100">Dry-Run</span>
            </div>
            <p className="text-[10px] text-zinc-500 font-mono">Isolated tenant sandbox</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            handleReset();
            onClose();
          }}
          aria-label="Close simulation console"
          className="h-6 w-6 rounded border border-white/[0.1] bg-white/[0.04] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {/* Target Selector: Draft vs Published */}
      <div className="flex items-center gap-1.5 p-3 border-b border-white/[0.06] bg-black/30 shrink-0">
        <button
          type="button"
          onClick={() => setTarget("draft")}
          className={`flex-1 py-1.5 px-2 rounded-xl text-[11px] font-mono font-semibold transition-all border ${
            target === "draft"
              ? "border-white/20 bg-white/[0.08] text-white shadow-[0_0_10px_rgba(255,255,255,0.06)]"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Simulate Draft
        </button>
        <button
          type="button"
          onClick={() => setTarget("published")}
          disabled={publishedVersionNumber === null}
          className={`flex-1 py-1.5 px-2 rounded-xl text-[11px] font-mono font-semibold transition-all border disabled:opacity-40 disabled:cursor-not-allowed ${
            target === "published"
              ? "border-white/20 bg-white/[0.08] text-white shadow-[0_0_10px_rgba(255,255,255,0.06)]"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {publishedVersionNumber !== null ? `Published v${publishedVersionNumber}` : "No Published v"}
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {/* Unsaved changes notice */}
        {hasUnsavedChanges && target === "draft" && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] font-mono text-amber-300 flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5 text-amber-400" />
            <span>You have unsaved edits. Simulation uses the latest saved draft from the database.</span>
          </div>
        )}

        {/* Payload Section */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-mono font-semibold text-zinc-300">
              Trigger Event Payload
            </label>
            <button
              type="button"
              onClick={() => setPayloadJson(defaultPayload)}
              className="text-[10px] font-mono text-zinc-400 hover:text-white underline transition-colors"
            >
              Reset Sample
            </button>
          </div>
          <textarea
            aria-label="Simulation trigger payload JSON"
            value={payloadJson}
            onChange={(e) => setPayloadJson(e.target.value)}
            rows={5}
            className="w-full rounded-xl border border-white/[0.1] bg-black/70 p-2.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-white/40 shadow-inner"
            placeholder="{}"
          />
        </div>

        {/* Error Alert */}
        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-[11px] font-mono text-rose-300 flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {/* Results Section */}
        {result && (
          <div className="space-y-3 pt-2 border-t border-white/[0.08]">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                [ SIMULATION RESULTS ]
              </span>
              <span
                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                  result.simulation.status === "COMPLETED"
                    ? "border-white/20 bg-white/[0.06] text-zinc-200"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                }`}
              >
                {result.simulation.status} ({result.simulation.totalDurationMs}ms)
              </span>
            </div>

            {/* Steps Timeline */}
            <div className="space-y-2">
              {result.simulation.steps.map((step) => {
                const isStepExpanded = expandedStepId === step.stepId;
                return (
                  <div
                    key={step.stepId}
                    className="rounded-xl border border-white/[0.08] bg-black/40 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedStepId(isStepExpanded ? null : step.stepId)}
                      className="w-full flex items-center justify-between p-2.5 text-left hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {step.status === "COMPLETED" ? (
                          <CheckCircle2 size={13} className="text-zinc-300 shrink-0" />
                        ) : (
                          <AlertCircle size={13} className="text-rose-400 shrink-0" />
                        )}
                        <span className="text-xs font-mono font-semibold text-zinc-200">
                          {step.stepId}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-500">
                          ({step.action})
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-400">
                        <span>{step.durationMs}ms</span>
                        {isStepExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </div>
                    </button>

                    {isStepExpanded && (
                      <div className="p-2.5 border-t border-white/[0.06] bg-black/60 space-y-2 text-[10px] font-mono">
                        {step.error && (
                          <div className="text-rose-400 bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
                            Error: {step.error}
                          </div>
                        )}
                        <div>
                          <span className="text-zinc-500 block mb-0.5">Resolved Inputs:</span>
                          <pre className="p-2 rounded bg-black/70 text-zinc-300 overflow-x-auto">
                            {JSON.stringify(step.resolvedInputs, null, 2)}
                          </pre>
                        </div>
                        {step.outputs && (
                          <div>
                            <span className="text-zinc-500 block mb-0.5">Simulated Output:</span>
                            <pre className="p-2 rounded bg-black/70 text-zinc-200 overflow-x-auto">
                              {JSON.stringify(step.outputs, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer Run Controls */}
      <div className="p-4 border-t border-white/[0.08] bg-black/40 flex items-center gap-2 shrink-0">
        {result && (
          <button
            type="button"
            onClick={handleReset}
            className="p-2 rounded-xl border border-white/[0.1] bg-white/[0.04] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
            title="Reset Simulation"
          >
            <RotateCcw size={15} />
          </button>
        )}

        <button
          type="button"
          onClick={handleRunSimulation}
          disabled={isRunning}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-zinc-100 hover:bg-white text-zinc-950 font-mono font-bold text-xs py-2.5 px-4 shadow-[0_4px_25px_rgba(255,255,255,0.18)] transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning ? (
            <>
              <Loader2 size={14} className="animate-spin text-zinc-950" />
              <span>Simulating...</span>
            </>
          ) : (
            <>
              <Play size={14} fill="currentColor" className="text-zinc-950" />
              <span>Execute Sandbox Run</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
