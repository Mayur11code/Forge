import { db } from "@/lib/prisma/db";
import { UTApi } from "uploadthing/server";
const utapi = new UTApi();

export async function deleteAttachment(id: string) {
  const file = await db.attachment.findUnique({
    where: { id },
  });

  if (!file) throw new Error("File not found");
//Extra defensive check to prevent errors in case the fileKey is missing, even though it should never be missing if the file record exists. This is just to prevent any potential issues with the UploadThing API if we try to delete a file without a fileKey.
  if (!file.fileKey) {
  throw new Error("Missing file key");
}


  // Delete from storage
  await utapi.deleteFiles(file.fileKey);

  // Delete DB record
  await db.attachment.delete({
    where: { id },
  });

  // Refund storage
  await db.organization.update({
    where: { id: file.orgId },
    data: {
      storageUsed: { decrement: BigInt(file.size) },
    },
  });
}


//USE THIS FOR DELETE FUNCITONALITY IN THE UI, IT WILL CALL THIS SERVER ACTION TO DELETE THE FILE FROM STORAGE AND DELETE THE DB RECORD AND REFUND THE STORAGE QUOTA FOR THE ORGANIZATION. MAKE SURE TO PASS THE FILE ID TO THIS FUNCTION TO DELETE THE CORRECT FILE.