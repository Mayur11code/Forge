import { createRouteHandler } from "uploadthing/next";
import { uploadRouter } from "./core";

export const { GET, POST } = createRouteHandler({
//Next.js uses route.js to define API routes. this is why we are creating a route handler here.
//GET is used by uploadThing to validate the upload request before the actual upload happens, and POST is used to handle the actual file upload.
//POST is the method that will be called when the file is being uploaded, and GET is the method that will be called when the upload request is being validated.
//POST IS FOR METADATA, GET IS FOR VALIDATION.


  router: uploadRouter,
  //This is the only configuration option required here. 
  // You are passing your specific "ruleset" (the uploadRouter) into the handler 
  // so it knows how to validate requests.
});
