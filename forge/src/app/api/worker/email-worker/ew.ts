import { createWorker } from "@/lib/events/worker";
import { resend } from "@/lib/emails/email";
import { pusherServer } from "@/lib/pusher/pusher-server";

export async function emailWorkerHandler({ event }: { event: any }) {
  if(event.type !== "SEND_EMAIL") {
    return; // Ignore irrelevant events
  }
  const { subject, body, orgId } = event.data;

  console.log("📧 Sending real email...");

  try {
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: "mayurnanda45@gmail.com", // 🔥 replace with dynamic later
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9;">
          <h2 style="color: #333;">${subject}</h2>
          <p style="color: #555; font-size: 16px;">${body}</p>
        </div>


      `,
    });
    await pusherServer.trigger(
    `org-${orgId}`,        // channel
    "job-completed",         // event name
    {
      message: "Email sent successfully 🚀",
    });
    console.log("✅ Email sent successfully");

  } catch (error) {
    console.error("❌ Email failed:", error);
    throw error; // IMPORTANT → triggers retry
  }
};