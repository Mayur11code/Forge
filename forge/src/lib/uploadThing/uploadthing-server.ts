import { UTApi } from "uploadthing/server";

// This singleton allows our QStash workers to bypass the frontend
// and upload buffers directly to your UploadThing project.
export const utapi = new UTApi();