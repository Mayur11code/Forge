"use client";

import { UploadButton } from "@uploadthing/react";
import type { UploadRouter } from "@/app/api/uploadthing/core";
import { createAttachment } from "@/app/actions/attachments";
import { useOrgSlug } from "@/contexts/OrgContext";
import { useState } from "react";


export function AttachmentUploader({ taskId }: { taskId: string }) {
  const orgSlug = useOrgSlug();
  const [fileSize, setFileSize] = useState<number | null>(null);


  return (
    <UploadButton<UploadRouter, "taskAttachment">
      endpoint="taskAttachment"
    onBeforeUploadBegin={(files) => {
        if (files.length === 0) return files;
        //since we allow muhltiple files we need to sum up the file sizes to check against the storage quota in the middleware. We capture the total file size and send it to the middleware through the input object. This way we can prevent the upload from happening if the user has exceeded their storage quota.
        setFileSize(files.reduce((sum, f) => sum + f.size, 0));
         // 👈 capture size
        return files; // must return files
      }}

      input={{
    orgSlug: orgSlug,
    taskId: taskId,
    fileSize: fileSize ?? 0, // 👈 send to middleware
  }}
      onClientUploadComplete={async (res) => {
        if (!res?.length) return;

        const file = res[0];

        await createAttachment({
          taskId,
          url: file.url,
          name: file.name,
          size: file.size,
          fileKey : file.key,
        });
      }}
      onUploadError={(error) => {
        console.error(error);
        alert("Upload failed");
      }}
    />
  );
}
