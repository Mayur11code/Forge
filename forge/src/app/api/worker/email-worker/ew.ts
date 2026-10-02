import { pusherServer } from "@/lib/pusher/pusher-server";
import { executeSendEmail } from "@/lib/emails/core-service";
import type { WorkerHandler } from "@/lib/events/worker";

export const emailWorkerHandler: WorkerHandler<"SEND_EMAIL"> = async ({
  event,
}) => {
  const { subject, body, userId } = event.data;
  console.log("📧 Sending background email...");

  try {
    const htmlTemplate = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9;">
        <h2 style="color: #333;">${subject}</h2>
        <p style="color: #555; font-size: 16px;">${body}</p>
      </div>
    `;

    // CALL THE SHARED CORE
    //
    // KNOWN DEFECT, deliberately not changed here: the recipient is hardcoded and
    // the SEND_EMAIL payload carries only userId, so every organisation's email
    // is delivered to one developer's personal inbox. Fixing it means resolving
    // userId to an address and deciding whether an org's mail should go to a
    // person at all - a product call, not a lint fix. The typed payload below is
    // what surfaced it: `orgId` is not a field of this event, so the previous
    // destructuring of it silently produced `undefined` and every completion was
    // broadcast to a channel literally named `org-undefined`.
    await executeSendEmail({
      to: "mayurnanda45@gmail.com",
      subject,
      html: htmlTemplate,
    });

    // Custom background job side-effect. No orgId on this event, so there is no
    // org channel to address; see the note above.
    await pusherServer.trigger(`org-${userId}`, "job-completed", {
      message: "Email sent successfully 🚀",
    });

  } catch (error) {
    console.error("❌ Email failed:", error);
    throw error; // Triggers QStash retry
  }
};