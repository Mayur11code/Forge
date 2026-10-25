import "server-only";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AiProvider, CredentialPurpose, CredentialStatus } from "@prisma/client";
import { db } from "@/lib/prisma/db";
import {
  decryptCredential,
  recordCredentialUsage,
  resolveOrganizationAiPolicy,
} from "@/lib/security/vault";
import { googleProvider } from "@/lib/ai/provider";

export type LanguageModel = ReturnType<GoogleGenerativeAIProvider>;
export type EmbeddingModel = ReturnType<GoogleGenerativeAIProvider["embeddingModel"]>;

export type ResolverErrorCode =
  | "ORGANIZATION_KEY_REQUIRED"
  | "CREDENTIAL_NOT_ACTIVE"
  | "POLICY_UNRESOLVED"
  | "VAULT_ERROR";

export class AiResolverError extends Error {
  public readonly code: ResolverErrorCode;
  public readonly orgId: string;
  public readonly purpose: CredentialPurpose;

  constructor(
    code: ResolverErrorCode,
    message: string,
    orgId: string,
    purpose: CredentialPurpose
  ) {
    super(`[AI_RESOLVER] [${code}] ${message}`);
    this.name = "AiResolverError";
    this.code = code;
    this.orgId = orgId;
    this.purpose = purpose;
  }
}

export interface ResolveModelOptions {
  orgId: string;
  modelId?: string;
  overrideKeyring?: Record<string, string>;
  prismaClient?: typeof db;
  fallbackModel?: LanguageModel;
}

export interface ResolvedGenerativeAiClient {
  client: GoogleGenerativeAI;
  source: "ORGANIZATION" | "PLATFORM";
  fallbackClient?: GoogleGenerativeAI;
}

/**
 * Resolves an organization-scoped LanguageModel for generation tasks.
 *
 * Strict Invariants:
 * 1. If an active organization credential exists, returns an isolated model
 *    instance bound to that key. It NEVER silently falls back to platform keys.
 * 2. If a credential exists in vault but is NOT ACTIVE (PENDING_VALIDATION,
 *    INVALID, REVOKED), throws CredentialNotActive error. NEVER silently falls back.
 * 3. If no credential exists in vault, queries authoritative entitlement policy.
 *    If fallback permitted -> returns Forge platform model (with rotation).
 *    If fallback denied -> throws OrganizationKeyRequired or PolicyUnresolved error.
 * 4. Never mutates global singleton models.
 */
export async function resolveOrganizationLanguageModel(
  options: ResolveModelOptions
): Promise<LanguageModel> {
  const { orgId, modelId = "gemini-3.6-flash", overrideKeyring, prismaClient = db } = options;

  if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new AiResolverError(
      "POLICY_UNRESOLVED",
      "Organization ID is required for AI model resolution.",
      orgId || "unknown",
      CredentialPurpose.GENERATION
    );
  }

  const credentialRecord = prismaClient.organizationApiKey?.findUnique
    ? await prismaClient.organizationApiKey.findUnique({
        where: {
          orgId_provider_purpose: {
            orgId,
            provider: AiProvider.GEMINI,
            purpose: CredentialPurpose.GENERATION,
          },
        },
      })
    : null;

  if (credentialRecord) {
    if (credentialRecord.status !== CredentialStatus.ACTIVE) {
      throw new AiResolverError(
        "CREDENTIAL_NOT_ACTIVE",
        `Organization generation credential is in status '${credentialRecord.status}'. ` +
          "AI operations cannot proceed until the key is validated and active.",
        orgId,
        CredentialPurpose.GENERATION
      );
    }

    // Decrypt organization key
    const decryptedKey = decryptCredential(
      {
        encryptedKey: credentialRecord.encryptedKey,
        keyIv: credentialRecord.keyIv,
        keyAuthTag: credentialRecord.keyAuthTag,
        keyVersion: credentialRecord.keyVersion,
      },
      {
        orgId,
        provider: credentialRecord.provider,
        purpose: credentialRecord.purpose,
        keyVersion: credentialRecord.keyVersion,
      },
      overrideKeyring
    );

    // Record usage asynchronously
    void recordCredentialUsage(orgId, CredentialPurpose.GENERATION, AiProvider.GEMINI, prismaClient);

    // Return tenant-isolated model instance
    const tenantProvider = createGoogleGenerativeAI({
      apiKey: decryptedKey,
    });
    return tenantProvider(modelId);
  }

  // No organization credential configured: evaluate entitlement policy
  const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.GENERATION, {
    prismaClient,
  });

  if (policy.allowPlatformFallback) {
    return options.fallbackModel ?? googleProvider(modelId);
  }

  if (!policy.tierResolved) {
    throw new AiResolverError(
      "POLICY_UNRESOLVED",
      policy.reason,
      orgId,
      CredentialPurpose.GENERATION
    );
  }

  throw new AiResolverError(
    "ORGANIZATION_KEY_REQUIRED",
    `Organization has no configured AI generation key. Platform fallback denied: ${policy.reason}`,
    orgId,
    CredentialPurpose.GENERATION
  );
}

/**
 * Resolves an organization-scoped EmbeddingModel for vector embeddings.
 */
export async function resolveOrganizationEmbeddingModel(
  options: ResolveModelOptions
): Promise<EmbeddingModel> {
  const { orgId, modelId = "gemini-embedding-001", overrideKeyring, prismaClient = db } = options;

  if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new AiResolverError(
      "POLICY_UNRESOLVED",
      "Organization ID is required for AI model resolution.",
      orgId || "unknown",
      CredentialPurpose.EMBEDDING
    );
  }

  const credentialRecord = prismaClient.organizationApiKey?.findUnique
    ? await prismaClient.organizationApiKey.findUnique({
        where: {
          orgId_provider_purpose: {
            orgId,
            provider: AiProvider.GEMINI,
            purpose: CredentialPurpose.EMBEDDING,
          },
        },
      })
    : null;

  if (credentialRecord) {
    if (credentialRecord.status !== CredentialStatus.ACTIVE) {
      throw new AiResolverError(
        "CREDENTIAL_NOT_ACTIVE",
        `Organization embedding credential is in status '${credentialRecord.status}'. ` +
          "AI operations cannot proceed until the key is validated and active.",
        orgId,
        CredentialPurpose.EMBEDDING
      );
    }

    const decryptedKey = decryptCredential(
      {
        encryptedKey: credentialRecord.encryptedKey,
        keyIv: credentialRecord.keyIv,
        keyAuthTag: credentialRecord.keyAuthTag,
        keyVersion: credentialRecord.keyVersion,
      },
      {
        orgId,
        provider: credentialRecord.provider,
        purpose: credentialRecord.purpose,
        keyVersion: credentialRecord.keyVersion,
      },
      overrideKeyring
    );

    void recordCredentialUsage(orgId, CredentialPurpose.EMBEDDING, AiProvider.GEMINI, prismaClient);

    const tenantProvider = createGoogleGenerativeAI({
      apiKey: decryptedKey,
    });
    return tenantProvider.embeddingModel(modelId);
  }

  const policy = await resolveOrganizationAiPolicy(orgId, CredentialPurpose.EMBEDDING, {
    prismaClient,
  });

  if (policy.allowPlatformFallback) {
    return googleProvider.embeddingModel(modelId);
  }

  if (!policy.tierResolved) {
    throw new AiResolverError(
      "POLICY_UNRESOLVED",
      policy.reason,
      orgId,
      CredentialPurpose.EMBEDDING
    );
  }

  throw new AiResolverError(
    "ORGANIZATION_KEY_REQUIRED",
    `Organization has no configured AI embedding key. Platform fallback denied: ${policy.reason}`,
    orgId,
    CredentialPurpose.EMBEDDING
  );
}

/**
 * Resolves a GoogleGenerativeAI client for direct SDK consumers (such as embedding-worker).
 */
export async function resolveOrganizationGenerativeAiClient(options: {
  orgId: string;
  purpose: CredentialPurpose;
  overrideKeyring?: Record<string, string>;
  prismaClient?: typeof db;
}): Promise<ResolvedGenerativeAiClient> {
  const { orgId, purpose, overrideKeyring, prismaClient = db } = options;

  if (!orgId || typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new AiResolverError(
      "POLICY_UNRESOLVED",
      "Organization ID is required for AI client resolution.",
      orgId || "unknown",
      purpose
    );
  }

  const credentialRecord = prismaClient.organizationApiKey?.findUnique
    ? await prismaClient.organizationApiKey.findUnique({
        where: {
          orgId_provider_purpose: {
            orgId,
            provider: AiProvider.GEMINI,
            purpose,
          },
        },
      })
    : null;

  if (credentialRecord) {
    if (credentialRecord.status !== CredentialStatus.ACTIVE) {
      throw new AiResolverError(
        "CREDENTIAL_NOT_ACTIVE",
        `Organization credential for '${purpose}' is in status '${credentialRecord.status}'. ` +
          "AI operations cannot proceed until the key is validated and active.",
        orgId,
        purpose
      );
    }

    const decryptedKey = decryptCredential(
      {
        encryptedKey: credentialRecord.encryptedKey,
        keyIv: credentialRecord.keyIv,
        keyAuthTag: credentialRecord.keyAuthTag,
        keyVersion: credentialRecord.keyVersion,
      },
      {
        orgId,
        provider: credentialRecord.provider,
        purpose: credentialRecord.purpose,
        keyVersion: credentialRecord.keyVersion,
      },
      overrideKeyring
    );

    void recordCredentialUsage(orgId, purpose, AiProvider.GEMINI, prismaClient);

    return {
      client: new GoogleGenerativeAI(decryptedKey),
      source: "ORGANIZATION",
    };
  }

  const policy = await resolveOrganizationAiPolicy(orgId, purpose, { prismaClient });

  if (policy.allowPlatformFallback) {
    const primaryKey = process.env.GEMINI_API_KEY!;
    const fallbackKey = process.env.GEMINI_API_KEY_FALLBACK;

    return {
      client: new GoogleGenerativeAI(primaryKey),
      source: "PLATFORM",
      fallbackClient: fallbackKey ? new GoogleGenerativeAI(fallbackKey) : undefined,
    };
  }

  if (!policy.tierResolved) {
    throw new AiResolverError("POLICY_UNRESOLVED", policy.reason, orgId, purpose);
  }

  throw new AiResolverError(
    "ORGANIZATION_KEY_REQUIRED",
    `Organization has no configured '${purpose}' key. Platform fallback denied: ${policy.reason}`,
    orgId,
    purpose
  );
}
