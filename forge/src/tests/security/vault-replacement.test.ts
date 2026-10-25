// src/tests/security/vault-replacement.test.ts
jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    organizationApiKey: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
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
      findUniqueOrThrow: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
    },
  },
}));

import { CredentialPurpose, CredentialStatus, AiProvider } from "@prisma/client";
import {
  stageAndActivateCredential,
  revokeOrganizationCredential,
  getDecryptedOrganizationCredential,
  VaultValidationError,
  VaultConcurrencyError,
  VaultStatusError,
} from "@/lib/security/vault";
import { db } from "@/lib/prisma/db";

const TEST_KEYRING = {
  v1: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const mockValidateGeminiKey = jest.fn();
jest.mock("@/lib/security/vault/validation", () => {
  const actual = jest.requireActual("@/lib/security/vault/validation");
  return {
    ...actual,
    validateGeminiKey: (...args: unknown[]) => mockValidateGeminiKey(...args),
  };
});

describe("vault-replacement: Safe Staged Key Replacement Lifecycle", () => {
  const orgId = "org-test-replacement";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("preserves preexisting ACTIVE key when candidate key fails validation", async () => {
    // 1. Existing active key in database
    const existingActiveRecord = {
      id: "key-1",
      orgId,
      provider: AiProvider.GEMINI,
      purpose: CredentialPurpose.GENERATION,
      status: CredentialStatus.ACTIVE,
      last4: "1111",
      keyVersion: "v1",
      encryptedKey: "existing-encrypted",
      keyIv: "iv",
      keyAuthTag: "tag",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      lastValidatedAt: new Date("2026-01-01"),
      lastUsedAt: null,
      createdByUserId: "user-1",
    };
    (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValue(existingActiveRecord);

    // 2. Candidate key validation fails (rejected by Google)
    mockValidateGeminiKey.mockResolvedValueOnce({
      valid: false,
      category: "AUTH_FAILURE",
      message: "API key was rejected by Google.",
      testedModel: "gemini-3.6-flash",
      latencyMs: 120,
    });

    // 3. Attempt to stage candidate key
    await expect(
      stageAndActivateCredential(
        {
          orgId,
          purpose: CredentialPurpose.GENERATION,
          apiKey: "AIzaCandidateKeyThatIsInvalid9999",
          userId: "admin-user",
          overrideKeyring: TEST_KEYRING,
        },
        db
      )
    ).rejects.toThrow(VaultValidationError);

    // 4. Invariant: Database was NEVER mutated (updateMany, create, update not called)
    expect(db.organizationApiKey.updateMany).not.toHaveBeenCalled();
    expect(db.organizationApiKey.create).not.toHaveBeenCalled();
    expect(db.organizationApiKey.update).not.toHaveBeenCalled();
  });

  it("atomically creates and activates credential in database when validation passes", async () => {
    (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce(null);

    mockValidateGeminiKey.mockResolvedValueOnce({
      valid: true,
      category: "VALID",
      message: "API key successfully validated.",
      testedModel: "gemini-3.6-flash",
      latencyMs: 80,
    });

    const candidateKey = "AIzaValidCandidateKey2222";
    const expectedLast4 = "2222";

    (db.organizationApiKey.create as jest.Mock).mockResolvedValueOnce({
      id: "key-2",
      orgId,
      provider: AiProvider.GEMINI,
      purpose: CredentialPurpose.GENERATION,
      status: CredentialStatus.ACTIVE,
      last4: expectedLast4,
      keyVersion: "v1",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastValidatedAt: new Date(),
      lastUsedAt: null,
      createdByUserId: "admin-user",
    });

    const result = await stageAndActivateCredential(
      {
        orgId,
        purpose: CredentialPurpose.GENERATION,
        apiKey: candidateKey,
        userId: "admin-user",
        overrideKeyring: TEST_KEYRING,
      },
      db
    );

    expect(result.validationResult.valid).toBe(true);
    expect(result.metadata.status).toBe(CredentialStatus.ACTIVE);
    expect(result.metadata.last4).toBe(expectedLast4);

    expect(db.organizationApiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId,
          provider: AiProvider.GEMINI,
          purpose: CredentialPurpose.GENERATION,
          status: CredentialStatus.ACTIVE,
          last4: expectedLast4,
        }),
      })
    );
  });

  it("atomically updates existing credential with CAS when validation passes", async () => {
    const existingDate = new Date("2026-02-01T10:00:00Z");
    (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "key-existing-1",
      updatedAt: existingDate,
    });

    mockValidateGeminiKey.mockResolvedValueOnce({
      valid: true,
      category: "VALID",
      message: "API key successfully validated.",
      testedModel: "gemini-3.6-flash",
      latencyMs: 80,
    });

    (db.organizationApiKey.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
    (db.organizationApiKey.findUniqueOrThrow as jest.Mock).mockResolvedValueOnce({
      id: "key-existing-1",
      orgId,
      provider: AiProvider.GEMINI,
      purpose: CredentialPurpose.GENERATION,
      status: CredentialStatus.ACTIVE,
      last4: "3333",
      keyVersion: "v1",
      createdAt: existingDate,
      updatedAt: new Date(),
      lastValidatedAt: new Date(),
      lastUsedAt: null,
      createdByUserId: "admin-user",
    });

    const result = await stageAndActivateCredential(
      {
        orgId,
        purpose: CredentialPurpose.GENERATION,
        apiKey: "AIzaValidCandidateKey3333",
        userId: "admin-user",
        overrideKeyring: TEST_KEYRING,
      },
      db
    );

    expect(result.validationResult.valid).toBe(true);
    expect(result.metadata.status).toBe(CredentialStatus.ACTIVE);
    expect(db.organizationApiKey.updateMany).toHaveBeenCalledWith({
      where: {
        id: "key-existing-1",
        updatedAt: existingDate,
      },
      data: expect.objectContaining({
        status: CredentialStatus.ACTIVE,
        last4: "3333",
      }),
    });
  });

  it("aborts with VaultConcurrencyError when a concurrent write modified the credential during validation (CAS failure)", async () => {
    const initialDate = new Date("2026-03-01T12:00:00Z");
    (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
      id: "key-stale-1",
      updatedAt: initialDate,
    });

    mockValidateGeminiKey.mockResolvedValueOnce({
      valid: true,
      category: "VALID",
      message: "Validation succeeded.",
      testedModel: "gemini-3.6-flash",
      latencyMs: 90,
    });

    // CAS failure: another transaction updated the record, so count is 0
    (db.organizationApiKey.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });

    await expect(
      stageAndActivateCredential(
        {
          orgId,
          purpose: CredentialPurpose.GENERATION,
          apiKey: "AIzaValidCandidateKey4444",
          userId: "admin-user",
          overrideKeyring: TEST_KEYRING,
        },
        db
      )
    ).rejects.toThrow(VaultConcurrencyError);
  });

  it("aborts with VaultConcurrencyError when concurrent creation occurs during validation", async () => {
    (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce(null);

    mockValidateGeminiKey.mockResolvedValueOnce({
      valid: true,
      category: "VALID",
      message: "Validation succeeded.",
      testedModel: "gemini-3.6-flash",
      latencyMs: 90,
    });

    // Unique collision error from Prisma (code P2002)
    const p2002Error = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    (db.organizationApiKey.create as jest.Mock).mockRejectedValueOnce(p2002Error);

    await expect(
      stageAndActivateCredential(
        {
          orgId,
          purpose: CredentialPurpose.GENERATION,
          apiKey: "AIzaValidCandidateKey5555",
          userId: "admin-user",
          overrideKeyring: TEST_KEYRING,
        },
        db
      )
    ).rejects.toThrow(VaultConcurrencyError);
  });

  it("transitions credential to REVOKED status and blocks subsequent retrieval", async () => {
    (db.organizationApiKey.update as jest.Mock).mockResolvedValueOnce({
      id: "key-1",
      orgId,
      provider: AiProvider.GEMINI,
      purpose: CredentialPurpose.GENERATION,
      status: CredentialStatus.REVOKED,
      last4: "1111",
      keyVersion: "v1",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastValidatedAt: new Date(),
      lastUsedAt: null,
      createdByUserId: "user-1",
    });

    const revoked = await revokeOrganizationCredential(
      orgId,
      CredentialPurpose.GENERATION,
      AiProvider.GEMINI,
      db
    );

    expect(revoked.status).toBe(CredentialStatus.REVOKED);
    expect(db.organizationApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId_provider_purpose: {
            orgId,
            provider: AiProvider.GEMINI,
            purpose: CredentialPurpose.GENERATION,
          },
        },
        data: expect.objectContaining({
          status: CredentialStatus.REVOKED,
        }),
      })
    );

    // Decrypting a revoked key throws VaultStatusError
    (db.organizationApiKey.findUnique as jest.Mock).mockResolvedValueOnce({
      status: CredentialStatus.REVOKED,
    });

    await expect(
      getDecryptedOrganizationCredential(
        orgId,
        CredentialPurpose.GENERATION,
        AiProvider.GEMINI,
        TEST_KEYRING,
        db
      )
    ).rejects.toThrow(VaultStatusError);
  });
});
