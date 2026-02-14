"use server";

import crypto from "crypto";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { InvitationStatus } from "@prisma/client";

interface CreateInvitationInput {
  orgSlug: string;
  email: string;
  role: "ADMIN" | "MEMBER"; // restrict for now
}

export async function createInvitation(input: CreateInvitationInput) {
  const { orgSlug, email, role } = input;

  // 1️⃣ Access Control
  const access = await getOrgAccess(orgSlug);
  if (!access) {
    throw new Error("Unauthorized");
  }

  if (access.membership.role !== "ADMIN") {
    throw new Error("Only admins can invite members.");
  }

  const orgId = access.organization.id;

  // 2️⃣ Prevent Inviting Existing Members
  const existingMembership = await db.membership.findFirst({
    where: {
      orgId,
      user: {
        email,
      },
    },
  });

  if (existingMembership) {
    throw new Error("User is already a member of this organization.");
  }

  // 3️⃣ Generate Secure Token
  const token = crypto.randomUUID();

  // 4️⃣ Set Expiration (24 hours)
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

  // 5️⃣ Save Invitation
  const invitation = await db.invitation.create({
    data: {
      email,
      token,
      role,
      orgId,
      status: InvitationStatus.PENDING,
      expiresAt,
    },
  });

  // 6️⃣ Build Invite Link
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${token}`;

  return {
    success: true,
    inviteUrl,
    invitationId: invitation.id,
  };
}
