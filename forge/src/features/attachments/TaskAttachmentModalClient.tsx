"use client";

import { useEffect, useState } from "react";
import { ModalPortal } from "../organizations/components/ui/ModalPortal";
import { AttachmentUploader } from "./AttachmentUploader";
import { getAttachments } from "@/app/actions/attachments";
import { FileText, Image as ImageIcon } from "lucide-react";

type Attachment = {
  id: string;
  url: string;
  name: string;
  size: number;
};

export function TaskAttachmentsModalClient({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);


//If we didn;t want the useEffevct
//  ( which we don;t need because useEffect is buggy, You may use SWR or tanstack instead)
//You would have to use the other type of modal (intercepting routes)

  async function loadAttachments() {
    setLoading(true);
    const data = await getAttachments(taskId);
    setAttachments(data);
    setLoading(false);
  }

  useEffect(() => {
    if (open) loadAttachments();
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        📎 Attachments
      </button>

      {open && (
        <ModalPortal>
          <div className="fixed inset-0 z-[100] flex items-center justify-center">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />

            {/* Modal */}
            <div className="relative z-10 w-full max-w-md rounded-xl bg-zinc-950 border border-zinc-800 p-5 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-zinc-100 font-semibold">Attachments</h3>
                <button
                  onClick={() => setOpen(false)}
                  className="text-zinc-500 hover:text-zinc-300"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-4">
                {/* Upload */}
                <AttachmentUploader taskId={taskId} />

                {/* List */}
                {loading ? (
                  <p className="text-sm text-zinc-500">Loading…</p>
                ) : attachments.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    No attachments yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {attachments.map((file) => {
                      const isImage = /\.(png|jpg|jpeg|webp)$/i.test(file.url);
                      const Icon = isImage ? ImageIcon : FileText;

                      return (
                        <li key={file.id}>
                          <a
                            href={file.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="
                              flex items-center gap-2
                              rounded-md border border-zinc-800
                              bg-zinc-900/40 px-3 py-2
                              text-sm text-zinc-300
                              hover:bg-zinc-800/50
                              transition
                            "
                          >
                            <Icon className="w-4 h-4 text-zinc-400" />
                            <span className="truncate">{file.name}</span>
                            <span className="ml-auto text-xs text-zinc-500">
                              {(file.size / 1024 / 1024).toFixed(1)} MB
                            </span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
