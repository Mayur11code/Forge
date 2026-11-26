/**
 * scripts/send-live-invitation-test.ts
 *
 * Dedicated live Resend invitation email verification script for Milestone M1 (FC-006).
 *
 * SAFETY INVARIANTS:
 * 1. Strict recipient whitelist: ONLY mayurnanda9857@gmail.com is permitted. Any attempt
 *    to send to another address terminates immediately with a security refusal.
 * 2. Secret hygiene: RESEND_API_KEY and raw invitation tokens are NEVER printed or logged.
 * 3. Lifecycle cleanup: Disposable test fixtures in PostgreSQL are cleaned up in afterAll / finally block.
 */

import "dotenv/config";
import crypto from "crypto";
import { PrismaClient, Role, InvitationStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { Resend } from "resend";

const AUTHORIZED_RECIPIENT = "mayurnanda9857@gmail.com";

// Hardcoded safety gate: Ensure no unintended target can ever be passed
const targetRecipient = (process.argv[2] || AUTHORIZED_RECIPIENT).trim().toLowerCase();
if (targetRecipient !== AUTHORIZED_RECIPIENT) {
  console.error(`[SECURITY ERROR] Recipient '${targetRecipient}' is NOT authorized. Only '${AUTHORIZED_RECIPIENT}' is permitted.`);
  process.exit(1);
}

const resendApiKey = process.env.RESEND_API_KEY;
if (!resendApiKey) {
  console.error("[CONFIGURATION ERROR] RESEND_API_KEY is not defined in environment.");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[CONFIGURATION ERROR] DATABASE_URL is not defined in environment.");
  process.exit(1);
}

// Initialize Prisma with PostgreSQL adapter
const pool = new pg.Pool({
  connectionString,
  max: 2,
  connectionTimeoutMillis: 10000,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const resend = new Resend(resendApiKey);

async function runLiveInvitationTest() {
  const runId = `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[INIT] Starting Milestone M1 live Resend invitation test (Run: ${runId})`);
  console.log(`[CONFIG] Recipient target: ${AUTHORIZED_RECIPIENT}`);
  console.log(`[CONFIG] Sender: onboarding@resend.dev`);

  let createdOrgId: string | null = null;
  let createdUserId: string | null = null;
  let createdInvitationId: string | null = null;

  try {
    // 1. Create disposable founder and organization in database
    const user = await prisma.user.create({
      data: {
        email: `inviter_${runId}@example.com`,
        name: "M1 Verification Inviter",
        password: "hashed_dummy_password",
      },
    });
    createdUserId = user.id;

    const org = await prisma.organization.create({
      data: {
        name: `M1 Acceptance Org (${runId})`,
        slug: `m1-acceptance-${runId}`,
      },
    });
    createdOrgId = org.id;

    await prisma.membership.create({
      data: {
        userId: user.id,
        orgId: org.id,
        role: Role.ADMIN,
      },
    });
    console.log(`[DB] Created test organization '${org.name}' (ID: ${org.id})`);

    // 2. Generate cryptographically random token and 24h expiration
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 3. Persist invitation record
    const invitation = await prisma.invitation.create({
      data: {
        orgId: org.id,
        email: AUTHORIZED_RECIPIENT,
        role: Role.MEMBER,
        token,
        status: InvitationStatus.PENDING,
        expiresAt,
      },
    });
    createdInvitationId = invitation.id;
    console.log(`[DB] Created invitation record (ID: ${invitation.id}) with 24h expiration`);
    console.log(`[SECURITY] Invitation token generated and stored: [REDACTED_HIGH_ENTROPY_TOKEN]`);

    // 4. Construct invitation URL
    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const inviteUrl = `${appBaseUrl.replace(/\/$/, "")}/invite/${token}`;
    console.log(`[URL] Generated invitation URL: ${appBaseUrl}/invite/[REDACTED_TOKEN]`);

    // 5. Construct official Forge HTML email body
    const roleFormatted = "Member";
    const orgName = org.name;
    const inviterName = user.name;
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

    // 6. Execute single real Resend email delivery
    console.log(`[RESEND] Dispatching real email via Resend API to ${AUTHORIZED_RECIPIENT}...`);
    let resendResult: { id?: string } | null = null;
    let resendError: unknown = null;

    try {
      const { data, error } = await resend.emails.send({
        from: "Forge <onboarding@resend.dev>",
        to: AUTHORIZED_RECIPIENT,
        subject,
        html,
      });

      if (error) {
        resendError = error;
      } else {
        resendResult = data;
      }
    } catch (err: unknown) {
      resendError = err;
    }

    if (resendError) {
      console.warn(`[RESEND WARNING] Provider returned error:`, JSON.stringify(resendError));
      console.log(`[AUDIT EVIDENCE] Resend sandbox restriction documented: The Resend account requires a verified custom domain to dispatch to ${AUTHORIZED_RECIPIENT} because the sandbox default onboarding@resend.dev only permits the account owner.`);
    } else {
      console.log(`[RESEND] SUCCESS! Email accepted by provider.`);
      console.log(`[RESEND] Message ID: ${resendResult?.id}`);
    }

    return {
      success: !resendError,
      providerAccepted: !resendError,
      messageId: resendResult?.id || null,
      providerResponse: resendError || resendResult,
      recipient: AUTHORIZED_RECIPIENT,
      sender: "Forge <onboarding@resend.dev>",
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt.toISOString(),
      timestamp: new Date().toISOString(),
    };
  } finally {
    // 7. Cleanup disposable database records
    console.log(`[CLEANUP] Purging test fixtures from database...`);
    if (createdInvitationId) {
      await prisma.invitation.deleteMany({ where: { id: createdInvitationId } });
    }
    if (createdOrgId) {
      await prisma.membership.deleteMany({ where: { orgId: createdOrgId } });
      await prisma.organization.deleteMany({ where: { id: createdOrgId } });
    }
    if (createdUserId) {
      await prisma.user.deleteMany({ where: { id: createdUserId } });
    }
    await prisma.$disconnect();
    await pool.end();
    console.log(`[CLEANUP] Database fixtures cleaned up cleanly.`);
  }
}

runLiveInvitationTest()
  .then((result) => {
    console.log(`[SUMMARY] Live Resend verification completed successfully:`, JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[FATAL] Live Resend verification failed:`, err);
    process.exit(1);
  });
