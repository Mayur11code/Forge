# Forge Security Architecture — Credential Vault & BYOK Persistence (Phase 1)

## Overview

Forge Bring Your Own Key (BYOK) Phase 1 introduces an organization-scoped, server-only credential vault designed for high-assurance cryptographic isolation, multi-tenant safety, and least-privilege key management.

This phase establishes the security, persistence, authenticated encryption, and server-side service primitives necessary for future BYOK operations. It does **not** expose public endpoints, user interface components, or dynamic AI provider routing.

---

## 1. Cryptographic Envelope & Authenticated Encryption

The credential vault uses authenticated symmetric encryption backed by Node.js cryptographic primitives (`node:crypto`):

- **Algorithm:** `AES-256-GCM` (`aes-256-gcm`).
- **Key Length:** 256 bits (32 bytes).
- **Initialization Vector (IV / Nonce):** 12 bytes (`crypto.randomBytes(12)`), uniquely generated for every encryption call.
- **Authentication Tag:** 16 bytes (128 bits), verified during decryption.
- **Encoding:** Hexadecimal strings for IV (`keyIv`, 24 hex characters), auth tag (`keyAuthTag`, 32 hex characters), and ciphertext (`encryptedKey`).

### Context Binding via Authenticated Additional Data (AAD)

To prevent ciphertext transplant attacks (where ciphertext encrypted for Tenant A or Purpose X is replayed into Tenant B or Purpose Y), the GCM authentication tag binds contextual metadata:

$$\text{AAD} = \text{Buffer.from}(\text{"forge:vault:v1:org="} + \text{orgId} + \text{":provider="} + \text{provider} + \text{":purpose="} + \text{purpose} + \text{":keyVersion="} + \text{keyVersion})$$

Any modification to `orgId`, `provider`, `purpose`, `keyVersion`, the ciphertext, or the tag results in an immediate, sanitized `VaultDecryptionError`.

---

## 2. Key Management, Configuration & Rotation

### Environment Variables

| Variable | Type | Description |
|---|---|---|
| `FORGE_VAULT_ENCRYPTION_KEY` | String (min 16 chars) | Primary master key used for new credential encryptions. |
| `FORGE_VAULT_PRIMARY_KEY_VERSION` | String (default: `"v1"`) | Version identifier corresponding to `FORGE_VAULT_ENCRYPTION_KEY`. |
| `FORGE_VAULT_KEYRING_JSON` | JSON string | Optional keyring mapping historical versions (e.g. `{"v1":"...", "v2":"..."}`) for key rotation. |

### Fail-Closed on Demand (Safe Boot Invariant)

To ensure Forge deployments, preview environments, or build pipelines without BYOK enabled boot cleanly, `FORGE_VAULT_ENCRYPTION_KEY` is optional at application boot time in `src/lib/env/server.ts`. If an operation requires encryption or decryption when the key is absent, it fails closed with an explicit, sanitized `VaultConfigurationError`.

### Cryptographic Key Material & Strict Validation

To guarantee maximum entropy for AES-256 keys, the vault strictly rejects arbitrary passphrases, short strings, unencoded text, and non-32-byte decodings. Encryption keys are never silently hashed with SHA-256 or padded.

The vault accepts only a cryptographically random 32-byte key encoded in one of two formats:
1. **Hexadecimal:** Exactly 64 hex characters (`[0-9a-fA-F]{64}`).
   - Safe generation: `openssl rand -hex 32`
2. **Base64:** Valid Base64 (or Base64URL) string decoding to exactly 32 bytes (44 characters with `=`).
   - Safe generation: `openssl rand -base64 32`

Both encryption and decryption paths interpret key encodings identically: a 64-hex key and an equivalent 44-base64 key decode to identical 32-byte key material.

### Keyring Management & Safe Historical Rotation

Every encrypted record persists its `keyVersion` in the database. During decryption:
1. The vault inspects `record.keyVersion`.
2. It looks up the key for that version in `FORGE_VAULT_KEYRING_JSON` (or in `FORGE_VAULT_ENCRYPTION_KEY` if the version matches `FORGE_VAULT_PRIMARY_KEY_VERSION`).
3. Every historical key in the keyring is validated against the exact same strict 32-byte hex/base64 rules.
4. **No Fallback Invariant:** If a historical key is missing, malformed, or invalid, the vault fails closed immediately with `VaultConfigurationError`. It **never** falls back to another key version or to Forge's Gemini credentials.

This enables zero-downtime key rotation: new keys can be introduced, historical keys preserved in the keyring, and existing records re-encrypted in the background before retiring old keys.

---

## 3. Data Model & Lifecycle Invariants

### Database Schema (`OrganizationApiKey`)

```prisma
enum AiProvider {
  GEMINI
}

enum CredentialPurpose {
  GENERATION
  EMBEDDING
}

enum CredentialStatus {
  PENDING_VALIDATION
  ACTIVE
  INVALID
  REVOKED
}

model OrganizationApiKey {
  id              String            @id @default(uuid())
  orgId           String
  provider        AiProvider        @default(GEMINI)
  purpose         CredentialPurpose
  encryptedKey    String
  keyIv           String
  keyAuthTag      String
  keyVersion      String
  last4           String
  status          CredentialStatus  @default(PENDING_VALIDATION)
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt
  lastValidatedAt DateTime?
  lastUsedAt      DateTime?
  createdByUserId String?

  organization    Organization      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  createdByUser   User?             @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)

  @@unique([orgId, provider, purpose])
  @@index([orgId])
  @@index([status])
}
```

### Purpose Separation

An organization can configure an AI `GENERATION` key, an `EMBEDDING` key, both, or neither. The `@@unique([orgId, provider, purpose])` constraint guarantees that at most one active credential exists per purpose per provider for any given organization.

### The `PENDING_VALIDATION` Invariant

1. **Initial Store:** When an administrator stores an API key, the record is created with `status = PENDING_VALIDATION`.
2. **Replacement:** When an administrator updates an existing key, the record is re-encrypted with a new IV and tag, and its status is unconditionally reset to `PENDING_VALIDATION`.
3. **Execution Gate:** Internal retrieval primitive `getDecryptedOrganizationCredential` strictly checks `status === ACTIVE`. Any call attempting to retrieve a credential in `PENDING_VALIDATION`, `INVALID`, or `REVOKED` state throws `VaultStatusError` and refuses execution.

### Tenant Isolation & Deletion Semantics

- Every query is scoped to the organization ID.
- Foreign keys enforce `onDelete: Cascade` against `Organization`. If an organization is deleted, all stored encrypted credentials are automatically purged.
- The `createdByUser` relation enforces `onDelete: SetNull` against `User` so credential history is preserved even if the creating administrator departs.

---

## 4. Server-Only Architecture & Security Boundaries

- **`import "server-only";` Boundary:** All vault modules (`src/lib/security/vault/encryption.ts`, `src/lib/security/vault/service.ts`, `src/lib/security/vault/index.ts`) enforce the `server-only` boundary to prevent any client-side bundling.
- **Safe Metadata:** Listing and metadata queries (`getOrganizationCredentialMetadata`, `listOrganizationCredentials`) use a strict projection (`safeCredentialSelect`) that excludes `encryptedKey`, `keyIv`, `keyAuthTag`, and any plaintext material. Only safe identification fields (`last4`, `status`, `purpose`, timestamps) are returned.
- **Diagnostic Sanitization:** All error messages pass through `redactSecretPatterns` to ensure secrets, API keys, or raw crypto diagnostics never leak into logs or telemetry.

---

## 5. Offline Migration & Safe Deployment Boundary

- **Migration Script:** `prisma/migrations/20261025120000_add_organization_api_key/migration.sql` was generated strictly offline using schema-to-schema diffing (`prisma migrate diff --from-schema ... --to-schema prisma/schema.prisma --script`).
- **Unapplied Status:** This migration is **UNAPPLIED** and was **NOT** executed against the live database (`DATABASE_URL`).
- **Deployment Procedure:** During Phase 1, `prisma db push` and `prisma migrate deploy` are prohibited. The migration will be deployed in a controlled maintenance window once Phase 2 (Validation & Routing) is scheduled.

---

## 6. Future Phases & Out-of-Scope Capabilities

Phase 1 provides the persistent vault foundation. The following capabilities are explicitly deferred to subsequent phases:

1. **Phase 2 — Credential Validation & Admin UI:** Key management forms, masked input fields, live Gemini test validation (`validateGeminiApiKey`), and status transition to `ACTIVE`.
2. **Phase 3 — AI Provider Resolution & Tier Policies:** Organization-tier fallback rules, platform key fallback when customer keys are absent, and fallback refusal for mandatory BYOK tiers.
3. **Phase 4 — Key Revocation & Automated Rotation Workflows:** Graceful revocation, re-encryption background workers, and audit logging.
