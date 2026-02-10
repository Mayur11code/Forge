"use client";

import { UploadButton } from "@uploadthing/react";
import type { UploadRouter } from "@/app/api/uploadthing/core";
import { createAttachment } from "@/app/actions/attachments";
import { useOrgSlug } from "@/contexts/OrgContext";

export function AttachmentUploader({ taskId }: { taskId: string }) {
  const orgSlug = useOrgSlug();

  return (
    <UploadButton<UploadRouter, "taskAttachment">
      endpoint="taskAttachment"
      input={{
    orgSlug: orgSlug,
    taskId: taskId,
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
