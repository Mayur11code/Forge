import { createWorker } from "@/lib/events/worker";
import { resend } from "@/lib/emails/email";

export const POST = createWorker("TASK_CREATED", async ({ event }) => {
  const { taskId, projectId, orgId } = event.data;

  console.log("📧 Sending real email...");

  try {
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: "mayurnanda45@gmail.com", // 🔥 replace with dynamic later
      subject: "New Task Created 🚀",
      html: `
        <h2>New Task Created</h2>
        <p>Task ID: ${taskId}</p>
        <p>Project ID: ${projectId}</p>
        <p>Org ID: ${orgId}</p>
      `,
    });

    console.log("✅ Email sent successfully");

  } catch (error) {
    console.error("❌ Email failed:", error);
    throw error; // IMPORTANT → triggers retry
  }
});