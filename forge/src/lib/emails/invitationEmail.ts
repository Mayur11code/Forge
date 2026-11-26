import "server-only";

import { executeSendEmail } from "@/lib/emails/core-service";

export interface SendInvitationEmailParams {
  to: string;
  orgName: string;
  inviterName?: string;
  role: string;
  inviteUrl: string;
  expiresAt: Date;
}

/**
 * Dispatches an organization team invitation email via Resend.
 */
export async function sendInvitationEmail({
  to,
  orgName,
  inviterName = "A team administrator",
  role,
  inviteUrl,
  expiresAt,
}: SendInvitationEmailParams) {
  const roleFormatted = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
  const subject = `You've been invited to join ${orgName} on Forge`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #09090b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
        <div style="max-width: 560px; margin: 40px auto; padding: 32px; background-color: #18181b; border: 1px solid #27272a; border-radius: 16px; color: #f4f4f5;">
          <div style="margin-bottom: 24px;">
            <span style="font-size: 22px; font-weight: 800; color: #3b82f6; letter-spacing: -0.5px;">Forge</span>
          </div>

          <h1 style="font-size: 20px; font-weight: 700; color: #ffffff; margin-bottom: 12px; line-height: 1.3;">
            You've been invited to join ${orgName}
          </h1>

          <p style="font-size: 14px; color: #a1a1aa; line-height: 1.6; margin-bottom: 24px;">
            <strong style="color: #ffffff;">${inviterName}</strong> has invited you to collaborate in the <strong style="color: #ffffff;">${orgName}</strong> organization as a <strong style="color: #3b82f6;">${roleFormatted}</strong>.
          </p>

          <div style="margin: 32px 0;">
            <a href="${inviteUrl}" style="display: inline-block; background-color: #2563eb; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 10px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);">
              Accept Invitation &rarr;
            </a>
          </div>

          <p style="font-size: 12px; color: #71717a; line-height: 1.5; margin-top: 32px; border-top: 1px solid #27272a; padding-top: 16px;">
            This invitation link is valid for 24 hours. If you did not expect an invitation, you can safely ignore this email.
          </p>
        </div>
      </body>
    </html>
  `;

  return await executeSendEmail({
    to,
    subject,
    html,
  });
}
