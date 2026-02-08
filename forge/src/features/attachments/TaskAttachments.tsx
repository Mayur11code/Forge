// import { db } from "@/lib/prisma/db";
// import { TaskAttachmentsModalClient } from "./TaskAttachmentModalClient";

// export async function TaskAttachments({ taskId }: { taskId: string }) {
//   const attachments = await db.attachment.findMany({
//     where: { taskId },
//     orderBy: { createdAt: "desc" },
//   });

//   return (
//     <TaskAttachmentsModalClient
//       taskId={taskId}
//       attachments={attachments}
//     />
//   );
// }


//Didn't work because we can't wrap a server component with a client component. We need to fetch the attachments in the client component instead. 
// So we will move the data fetching logic to the TaskAttachmentsModalClient component and make it a client component.
//This is why i made the TaskAttachmentsModalClient component a client component and moved the data fetching logic there. 
// Now the TaskAttachments component is just a wrapper that renders the TaskAttachmentsModalClient component, and the TaskAttachmentsModalClient component is responsible for fetching the attachments and rendering them.
//it uses useeffect