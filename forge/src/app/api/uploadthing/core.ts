import { createUploadthing, type FileRouter } from "uploadthing/next";
import { z } from "zod";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { UTApi } from "uploadthing/server";
import { validateMagicBytes } from "@/lib/security/magic-bytes";
import { db } from "@/lib/prisma/db";
import { metadata } from "@/app/layout";
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
      fileSize: z.number().min(1, "File size must be greater than 0"),
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

      //STORAGE QUOTA CHEECK, it is being done in middleware because we want to prevent the upload from happening if the user has exceeded their storage quota. This way we can save bandwidth and storage space. We check the storage limit and storage used for the organization, and if the storage used is greater than or equal to the storage limit, we throw an error and prevent the upload from happening.
      const fileSize = BigInt(input.fileSize);

      //Extra defensive check to prevent large files from being uploaded, even though the client should prevent this, we want to make sure that it is also checked on the server. This is to prevent any malicious user from bypassing the client-side checks and uploading large files that could potentially fill up our storage and cause issues for other users.
      if (fileSize > BigInt(4 * 1024 * 1024)) {
        throw new Error("File too large");
      }


      const limit = access.organization.storageLimit;

      const result = await db.organization.updateMany({
        where: {
          id: access.organization.id,
          storageUsed: {
            lte: limit - fileSize,
          },
        },
        data: {
          storageUsed: { increment: fileSize },
        },
      });

      if (result.count === 0) {
        throw new Error("Storage quota exceeded");
      }


      return {
        userId: access.userId,
        orgId: access.organization.id,
        role: access.membership.role,
        taskId: input.taskId,
        fileSize: input.fileSize,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {

      try {
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
      } catch (error) {
        // 🔥 REFUND LOGIC

        await utapi.deleteFiles(file.key); // delete from storage

        await db.organization.update({
          where: { id: metadata.orgId },
          data: {
            storageUsed: { decrement: metadata.fileSize },
          },
        });

        throw error;
      }
    }),

  orgLogo: f({
    image: { maxFileSize: "4MB" },
  })
    .input(
      z.object({
        orgSlug: z.string(),
      })
    )
    .middleware(async ({ input }) => {
      const access = await getOrgAccess(input.orgSlug);

      if (!access) throw new Error("Unauthorized");

      if (access.membership.role !== "ADMIN") {
        throw new Error("Only admins can change logo");
      }

      return {
        orgId: access.organization.id,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      return {
        key: file.key,
        url: file.url,
        orgId: metadata.orgId,
      };
    }),

  userAvatar: f({
    image: { maxFileSize: "4MB" },
  })
    .input(
      z.object({
        userId: z.string(),
        OrgId : z.string(),
      })
    )
    .middleware(async ({ input }) => {
      const session = await getOrgAccess(input.OrgId);
      if (!session) {
        throw new Error("Unauthorized");
      }

      if (session.userId !== input.userId) {
        throw new Error("Forbidden");
      }

      return { userId: input.userId };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      return {
        url: file.url,
        key: file.key,
        userId: metadata.userId,
      };
    }),


} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;