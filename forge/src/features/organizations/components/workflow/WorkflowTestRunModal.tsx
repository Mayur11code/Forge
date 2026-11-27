"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  SkipForward,
  X,
} from "lucide-react";
import { AVAILABLE_TRIGGERS } from "@/lib/workflow-types/registry";
import { simulateWorkflowRunAction } from "@/app/actions/workflows/workflow-run";
import type { WorkflowSimulationResult } from "@/lib/workflow/execution/simulator";

interface WorkflowTestRunModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowId: string;
  orgId: string;
  triggerEventId?: string | null;
  publishedVersionNumber?: number | null;
  hasUnsavedChanges?: boolean;
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

export default function WorkflowTestRunModal({
  isOpen,
  onClose,
  workflowId,
  orgId,
  triggerEventId,
  publishedVersionNumber = null,
  hasUnsavedChanges = false,
}: WorkflowTestRunModalProps) {
  const defaultPayload = useMemo(
    () => buildDefaultTriggerPayload(triggerEventId),
    [triggerEventId],
  );

  const [target, setTarget] = useState<"draft" | "published">("draft");
  const [payloadJson, setPayloadJson] = useState(defaultPayload);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    try {
      const response = await simulateWorkflowRunAction({
        workflowId,
        orgslug: orgId,
        target,
        triggerPayloadJson: payloadJson,
      });

      if (!response.success) {
        setError(response.error);
        return;
      }

      setResult({
        target: response.target,
        versionNumber: response.versionNumber,
        simulation: response.simulation,
      });
    } catch {
      setError("Network error while running simulation.");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Workflow Sandbox Simulation"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/[0.12] bg-[#0c0c14]/98 text-zinc-100 shadow-[0_25px_60px_rgba(0,0,0,0.95)] backdrop-blur-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/20 bg-white/[0.08] text-zinc-100 shadow-sm">
              <FlaskConical size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-mono font-semibold text-white">
                  Test Workflow (Sandbox Simulation)
                </h2>
                <span className="rounded-full border border-white/15 bg-white/[0.05] px-2 py-0.5 text-[10px] font-mono font-medium text-zinc-300">
                  Dry Run · Zero Side Effects
                </span>
              </div>
              <p className="text-xs font-mono text-zinc-400">
                Simulates trigger inputs and step resolution without creating tasks or dispatching live runs.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close simulation modal"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {hasUnsavedChanges && target === "draft" && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-mono text-amber-200">
              Your canvas has unsaved edits. Save the draft first to include those changes in the simulation.
            </div>
          )}

          {/* Target & Trigger Payload */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="text-xs font-mono font-semibold text-zinc-300">
                Simulation Target
              </label>
              <div className="inline-flex rounded-xl border border-white/[0.08] bg-black/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setTarget("draft")}
                  className={`rounded-lg px-3 py-1 font-mono text-xs font-medium transition-colors ${
                    target === "draft"
                      ? "bg-white/[0.1] text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Saved Draft
                </button>
                <button
                  type="button"
                  disabled={publishedVersionNumber === null}
                  onClick={() => setTarget("published")}
                  className={`rounded-lg px-3 py-1 font-mono text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    target === "published"
                      ? "bg-white/[0.1] text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {publishedVersionNumber !== null
                    ? `Published v${publishedVersionNumber}`
                    : "Published (none)"}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="simulation-trigger-payload"
                  className="text-xs font-mono font-semibold text-zinc-300"
                >
                  Mock Trigger Payload (JSON)
                </label>
                {triggerEventId && (
                  <span className="font-mono text-[11px] text-zinc-500">
                    Event: {triggerEventId}
                  </span>
                )}
              </div>
              <textarea
                id="simulation-trigger-payload"
                value={payloadJson}
                onChange={(e) => setPayloadJson(e.target.value)}
                rows={5}
                spellCheck={false}
                className="w-full rounded-xl border border-white/[0.12] bg-black/70 p-3 font-mono text-xs text-zinc-200 focus:border-white/40 focus:outline-none focus:ring-1 focus:ring-white/20 shadow-inner"
              />
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs font-mono text-rose-200"
            >
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {/* Simulation Results */}
          {result && (
            <div className="space-y-3 border-t border-white/[0.08] pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {result.simulation.status === "COMPLETED" ? (
                    <CheckCircle2 size={16} className="text-zinc-200" />
                  ) : (
                    <AlertCircle size={16} className="text-rose-400" />
                  )}
                  <span className="text-xs font-mono font-semibold text-white">
                    Simulation {result.simulation.status}
                  </span>
                  <span className="text-[11px] font-mono text-zinc-400">
                    ({result.target === "published"
                      ? `Published v${result.versionNumber}`
                      : "Saved Draft"}
                    )
                  </span>
                </div>
                <span className="font-mono text-[11px] text-zinc-400">
                  {result.simulation.totalDurationMs} ms
                </span>
              </div>

              <div className="space-y-2.5">
                {result.simulation.steps.map((step, index) => (
                  <div
                    key={step.stepId}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[11px] font-mono text-zinc-500">
                          #{index + 1}
                        </span>
                        <span className="truncate text-xs font-semibold text-zinc-100">
                          {step.label}
                        </span>
                        <span className="rounded bg-black/60 border border-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                          {step.action}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-[10px] text-zinc-500">
                          {step.durationMs}ms
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-mono font-medium ${
                            step.status === "COMPLETED"
                              ? "border-white/20 bg-white/[0.08] text-zinc-100"
                              : step.status === "SKIPPED"
                              ? "border-zinc-700 bg-zinc-800/60 text-zinc-400"
                              : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                          }`}
                        >
                          {step.status === "SKIPPED" && <SkipForward size={10} />}
                          {step.status}
                        </span>
                      </div>
                    </div>

                    {step.error && (
                      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-mono text-rose-200">
                        {step.error}
                      </div>
                    )}

                    {step.skipReason && (
                      <div className="rounded-lg border border-white/[0.08] bg-black/50 px-2.5 py-1.5 text-[11px] font-mono text-zinc-400">
                        {step.skipReason}
                      </div>
                    )}

                    {Object.keys(step.resolvedInputs).length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] font-mono uppercase text-zinc-500">
                          Resolved Inputs
                        </div>
                        <pre className="max-h-32 overflow-auto rounded-lg border border-white/[0.08] bg-black/60 p-2 font-mono text-[11px] text-zinc-300">
                          {JSON.stringify(step.resolvedInputs, null, 2)}
                        </pre>
                      </div>
                    )}

                    {step.outputs && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono uppercase text-zinc-500">
                          <span>Outputs</span>
                          {step.truncated && (
                            <span className="text-amber-400">Truncated</span>
                          )}
                        </div>
                        <pre className="max-h-40 overflow-auto rounded-lg border border-white/[0.08] bg-black/60 p-2 font-mono text-[11px] text-zinc-200">
                          {JSON.stringify(step.outputs, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/[0.1] bg-white/[0.04] px-3.5 py-2 font-mono text-xs font-medium text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleRunSimulation}
            disabled={isRunning}
            className="flex items-center gap-1.5 rounded-xl bg-zinc-100 px-4 py-2 font-mono text-xs font-semibold text-zinc-950 shadow-[0_4px_25px_rgba(255,255,255,0.18)] hover:bg-white disabled:opacity-50 transition-all hover:-translate-y-0.5 active:translate-y-0"
          >
            {isRunning ? (
              <Loader2 size={14} className="animate-spin text-zinc-950" />
            ) : (
              <Play size={13} className="fill-zinc-950 text-zinc-950" />
            )}
            <span>{isRunning ? "Simulating..." : "Run Simulation"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
