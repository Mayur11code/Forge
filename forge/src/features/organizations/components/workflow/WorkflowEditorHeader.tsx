"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  FlaskConical,
  Loader2,
  PauseCircle,
  Pencil,
  PlayCircle,
  Rocket,
  Save,
  X,
} from "lucide-react";
import RunWorkflowButton from "./RunWorkflowButton";
import type { WorkflowDiagnosticsReport } from "@/lib/workflow/validation/diagnostics";

interface WorkflowEditorHeaderProps {
  workflowId?: string;
  orgId: string;
  name: string;
  description: string | null;
  isPending: boolean;
  canSave: boolean;
  draftRevision?: number;
  publishedVersionNumber?: number | null;
  hasUnsavedChanges?: boolean;
  hasUnpublishedChanges?: boolean;
  isActive?: boolean;
  isPublishing?: boolean;
  isTogglingActive?: boolean;
  isPaletteCollapsed?: boolean;
  onTogglePalette?: () => void;
  diagnostics?: WorkflowDiagnosticsReport;
  onFocusNode?: (nodeId: string) => void;
  onCommitName: (nextName: string) => void;
  onCommitDescription: (nextDescription: string | null) => void;
  onSave: () => void;
  onPublish?: () => void;
  onToggleActive?: (nextActive: boolean) => void;
  onOpenSimulation?: () => void;
}

export default function WorkflowEditorHeader({
  workflowId,
  orgId,
  name,
  description,
  isPending,
  canSave,
  draftRevision,
  publishedVersionNumber = null,
  hasUnsavedChanges = false,
  hasUnpublishedChanges = false,
  isActive = false,
  isPublishing = false,
  isTogglingActive = false,
  diagnostics,
  onFocusNode,
  onCommitName,
  onCommitDescription,
  onSave,
  onPublish,
  onToggleActive,
  onOpenSimulation,
}: WorkflowEditorHeaderProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState(description ?? "");
  const descInputRef = useRef<HTMLInputElement>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  useEffect(() => {
    setDraftName(name);
  }, [name]);

  useEffect(() => {
    setDraftDesc(description ?? "");
  }, [description]);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  useEffect(() => {
    if (isEditingDesc && descInputRef.current) {
      descInputRef.current.focus();
      descInputRef.current.select();
    }
  }, [isEditingDesc]);

  const confirmNameEdit = () => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      setDraftName(name);
      setIsEditingName(false);
      return;
    }
    setIsEditingName(false);
    if (trimmed !== name) {
      onCommitName(trimmed);
    }
  };

  const cancelNameEdit = () => {
    setDraftName(name);
    setIsEditingName(false);
  };

  const confirmDescEdit = () => {
    const trimmed = draftDesc.trim();
    const normalized = trimmed.length > 0 ? trimmed : null;
    setIsEditingDesc(false);
    if (normalized !== (description ?? null)) {
      onCommitDescription(normalized);
    }
  };

  const cancelDescEdit = () => {
    setDraftDesc(description ?? "");
    setIsEditingDesc(false);
  };

  return (
    <header className="flex flex-col border-b border-white/[0.08] bg-[#09090e]/95 backdrop-blur-2xl shrink-0 z-30 shadow-md">
      {/* =========================================================================
          ROW 1: Identity, Breadcrumb, Name & Description, Workspace Context
          ========================================================================= */}
      <div className="flex items-center justify-between gap-4 px-5 py-2.5 border-b border-white/[0.05]">
        {/* Left: Navigation & Workflow Identity */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Breadcrumb / Back Link */}
          <Link
            href={`/org/${orgId}/workflows`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-xs font-mono text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors shrink-0"
            title="Back to Automations"
          >
            <ArrowLeft size={13} />
            <span>Workflows</span>
          </Link>

          <span className="text-zinc-600 font-mono text-xs select-none">/</span>

          {/* Inline Workflow Name */}
          <div className="flex items-center gap-1.5 min-w-0">
            {isEditingName ? (
              <div className="flex items-center gap-1.5">
                <input
                  ref={nameInputRef}
                  type="text"
                  aria-label="Workflow name"
                  value={draftName}
                  maxLength={100}
                  disabled={isPending}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      confirmNameEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelNameEdit();
                    }
                  }}
                  onBlur={confirmNameEdit}
                  className="rounded-xl border border-white/40 bg-black/80 px-2.5 py-1 font-mono text-sm font-semibold text-white outline-none focus:border-white focus:ring-1 focus:ring-white/30 min-w-[200px] shadow-inner"
                />
                <button
                  type="button"
                  aria-label="Confirm workflow name"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={confirmNameEdit}
                  className="rounded-lg p-1 text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Cancel workflow name edit"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelNameEdit}
                  className="rounded-lg p-1 text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsEditingName(true)}
                className="group inline-flex items-center gap-2 rounded-lg px-2 py-0.5 -ml-1 text-left hover:bg-white/[0.06] transition-colors"
                title="Click to rename workflow"
              >
                <span className="truncate text-sm sm:text-base font-semibold text-white max-w-[220px] sm:max-w-[340px]">
                  {name}
                </span>
                <Pencil className="h-3.5 w-3.5 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
          </div>

          <span className="text-zinc-700 hidden sm:inline select-none">|</span>

          {/* Inline Workflow Description */}
          <div className="hidden sm:flex items-center min-w-0 flex-1">
            {isEditingDesc ? (
              <div className="flex items-center gap-1.5 w-full max-w-md">
                <input
                  ref={descInputRef}
                  type="text"
                  aria-label="Workflow description"
                  value={draftDesc}
                  maxLength={500}
                  disabled={isPending}
                  placeholder="Describe what this automation does..."
                  onChange={(e) => setDraftDesc(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      confirmDescEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelDescEdit();
                    }
                  }}
                  onBlur={confirmDescEdit}
                  className="rounded-xl border border-white/[0.15] bg-black/80 px-2.5 py-0.5 text-xs font-mono text-zinc-200 placeholder-zinc-500 outline-none focus:border-white/40 w-full shadow-inner"
                />
                <button
                  type="button"
                  aria-label="Confirm workflow description"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={confirmDescEdit}
                  className="rounded-lg p-1 text-zinc-200 hover:text-white hover:bg-white/[0.08] transition-colors"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label="Cancel workflow description edit"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelDescEdit}
                  className="rounded-lg p-1 text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsEditingDesc(true)}
                className="group inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 -ml-1 text-left text-xs font-mono text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors max-w-md truncate"
                title="Click to edit workflow description"
              >
                <span className="truncate">
                  {description ? description : "Add a workflow description..."}
                </span>
                <Pencil className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
          </div>
        </div>

        {/* Right: Workspace Context Badge */}
        <div className="hidden lg:flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
            ORG: <span className="text-zinc-300 font-semibold">{orgId}</span>
          </span>
        </div>
      </div>

      {/* =========================================================================
          ROW 2: Diagnostics, Lifecycle State, & Action Buttons
          ========================================================================= */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-2 bg-black/25">
        {/* Left: Diagnostics & Lifecycle Status Badges */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Diagnostics summary */}
          {diagnostics && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDiagnostics((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-mono font-medium transition-all backdrop-blur-md shadow-sm ${
                  diagnostics.errors.length > 0
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 shadow-[0_0_12px_rgba(244,63,94,0.15)]"
                    : diagnostics.warnings.length > 0
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                    : "border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]"
                }`}
                title="Inspect workflow diagnostics"
              >
                {diagnostics.errors.length > 0 ? (
                  <AlertCircle className="h-3.5 w-3.5 text-rose-400" />
                ) : diagnostics.warnings.length > 0 ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-zinc-300" />
                )}
                <span>
                  {diagnostics.errors.length} err · {diagnostics.warnings.length} warn
                </span>
              </button>

              {/* Diagnostics Flyout Panel */}
              {showDiagnostics && diagnostics.issues.length > 0 && (
                <div className="absolute left-0 top-full mt-2 z-40 w-84 rounded-2xl border border-white/[0.12] bg-[#0c0c14]/98 p-3.5 shadow-[0_25px_50px_rgba(0,0,0,0.95)] backdrop-blur-2xl space-y-2.5 animate-in fade-in zoom-in-95 duration-150">
                  <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
                    <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                      [ GRAPH DIAGNOSTICS ({diagnostics.issues.length}) ]
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowDiagnostics(false)}
                      className="text-xs font-mono text-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      Close
                    </button>
                  </div>
                  <div className="max-h-60 overflow-y-auto space-y-1.5 pr-0.5 custom-scrollbar">
                    {diagnostics.issues.map((issue, idx) => (
                      <button
                        key={`${issue.code}-${issue.nodeId ?? idx}`}
                        type="button"
                        onClick={() => {
                          if (issue.nodeId && onFocusNode) {
                            onFocusNode(issue.nodeId);
                          }
                          setShowDiagnostics(false);
                        }}
                        className="w-full text-left rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.15] p-2.5 space-y-1 transition-all"
                      >
                        <div className="flex items-center gap-1.5 text-[11px] font-mono font-semibold">
                          {issue.severity === "ERROR" ? (
                            <AlertCircle className="h-3 w-3 text-rose-400 shrink-0" />
                          ) : (
                            <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
                          )}
                          <span
                            className={
                              issue.severity === "ERROR"
                                ? "text-rose-300"
                                : "text-amber-300"
                            }
                          >
                            {issue.code}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-300 font-mono leading-snug">
                          {issue.message}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Lifecycle Badge */}
          {workflowId && (
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-mono font-medium tracking-tight shadow-sm flex items-center gap-1.5 ${
                publishedVersionNumber !== null
                  ? isActive
                    ? "border-white/20 bg-white/[0.08] text-zinc-100 shadow-[0_0_12px_rgba(255,255,255,0.06)]"
                    : "border-zinc-700 bg-zinc-800/40 text-zinc-400"
                  : "border-white/[0.1] bg-white/[0.04] text-zinc-400"
              }`}
              data-testid="workflow-lifecycle-badge"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  publishedVersionNumber !== null && isActive
                    ? "bg-white animate-pulse shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                    : publishedVersionNumber !== null
                    ? "bg-zinc-500"
                    : "bg-zinc-600"
                }`}
              />
              <span>
                {publishedVersionNumber !== null
                  ? `v${publishedVersionNumber} · ${isActive ? "Active" : "Paused"}`
                  : `Draft${draftRevision ? ` r${draftRevision}` : ""}`}
              </span>
            </span>
          )}

          {/* Unsaved / Drift Badges */}
          {hasUnsavedChanges ? (
            <span className="rounded-full border border-white/15 bg-white/[0.05] px-2 py-0.5 text-[10px] font-mono text-zinc-300">
              Unsaved edits
            </span>
          ) : (
            hasUnpublishedChanges &&
            publishedVersionNumber !== null && (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono text-amber-300">
                Draft differs from v{publishedVersionNumber}
              </span>
            )
          )}
        </div>

        {/* Right: Actions Hierarchy */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Pause / Activate */}
          {workflowId && publishedVersionNumber !== null && onToggleActive && (
            <button
              type="button"
              onClick={() => onToggleActive(!isActive)}
              disabled={isPending || isPublishing || isTogglingActive}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-mono font-semibold transition-all disabled:opacity-50 ${
                isActive
                  ? "border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200"
                  : "border-white/20 bg-white/[0.08] text-zinc-200 hover:bg-white/[0.15]"
              }`}
              title={isActive ? "Pause active workflow" : "Activate published workflow"}
            >
              {isTogglingActive ? (
                <Loader2 size={13} className="animate-spin" />
              ) : isActive ? (
                <PauseCircle size={13} />
              ) : (
                <PlayCircle size={13} />
              )}
              <span>{isActive ? "Pause" : "Activate"}</span>
            </button>
          )}

          {/* Publish */}
          {onPublish && (
            <button
              type="button"
              onClick={onPublish}
              disabled={
                isPending ||
                isPublishing ||
                isTogglingActive ||
                Boolean(diagnostics && !diagnostics.canPublish)
              }
              title={
                diagnostics && !diagnostics.canPublish
                  ? "Fix graph validation errors before publishing"
                  : hasUnsavedChanges || !workflowId
                  ? "Save draft and publish workflow version"
                  : "Publish an immutable version from the saved draft"
              }
              className="flex items-center gap-1.5 rounded-xl border border-white/20 bg-white/[0.08] px-3 py-1.5 text-xs font-mono font-semibold text-zinc-100 transition-all hover:bg-white/[0.15] disabled:cursor-not-allowed disabled:opacity-40 shadow-[0_0_12px_rgba(255,255,255,0.06)]"
            >
              {isPublishing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Rocket size={13} />
              )}
              <span>{isPublishing ? "Publishing..." : "Publish"}</span>
            </button>
          )}

          {/* Simulate */}
          {onOpenSimulation && (
            <button
              type="button"
              onClick={onOpenSimulation}
              disabled={!workflowId || isPending || isPublishing}
              className="flex items-center gap-1.5 rounded-xl border border-white/[0.12] bg-zinc-900/60 px-3 py-1.5 text-xs font-mono font-semibold text-zinc-200 transition-all hover:bg-zinc-800/80 hover:border-white/30 disabled:opacity-40 shadow-sm"
              title={
                !workflowId
                  ? "Save workflow to run simulation"
                  : "Run sandbox dry-run simulation without creating real data"
              }
            >
              <FlaskConical size={13} />
              <span>Simulate</span>
            </button>
          )}

          {/* Run Live (if active published) */}
          {workflowId && publishedVersionNumber !== null && isActive && (
            <RunWorkflowButton
              workflowId={workflowId}
              orgId={orgId}
              label="Run Live"
            />
          )}

          {/* Primary Save Button */}
          <button
            type="button"
            onClick={onSave}
            disabled={isPending || !canSave}
            className="flex items-center gap-1.5 rounded-xl bg-zinc-100 hover:bg-white px-3.5 py-1.5 text-xs font-mono font-bold tracking-wider text-zinc-950 shadow-[0_4px_20px_rgba(255,255,255,0.15)] transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 shrink-0"
          >
            {isPending ? (
              <Loader2 size={13} className="animate-spin text-zinc-950" />
            ) : (
              <Save size={13} className="text-zinc-950" />
            )}
            <span>
              {isPending
                ? "Saving..."
                : workflowId
                ? "Save Canvas"
                : "Save Workflow"}
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
