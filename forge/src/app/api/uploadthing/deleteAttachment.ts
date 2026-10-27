// src/app/api/uploadthing/deleteAttachment.ts
import { auth } from "@/lib/auth/auth";
import { deleteAttachmentTransactionally } from "@/lib/deletion/service";

// S9 (security) — this function had no authorization. It has no caller in the
// repository today (so it is not HTTP-reachable), but it is a destructive,
// tenant-scoped operation and is hardened defensively: the caller must be a
// member of the organization that owns the attachment's task.
//
// H4.5: Redesigned around the transactional domain outbox. The database deletion,
// storage-quota refund, and durable cleanup intent commit atomically in PostgreSQL.
// External cleanup (Pinecone vectors + UploadThing file) is executed synchronously
// where possible, with guaranteed asynchronous background recovery if external
// systems fail.
export async function deleteAttachment(id: string) {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      throw new Error("Unauthorized");
    }

    return await deleteAttachmentTransactionally(id, userId);
  } catch (error) {
    console.error("[DELETE_ATTACHMENT_ERROR]:", error);
    throw new Error(error instanceof Error ? error.message : "Internal Server Error");
  }
}
