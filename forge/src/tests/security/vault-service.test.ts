jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    organizationApiKey: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock("@/lib/prisma/extended", () => ({
  prisma: {
    organizationApiKey: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

import { db } from "@/lib/prisma/db";
import {
  storeOrganizationCredential,
  getOrganizationCredentialMetadata,
  listOrganizationCredentials,
  getDecryptedOrganizationCredential,
  updateCredentialStatus,
  recordCredentialUsage,
  deleteOrganizationCredential,
  VaultStatusError,
} from "@/lib/security/vault/service";
import {
  AiProvider,
  CredentialPurpose,
  CredentialStatus,
} from "@prisma/client";
import { VaultEncryptionError } from "@/lib/security/vault/encryption";

interface UpsertArgs {
  where: { orgId_provider_purpose: { orgId: string; provider: AiProvider; purpose: CredentialPurpose } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: Record<string, boolean>;
}
interface FindUniqueArgs {
  where: { orgId_provider_purpose: { orgId: string; provider: AiProvider; purpose: CredentialPurpose } };
  select?: Record<string, boolean>;
}
interface FindManyArgs {
  where: { orgId: string };
  select?: Record<string, boolean>;
  orderBy?: unknown;
}
interface UpdateArgs {
  where: { orgId_provider_purpose: { orgId: string; provider: AiProvider; purpose: CredentialPurpose } };
  data: Record<string, unknown>;
  select?: Record<string, boolean>;
}
interface DeleteArgs {
  where: { orgId_provider_purpose: { orgId: string; provider: AiProvider; purpose: CredentialPurpose } };
}

describe("BYOK Phase 1 — Server-Only Vault Persistence Primitives", () => {
  const testKeyV1 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const overrideKeyring = { v1: testKeyV1 };

  const orgA = "org_enterprise_alpha";
  const orgB = "org_enterprise_beta";
  const userAdmin = "user_admin_cuid_123";

  type DbRecord = {
    id: string;
    orgId: string;
    provider: AiProvider;
    purpose: CredentialPurpose;
    encryptedKey: string;
    keyIv: string;
    keyAuthTag: string;
    keyVersion: string;
    last4: string;
    status: CredentialStatus;
    createdAt: Date;
    updatedAt: Date;
    lastValidatedAt: Date | null;
    lastUsedAt: Date | null;
    createdByUserId: string | null;
  };

  let mockDb: DbRecord[] = [];

  beforeEach(() => {
    mockDb = [];
    jest.clearAllMocks();

    (db.organizationApiKey.upsert as jest.Mock).mockImplementation(
      async ({ where, create, update, select }: UpsertArgs) => {
        const { orgId, provider, purpose } = where.orgId_provider_purpose;
        const existingIdx = mockDb.findIndex(
          (r) => r.orgId === orgId && r.provider === provider && r.purpose === purpose
        );

        let record: DbRecord;
        if (existingIdx >= 0) {
          record = {
            ...mockDb[existingIdx],
            ...(update as Partial<DbRecord>),
            id: mockDb[existingIdx].id,
            updatedAt: new Date(),
          };
          mockDb[existingIdx] = record;
        } else {
          record = {
            id: `key_${Date.now()}_${Math.random()}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastValidatedAt: null,
            lastUsedAt: null,
            ...(create as Partial<DbRecord>),
          } as DbRecord;
          mockDb.push(record);
        }

        if (select) {
          const filtered: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            if (select[key]) filtered[key] = record[key as keyof DbRecord];
          }
          return filtered;
        }
        return record;
      }
    );

    (db.organizationApiKey.findUnique as jest.Mock).mockImplementation(
      async ({ where, select }: FindUniqueArgs) => {
        const { orgId, provider, purpose } = where.orgId_provider_purpose;
        const record = mockDb.find(
          (r) => r.orgId === orgId && r.provider === provider && r.purpose === purpose
        );
        if (!record) return null;

        if (select) {
          const filtered: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            if (select[key]) filtered[key] = record[key as keyof DbRecord];
          }
          return filtered;
        }
        return record;
      }
    );

    (db.organizationApiKey.findMany as jest.Mock).mockImplementation(
      async ({ where, select }: FindManyArgs) => {
        const results = mockDb.filter((r) => r.orgId === where.orgId);
        if (select) {
          return results.map((record) => {
            const filtered: Record<string, unknown> = {};
            for (const key of Object.keys(select)) {
              if (select[key]) filtered[key] = record[key as keyof DbRecord];
            }
            return filtered;
          });
        }
        return results;
      }
    );

    (db.organizationApiKey.update as jest.Mock).mockImplementation(
      async ({ where, data, select }: UpdateArgs) => {
        const { orgId, provider, purpose } = where.orgId_provider_purpose;
        const existingIdx = mockDb.findIndex(
          (r) => r.orgId === orgId && r.provider === provider && r.purpose === purpose
        );
        if (existingIdx < 0) {
          const err = new Error("Record to update not found") as Error & { code?: string };
          err.code = "P2025";
          throw err;
        }
        mockDb[existingIdx] = {
          ...mockDb[existingIdx],
          ...(data as Partial<DbRecord>),
          updatedAt: new Date(),
        };
        const record = mockDb[existingIdx];
        if (select) {
          const filtered: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            if (select[key]) filtered[key] = record[key as keyof DbRecord];
          }
          return filtered;
        }
        return record;
      }
    );

    (db.organizationApiKey.delete as jest.Mock).mockImplementation(
      async ({ where }: DeleteArgs) => {
        const { orgId, provider, purpose } = where.orgId_provider_purpose;
        const existingIdx = mockDb.findIndex(
          (r) => r.orgId === orgId && r.provider === provider && r.purpose === purpose
        );
        if (existingIdx < 0) {
          const err = new Error("Record to delete not found") as Error & { code?: string };
          err.code = "P2025";
          throw err;
        }
        mockDb.splice(existingIdx, 1);
        return true;
      }
    );
  });

  describe("Storing Organization Credentials", () => {
    it("stores a credential with PENDING_VALIDATION status and returns safe metadata", async () => {
      const result = await storeOrganizationCredential({
        orgId: orgA,
        provider: AiProvider.GEMINI,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSySecretGenerationKey1234",
        userId: userAdmin,
        overrideKeyring,
      });

      expect(result.orgId).toBe(orgA);
      expect(result.provider).toBe(AiProvider.GEMINI);
      expect(result.purpose).toBe(CredentialPurpose.GENERATION);
      expect(result.status).toBe(CredentialStatus.PENDING_VALIDATION);
      expect(result.last4).toBe("1234");
      expect(result.createdByUserId).toBe(userAdmin);

      // Verify safe metadata invariant: ciphertext, IV, auth tag are NEVER returned
      expect("encryptedKey" in result).toBe(false);
      expect("keyIv" in result).toBe(false);
      expect("keyAuthTag" in result).toBe(false);
      expect("apiKey" in result).toBe(false);

      // Verify stored record in DB has ciphertext and IV
      const dbRow = mockDb[0];
      expect(dbRow.encryptedKey).toBeDefined();
      expect(dbRow.keyIv).toBeDefined();
      expect(dbRow.keyAuthTag).toBeDefined();
      expect(dbRow.status).toBe(CredentialStatus.PENDING_VALIDATION);
    });

    it("resets status to PENDING_VALIDATION when updating an existing active credential", async () => {
      // 1. Store initial key
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSyOldSecretKey1111",
        overrideKeyring,
      });

      // 2. Mark it active
      await updateCredentialStatus(orgA, CredentialPurpose.GENERATION, CredentialStatus.ACTIVE);
      expect(mockDb[0].status).toBe(CredentialStatus.ACTIVE);

      // 3. Store replacement key
      const updated = await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSyNewSecretKey2222",
        overrideKeyring,
      });

      expect(updated.status).toBe(CredentialStatus.PENDING_VALIDATION);
      expect(updated.last4).toBe("2222");
      expect(mockDb[0].status).toBe(CredentialStatus.PENDING_VALIDATION);
      expect(mockDb).toHaveLength(1); // Upsert guarantees no duplicates
    });

    it("fails when orgId or apiKey is invalid", async () => {
      await expect(
        storeOrganizationCredential({
          orgId: "",
          purpose: CredentialPurpose.GENERATION,
          apiKey: "valid-key-1234",
          overrideKeyring,
        })
      ).rejects.toThrow(VaultEncryptionError);

      await expect(
        storeOrganizationCredential({
          orgId: orgA,
          purpose: CredentialPurpose.GENERATION,
          apiKey: "abc", // less than 4 chars
          overrideKeyring,
        })
      ).rejects.toThrow(VaultEncryptionError);
    });
  });

  describe("Separate Purpose Credentials", () => {
    it("allows independent GENERATION and EMBEDDING credentials for the same org", async () => {
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSyGenKeyAAAA",
        overrideKeyring,
      });

      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.EMBEDDING,
        apiKey: "AIzaSyEmbedKeyBBBB",
        overrideKeyring,
      });

      expect(mockDb).toHaveLength(2);

      const genMeta = await getOrganizationCredentialMetadata(orgA, CredentialPurpose.GENERATION);
      const embMeta = await getOrganizationCredentialMetadata(orgA, CredentialPurpose.EMBEDDING);

      expect(genMeta?.purpose).toBe(CredentialPurpose.GENERATION);
      expect(genMeta?.last4).toBe("AAAA");
      expect(embMeta?.purpose).toBe(CredentialPurpose.EMBEDDING);
      expect(embMeta?.last4).toBe("BBBB");
    });
  });

  describe("Tenant Isolation", () => {
    it("strictly isolates credentials between different organizations", async () => {
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSyOrgAKey1111",
        overrideKeyring,
      });

      await storeOrganizationCredential({
        orgId: orgB,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSyOrgBKey2222",
        overrideKeyring,
      });

      const listA = await listOrganizationCredentials(orgA);
      const listB = await listOrganizationCredentials(orgB);

      expect(listA).toHaveLength(1);
      expect(listA[0].orgId).toBe(orgA);
      expect(listA[0].last4).toBe("1111");

      expect(listB).toHaveLength(1);
      expect(listB[0].orgId).toBe(orgB);
      expect(listB[0].last4).toBe("2222");

      // Org A cannot see Org B's credentials
      const crossFetch = await getOrganizationCredentialMetadata(orgA, CredentialPurpose.GENERATION);
      expect(crossFetch?.last4).toBe("1111");
    });
  });

  describe("Decryption & Status Invariants", () => {
    it("refuses to decrypt credentials with PENDING_VALIDATION status", async () => {
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSySecretKey9999",
        overrideKeyring,
      });

      await expect(
        getDecryptedOrganizationCredential(orgA, CredentialPurpose.GENERATION, AiProvider.GEMINI, overrideKeyring)
      ).rejects.toThrow(VaultStatusError);
    });

    it("refuses to decrypt credentials with INVALID or REVOKED status", async () => {
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSySecretKey9999",
        overrideKeyring,
      });

      // Transition to INVALID
      await updateCredentialStatus(orgA, CredentialPurpose.GENERATION, CredentialStatus.INVALID);
      await expect(
        getDecryptedOrganizationCredential(orgA, CredentialPurpose.GENERATION, AiProvider.GEMINI, overrideKeyring)
      ).rejects.toThrow(/status is 'INVALID'/);

      // Transition to REVOKED
      await updateCredentialStatus(orgA, CredentialPurpose.GENERATION, CredentialStatus.REVOKED);
      await expect(
        getDecryptedOrganizationCredential(orgA, CredentialPurpose.GENERATION, AiProvider.GEMINI, overrideKeyring)
      ).rejects.toThrow(/status is 'REVOKED'/);
    });

    it("successfully decrypts credential when status is ACTIVE", async () => {
      const originalKey = "AIzaSyActiveCustomerKey12345678";
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: originalKey,
        overrideKeyring,
      });

      // Transition to ACTIVE
      await updateCredentialStatus(orgA, CredentialPurpose.GENERATION, CredentialStatus.ACTIVE);

      const decryptedResult = await getDecryptedOrganizationCredential(
        orgA,
        CredentialPurpose.GENERATION,
        AiProvider.GEMINI,
        overrideKeyring
      );

      expect(decryptedResult).not.toBeNull();
      expect(decryptedResult?.apiKey).toBe(originalKey);
      expect(decryptedResult?.metadata.status).toBe(CredentialStatus.ACTIVE);
      expect(decryptedResult?.metadata.last4).toBe("5678");
      expect(decryptedResult?.metadata.lastValidatedAt).toBeInstanceOf(Date);
    });

    it("records lastUsedAt timestamp without error", async () => {
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSySecretKey9999",
        overrideKeyring,
      });

      await recordCredentialUsage(orgA, CredentialPurpose.GENERATION);
      expect(mockDb[0].lastUsedAt).toBeInstanceOf(Date);
    });

    it("deletes credential cleanly", async () => {
      await storeOrganizationCredential({
        orgId: orgA,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaSySecretKey9999",
        overrideKeyring,
      });

      const deleted = await deleteOrganizationCredential(orgA, CredentialPurpose.GENERATION);
      expect(deleted).toBe(true);
      expect(mockDb).toHaveLength(0);

      const notFoundDeleted = await deleteOrganizationCredential(orgA, CredentialPurpose.GENERATION);
      expect(notFoundDeleted).toBe(false);
    });
  });
});
