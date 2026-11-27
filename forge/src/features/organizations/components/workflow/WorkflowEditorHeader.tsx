"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Pencil, Save, X } from "lucide-react";
import RunWorkflowButton from "./RunWorkflowButton";

interface WorkflowEditorHeaderProps {
  workflowId?: string;
  orgId: string;
  name: string;
  description: string | null;
  isPending: boolean;
  canSave: boolean;
  onCommitName: (nextName: string) => void;
  onCommitDescription: (nextDescription: string | null) => void;
  onSave: () => void;
}

export default function WorkflowEditorHeader({
  workflowId,
  orgId,
  name,
  description,
  isPending,
  canSave,
  onCommitName,
  onCommitDescription,
  onSave,
}: WorkflowEditorHeaderProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState(description ?? "");
  const descInputRef = useRef<HTMLInputElement>(null);

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
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 bg-[#0d0d10] px-5 py-3 shrink-0">
      <div className="min-w-0 flex-1 space-y-1">
        {/* Inline Workflow Name */}
        <div className="flex items-center gap-2">
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
                className="rounded-md border border-blue-500/60 bg-zinc-900 px-2.5 py-1 text-sm font-semibold text-white outline-none focus:border-blue-400 min-w-[220px]"
              />
              <button
                type="button"
                aria-label="Confirm workflow name"
                onMouseDown={(e) => e.preventDefault()}
                onClick={confirmNameEdit}
                className="rounded p-1 text-emerald-400 hover:bg-zinc-800"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="Cancel workflow name edit"
                onMouseDown={(e) => e.preventDefault()}
                onClick={cancelNameEdit}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingName(true)}
              className="group inline-flex items-center gap-2 rounded-md px-1.5 py-0.5 -ml-1.5 text-left hover:bg-zinc-800/70 transition-colors"
              title="Click to rename workflow"
            >
              <span className="truncate text-base font-semibold text-white max-w-[360px]">
                {name}
              </span>
              <Pencil className="h-3.5 w-3.5 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          )}
        </div>

        {/* Inline Workflow Description */}
        <div>
          {isEditingDesc ? (
            <div className="flex items-center gap-1.5">
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
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 text-xs text-zinc-200 placeholder-zinc-500 outline-none focus:border-blue-500 w-full max-w-md"
              />
              <button
                type="button"
                aria-label="Confirm workflow description"
                onMouseDown={(e) => e.preventDefault()}
                onClick={confirmDescEdit}
                className="rounded p-1 text-emerald-400 hover:bg-zinc-800"
              >
                <Check className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label="Cancel workflow description edit"
                onMouseDown={(e) => e.preventDefault()}
                onClick={cancelDescEdit}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingDesc(true)}
              className="group inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 -ml-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 transition-colors"
              title="Click to edit workflow description"
            >
              <span className="truncate max-w-md">
                {description ? description : "Add a workflow description..."}
              </span>
              <Pencil className="h-3 w-3 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          )}
        </div>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-3 shrink-0">
        {workflowId && (
          <RunWorkflowButton workflowId={workflowId} orgId={orgId} />
        )}

        <button
          type="button"
          onClick={onSave}
          disabled={isPending || !canSave}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg transition-all hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Save size={16} />
          )}
          {isPending
            ? "Saving..."
            : workflowId
            ? "Save Canvas"
            : "Save Workflow"}
        </button>
      </div>
    </div>
  );
}
