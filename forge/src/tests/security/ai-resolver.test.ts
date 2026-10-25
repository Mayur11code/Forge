// src/tests/security/ai-resolver.test.ts
jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    organizationApiKey: {
      findUnique: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    organizationApiKey: {
      findUnique: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
    },
  },
}));

interface MockTestModel {
  modelId: string;
  provider: string;
  apiKeyUsed: string;
}

jest.mock("@ai-sdk/google", () => {
  return {
    createGoogleGenerativeAI: jest.fn().mockImplementation((config: { apiKey: string }) => {
      const providerFn = ((modelId: string) => ({
        modelId,
        provider: "google.generative-ai",
        apiKeyUsed: config.apiKey,
      })) as unknown as {
        (modelId: string): MockTestModel;
        embeddingModel: (modelId: string) => MockTestModel;
      };
      providerFn.embeddingModel = (modelId: string) => ({
        modelId,
        provider: "google.generative-ai.embedding",
        apiKeyUsed: config.apiKey,
      });
      return providerFn;
    }),
  };
});

jest.mock("@/lib/security/vault", () => ({
  decryptCredential: jest.fn(),
  recordCredentialUsage: jest.fn(),
  resolveOrganizationAiPolicy: jest.fn(),
}));

import { CredentialPurpose, CredentialStatus, AiProvider } from "@prisma/client";
import {
  resolveOrganizationLanguageModel,
  resolveOrganizationEmbeddingModel,
  resolveOrganizationGenerativeAiClient,
  AiResolverError,
} from "@/lib/ai/resolver";
import { googleProvider } from "@/lib/ai/provider";
import { db } from "@/lib/prisma/db";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  decryptCredential,
  resolveOrganizationAiPolicy,
} from "@/lib/security/vault";

const TEST_KEYRING = {
  v1: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("ai-resolver: Organization-Aware AI Provider Resolution", () => {
  const orgA = "org-tenant-a";
  const orgB = "org-tenant-b";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Active Organization BYOK Credential", () => {
    it("resolves to an isolated language model bound to Org A's active key", async () => {
      const orgAKey = "AIzaSecretKeyForOrgA1111111111111111";

      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "key-org-a",
        orgId: orgA,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.GENERATION,
        status: CredentialStatus.ACTIVE,
        keyVersion: "v1",
        encryptedKey: "enc-key-a",
        keyIv: "iv-a",
        keyAuthTag: "tag-a",
        last4: "1111",
      });
      (decryptCredential as jest.Mock).mockReturnValueOnce(orgAKey);

      const model = await resolveOrganizationLanguageModel({
        orgId: orgA,
        overrideKeyring: TEST_KEYRING,
        prismaClient: db,
      });

      expect(decryptCredential).toHaveBeenCalledTimes(1);
      expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: orgAKey });
      expect((model as unknown as MockTestModel).apiKeyUsed).toBe(orgAKey);
    });

    it("enforces strict tenant isolation: Org A's key is never used for Org B", async () => {
      const orgAKey = "AIzaSecretKeyForOrgA1111111111111111";
      const orgBKey = "AIzaSecretKeyForOrgB2222222222222222";

      // 1. Resolve Org A
      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "key-org-a",
        orgId: orgA,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.GENERATION,
        status: CredentialStatus.ACTIVE,
        keyVersion: "v1",
        encryptedKey: "enc-key-a",
        keyIv: "iv-a",
        keyAuthTag: "tag-a",
        last4: "1111",
      });
      (decryptCredential as jest.Mock).mockReturnValueOnce(orgAKey);

      const modelA = await resolveOrganizationLanguageModel({
        orgId: orgA,
        overrideKeyring: TEST_KEYRING,
        prismaClient: db,
      });

      // 2. Resolve Org B
      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "key-org-b",
        orgId: orgB,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.GENERATION,
        status: CredentialStatus.ACTIVE,
        keyVersion: "v1",
        encryptedKey: "enc-key-b",
        keyIv: "iv-b",
        keyAuthTag: "tag-b",
        last4: "2222",
      });
      (decryptCredential as jest.Mock).mockReturnValueOnce(orgBKey);

      const modelB = await resolveOrganizationLanguageModel({
        orgId: orgB,
        overrideKeyring: TEST_KEYRING,
        prismaClient: db,
      });

      expect((modelA as unknown as MockTestModel).apiKeyUsed).toBe(orgAKey);
      expect((modelB as unknown as MockTestModel).apiKeyUsed).toBe(orgBKey);
      expect((modelA as unknown as MockTestModel).apiKeyUsed).not.toBe(
        (modelB as unknown as MockTestModel).apiKeyUsed
      );
    });
  });

  describe("Inactive Organization Credential Guard (No Silent Fallback)", () => {
    it("refuses resolution and NEVER falls back when credential status is REVOKED", async () => {
      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "key-org-revoked",
        orgId: orgA,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.GENERATION,
        status: CredentialStatus.REVOKED,
      });

      await expect(
        resolveOrganizationLanguageModel({
          orgId: orgA,
          prismaClient: db,
        })
      ).rejects.toThrow(AiResolverError);

      expect(decryptCredential).not.toHaveBeenCalled();
      expect(resolveOrganizationAiPolicy).not.toHaveBeenCalled();
    });

    it("refuses resolution and NEVER falls back when credential status is PENDING_VALIDATION", async () => {
      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "key-org-pending",
        orgId: orgA,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.GENERATION,
        status: CredentialStatus.PENDING_VALIDATION,
      });

      await expect(
        resolveOrganizationLanguageModel({
          orgId: orgA,
          prismaClient: db,
        })
      ).rejects.toThrow(AiResolverError);

      expect(decryptCredential).not.toHaveBeenCalled();
      expect(resolveOrganizationAiPolicy).not.toHaveBeenCalled();
    });
  });

  describe("Missing Credential & Entitlement Policy", () => {
    it("uses Forge platform provider when missing credential and policy permits fallback", async () => {
      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce(null);

      (resolveOrganizationAiPolicy as jest.Mock).mockResolvedValueOnce({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        allowPlatformFallback: true,
        requiresByok: false,
        tierResolved: true,
        tierIdentifier: "PAID_PLAN_123",
        reason: "Active subscription entitled to Forge platform AI fallback.",
      });

      const model = await resolveOrganizationLanguageModel({
        orgId: orgA,
        modelId: "gemini-3.6-flash",
        prismaClient: db,
      });

      const platformModel = googleProvider("gemini-3.6-flash");
      expect(model.modelId).toBe(platformModel.modelId);
      expect(model.provider).toBe(platformModel.provider);
    });

    it("throws ORGANIZATION_KEY_REQUIRED when missing credential and policy disallows fallback", async () => {
      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce(null);

      (resolveOrganizationAiPolicy as jest.Mock).mockResolvedValueOnce({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        allowPlatformFallback: false,
        requiresByok: true,
        tierResolved: true,
        tierIdentifier: "FREE",
        reason: "Unsubscribed organization has no platform AI credit entitlement; BYOK is required.",
      });

      await expect(
        resolveOrganizationLanguageModel({
          orgId: orgA,
          prismaClient: db,
        })
      ).rejects.toMatchObject({
        code: "ORGANIZATION_KEY_REQUIRED",
      });
    });

    it("throws POLICY_UNRESOLVED when organization tier cannot be authoritatively resolved", async () => {
      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce(null);

      (resolveOrganizationAiPolicy as jest.Mock).mockResolvedValueOnce({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        allowPlatformFallback: false,
        requiresByok: true,
        tierResolved: false,
        tierIdentifier: "UNKNOWN_TIER",
        reason: "Unresolved plan identifier 'UNKNOWN_TIER'. No authoritative mapping to platform AI fallback exists.",
      });

      await expect(
        resolveOrganizationLanguageModel({
          orgId: orgA,
          prismaClient: db,
        })
      ).rejects.toMatchObject({
        code: "POLICY_UNRESOLVED",
      });
    });
  });

  describe("Embedding & Direct Client Resolution", () => {
    it("resolves embedding model using organization key", async () => {
      const orgAEmbeddingKey = "AIzaEmbeddingKeyOrgA1111111111111111";

      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "key-emb-a",
        orgId: orgA,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.EMBEDDING,
        status: CredentialStatus.ACTIVE,
        keyVersion: "v1",
        encryptedKey: "enc-emb-a",
        keyIv: "iv-emb",
        keyAuthTag: "tag-emb",
        last4: "3333",
      });
      (decryptCredential as jest.Mock).mockReturnValueOnce(orgAEmbeddingKey);

      const embModel = await resolveOrganizationEmbeddingModel({
        orgId: orgA,
        overrideKeyring: TEST_KEYRING,
        prismaClient: db,
      });

      expect(decryptCredential).toHaveBeenCalledTimes(1);
      expect((embModel as unknown as MockTestModel).apiKeyUsed).toBe(orgAEmbeddingKey);
    });

    it("resolves direct GenerativeAI client for worker pipelines", async () => {
      const orgAEmbeddingKey = "AIzaEmbeddingKeyOrgA1111111111111111";

      (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
        id: "key-emb-a",
        orgId: orgA,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.EMBEDDING,
        status: CredentialStatus.ACTIVE,
        keyVersion: "v1",
        encryptedKey: "enc-emb-a",
        keyIv: "iv-emb",
        keyAuthTag: "tag-emb",
        last4: "3333",
      });
      (decryptCredential as jest.Mock).mockReturnValueOnce(orgAEmbeddingKey);

      const resolved = await resolveOrganizationGenerativeAiClient({
        orgId: orgA,
        purpose: CredentialPurpose.EMBEDDING,
        overrideKeyring: TEST_KEYRING,
        prismaClient: db,
      });

      expect(resolved.source).toBe("ORGANIZATION");
      expect(resolved.client).toBeDefined();
      expect(resolved.fallbackClient).toBeUndefined();
    });
  });
});
