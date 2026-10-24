import "server-only";
import crypto from "crypto";
import { serverEnv } from "@/lib/env/server";
import { redactSecretPatterns } from "@/lib/security/credential-rotation";

/**
 * Custom error types for the BYOK Credential Vault.
 * Invariant: Messages MUST NEVER leak plaintext keys, ciphertext, or cryptographic secrets.
 */
export class VaultConfigurationError extends Error {
  public readonly code = "VAULT_CONFIGURATION_ERROR";
  constructor(message: string) {
    super(`[BYOK_VAULT_CONFIG] ${redactSecretPatterns(message)}`);
    this.name = "VaultConfigurationError";
  }
}

export class VaultEncryptionError extends Error {
  public readonly code = "VAULT_ENCRYPTION_ERROR";
  constructor(message: string) {
    super(`[BYOK_VAULT_ENCRYPTION] ${redactSecretPatterns(message)}`);
    this.name = "VaultEncryptionError";
  }
}

export class VaultDecryptionError extends Error {
  public readonly code = "VAULT_DECRYPTION_ERROR";
  constructor(message: string) {
    super(`[BYOK_VAULT_DECRYPTION] ${redactSecretPatterns(message)}`);
    this.name = "VaultDecryptionError";
  }
}

export interface EncryptionContext {
  orgId: string;
  provider: string;
  purpose: string;
  keyVersion?: string;
}

export interface EncryptedPayload {
  encryptedKey: string;
  keyIv: string;
  keyAuthTag: string;
  keyVersion: string;
}

/**
 * Builds the canonical Authenticated Additional Data (AAD) buffer.
 * Binds organization, provider, purpose, and key version into the GCM MAC.
 */
export function buildVaultAAD(context: EncryptionContext, keyVersion: string): Buffer {
  if (!context.orgId || !context.provider || !context.purpose) {
    throw new VaultEncryptionError("Missing mandatory context parameters (orgId, provider, purpose) for AAD binding");
  }
  const canonicalString = `forge:vault:v1:org=${context.orgId}:provider=${context.provider}:purpose=${context.purpose}:keyVersion=${keyVersion}`;
  return Buffer.from(canonicalString, "utf8");
}

/**
 * Strictly parses and validates a 32-byte AES-256 encryption key.
 * Accepts only:
 * - 64 hexadecimal characters (256 bits)
 * - Valid Base64 (or Base64URL) string decoding to exactly 32 bytes (256 bits)
 * 
 * Rejects arbitrary passphrases, short strings, malformed encodings,
 * and invalid byte lengths. Never silently hashes or normalizes text into a key.
 */
export function parseVaultKey(rawKey: string): Buffer {
  if (!rawKey || typeof rawKey !== "string") {
    throw new VaultConfigurationError("Vault master key must be a non-empty string");
  }

  const trimmed = rawKey.trim();

  // 1. Strict 64-character hexadecimal check
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "hex");
    if (buf.length === 32) {
      return buf;
    }
  }

  // 2. Strict 32-byte Base64 check (standard 44-char base64 ending in '=')
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 32) {
      return buf;
    }
  }

  // 3. Strict 32-byte Base64URL check (43 characters unpadded or 44 with '=')
  if (/^[A-Za-z0-9\-_]{43}=?$/.test(trimmed)) {
    const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard.padEnd(44, "=");
    const buf = Buffer.from(padded, "base64");
    if (buf.length === 32) {
      return buf;
    }
  }

  throw new VaultConfigurationError(
    "Vault master key must be a cryptographically random 32-byte key encoded as either 64 hexadecimal characters or valid Base64 decoding to 32 bytes. Arbitrary passphrases or unencoded strings are strictly rejected."
  );
}

/**
 * Backward-compatible alias for parseVaultKey.
 */
export const deriveKeyBuffer = parseVaultKey;

/**
 * Resolves the 32-byte encryption key for a given key version.
 * Supports primary key and historical versioned keyring from environment.
 * Applies identical strict validation to all keys (primary and historical).
 */
export function resolveVaultKey(
  targetVersion?: string,
  overrideKeyring?: Record<string, string>
): { keyBuffer: Buffer; resolvedVersion: string } {
  const primaryVersion = serverEnv.FORGE_VAULT_PRIMARY_KEY_VERSION || "v1";
  const version = targetVersion || primaryVersion;

  // 1. Check explicit override keyring (useful in unit testing or rotation tooling)
  if (overrideKeyring) {
    if (Object.prototype.hasOwnProperty.call(overrideKeyring, version)) {
      const rawKey = overrideKeyring[version];
      if (!rawKey || typeof rawKey !== "string") {
        throw new VaultConfigurationError(
          `Empty or non-string key material configured for vault keyVersion '${version}' in override keyring`
        );
      }
      return {
        keyBuffer: parseVaultKey(rawKey),
        resolvedVersion: version,
      };
    }
    // If an explicit override keyring was supplied but does not have the target version, fail closed
    throw new VaultConfigurationError(
      `No encryption key found for vault keyVersion '${version}' in provided keyring.`
    );
  }

  // 2. Check JSON keyring environment variable if present
  const keyringJson = serverEnv.FORGE_VAULT_KEYRING_JSON;
  if (keyringJson && keyringJson.trim() !== "") {
    let parsedKeyring: Record<string, unknown>;
    try {
      parsedKeyring = JSON.parse(keyringJson);
      if (typeof parsedKeyring !== "object" || parsedKeyring === null || Array.isArray(parsedKeyring)) {
        throw new Error("Keyring must be a JSON object");
      }
    } catch {
      throw new VaultConfigurationError(
        "Failed to parse FORGE_VAULT_KEYRING_JSON environment variable: must be a valid JSON object"
      );
    }

    if (Object.prototype.hasOwnProperty.call(parsedKeyring, version)) {
      const rawKey = parsedKeyring[version];
      if (typeof rawKey !== "string" || !rawKey.trim()) {
        throw new VaultConfigurationError(
          `Invalid or empty key material for vault keyVersion '${version}' in FORGE_VAULT_KEYRING_JSON`
        );
      }
      return {
        keyBuffer: parseVaultKey(rawKey),
        resolvedVersion: version,
      };
    }
  }

  // 3. Check primary encryption key environment variable if version matches primaryVersion
  if (version === primaryVersion) {
    const primaryKey = serverEnv.FORGE_VAULT_ENCRYPTION_KEY;
    if (!primaryKey || primaryKey.trim() === "") {
      throw new VaultConfigurationError(
        `Vault primary encryption key FORGE_VAULT_ENCRYPTION_KEY is not configured for keyVersion '${version}'.`
      );
    }
    return {
      keyBuffer: parseVaultKey(primaryKey),
      resolvedVersion: primaryVersion,
    };
  }

  throw new VaultConfigurationError(
    `No encryption key found for vault keyVersion '${version}'. Set FORGE_VAULT_ENCRYPTION_KEY or configure FORGE_VAULT_KEYRING_JSON.`
  );
}

/**
 * Encrypts an organization API credential using AES-256-GCM.
 * Generates a unique 12-byte random nonce and attaches AAD bound to the tenant & context.
 */
export function encryptCredential(
  plaintext: string,
  context: EncryptionContext,
  overrideKeyring?: Record<string, string>
): EncryptedPayload {
  if (!plaintext || typeof plaintext !== "string" || plaintext.trim().length === 0) {
    throw new VaultEncryptionError("Cannot encrypt empty or non-string credential material");
  }

  const { keyBuffer, resolvedVersion } = resolveVaultKey(context.keyVersion, overrideKeyring);
  const aad = buildVaultAAD(context, resolvedVersion);

  // 12-byte random IV as strongly recommended for GCM
  const iv = crypto.randomBytes(12);

  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, iv, {
      authTagLength: 16,
    });
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      encryptedKey: encrypted.toString("hex"),
      keyIv: iv.toString("hex"),
      keyAuthTag: authTag.toString("hex"),
      keyVersion: resolvedVersion,
    };
  } catch (error) {
    if (error instanceof VaultConfigurationError || error instanceof VaultEncryptionError) {
      throw error;
    }
    throw new VaultEncryptionError("Failed to securely encrypt credential material");
  }
}

/**
 * Decrypts an organization API credential using AES-256-GCM.
 * Enforces strict IV and AuthTag length checks, validates AAD context,
 * and fails closed on any tampering or misconfiguration.
 */
export function decryptCredential(
  payload: EncryptedPayload,
  context: EncryptionContext,
  overrideKeyring?: Record<string, string>
): string {
  if (!payload || !payload.encryptedKey || !payload.keyIv || !payload.keyAuthTag || !payload.keyVersion) {
    throw new VaultDecryptionError("Incomplete encrypted payload: missing ciphertext, IV, auth tag, or key version");
  }

  // Validate IV length: 12 bytes = 24 hex chars
  if (payload.keyIv.length !== 24 || !/^[0-9a-fA-F]+$/.test(payload.keyIv)) {
    throw new VaultDecryptionError("Invalid initialization vector: must be a 12-byte hex string");
  }

  // Validate AuthTag length: 16 bytes = 32 hex chars
  if (payload.keyAuthTag.length !== 32 || !/^[0-9a-fA-F]+$/.test(payload.keyAuthTag)) {
    throw new VaultDecryptionError("Invalid authentication tag: must be a 16-byte hex string");
  }

  if (!/^[0-9a-fA-F]+$/.test(payload.encryptedKey)) {
    throw new VaultDecryptionError("Invalid ciphertext: must be a valid hex string");
  }

  const { keyBuffer } = resolveVaultKey(payload.keyVersion, overrideKeyring);
  const aad = buildVaultAAD(context, payload.keyVersion);

  const iv = Buffer.from(payload.keyIv, "hex");
  const authTag = Buffer.from(payload.keyAuthTag, "hex");
  const ciphertext = Buffer.from(payload.encryptedKey, "hex");

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, iv, {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch (error) {
    if (error instanceof VaultConfigurationError || error instanceof VaultDecryptionError) {
      throw error;
    }
    // Fail-closed with sanitized message; never disclose cryptographic details or cipher text
    throw new VaultDecryptionError("Failed to authenticate or decrypt credential material: ciphertext or context tampered");
  }
}
