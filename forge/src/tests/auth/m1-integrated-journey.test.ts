import bcrypt from "bcryptjs";

// Mocks
jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/emails/invitationEmail", () => ({
  sendInvitationEmail: jest.fn(),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    membership: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    project: {
      create: jest.fn(),
    },
    task: {
      create: jest.fn(),
    },
    invitation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { registerUser } from "@/app/actions/user/registerUser";
import { createOrganizationAction } from "@/app/actions/settings/createOrg";
import { createInvitation } from "@/app/actions/Invitations/createInvitation";
import { updateMemberRole, removeMember } from "@/app/actions/user/memberActions";
import { updateUserProfileAction, changePasswordAction } from "@/app/actions/user/profileActions";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { sendInvitationEmail } from "@/lib/emails/invitationEmail";
import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { Role, InvitationStatus, TaskStatus, TaskPriority } from "@prisma/client";

describe("M1 Integrated Customer Journey Acceptance Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("executes the complete M1 journey end-to-end: Register -> Onboard -> Invite -> Manage -> Profile", async () => {
    // -------------------------------------------------------------
    // Step 1 (FC-002): Visitor Registration
    // -------------------------------------------------------------
    (db.user.findUnique as jest.Mock).mockResolvedValue(null);
    (db.user.create as jest.Mock).mockImplementation(async ({ data }) => ({
      id: "usr_founder_001",
      email: data.email,
      name: data.name,
      password: data.password,
    }));

    const regResult = await registerUser({
      name: "Founder Alice",
      email: "Alice@acme-enterprises.com",
      password: "StrongPassword2026!",
      confirmPassword: "StrongPassword2026!",
    });

    expect(regResult.success).toBe(true);
    expect(regResult.email).toBe("alice@acme-enterprises.com");
    expect(regResult.nextUrl).toBe("/router");

    // -------------------------------------------------------------
    // Step 2 (FC-003): Organization Onboarding (Atomic Transaction)
    // -------------------------------------------------------------
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "usr_founder_001", email: "alice@acme-enterprises.com" },
    });

    const mockOrgTx = {
      organization: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "org_acme_001",
          name: "Acme Enterprises",
          slug: "acme-enterprises",
        }),
      },
      membership: {
        create: jest.fn().mockResolvedValue({
          id: "mem_alice_001",
          userId: "usr_founder_001",
          orgId: "org_acme_001",
          role: Role.ADMIN,
        }),
      },
      project: {
        create: jest.fn().mockResolvedValue({ id: "proj_gen_001" }),
      },
      task: {
        create: jest.fn().mockResolvedValue({ id: "task_starter_001" }),
      },
    };

    (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockOrgTx));

    const orgResult = await createOrganizationAction({
      name: "Acme Enterprises",
    });

    expect(orgResult.success).toBe(true);
    expect(orgResult.orgSlug).toBe("acme-enterprises");
    expect(orgResult.redirectUrl).toBe("/org/acme-enterprises/dashboard");
    expect(mockOrgTx.membership.create).toHaveBeenCalledWith({
      data: {
        userId: "usr_founder_001",
        orgId: "org_acme_001",
        role: Role.ADMIN,
      },
    });

    // -------------------------------------------------------------
    // Step 3 (FC-006): Team Invitation via Resend
    // -------------------------------------------------------------
    (getOrgAccess as jest.Mock).mockResolvedValue({
      userId: "usr_founder_001",
      organization: { id: "org_acme_001", name: "Acme Enterprises" },
      membership: { role: Role.ADMIN },
    });
    (db.membership.findFirst as jest.Mock).mockResolvedValue(null);
    (db.invitation.create as jest.Mock).mockResolvedValue({
      id: "inv_bob_001",
      email: "bob@acme-enterprises.com",
      token: "secure-token-bob-uuid",
      role: Role.MEMBER,
      status: InvitationStatus.PENDING,
    });
    (sendInvitationEmail as jest.Mock).mockResolvedValue({
      id: "msg_resend_bob",
      deliveredTo: "bob@acme-enterprises.com",
    });

    process.env.RESEND_API_KEY = "test_key";
    const inviteResult = await createInvitation({
      orgSlug: "acme-enterprises",
      email: "bob@acme-enterprises.com",
      role: Role.MEMBER,
    });

    expect(inviteResult.success).toBe(true);
    expect(inviteResult.emailSent).toBe(true);
    expect(inviteResult.inviteUrl).toContain("/invite/");

    // -------------------------------------------------------------
    // Step 4 (FC-005): Member Role Promotion & Last-Admin Protection
    // -------------------------------------------------------------
    const mockMemberTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "org_acme_001" }]),
      membership: {
        findFirst: jest.fn().mockImplementation(async ({ where }) => {
          if (where.userId) return { role: Role.ADMIN };
          return {
            id: "mem_bob_001",
            orgId: "org_acme_001",
            role: Role.MEMBER,
          };
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockMemberTx));

    // Promote Bob to MANAGER
    const roleResult = await updateMemberRole(
      "acme-enterprises",
      "mem_bob_001",
      Role.MANAGER
    );
    expect(roleResult.success).toBe(true);
    expect(mockMemberTx.membership.update).toHaveBeenCalledWith({
      where: { id: "mem_bob_001" },
      data: { role: Role.MANAGER },
    });

    // Last admin protection: Attempt to demote Alice (sole ADMIN)
    const mockLastAdminTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "org_acme_001" }]),
      membership: {
        findFirst: jest.fn().mockImplementation(async ({ where }) => {
          if (where.userId) return { role: Role.ADMIN };
          return {
            id: "mem_alice_001",
            orgId: "org_acme_001",
            role: Role.ADMIN,
          };
        }),
        count: jest.fn().mockResolvedValue(1), // only 1 admin
        update: jest.fn(),
      },
    };
    (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockLastAdminTx));

    const demoteResult = await updateMemberRole(
      "acme-enterprises",
      "mem_alice_001",
      Role.MEMBER
    );
    expect(demoteResult.success).toBe(false);
    expect(demoteResult.error).toContain("Cannot demote the sole administrator");

    // -------------------------------------------------------------
    // Step 5 (FC-007): Profile Name Update & Password Change
    // -------------------------------------------------------------
    (auth as jest.Mock).mockResolvedValue({
      user: { id: "usr_founder_001", email: "alice@acme-enterprises.com" },
    });
    (db.user.update as jest.Mock).mockResolvedValue({});

    const profileResult = await updateUserProfileAction(
      "Alice W. Founder",
      "https://example.com/alice-avatar.png"
    );
    expect(profileResult.success).toBe(true);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "usr_founder_001" },
      data: {
        name: "Alice W. Founder",
        image: "https://example.com/alice-avatar.png",
      },
    });

    // Password change
    const initialHash = await bcrypt.hash("StrongPassword2026!", 10);
    (db.user.findUnique as jest.Mock).mockResolvedValue({
      id: "usr_founder_001",
      password: initialHash,
    });

    const pwdResult = await changePasswordAction(
      "StrongPassword2026!",
      "BrandNewPassword2027!",
      "BrandNewPassword2027!"
    );
    expect(pwdResult.success).toBe(true);

    const updatedCall = (db.user.update as jest.Mock).mock.calls.find(
      (c) => c[0].data?.password
    );
    expect(updatedCall).toBeDefined();
    const updatedHash = updatedCall[0].data.password;
    expect(await bcrypt.compare("BrandNewPassword2027!", updatedHash)).toBe(true);
    expect(await bcrypt.compare("StrongPassword2026!", updatedHash)).toBe(false);
  });
});
