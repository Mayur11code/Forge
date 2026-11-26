"use client";

import { UploadDropzone } from "@uploadthing/react";
import type { UploadRouter } from "@/app/api/uploadthing/core";
import { createAttachment } from "@/app/actions/Tasks/attachments";
import { useOrgSlug } from "@/contexts/OrgContext";
import { useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

interface AttachmentUploaderProps {
  taskId: string;
  onUploadSuccess?: () => void;
}

export function AttachmentUploader({ taskId, onUploadSuccess }: AttachmentUploaderProps) {
  const orgSlug = useOrgSlug();
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {errorMessage && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs font-mono">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs font-mono">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{successMessage}</span>
        </div>
      )}

      <UploadDropzone<UploadRouter, "taskAttachment">
        endpoint="taskAttachment"
        onBeforeUploadBegin={(files) => {
          setErrorMessage(null);
          setSuccessMessage(null);
          if (files.length === 0) return files;
          setFileSize(files.reduce((sum, f) => sum + f.size, 0));
          return files;
        }}
        input={{
          orgSlug: orgSlug,
          taskId: taskId,
          fileSize: fileSize ?? 0,
        }}
        appearance={{
          container:
            "border border-dashed border-zinc-800 hover:border-zinc-700 bg-zinc-900/30 hover:bg-zinc-900/50 transition-all rounded-xl p-6 cursor-pointer text-center",
          uploadIcon: "text-zinc-500 w-8 h-8 mb-2 mx-auto",
          label: "text-xs font-medium text-zinc-300 hover:text-white transition-colors",
          allowedContent: "text-[11px] text-zinc-500 font-mono mt-1",
          button:
            "mt-3 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono rounded-lg transition-colors ut-uploading:opacity-50",
        }}
        content={{
          label({ isDragActive }) {
            return isDragActive
              ? "Drop files to attach to task..."
              : "Drop files here or click to browse";
          },
          allowedContent() {
            return "Documents, images, specs, logs (up to 8MB)";
          },
          button({ isUploading }) {
            return isUploading ? "Uploading..." : "Upload Selected";
          },
        }}
        onClientUploadComplete={async (res) => {
          if (!res?.length) return;
          try {
            for (const file of res) {
              await createAttachment({
                taskId,
                url: file.url,
                name: file.name,
                size: file.size,
                fileKey: file.key,
              });
            }
            setSuccessMessage(`Successfully uploaded ${res.length} file${res.length > 1 ? "s" : ""}.`);
            onUploadSuccess?.();
            setTimeout(() => setSuccessMessage(null), 4000);
          } catch (err) {
            setErrorMessage(err instanceof Error ? err.message : "Failed to persist attachment record.");
          }
        }}
        onUploadError={(error) => {
          setErrorMessage(error?.message || "Upload failed. Please check network and file size.");
        }}
      />
    </div>
  );
}
