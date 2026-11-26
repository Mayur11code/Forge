"use server";

import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { Role, InvitationStatus } from "@prisma/client";
import { sendInvitationEmail } from "@/lib/emails/invitationEmail";

interface CreateInvitationInput {
  orgSlug: string;
  email: string;
  role: Role;
}

export interface CreateInvitationResult {
  success: boolean;
  inviteUrl: string;
  invitationId: string;
  emailSent: boolean;
  message?: string;
}

/**
 * Creates an organization invitation and dispatches an invitation email via Resend.
 * External email side effect is handled safely outside the database write.
 */
export async function createInvitation(
  input: CreateInvitationInput
): Promise<CreateInvitationResult> {
  const { orgSlug, email, role } = input;
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Authenticate caller and verify ADMIN role
  const access = await getOrgAccess(orgSlug);
  if (!access) {
    throw new Error("Unauthorized");
  }

  if (access.membership.role !== Role.ADMIN) {
    throw new Error("Only administrators can invite members.");
  }

  const orgId = access.organization.id;
  const orgName = access.organization.name;

  // 2. Prevent inviting users who are already members
  const existingMembership = await db.membership.findFirst({
    where: {
      orgId,
      user: {
        email: normalizedEmail,
      },
    },
  });

  if (existingMembership) {
    throw new Error("User is already a member of this organization.");
  }

  // 3. Generate high-entropy token and set 24h expiration
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

  // 4. Save Invitation record in database
  const invitation = await db.invitation.create({
    data: {
      email: normalizedEmail,
      token,
      role,
      orgId,
      status: InvitationStatus.PENDING,
      expiresAt,
    },
  });

  // 5. Build trusted invitation URL from app configuration
  const appBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000";
  const inviteUrl = `${appBaseUrl.replace(/\/$/, "")}/invite/${token}`;

  // 6. External side effect: Dispatch Resend email outside DB transaction (P14)
  let emailSent = false;
  let emailErrorMessage: string | undefined;

  try {
    if (process.env.RESEND_API_KEY) {
      await sendInvitationEmail({
        to: normalizedEmail,
        orgName,
        inviterName: orgName,
        role,
        inviteUrl,
        expiresAt,
      });
      emailSent = true;
    } else {
      console.warn(
        `[createInvitation] RESEND_API_KEY unconfigured. Email skipped for ${normalizedEmail}.`
      );
    }
  } catch (emailErr) {
    console.error(
      "[createInvitation] Resend email delivery failed:",
      emailErr instanceof Error ? emailErr.message : String(emailErr)
    );
    emailErrorMessage =
      emailErr instanceof Error ? emailErr.message : "Provider failure";
  }

  return {
    success: true,
    inviteUrl,
    invitationId: invitation.id,
    emailSent,
    message: emailSent
      ? `Invitation sent to ${normalizedEmail} via email.`
      : `Invitation link generated. Email unconfigured or failed (${emailErrorMessage || "no API key"}).`,
  };
}
