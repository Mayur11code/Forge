jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    $transaction: jest.fn(),
    membership: {
      findFirst: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import { db } from "@/lib/prisma/db";
import { updateMemberRole, removeMember } from "@/app/actions/user/memberActions";
import { Role } from "@prisma/client";

describe("Member Role Management & Removal Server Actions (FC-005)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("updateMemberRole", () => {
    it("rejects unauthenticated caller", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue(null);

      const result = await updateMemberRole("acme", "mem-1", Role.MANAGER);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("rejects non-admin caller (MEMBER)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-member",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      const result = await updateMemberRole("acme", "mem-1", Role.ADMIN);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Forbidden: Only administrators");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("rejects non-admin caller (MANAGER)", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-mgr",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.MANAGER },
      });

      const result = await updateMemberRole("acme", "mem-1", Role.ADMIN);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Forbidden: Only administrators");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("rejects cross-tenant member mutation attempt", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "org-1" }]),
        membership: {
          findFirst: jest.fn().mockImplementation(async ({ where }) => {
            if (where.userId) return { role: Role.ADMIN };
            return null; // target belongs to Org 2, not Org 1
          }),
        },
      };
      (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockTx));

      const result = await updateMemberRole("acme", "mem-from-other-org", Role.MANAGER);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Member not found in this organization");
      expect(mockTx.$queryRaw).toHaveBeenCalled();
    });

    it("refuses to demote the sole administrator of an organization", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "org-1" }]),
        membership: {
          findFirst: jest.fn().mockImplementation(async ({ where }) => {
            if (where.userId) return { role: Role.ADMIN };
            return {
              id: "mem-admin",
              orgId: "org-1",
              role: Role.ADMIN,
            };
          }),
          count: jest.fn().mockResolvedValue(1), // sole admin
          update: jest.fn(),
        },
      };
      (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockTx));

      const result = await updateMemberRole("acme", "mem-admin", Role.MEMBER);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot demote the sole administrator");
      expect(mockTx.membership.update).not.toHaveBeenCalled();
      expect(mockTx.$queryRaw).toHaveBeenCalled();
    });

    it("successfully demotes an administrator when multiple administrators exist", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin-1",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "org-1" }]),
        membership: {
          findFirst: jest.fn().mockImplementation(async ({ where }) => {
            if (where.userId) return { role: Role.ADMIN };
            return {
              id: "mem-admin-2",
              orgId: "org-1",
              role: Role.ADMIN,
            };
          }),
          count: jest.fn().mockResolvedValue(2), // 2 admins exist
          update: jest.fn().mockResolvedValue({}),
        },
      };
      (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockTx));

      const result = await updateMemberRole("acme", "mem-admin-2", Role.MANAGER);
      expect(result.success).toBe(true);
      expect(result.message).toContain("Member role updated to MANAGER");
      expect(mockTx.membership.update).toHaveBeenCalledWith({
        where: { id: "mem-admin-2" },
        data: { role: Role.MANAGER },
      });
      expect(mockTx.$queryRaw).toHaveBeenCalled();
    });

    it("successfully promotes a member to ADMIN", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin-1",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "org-1" }]),
        membership: {
          findFirst: jest.fn().mockImplementation(async ({ where }) => {
            if (where.userId) return { role: Role.ADMIN };
            return {
              id: "mem-member",
              orgId: "org-1",
              role: Role.MEMBER,
            };
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockTx));

      const result = await updateMemberRole("acme", "mem-member", Role.ADMIN);
      expect(result.success).toBe(true);
      expect(mockTx.membership.update).toHaveBeenCalledWith({
        where: { id: "mem-member" },
        data: { role: Role.ADMIN },
      });
    });
  });

  describe("removeMember", () => {
    it("rejects unauthenticated caller", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue(null);

      const result = await removeMember("acme", "mem-1");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("rejects non-admin caller", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-member",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.MEMBER },
      });

      const result = await removeMember("acme", "mem-1");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Forbidden: Only administrators");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("rejects cross-tenant member removal attempt", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "org-1" }]),
        membership: {
          findFirst: jest.fn().mockImplementation(async ({ where }) => {
            if (where.userId) return { role: Role.ADMIN };
            return null;
          }),
        },
      };
      (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockTx));

      const result = await removeMember("acme", "mem-foreign");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Member not found in this organization");
    });

    it("refuses to remove the sole administrator of an organization", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "org-1" }]),
        membership: {
          findFirst: jest.fn().mockImplementation(async ({ where }) => {
            if (where.userId) return { role: Role.ADMIN };
            return {
              id: "mem-admin",
              orgId: "org-1",
              role: Role.ADMIN,
            };
          }),
          count: jest.fn().mockResolvedValue(1), // sole admin
          delete: jest.fn(),
        },
      };
      (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockTx));

      const result = await removeMember("acme", "mem-admin");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot remove the sole administrator");
      expect(mockTx.membership.delete).not.toHaveBeenCalled();
    });

    it("successfully removes a non-admin member", async () => {
      (getOrgAccess as jest.Mock).mockResolvedValue({
        userId: "user-admin",
        organization: { id: "org-1", name: "Acme" },
        membership: { role: Role.ADMIN },
      });

      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: "org-1" }]),
        membership: {
          findFirst: jest.fn().mockImplementation(async ({ where }) => {
            if (where.userId) return { role: Role.ADMIN };
            return {
              id: "mem-to-remove",
              orgId: "org-1",
              role: Role.MEMBER,
            };
          }),
          delete: jest.fn().mockResolvedValue({}),
        },
      };
      (db.$transaction as jest.Mock).mockImplementation((cb) => cb(mockTx));

      const result = await removeMember("acme", "mem-to-remove");
      expect(result.success).toBe(true);
      expect(result.message).toContain("Member removed from organization successfully");
      expect(mockTx.membership.delete).toHaveBeenCalledWith({
        where: { id: "mem-to-remove" },
      });
    });
  });
});
