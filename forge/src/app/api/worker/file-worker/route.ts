import { createWorker } from "@/lib/events/worker";
import { publishEvent } from "@/lib/events/queue";
import { db } from "@/lib/prisma/db";

export const POST = createWorker("FILE_UPLOADED", async ({ event }) => {
  const { fileId } = event.data;

  const file = await db.attachment.findUnique({
    where: { id: fileId },
    include: {
      task: {
        select: {
          project: { select: { orgId: true } }
        }
      }
    }
  });

  if (!file) throw new Error("File not found");

  const orgId = file.task?.project?.orgId;
  if (!orgId) throw new Error("Missing orgId");

  // Extract content
  const extractedText = `Content of file: ${file.name}`;

  // Trigger AI
  await publishEvent("EMBEDDING_REQUESTED", {
    orgId,
    entityId: fileId,
    type: "ATTACHMENT",
  });
});