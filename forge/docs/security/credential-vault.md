# Forge Security Architecture — Credential Vault, Key Validation & Organization-Aware Resolution (Phases 1, 1.1, 2, 3)

## Overview

Forge Bring Your Own Key (BYOK) enables authorized organization administrators to provide and manage their own Google Gemini API credentials for text generation and semantic embeddings.

This implementation spans:
1. **Phase 1 & 1.1:** Secure server-only credential vault, authenticated AES-256-GCM encryption with contextual AAD, strict 32-byte key parsing (64-hex / 44-base64), and versioned keyring rotation.
2. **Phase 2:** Administrative key management UI (`ApiKeyManagementCard`), server actions (`apiKeyActions.ts`), bounded runtime provider-key validation (`validation.ts`), and safe staged key replacement.
3. **Phase 3:** Authoritative entitlement fallback policy (`policy.ts`), dynamic organization-aware provider resolution (`resolver.ts`), and wiring across synchronous and asynchronous AI operations (Chat RAG, Triage, Agent Loop, Embedding Worker, Vector Retrieval).

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

## 5. Migration & Deployment Status

- **Migration Script:** `prisma/migrations/20261025120000_add_organization_api_key/migration.sql` was generated offline using schema-to-schema diffing (`prisma migrate diff --from-schema ... --to-schema prisma/schema.prisma --script`).
- **Deployment Status:** Successfully applied to the development database via `prisma migrate deploy`. All 27 migrations are up to date and in sync with the database schema.

---

## 6. Phase 2 — Runtime Provider Validation & Safe Staged Replacement

### Bounded Runtime Key Validation (`src/lib/security/vault/validation.ts`)

Candidate API keys are validated using bounded, harmless test calls to Google Gemini with a strict 5000ms timeout:
- **`GENERATION`:** Issues a minimal ping prompt to active production model `gemini-3.6-flash`.
- **`EMBEDDING`:** Issues a minimal single-word embedding to `gemini-embedding-001` (guaranteeing 768-dimensional compatibility with Forge's Pinecone vector index).

Errors are classified deterministically without exposing secret material:
- `VALID`: Provider accepted the key.
- `AUTH_FAILURE`: Key rejected by Google (HTTP 400/401, `API_KEY_INVALID`, `API_KEY_EXPIRED`).
- `PERMISSION_DENIED`: Valid key format lacking required model access (HTTP 403, `PERMISSION_DENIED`).
- `QUOTA_EXHAUSTED`: Rate limit or quota exhausted (HTTP 429, `RESOURCE_EXHAUSTED`).
- `TRANSIENT_FAILURE`: Request timeout or Google 5xx server error.
- `INVALID_REQUEST`: Malformed request, empty key, or retired/unsupported model (HTTP 404).

All diagnostic output is sanitized through `redactSecretPatterns` to ensure zero credential disclosure in responses or logs.

### Safe Staged Key Replacement Lifecycle & CAS Concurrency Control

To prevent accidental downtime or race conditions when updating credentials:
1. Administrator submits candidate API key.
2. Initial credential metadata and `updatedAt` timestamp are snapshotted.
3. Candidate key is validated against Google **before** the database is modified.
4. **Zero Downtime Invariant:** If the candidate key fails validation, a `VaultValidationError` is returned and the database is **never mutated**. The preexisting `ACTIVE` credential remains completely intact and active.
5. **Compare-and-Swap (CAS) Concurrency Control:** If validation succeeds, activation is executed conditionally:
   - For existing credentials, the update is executed with an atomic filter matching `[id, updatedAt]`. If another concurrent write occurred during validation, `updateMany.count === 0` and the operation safely aborts with `VaultConcurrencyError`.
   - For new credentials, creation catches unique constraint collisions (`P2002`) and safely aborts with `VaultConcurrencyError`.
6. This guarantees that concurrent submissions cannot cause older candidates to silently overwrite newer ones.

---

## 7. Phase 3 — Organization-Aware Provider Resolution & Entitlement Policy

### Authoritative Entitlement Policy (`src/lib/security/vault/policy.ts`)

When an organization has no configured BYOK credential, Forge checks `resolveOrganizationAiPolicy`:
- Verified active paid subscriptions (`planId === RAZORPAY_PLAN_ID` and `status === active`) are entitled to Forge platform credential fallback.
- Free, unsubscribed, or canceled organizations are denied platform fallback (`requiresByok: true`).
- Unrecognized or unmapped plan IDs fail closed with `POLICY_UNRESOLVED` rather than silently granting platform credentials.
- **Strict Development Override Predicate:** The `FORGE_ALLOW_UNRESTRICTED_PLATFORM_FALLBACK` override is strictly gated by `process.env.NODE_ENV === "development"`. In test, staging, production, or unset environments, the override is completely inert, guaranteeing that automated test runners and production deployments fail closed.

### Centralized Provider Resolver (`src/lib/ai/resolver.ts`)

The resolver dynamically constructs tenant-isolated model instances:
- `resolveOrganizationLanguageModel({ orgId, modelId?, fallbackModel? })`: Resolves `LanguageModel` for generation tasks.
- `resolveOrganizationEmbeddingModel({ orgId, modelId? })`: Resolves `EmbeddingModel` for embeddings.
- `resolveOrganizationGenerativeAiClient({ orgId, purpose })`: Resolves low-level `GoogleGenerativeAI` client for worker pipelines.

#### Invariants Enforced by Resolver:
1. **Active BYOK Key:** Returns a fresh, tenant-isolated provider bound to the decrypted customer key. Usage timestamp is recorded asynchronously.
2. **Inactive Key Guard (No Silent Fallback):** If an organization has a credential in `REVOKED`, `INVALID`, or `PENDING_VALIDATION` status, the resolver throws `AiResolverError("CREDENTIAL_NOT_ACTIVE")`. It **never** silently switches to Forge platform keys.
3. **No Singleton Mutation:** Global singletons (`googleProvider`, `agentModel`) are never mutated or re-configured.
4. **Tenant Isolation:** Org A's credentials are never accessible or usable by Org B.

### Execution Path Integration

| Call Site | Operation | Resolution Mechanism |
|---|---|---|
| `src/app/api/chat/route.ts` | Chat RAG embeddings & streaming completion | `resolveOrganizationEmbeddingModel` & `resolveOrganizationLanguageModel` |
| `src/app/api/triage/route.ts` | Automated issue triage categorization | `resolveOrganizationLanguageModel({ orgId: project.orgId })` |
| `src/lib/vector/retreiver.ts` | Context chunk retrieval for RAG | `resolveOrganizationEmbeddingModel({ orgId })` (768 dimensions) |
| `src/app/api/worker/embedding-worker/ew.ts` | Background document embedding pipeline | `resolveOrganizationGenerativeAiClient({ orgId, purpose: "EMBEDDING" })` |
| `src/lib/ai/agent/loop-runner.ts` | Autonomous agent execution turn | Resolves model via `resolveOrganizationLanguageModel({ orgId, fallbackModel: agentModel })`. Evaluates authoritative entitlement policy; fails closed if BYOK required or unconfigured; never silently falls back to platform on unsubscribed tiers |
| `src/app/api/stream-audit/route.ts` | Architecture audit analysis | Authenticates session, strictly verifies tenant membership in `db.membership`, and resolves model via `resolveOrganizationLanguageModel` (402 if BYOK required; 403 if unauthorized) |

---

## 8. Verification & Test Coverage

The BYOK implementation is verified by 10 dedicated test suites (101 focused tests) and passes the complete repository test suite of 93 test suites (1,471 tests):
1. `src/tests/security/vault-encryption.test.ts` (30 tests): AES-256-GCM authenticated encryption, strict 32-byte key validation, keyring rotation, and context binding.
2. `src/tests/security/vault-service.test.ts` (10 tests): Database persistence, safe projections, status invariants.
3. `src/tests/security/vault-validation.test.ts` (12 tests): Bounded validation against Gemini (`gemini-3.6-flash` and `gemini-embedding-001`), error classification, redaction.
4. `src/tests/security/vault-replacement.test.ts` (6 tests): Safe staged replacement lifecycle, active key preservation on failure, CAS concurrency serialization, revocation.
5. `src/tests/security/vault-policy.test.ts` (12 tests): Authoritative Razorpay plan matching, fail-closed handling on missing/empty plan configuration, and strict `NODE_ENV === "development"` override restriction.
6. `src/tests/security/ai-resolver.test.ts` (9 tests): Tenant isolation, dynamic model instantiation, no-silent-fallback on broken keys, entitlement enforcement.
7. `src/tests/security/api-key-actions.test.ts` (7 tests): Server actions, authentication, admin RBAC, cross-tenant isolation, CAS error handling.
8. `src/tests/security/stream-audit-authz.test.ts` (6 tests): Tenant authorization, forged orgId rejection (403), unauthenticated rejection (401), missing key 402 handling.
9. `src/tests/worker/embedding-worker-byok.test.ts` (4 tests): Worker pipeline resolution, batch embedding (`gemini-embedding-001`, 768 dimensions), platform fallback refusal when denied, fail-closed on inactive credentials.
10. `src/tests/agent/loop-runner-byok.test.ts` (5 tests): Agent loop BYOK resolution, entitlement enforcement, inactive key refusal, policy bypass prevention.
