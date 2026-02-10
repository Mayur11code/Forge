import { db } from "@/lib/prisma/db";
import { UTApi } from "uploadthing/server";

const utapi = new UTApi();

export async function deleteAttachment(id: string) {
  try {
    // 1. NESTED FETCH: We jump from Attachment -> Task -> Project in one query.
    // This is more efficient than multiple separate await calls.
    const file = await db.attachment.findUnique({
      where: { id },
      select: {
        fileKey: true,
        size: true,
        task: {
          select: {
            project: {
              select: { orgId: true }
            }
          }
        }
      }
    });

    // 2. GUARD CLAUSES: Check for existence and the required UploadThing key.
    if (!file) throw new Error("Attachment record not found in database.");
    if (!file.fileKey) throw new Error("No remote file key associated with this record.");

    const orgId = file.task.project.orgId;

    // 3. CLOUD DELETION: Remove the physical file from UploadThing first.
    // We do this before the DB transaction because if this fails, we want to stop.
    const utResponse = await utapi.deleteFiles(file.fileKey);
    if (!utResponse.success) {
      throw new Error("Failed to delete file from cloud storage.");
    }

    // 4. ATOMIC TRANSACTION: Both DB operations must succeed together.
    // If the refund fails, the record deletion is rolled back (undone).
    await db.$transaction([
      // Remove the metadata record
      db.attachment.delete({
        where: { id },
      }),
      // Decrement the organization's storage usage
      db.organization.update({
        where: { id: orgId },
        data: {
          // Use BigInt because your schema defines storage as BigInt
          storageUsed: { decrement: BigInt(file.size) },
        },
      }),
    ]);

    return { success: true, message: "File deleted and quota updated." };

  } catch (error) {
    // 5. ERROR HANDLING: Log the error and return a clear message to the UI.
    console.error("[DELETE_ATTACHMENT_ERROR]:", error);
    throw new Error(error instanceof Error ? error.message : "Internal Server Error");
  }
}