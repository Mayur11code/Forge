"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Settings, X, Archive, ArchiveRestore, Trash2, AlertTriangle, Loader2 } from "lucide-react";
import { updateProject, archiveProject, unarchiveProject, deleteProject } from "@/app/actions/projects/projectActions";
import { ModalPortal } from "@/features/organizations/components/ui/ModalPortal";

interface ProjectSettingsModalProps {
  orgSlug: string;
  project: {
    id: string;
    name: string;
    description: string | null;
    archivedAt?: Date | string | null;
  };
  triggerClassName?: string;
  onUpdated?: () => void;
  onDeleted?: () => void;
}

export default function ProjectSettingsModal({
  orgSlug,
  project,
  triggerClassName,
  onUpdated,
  onDeleted,
}: ProjectSettingsModalProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"general" | "archive" | "danger">("general");

  // Form states
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || "");
  const [confirmDeleteName, setConfirmDeleteName] = useState("");
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [isPending, startTransition] = useTransition();

  const isArchived = Boolean(project.archivedAt);

  const handleOpen = () => {
    setName(project.name);
    setDescription(project.description || "");
    setConfirmDeleteName("");
    setStatusMessage(null);
    setIsOpen(true);
  };

  const handleClose = () => {
    if (!isPending) {
      setIsOpen(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);

    startTransition(async () => {
      const res = await updateProject(orgSlug, {
        projectId: project.id,
        name,
        description: description || null,
      });

      if (res.success) {
        setStatusMessage({ type: "success", text: "Project updated successfully." });
        router.refresh();
        if (onUpdated) onUpdated();
      } else {
        setStatusMessage({ type: "error", text: res.error || "Failed to update project." });
      }
    });
  };

  const handleArchiveToggle = async () => {
    setStatusMessage(null);
    startTransition(async () => {
      const res = isArchived
        ? await unarchiveProject(orgSlug, project.id)
        : await archiveProject(orgSlug, project.id);

      if (res.success) {
        setStatusMessage({
          type: "success",
          text: isArchived ? "Project restored to active." : "Project archived successfully.",
        });
        router.refresh();
        if (onUpdated) onUpdated();
      } else {
        setStatusMessage({ type: "error", text: res.error || "Failed to update archival status." });
      }
    });
  };

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (confirmDeleteName.trim() !== project.name.trim()) return;

    setStatusMessage(null);
    startTransition(async () => {
      const res = await deleteProject(orgSlug, project.id, confirmDeleteName);

      if (res.success) {
        setIsOpen(false);
        if (onDeleted) {
          onDeleted();
        } else {
          router.push(`/org/${orgSlug}/projects`);
          router.refresh();
        }
      } else {
        setStatusMessage({ type: "error", text: res.error || "Failed to delete project." });
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={
          triggerClassName ||
          "inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
        }
        title="Project Settings"
      >
        <Settings className="w-3.5 h-3.5" />
        <span>Settings</span>
      </button>

      {isOpen && (
        <ModalPortal>
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 shadow-2xl space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
              <div className="space-y-0.5">
                <h3 className="text-lg font-semibold tracking-tight text-white flex items-center gap-2">
                  <Settings className="w-4 h-4 text-zinc-400" />
                  Project Settings
                </h3>
                <p className="text-xs text-zinc-400">
                  Manage metadata, archival, and lifecycle for <span className="text-zinc-200 font-medium">{project.name}</span>
                </p>
              </div>

              <button
                type="button"
                onClick={handleClose}
                disabled={isPending}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-2 border-b border-zinc-800/60 pb-2">
              <button
                type="button"
                onClick={() => { setActiveTab("general"); setStatusMessage(null); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  activeTab === "general"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                General
              </button>
              <button
                type="button"
                onClick={() => { setActiveTab("archive"); setStatusMessage(null); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  activeTab === "archive"
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Archival
              </button>
              <button
                type="button"
                onClick={() => { setActiveTab("danger"); setStatusMessage(null); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  activeTab === "danger"
                    ? "bg-red-950/60 text-red-300 border border-red-900/50"
                    : "text-red-400/80 hover:text-red-300"
                }`}
              >
                Danger Zone
              </button>
            </div>

            {/* Feedback Message */}
            {statusMessage && (
              <div
                className={`p-3 rounded-lg text-xs font-medium ${
                  statusMessage.type === "success"
                    ? "bg-emerald-950/50 text-emerald-300 border border-emerald-900/60"
                    : "bg-red-950/50 text-red-300 border border-red-900/60"
                }`}
              >
                {statusMessage.text}
              </div>
            )}

            {/* General Tab */}
            {activeTab === "general" && (
              <form onSubmit={handleUpdate} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-400">Project Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={100}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-400">Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder="Describe the scope of this project..."
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-600 focus:outline-none resize-none"
                  />
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={isPending}
                    className="rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isPending || !name.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-white disabled:opacity-50 transition-colors"
                  >
                    {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Save Changes
                  </button>
                </div>
              </form>
            )}

            {/* Archive Tab */}
            {activeTab === "archive" && (
              <div className="space-y-4">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    {isArchived ? (
                      <ArchiveRestore className="w-4 h-4 text-amber-400" />
                    ) : (
                      <Archive className="w-4 h-4 text-zinc-400" />
                    )}
                    <span>{isArchived ? "Unarchive Project" : "Archive Project"}</span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    {isArchived
                      ? "Restoring this project will make its tasks and workflows active and visible across normal team boards again."
                      : "Archiving hides this project and its tasks from normal views and pauses active automated triggers. No data will be deleted."}
                  </p>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={isPending}
                    className="rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleArchiveToggle}
                    disabled={isPending}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-colors ${
                      isArchived
                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30"
                        : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white"
                    }`}
                  >
                    {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    {isArchived ? "Restore to Active" : "Archive This Project"}
                  </button>
                </div>
              </div>
            )}

            {/* Danger Zone Tab */}
            {activeTab === "danger" && (
              <form onSubmit={handleDelete} className="space-y-4">
                <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-red-400">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Permanent Project Deletion</span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    This action is destructive and irreversible. It will permanently delete this project, all associated tasks, comments, and queued attachments from storage.
                  </p>
                  <div className="pt-1">
                    <p className="text-xs text-zinc-300 font-medium mb-1.5">
                      To confirm, type <span className="font-mono text-red-400 font-semibold select-all">&quot;{project.name}&quot;</span> below:
                    </p>
                    <input
                      type="text"
                      value={confirmDeleteName}
                      onChange={(e) => setConfirmDeleteName(e.target.value)}
                      placeholder={project.name}
                      className="w-full rounded-lg border border-red-900/60 bg-black/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-red-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={isPending}
                    className="rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isPending || confirmDeleteName.trim() !== project.name.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-40 transition-colors shadow-lg shadow-red-950/50"
                  >
                    {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Delete Project
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </ModalPortal>
    )}
    </>
  );
}
