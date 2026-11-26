"use client";

import { useState } from "react";
import { ModalPortal } from "../organizations/components/ui/ModalPortal";
import { AttachmentUploader } from "./AttachmentUploader";
import { getAttachments, getSignedDownloadUrl, removeAttachment } from "@/app/actions/Tasks/attachments";
import {
  FileText,
  Image as ImageIcon,
  FileCode,
  Archive,
  Paperclip,
  Download,
  Trash2,
  Copy,
  Check,
  X,
  Plus,
  Files,
  Loader2,
} from "lucide-react";

type Attachment = {
  id: string;
  url: string;
  name: string;
  size: number;
  fileKey: string | null;
  createdAt?: Date;
};

interface TaskAttachmentsModalClientProps {
  taskId: string;
  taskTitle?: string;
  compact?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)) {
    return <ImageIcon className="w-4 h-4 text-cyan-400 shrink-0" />;
  }
  if (["ts", "tsx", "js", "jsx", "json", "py", "rs", "go", "sql", "sh"].includes(ext)) {
    return <FileCode className="w-4 h-4 text-amber-400 shrink-0" />;
  }
  if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) {
    return <Archive className="w-4 h-4 text-purple-400 shrink-0" />;
  }
  return <FileText className="w-4 h-4 text-blue-400 shrink-0" />;
}

export function TaskAttachmentsModalClient({
  taskId,
  taskTitle,
  compact = false,
}: TaskAttachmentsModalClientProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"list" | "upload">("list");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function loadAttachments() {
    setLoading(true);
    try {
      const items = await getAttachments(taskId);
      setAttachments(items);
    } catch (err) {
      console.error("[LOAD_ATTACHMENTS_ERROR]:", err);
    } finally {
      setLoading(false);
    }
  }

  function handleOpen() {
    setOpen(true);
    setActiveTab("list");
    void loadAttachments();
  }

  async function handleDownload(file: Attachment) {
    try {
      setDownloadingId(file.id);
      let targetUrl = file.url;
      if (file.fileKey) {
        targetUrl = await getSignedDownloadUrl(file.fileKey);
      }
      window.open(targetUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("[DOWNLOAD_FAILED]:", err);
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleCopyLink(file: Attachment) {
    try {
      let targetUrl = file.url;
      if (file.fileKey) {
        targetUrl = await getSignedDownloadUrl(file.fileKey);
      }
      await navigator.clipboard.writeText(targetUrl);
      setCopiedId(file.id);
      setTimeout(() => setCopiedId(null), 2500);
    } catch (err) {
      console.error("[COPY_LINK_FAILED]:", err);
    }
  }

  async function handleDelete(fileId: string) {
    if (!confirm("Are you sure you want to delete this attachment? This cannot be undone.")) return;
    try {
      setDeletingId(fileId);
      await removeAttachment(fileId);
      setAttachments((prev) => prev.filter((a) => a.id !== fileId));
    } catch (err) {
      console.error("[DELETE_FAILED]:", err);
      alert(err instanceof Error ? err.message : "Failed to delete attachment.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      {compact ? (
        <button
          onClick={handleOpen}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs transition-colors shrink-0"
          title="Task Attachments"
        >
          <Paperclip className="w-3 h-3 text-zinc-500" />
          <span className="text-[11px] font-mono">
            {attachments.length > 0 ? attachments.length : "0"}
          </span>
        </button>
      ) : (
        <button
          onClick={handleOpen}
          className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-800/60 hover:border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 transition-all duration-200"
          title="Manage Task Attachments"
        >
          <Paperclip className="w-3 h-3 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
          <span>Attachments</span>
          {attachments.length > 0 && (
            <span className="ml-0.5 px-1.5 py-0.2 rounded-full bg-zinc-800 text-[10px] text-zinc-300 font-mono">
              {attachments.length}
            </span>
          )}
        </button>
      )}

      {open && (
        <ModalPortal>
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/75 backdrop-blur-sm transition-opacity"
              onClick={() => setOpen(false)}
            />

            {/* Modal Dialog */}
            <div className="relative z-10 w-full max-w-lg rounded-2xl bg-zinc-950 border border-zinc-800/90 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/30">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-lg bg-zinc-800 border border-zinc-700/50 text-zinc-200">
                    <Paperclip className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Task Attachments
                    </h3>
                    {taskTitle && (
                      <p className="text-[11px] text-zinc-400 truncate max-w-xs">
                        {taskTitle}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900 text-[10px] font-mono text-zinc-400">
                    {attachments.length} {attachments.length === 1 ? "file" : "files"}
                  </span>
                  <button
                    onClick={() => setOpen(false)}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Navigation Tabs */}
              <div className="flex border-b border-zinc-800/80 bg-zinc-900/10 px-6 pt-2">
                <button
                  onClick={() => setActiveTab("list")}
                  className={`flex items-center gap-1.5 pb-2.5 px-1 border-b-2 text-xs font-mono transition-colors ${
                    activeTab === "list"
                      ? "border-white text-white font-medium"
                      : "border-transparent text-zinc-400 hover:text-zinc-300"
                  }`}
                >
                  <Files className="w-3.5 h-3.5" />
                  <span>Files ({attachments.length})</span>
                </button>

                <button
                  onClick={() => setActiveTab("upload")}
                  className={`flex items-center gap-1.5 pb-2.5 px-1 ml-6 border-b-2 text-xs font-mono transition-colors ${
                    activeTab === "upload"
                      ? "border-white text-white font-medium"
                      : "border-transparent text-zinc-400 hover:text-zinc-300"
                  }`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Upload File</span>
                </button>
              </div>

              {/* Body Content */}
              <div className="p-6 overflow-y-auto space-y-4 flex-1">
                {activeTab === "upload" ? (
                  <div className="space-y-4">
                    <AttachmentUploader
                      taskId={taskId}
                      onUploadSuccess={() => {
                        void loadAttachments();
                        setActiveTab("list");
                      }}
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    {loading ? (
                      <div className="py-12 flex flex-col items-center justify-center text-zinc-500 space-y-2">
                        <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
                        <span className="text-xs font-mono">Syncing attachment catalog...</span>
                      </div>
                    ) : attachments.length === 0 ? (
                      <div className="py-10 border border-dashed border-zinc-800/80 rounded-xl flex flex-col items-center justify-center text-center p-6 bg-zinc-900/10">
                        <div className="p-3 rounded-full bg-zinc-900 text-zinc-500 mb-3 border border-zinc-800">
                          <Paperclip className="w-5 h-5" />
                        </div>
                        <p className="text-xs font-medium text-zinc-300 mb-1">
                          No attachments linked yet
                        </p>
                        <p className="text-[11px] text-zinc-500 max-w-xs mb-4">
                          Attach architecture diagrams, reproduction logs, specs, or datasets.
                        </p>
                        <button
                          onClick={() => setActiveTab("upload")}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition-colors"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Upload first file</span>
                        </button>
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {attachments.map((file) => (
                          <li
                            key={file.id}
                            className="group flex items-center justify-between gap-3 p-3 rounded-xl border border-zinc-800/70 bg-zinc-900/30 hover:bg-zinc-900/60 hover:border-zinc-700 transition-all duration-200"
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800/80 shrink-0">
                                {getFileIcon(file.name)}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium text-zinc-200 truncate">
                                  {file.name}
                                </p>
                                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                                  {formatBytes(file.size)}
                                </p>
                              </div>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => handleDownload(file)}
                                disabled={downloadingId === file.id}
                                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                                title="Download File"
                              >
                                {downloadingId === file.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Download className="w-3.5 h-3.5" />
                                )}
                              </button>

                              <button
                                onClick={() => handleCopyLink(file)}
                                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                                title="Copy Download Link"
                              >
                                {copiedId === file.id ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>

                              <button
                                onClick={() => handleDelete(file.id)}
                                disabled={deletingId === file.id}
                                className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                                title="Delete Attachment"
                              >
                                {deletingId === file.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-3 border-t border-zinc-800/80 bg-zinc-900/30 flex items-center justify-between text-[11px] font-mono text-zinc-500">
                <span>DURABLE STORAGE · S3 BACKED</span>
                <button
                  onClick={() => setOpen(false)}
                  className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
