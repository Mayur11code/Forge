// src/tests/security/vault-policy.test.ts
jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    organization: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    organization: {
      findUnique: jest.fn(),
    },
  },
}));

import { resolveOrganizationAiPolicy } from "@/lib/security/vault/policy";
import { CredentialPurpose } from "@prisma/client";
import { db } from "@/lib/prisma/db";

describe("vault-policy: Authoritative Entitlement & Fallback Policy", () => {
  const originalEnv = process.env;
  const orgId = "org-policy-test";

  function setNodeEnv(value: string | undefined) {
    if (value === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      (process.env as Record<string, string | undefined>).NODE_ENV = value;
    }
  }

  let mockPrisma: {
    organization: {
      findUnique: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK;
    delete process.env.RAZORPAY_PLAN_ID;

    mockPrisma = {
      organization: {
        findUnique: jest.fn(),
      },
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("Development Override Restriction", () => {
    it("activates override ONLY when NODE_ENV is strictly 'development'", async () => {
      setNodeEnv("development");
      process.env.FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK = "true";

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(true);
      expect(policy.tierIdentifier).toBe("DEV_OVERRIDE");
      expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
    });

    it("REFUSES override when NODE_ENV is 'test', even if override env var is set", async () => {
      setNodeEnv("test");
      process.env.FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK = "true";

      // DB returns unsubscribed organization
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: orgId,
        planId: null,
        subscriptionStatus: null,
        razorpaySubscriptionId: null,
      });

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      // Override did NOT activate; evaluated database and denied fallback
      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(policy.tierIdentifier).toBe("FREE");
      expect(mockPrisma.organization.findUnique).toHaveBeenCalled();
    });

    it("REFUSES override when NODE_ENV is 'production', even if override env var is set", async () => {
      setNodeEnv("production");
      process.env.FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK = "true";

      mockPrisma.organization.findUnique.mockResolvedValueOnce(null);

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      // Fails closed because org does not exist; override refused
      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(mockPrisma.organization.findUnique).toHaveBeenCalled();
    });

    it("REFUSES override when NODE_ENV is 'staging'", async () => {
      setNodeEnv("staging");
      process.env.FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK = "true";

      mockPrisma.organization.findUnique.mockResolvedValueOnce(null);

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(mockPrisma.organization.findUnique).toHaveBeenCalled();
    });

    it("REFUSES override when NODE_ENV is unset / undefined", async () => {
      setNodeEnv(undefined);
      process.env.FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK = "true";

      mockPrisma.organization.findUnique.mockResolvedValueOnce(null);

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(mockPrisma.organization.findUnique).toHaveBeenCalled();
    });
  });

  describe("Authoritative Razorpay Plan Entitlement", () => {
    beforeEach(() => {
      setNodeEnv("test");
    });

    it("authorizes platform fallback for active subscription matching RAZORPAY_PLAN_ID", async () => {
      process.env.RAZORPAY_PLAN_ID = "plan_enterprise_pro";

      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: orgId,
        planId: "plan_enterprise_pro",
        subscriptionStatus: "active",
        razorpaySubscriptionId: "sub_12345",
      });

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(true);
      expect(policy.requiresByok).toBe(false);
      expect(policy.tierResolved).toBe(true);
      expect(policy.tierIdentifier).toBe("plan_enterprise_pro");
      expect(policy.reason).toContain("Active subscription entitled");
    });

    it("denies fallback when RAZORPAY_PLAN_ID is not configured in server environment", async () => {
      delete process.env.RAZORPAY_PLAN_ID;

      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: orgId,
        planId: "plan_enterprise_pro",
        subscriptionStatus: "active",
        razorpaySubscriptionId: "sub_12345",
      });

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      // Cannot match an unconfigured plan ID -> fails closed
      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(policy.tierResolved).toBe(false);
      expect(policy.reason).toContain("Unresolved plan identifier");
    });

    it("denies fallback when RAZORPAY_PLAN_ID is an empty or whitespace-only string", async () => {
      process.env.RAZORPAY_PLAN_ID = "   ";

      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: orgId,
        planId: "   ",
        subscriptionStatus: "active",
        razorpaySubscriptionId: "sub_12345",
      });

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
    });

    it("denies fallback when subscription status is not active (past_due, canceled)", async () => {
      process.env.RAZORPAY_PLAN_ID = "plan_enterprise_pro";

      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: orgId,
        planId: "plan_enterprise_pro",
        subscriptionStatus: "past_due",
        razorpaySubscriptionId: "sub_12345",
      });

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(policy.reason).toContain("past_due");
    });

    it("denies fallback for free/unsubscribed organizations", async () => {
      process.env.RAZORPAY_PLAN_ID = "plan_enterprise_pro";

      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        id: orgId,
        planId: null,
        subscriptionStatus: null,
        razorpaySubscriptionId: null,
      });

      const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(policy.tierIdentifier).toBe("FREE");
      expect(policy.reason).toContain("BYOK is required");
    });

    it("fails closed when organization is missing in database", async () => {
      process.env.RAZORPAY_PLAN_ID = "plan_enterprise_pro";
      mockPrisma.organization.findUnique.mockResolvedValueOnce(null);

      const policy = await resolveOrganizationAiPolicy("non-existent-org", CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(policy.tierResolved).toBe(false);
    });

    it("fails closed when orgId is invalid or whitespace", async () => {
      const policy = await resolveOrganizationAiPolicy("   ", CredentialPurpose.GENERATION, {
        prismaClient: mockPrisma as unknown as typeof db,
      });

      expect(policy.allowPlatformFallback).toBe(false);
      expect(policy.requiresByok).toBe(true);
      expect(policy.tierResolved).toBe(false);
      expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
    });
  });
});
