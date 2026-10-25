// src/tests/security/api-key-actions.test.ts
import { CredentialPurpose, CredentialStatus, AiProvider, Role } from "@prisma/client";
import {
  saveOrgApiKeyAction,
  revokeOrgApiKeyAction,
  deleteOrgApiKeyAction,
  getOrgApiKeysAction,
} from "@/app/actions/settings/apiKeyActions";
import { auth } from "@/lib/auth/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/prisma/db";
import {
  stageAndActivateCredential,
  revokeOrganizationCredential,
  deleteOrganizationCredential,
} from "@/lib/security/vault";

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    organization: {
      findFirst: jest.fn(),
    },
    membership: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("@/lib/security/vault", () => ({
  stageAndActivateCredential: jest.fn(),
  revokeOrganizationCredential: jest.fn(),
  deleteOrganizationCredential: jest.fn(),
  listOrganizationCredentials: jest.fn(),
  VaultValidationError: class VaultValidationError extends Error {
    public readonly category: string;
    constructor(msg: string, cat: string = "AUTH_FAILURE") {
      super(msg);
      this.name = "VaultValidationError";
      this.category = cat;
    }
  },
  VaultConcurrencyError: class VaultConcurrencyError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "VaultConcurrencyError";
    }
  },
}));

describe("api-key-actions: RBAC and Tenant Authorization", () => {
  const adminUserId = "user-admin";
  const memberUserId = "user-member";
  const orgAId = "org-uuid-a";
  const orgASlug = "acme-corp";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Authentication Guard", () => {
    it("rejects unauthenticated requests for saving keys", async () => {
      (auth as jest.Mock).mockResolvedValueOnce(null);

      const result = await saveOrgApiKeyAction({
        orgId: orgAId,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaValidKey123456789",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
      expect(stageAndActivateCredential).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests for retrieving keys", async () => {
      (auth as jest.Mock).mockResolvedValueOnce(null);

      const result = await getOrgApiKeysAction(orgAId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
    });
  });

  describe("RBAC Role Authorization", () => {
    it("rejects non-admin (MEMBER) user from saving credentials", async () => {
      (auth as jest.Mock).mockResolvedValueOnce({
        user: { id: memberUserId, email: "member@acme.com" },
      });

      (db.organization.findFirst as jest.Mock).mockResolvedValueOnce({
        id: orgAId,
        slug: orgASlug,
        memberships: [{ role: Role.MEMBER }],
      });

      const result = await saveOrgApiKeyAction({
        orgId: orgAId,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaValidKey123456789",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Forbidden");
      expect(result.error).toContain("administrators");
      expect(stageAndActivateCredential).not.toHaveBeenCalled();
    });

    it("allows ADMIN user to save candidate credentials", async () => {
      (auth as jest.Mock).mockResolvedValueOnce({
        user: { id: adminUserId, email: "admin@acme.com" },
      });

      (db.organization.findFirst as jest.Mock).mockResolvedValueOnce({
        id: orgAId,
        slug: orgASlug,
        memberships: [{ role: Role.ADMIN }],
      });

      (stageAndActivateCredential as jest.Mock).mockResolvedValueOnce({
        metadata: {
          id: "key-1",
          orgId: orgAId,
          provider: AiProvider.GEMINI,
          purpose: CredentialPurpose.GENERATION,
          last4: "6789",
          keyVersion: "v1",
          status: CredentialStatus.ACTIVE,
        },
        validationResult: {
          valid: true,
          category: "VALID",
          message: "Validated",
          testedModel: "gemini-1.5-flash",
          latencyMs: 90,
        },
      });

      const result = await saveOrgApiKeyAction({
        orgId: orgAId,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaValidKey123456789",
      });

      expect(result.success).toBe(true);
      expect(result.data?.metadata.status).toBe(CredentialStatus.ACTIVE);
      expect(stageAndActivateCredential).toHaveBeenCalledWith({
        orgId: orgAId,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaValidKey123456789",
        userId: adminUserId,
      });
      expect(revalidatePath).toHaveBeenCalledWith(`/org/${orgASlug}/settings`);
    });
  });

  describe("Cross-Tenant Isolation", () => {
    it("blocks an admin from modifying another organization's credentials", async () => {
      (auth as jest.Mock).mockResolvedValueOnce({
        user: { id: adminUserId, email: "admin@acme.com" },
      });

      // User has no membership in Org B
      (db.organization.findFirst as jest.Mock).mockResolvedValueOnce({
        id: "org-uuid-b",
        slug: "beta-corp",
        memberships: [],
      });

      const result = await saveOrgApiKeyAction({
        orgId: "org-uuid-b",
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaValidKey123456789",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
      expect(stageAndActivateCredential).not.toHaveBeenCalled();
    });
  });

  describe("Revoke and Delete Actions", () => {
    it("allows ADMIN to revoke credential", async () => {
      (auth as jest.Mock).mockResolvedValueOnce({
        user: { id: adminUserId, email: "admin@acme.com" },
      });

      (db.organization.findFirst as jest.Mock).mockResolvedValueOnce({
        id: orgAId,
        slug: orgASlug,
        memberships: [{ role: Role.ADMIN }],
      });

      (revokeOrganizationCredential as jest.Mock).mockResolvedValueOnce({
        id: "key-1",
        status: CredentialStatus.REVOKED,
      });

      const result = await revokeOrgApiKeyAction({
        orgId: orgAId,
        purpose: CredentialPurpose.GENERATION,
      });

      expect(result.success).toBe(true);
      expect(revokeOrganizationCredential).toHaveBeenCalledWith(orgAId, CredentialPurpose.GENERATION);
      expect(revalidatePath).toHaveBeenCalledWith(`/org/${orgASlug}/settings`);
    });

    it("allows ADMIN to delete credential", async () => {
      (auth as jest.Mock).mockResolvedValueOnce({
        user: { id: adminUserId, email: "admin@acme.com" },
      });

      (db.organization.findFirst as jest.Mock).mockResolvedValueOnce({
        id: orgAId,
        slug: orgASlug,
        memberships: [{ role: Role.ADMIN }],
      });

      (deleteOrganizationCredential as jest.Mock).mockResolvedValueOnce(true);

      const result = await deleteOrgApiKeyAction({
        orgId: orgAId,
        purpose: CredentialPurpose.GENERATION,
      });

      expect(result.success).toBe(true);
      expect(deleteOrganizationCredential).toHaveBeenCalledWith(orgAId, CredentialPurpose.GENERATION);
      expect(revalidatePath).toHaveBeenCalledWith(`/org/${orgASlug}/settings`);
    });
  });
});
