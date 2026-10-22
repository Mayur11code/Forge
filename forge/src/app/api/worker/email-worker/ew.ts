import { z } from "zod";
import { db } from "@/lib/prisma/db";
import { pusherServer } from "@/lib/pusher/pusher-server";
import { organizationChannelName } from "@/lib/pusher/org-channel";
import { executeSendEmail } from "@/lib/emails/core-service";
import type { WorkerHandler } from "@/lib/events/worker";

const recipientEmailSchema = z.email();

export const emailWorkerHandler: WorkerHandler<"SEND_EMAIL"> = async ({
  event,
}) => {
  const { orgId, subject, body, userId } = event.data;

  try {
    const membership = await db.membership.findUnique({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
      select: {
        user: {
          select: {
            email: true,
          },
        },
      },
    });

    const recipient = recipientEmailSchema.safeParse(membership?.user.email);

    if (!recipient.success) {
      throw new Error(
        "SEND_EMAIL could not resolve a deliverable member recipient from event.data.userId and event.data.orgId.",
      );
    }

    // Resolve the channel before sending. A malformed org id must fail before
    // the email is handed to the transport, otherwise the post-send throw
    // would trigger a QStash retry and a duplicate email.
    const channelName = organizationChannelName(orgId);

    const htmlTemplate = `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f9f9f9;">
        <h2 style="color: #333;">${subject}</h2>
        <p style="color: #555; font-size: 16px;">${body}</p>
      </div>
    `;

    await executeSendEmail({
      to: recipient.data,
      subject,
      html: htmlTemplate,
    });

    await pusherServer.trigger(channelName, "job-completed", {
      message: "Email sent successfully 🚀",
    });

  } catch (error) {
    console.error("❌ Email failed:", error);
    throw error;
  }
};