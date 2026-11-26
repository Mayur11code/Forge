jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/emails/invitationEmail", () => ({
  sendInvitationEmail: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    invitation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    membership: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { sendInvitationEmail } from "@/lib/emails/invitationEmail";
import { db } from "@/lib/prisma/db";
import { createInvitation } from "@/app/actions/Invitations/createInvitation";
import { Role, InvitationStatus } from "@prisma/client";

describe("Invitation Creation & Email Delivery (FC-006)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      RESEND_API_KEY: "re_mock_test_key_123",
      NEXT_PUBLIC_APP_URL: "https://forge.example.com",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects unauthenticated caller", async () => {
    (getOrgAccess as jest.Mock).mockResolvedValue(null);

    await expect(
      createInvitation({
        orgSlug: "acme",
        email: "newuser@example.com",
        role: Role.MEMBER,
      })
    ).rejects.toThrow("Unauthorized");

    expect(db.invitation.create).not.toHaveBeenCalled();
  });

  it("rejects non-admin caller", async () => {
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: "user_member_1",
      organization: { id: "org_1", name: "Acme Corp" },
      membership: { role: Role.MEMBER },
    });

    await expect(
      createInvitation({
        orgSlug: "acme",
        email: "newuser@example.com",
        role: Role.MEMBER,
      })
    ).rejects.toThrow("Only administrators can invite members.");

    expect(db.invitation.create).not.toHaveBeenCalled();
  });

  it("rejects inviting a user who is already a member of the organization", async () => {
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: "user_admin_1",
      organization: { id: "org_1", name: "Acme Corp" },
      membership: { role: Role.ADMIN },
    });

    (db.membership.findFirst as jest.Mock).mockResolvedValue({
      id: "existing_membership_id",
      userId: "existing_user_id",
      orgId: "org_1",
    });

    await expect(
      createInvitation({
        orgSlug: "acme",
        email: "existing@example.com",
        role: Role.MEMBER,
      })
    ).rejects.toThrow("User is already a member of this organization.");

    expect(db.invitation.create).not.toHaveBeenCalled();
  });

  it("successfully creates invitation and dispatches email via Resend", async () => {
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: "user_admin_1",
      organization: { id: "org_1", name: "Acme Corp" },
      membership: { role: Role.ADMIN },
    });

    (db.membership.findFirst as jest.Mock).mockResolvedValue(null);

    (db.invitation.create as jest.Mock).mockResolvedValue({
      id: "inv_123",
      email: "colleague@example.com",
      token: "uuid-token-xyz-123",
      role: Role.MANAGER,
      status: InvitationStatus.PENDING,
    });

    (sendInvitationEmail as jest.Mock).mockResolvedValue({
      id: "msg_resend_456",
      deliveredTo: "colleague@example.com",
    });

    const result = await createInvitation({
      orgSlug: "acme",
      email: "Colleague@Example.com ",
      role: Role.MANAGER,
    });

    expect(result.success).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(result.inviteUrl).toMatch(/^https:\/\/forge\.example\.com\/invite\//);
    expect(result.invitationId).toBe("inv_123");

    // Verify email normalization
    expect(db.invitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "colleague@example.com",
        role: Role.MANAGER,
        status: InvitationStatus.PENDING,
      }),
    });

    // Verify Resend email was invoked
    expect(sendInvitationEmail).toHaveBeenCalledWith({
      to: "colleague@example.com",
      orgName: "Acme Corp",
      inviterName: "Acme Corp",
      role: Role.MANAGER,
      inviteUrl: result.inviteUrl,
      expiresAt: expect.any(Date),
    });
  });

  it("preserves invitation record safely even if Resend delivery fails", async () => {
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: "user_admin_1",
      organization: { id: "org_1", name: "Acme Corp" },
      membership: { role: Role.ADMIN },
    });

    (db.membership.findFirst as jest.Mock).mockResolvedValue(null);

    (db.invitation.create as jest.Mock).mockResolvedValue({
      id: "inv_123",
      email: "colleague@example.com",
      token: "uuid-token-xyz-123",
      role: Role.MEMBER,
      status: InvitationStatus.PENDING,
    });

    (sendInvitationEmail as jest.Mock).mockRejectedValue(
      new Error("Resend API rate limit exceeded")
    );

    const result = await createInvitation({
      orgSlug: "acme",
      email: "colleague@example.com",
      role: Role.MEMBER,
    });

    // Invitation must NOT be deleted; url is returned with emailSent=false
    expect(result.success).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.inviteUrl).toBeDefined();
    expect(result.message).toContain("Resend API rate limit exceeded");
  });
});
