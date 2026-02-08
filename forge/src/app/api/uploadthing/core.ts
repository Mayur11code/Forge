import { createUploadthing, type FileRouter } from "uploadthing/next";

const f = createUploadthing();
// FileRouter is the type that will be used to ensure the correct configuration
//here f is the function that will be used to create the uploadthing instance, it can be named anything you want. The important part is that it is used to create the uploadthing instance and that it is used to define the uploadRouter.

export const uploadRouter = {
  taskAttachment: f({
    //taskAttachment is the name of the route, it can be named anything you want. 
    // The important part is that it is used to define the route and that it is used to configure the uploadthing instance for that route.
    image: { maxFileSize: "256MB" },
    pdf: { maxFileSize: "4MB" },
    //This is where you can configure the file types and their respective max file sizes for the taskAttachment route. 
    //You can add as many file types as you want, and you can configure them differently if needed.
  }).middleware(() => {
    return { isPrivate: true };
  })
    .onUploadComplete(async ({ file }) => {
      // v7: still NO database work here
      return {
        url: file.url,
        name: file.name,
        size: file.size,
        fileKey: file.key
      };
    }),
} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;
