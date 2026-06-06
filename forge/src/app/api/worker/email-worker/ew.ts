import { pusherServer } from "@/lib/pusher/pusher-server";
import { executeSendEmail } from "@/lib/emails/core-service";

export async function emailWorkerHandler({ event }: { event: any }) {
  if (event.type !== "SEND_EMAIL") return;
  
  const { subject, body, orgId } = event.data;
  console.log("📧 Sending background email...");

  try {
    const htmlTemplate = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9;">
        <h2 style="color: #333;">${subject}</h2>
        <p style="color: #555; font-size: 16px;">${body}</p>
      </div>
    `;

    // CALL THE SHARED CORE
    await executeSendEmail({
      to: "mayurnanda45@gmail.com", // Or dynamic from event
      subject,
      html: htmlTemplate,
    });

    // Custom background job side-effect
    await pusherServer.trigger(`org-${orgId}`, "job-completed", {
      message: "Email sent successfully 🚀",
    });

  } catch (error) {
    console.error("❌ Email failed:", error);
    throw error; // Triggers QStash retry
  }
}