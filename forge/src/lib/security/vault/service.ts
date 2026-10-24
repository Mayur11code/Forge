import "server-only";
import { db } from "@/lib/prisma/db";
import {
  AiProvider,
  CredentialPurpose,
  CredentialStatus,
} from "@prisma/client";
import {
  encryptCredential,
  decryptCredential,
  VaultEncryptionError,
} from "./encryption";

export class VaultStatusError extends Error {
  public readonly code = "VAULT_STATUS_ERROR";
  constructor(message: string) {
    super(`[BYOK_VAULT_STATUS] ${message}`);
    this.name = "VaultStatusError";
  }
}

/**
 * Public, safe representation of an organization credential.
 * Strict invariant: Never includes ciphertext, IV, auth tag, or plaintext secret.
 */
export interface OrganizationCredentialMetadata {
  id: string;
  orgId: string;
  provider: AiProvider;
  purpose: CredentialPurpose;
  keyVersion: string;
  last4: string;
  status: CredentialStatus;
  createdAt: Date;
  updatedAt: Date;
  lastValidatedAt: Date | null;
  lastUsedAt: Date | null;
  createdByUserId: string | null;
}

export const safeCredentialSelect = {
  id: true,
  orgId: true,
  provider: true,
  purpose: true,
  keyVersion: true,
  last4: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  lastValidatedAt: true,
  lastUsedAt: true,
  createdByUserId: true,
} as const;

export interface StoreCredentialInput {
  orgId: string;
  provider?: AiProvider;
  purpose: CredentialPurpose;
  apiKey: string;
  userId?: string | null;
  overrideKeyring?: Record<string, string>;
}

export interface DecryptedCredentialResult {
  apiKey: string;
  metadata: OrganizationCredentialMetadata;
}

type DatabaseClient = typeof db;

/**
 * Encrypts and stores an organization credential.
 * Enforces:
 * - Upsert logic on unique [orgId, provider, purpose].
 * - Initial status ALWAYS enters PENDING_VALIDATION.
 * - Extracts last4 for safe identification.
 * - Returns ONLY safe metadata.
 */
export async function storeOrganizationCredential(
  input: StoreCredentialInput,
  prismaClient: DatabaseClient = db
): Promise<OrganizationCredentialMetadata> {
  const { orgId, purpose, apiKey, userId, overrideKeyring } = input;
  const provider = input.provider || AiProvider.GEMINI;

  if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new VaultEncryptionError("Cannot store credential: valid orgId is required");
  }
  if (!purpose || !Object.values(CredentialPurpose).includes(purpose)) {
    throw new VaultEncryptionError(`Cannot store credential: valid purpose is required (got ${purpose})`);
  }
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 4) {
    throw new VaultEncryptionError("Cannot store credential: valid API key of at least 4 characters is required");
  }

  const trimmedKey = apiKey.trim();
  const last4 = trimmedKey.slice(-4);

  // Encrypt with authenticated AAD context bound to this tenant and purpose
  const payload = encryptCredential(
    trimmedKey,
    {
      orgId,
      provider,
      purpose,
    },
    overrideKeyring
  );

  const record = await prismaClient.organizationApiKey.upsert({
    where: {
      orgId_provider_purpose: {
        orgId,
        provider,
        purpose,
      },
    },
    create: {
      orgId,
      provider,
      purpose,
      encryptedKey: payload.encryptedKey,
      keyIv: payload.keyIv,
      keyAuthTag: payload.keyAuthTag,
      keyVersion: payload.keyVersion,
      last4,
      status: CredentialStatus.PENDING_VALIDATION,
      createdByUserId: userId ?? null,
    },
    update: {
      encryptedKey: payload.encryptedKey,
      keyIv: payload.keyIv,
      keyAuthTag: payload.keyAuthTag,
      keyVersion: payload.keyVersion,
      last4,
      status: CredentialStatus.PENDING_VALIDATION,
      createdByUserId: userId ?? null,
      updatedAt: new Date(),
    },
    select: safeCredentialSelect,
  });

  return record;
}

/**
 * Retrieves safe metadata for a specific credential without returning cipher or plaintext.
 */
export async function getOrganizationCredentialMetadata(
  orgId: string,
  purpose: CredentialPurpose,
  provider: AiProvider = AiProvider.GEMINI,
  prismaClient: DatabaseClient = db
): Promise<OrganizationCredentialMetadata | null> {
  if (!orgId) return null;

  return prismaClient.organizationApiKey.findUnique({
    where: {
      orgId_provider_purpose: {
        orgId,
        provider,
        purpose,
      },
    },
    select: safeCredentialSelect,
  });
}

/**
 * Lists all safe credential metadata for an organization.
 * Never leaks ciphertext, auth tags, or secrets.
 */
export async function listOrganizationCredentials(
  orgId: string,
  prismaClient: DatabaseClient = db
): Promise<OrganizationCredentialMetadata[]> {
  if (!orgId) return [];

  return prismaClient.organizationApiKey.findMany({
    where: { orgId },
    select: safeCredentialSelect,
    orderBy: [{ provider: "asc" }, { purpose: "asc" }],
  });
}

/**
 * Internal-only server primitive: retrieves and decrypts an organization credential.
 * Enforces:
 * - Must exist in database.
 * - Status MUST be ACTIVE. Any other status (PENDING_VALIDATION, INVALID, REVOKED) throws VaultStatusError.
 * - AAD context is validated; tampering throws VaultDecryptionError.
 */
export async function getDecryptedOrganizationCredential(
  orgId: string,
  purpose: CredentialPurpose,
  provider: AiProvider = AiProvider.GEMINI,
  overrideKeyring?: Record<string, string>,
  prismaClient: DatabaseClient = db
): Promise<DecryptedCredentialResult | null> {
  if (!orgId) return null;

  const record = await prismaClient.organizationApiKey.findUnique({
    where: {
      orgId_provider_purpose: {
        orgId,
        provider,
        purpose,
      },
    },
  });

  if (!record) {
    return null;
  }

  // Refuse execution if status is not ACTIVE
  if (record.status !== CredentialStatus.ACTIVE) {
    throw new VaultStatusError(
      `Credential for org '${orgId}', provider '${provider}', purpose '${purpose}' cannot be used: status is '${record.status}' (expected ACTIVE)`
    );
  }

  const decryptedKey = decryptCredential(
    {
      encryptedKey: record.encryptedKey,
      keyIv: record.keyIv,
      keyAuthTag: record.keyAuthTag,
      keyVersion: record.keyVersion,
    },
    {
      orgId,
      provider,
      purpose,
      keyVersion: record.keyVersion,
    },
    overrideKeyring
  );

  const metadata: OrganizationCredentialMetadata = {
    id: record.id,
    orgId: record.orgId,
    provider: record.provider,
    purpose: record.purpose,
    keyVersion: record.keyVersion,
    last4: record.last4,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastValidatedAt: record.lastValidatedAt,
    lastUsedAt: record.lastUsedAt,
    createdByUserId: record.createdByUserId,
  };

  return {
    apiKey: decryptedKey,
    metadata,
  };
}

/**
 * Updates the lifecycle status of an organization credential.
 * If status transitions to ACTIVE, records lastValidatedAt.
 */
export async function updateCredentialStatus(
  orgId: string,
  purpose: CredentialPurpose,
  status: CredentialStatus,
  provider: AiProvider = AiProvider.GEMINI,
  prismaClient: DatabaseClient = db
): Promise<OrganizationCredentialMetadata> {
  const updateData: { status: CredentialStatus; lastValidatedAt?: Date } = { status };
  if (status === CredentialStatus.ACTIVE) {
    updateData.lastValidatedAt = new Date();
  }

  return prismaClient.organizationApiKey.update({
    where: {
      orgId_provider_purpose: {
        orgId,
        provider,
        purpose,
      },
    },
    data: updateData,
    select: safeCredentialSelect,
  });
}

/**
 * Records lastUsedAt timestamp when an active credential is used.
 */
export async function recordCredentialUsage(
  orgId: string,
  purpose: CredentialPurpose,
  provider: AiProvider = AiProvider.GEMINI,
  prismaClient: DatabaseClient = db
): Promise<void> {
  try {
    await prismaClient.organizationApiKey.update({
      where: {
        orgId_provider_purpose: {
          orgId,
          provider,
          purpose,
        },
      },
      data: {
        lastUsedAt: new Date(),
      },
    });
  } catch {
    // Non-fatal telemetry update
  }
}

/**
 * Deletes an organization credential.
 */
export async function deleteOrganizationCredential(
  orgId: string,
  purpose: CredentialPurpose,
  provider: AiProvider = AiProvider.GEMINI,
  prismaClient: DatabaseClient = db
): Promise<boolean> {
  try {
    await prismaClient.organizationApiKey.delete({
      where: {
        orgId_provider_purpose: {
          orgId,
          provider,
          purpose,
        },
      },
    });
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      return false; // Record to delete does not exist
    }
    throw err;
  }
}
