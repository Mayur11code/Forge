import { createUploadthing, type FileRouter } from "uploadthing/next";
import { z } from "zod";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { UTApi } from "uploadthing/server";
import { validateMagicBytes } from "@/lib/security/magic-bytes";
const f = createUploadthing();
const utapi = new UTApi();
// FileRouter is the type that will be used to ensure the correct configuration
//here f is the function that will be used to create the uploadthing instance, it can be named anything you want. The important part is that it is used to create the uploadthing instance and that it is used to define the uploadRouter.

export const uploadRouter = {
  taskAttachment: f({
    //taskAttachment is the name of the route, it can be named anything you want. 
    // The important part is that it is used to define the route and that it is used to configure the uploadthing instance for that route.
    image: { maxFileSize: "256MB" },
    pdf: { maxFileSize: "4MB" },




  }).input(
    z.object({
      orgSlug: z.string(),
      taskId: z.string(),
    })
  )

    .middleware(async ({ input }) => {
      const access = await getOrgAccess(input.orgSlug);

      if (!access) {
        throw new Error("Unauthorized");
      }
      if (access.membership.role === "MEMBER") {
        console.log("User does not have permission to upload attachments");
        throw new Error("Insufficient permissions");
      }

      return {
        userId: access.userId,
        orgId: access.organization.id,
        role: access.membership.role,
        taskId: input.taskId,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const allowedMimeTypes = [
        "application/pdf",
        "image/jpeg",
        "image/png",
      ];

      if (!allowedMimeTypes.includes(file.type)) {
        await utapi.deleteFiles(file.key);
        throw new Error("Invalid file type");
      }

      // Determine expected signature
  let expectedType: "pdf" | "jpg" | "png";

  if (file.type === "application/pdf") expectedType = "pdf";
  else if (file.type === "image/jpeg") expectedType = "jpg";
  else expectedType = "png";

  // Layer 2 — Magic byte check
  const isValid = await validateMagicBytes(file.url, expectedType);

  if (!isValid) {
    console.error(
      `SECURITY ALERT: User ${metadata.userId} attempted spoofed upload.`
    );

    await utapi.deleteFiles(file.key);
    throw new Error("File signature mismatch");
  }

      return {
        key: file.key,
        url: file.url,
        name: file.name,
        size: file.size,
        taskId: metadata.taskId,
      };
    }),
} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;