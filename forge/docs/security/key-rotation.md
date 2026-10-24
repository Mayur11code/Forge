# Zero-Downtime Credential Rotation Protocols

## 1. Executive Summary

This document establishes the authoritative operational and engineering protocols for rotating production and non-production credentials in Engineered Forge without incurring service disruption, downtime, dropped asynchronous tasks, duplicate operations, or security degradation.

Forge enforces zero-downtime rotation through **Dual-Key Overlap Architecture** across three critical integrations:
1. **Google Gemini AI & Agent Runtime** (`@ai-sdk/google`, `@google/generative-ai`)
2. **Pinecone Vector Database** (`@pinecone-database/pinecone`)
3. **Upstash QStash Asynchronous Message Broker** (`@upstash/qstash`)

Additional operational guidance is provided for single-credential integrations (PostgreSQL, Upstash Redis, Pusher, Resend, and Auth secrets).

---

## 2. Universal Principles & Security Invariants

1. **Zero Secret Disclosure:**
   Under no circumstances may plaintext API keys, tokens, signing secrets, or connection strings be printed to terminal output, standard logs, commit messages, bug reports, or customer-facing error messages.
2. **Fail-Closed Enforcement:**
   Fallback mechanisms only trigger for explicit, narrow authentication errors. Non-auth errors (e.g. rate limits, network timeouts, invalid business parameters) must never trigger key failover.
3. **Strict Environment Segregation:**
   Non-production (Development/Preview) and Production credential sets are physically decoupled in schemas and runtimes. Non-production credentials must never fallback to production credentials, and vice versa.
4. **Transparent Observability:**
   Every authentication failover emits a sanitized, structured warning log (`[CREDENTIAL_ROTATION]`) recording provider, subsystem, slot, operation, and error category without revealing raw secrets.
5. **Idempotency Guarantees:**
   Any mutation retried on a fallback key must either be mathematically idempotent (deterministic vector upserts, deletes by prefix) or validated before retry.

---

## 3. Routine 5-Step Overlap Rotation Lifecycle

For dual-key supported providers, all planned rotations adhere to the standard 5-step lifecycle:

```
[Phase 1: Provision] ──> [Phase 2: Deploy Overlap] ──> [Phase 3: Verify Validity]
                                                                  │
[Phase 5: Retire Key A] <── [Phase 4: Promote Key B] <────────────┘
```

### Phase 1 — Provision Key B
Generate a new, cryptographically strong key or token in the provider console (Google Cloud Console, Pinecone Console, or Upstash Console). Label the key clearly with its rotation timestamp (e.g., `forge-prod-gemini-2026-10`). Do not revoke the active Key A.

### Phase 2 — Deploy Overlap Configuration
Deploy the new Key B to the secondary/fallback environment variable slot while keeping Key A in the primary slot:
- **Gemini:** `GEMINI_API_KEY` (Key A), `GEMINI_API_KEY_FALLBACK` (Key B)
- **Pinecone (Prod):** `PINECONE_API_KEY_PROD` (Key A), `PINECONE_API_KEY_PROD_FALLBACK` (Key B)
- **Pinecone (Dev):** `PINECONE_API_KEY_DEV` (Key A), `PINECONE_API_KEY_DEV_FALLBACK` (Key B)
- **QStash:** `QSTASH_CURRENT_SIGNING_KEY` (Key A), `QSTASH_NEXT_SIGNING_KEY` (Key B)

Both keys are now loaded in the runtime. In-flight requests continue using Key A seamlessly.

### Phase 3 — Verify Fallback Validity
Verify that the secondary key is recognized and authorized. In QStash, inbound webhooks signed with either key are accepted. In Gemini and Pinecone, the application is protected against any unexpected invalidation of Key A.

### Phase 4 — Promote Key B to Primary
Promote Key B to the primary variable slot, and shift Key A to the fallback slot (or omit fallback):
- **Gemini:** Set `GEMINI_API_KEY` to Key B. Optionally retain Key A as `GEMINI_API_KEY_FALLBACK` during the deployment grace window.
- **Pinecone:** Set `PINECONE_API_KEY_PROD` to Key B.
- **QStash:** Rotate signing keys in the Upstash console. Promote `QSTASH_NEXT_SIGNING_KEY` to `QSTASH_CURRENT_SIGNING_KEY` in Vercel/env.

### Phase 5 — Retire Key A
Monitor application logs for 24 hours. Confirm that zero `[CREDENTIAL_ROTATION]` failover logs reference Key A. Once confirmed:
1. Remove `GEMINI_API_KEY_FALLBACK` / `PINECONE_API_KEY_*_FALLBACK` from environment variables.
2. Revoke Key A in the provider console.

---

## 4. Emergency Compromise Protocol

If a production key is suspected or confirmed leaked:

1. **Immediate Revocation (Compromised Key):**
   Immediately revoke the leaked key in the provider console.
2. **Emergency Key Provisioning:**
   Generate an emergency replacement key in the provider console.
3. **Direct Primary Deployment:**
   Deploy the new key directly to the primary variable slot (`GEMINI_API_KEY`, `PINECONE_API_KEY_PROD`, etc.).
   *Note: If Key A is already revoked, any requests in-flight before deployment will trigger immediate fallback if a valid fallback key was already pre-configured.*
4. **Drain & Verification:**
   Redeploy all serverless instances / background workers.
   Audit invocation logs for abnormal access patterns or exfiltration during the exposure window.

---

## 5. Provider-Specific Runbooks

### 5.1 Google Gemini AI (`src/lib/ai/provider.ts`, `src/app/api/worker/embedding-worker/ew.ts`)

Forge uses **Google Gemini** (`gemini-3.6-flash` and `gemini-embedding-001`) via `@ai-sdk/google` and `@google/generative-ai`.

- **Environment Variables:**
  - `GEMINI_API_KEY` (Primary, required)
  - `GEMINI_API_KEY_FALLBACK` (Secondary, optional)
- **Runtime Architecture:**
  `googleProvider` wraps both `doGenerate` and `doStream` for model invocations and `doEmbed` for embeddings. If the primary key fails with an authentication error, the call is automatically retried once using the fallback key.
- **Error Classification (`isGeminiAuthenticationError`):**
  - **Triggers Failover:** Definitive API key invalidity, expiration, revocation, or credential-specific restriction:
    - Structured Google RPC `ErrorInfo` reasons: `API_KEY_INVALID`, `API_KEY_EXPIRED`, `API_KEY_NOT_FOUND`.
    - Key restrictions: `API_KEY_SERVICE_BLOCKED`, `API_KEY_HTTP_REFERRER_BLOCKED`, `API_KEY_IP_ADDRESS_BLOCKED` **only** when either no service metadata is present or `metadata.service` explicitly matches Forge's Gemini service target (`generativelanguage.googleapis.com`). Restrictions targeted at unrelated Google Cloud services (e.g. `maps.googleapis.com`) fail closed and do not trigger failover.
    - Explicit API key failure messages emitted by Google API endpoints (e.g., `"API key not valid"` or `"API key expired"`).
    - HTTP 401 with `UNAUTHENTICATED` status or credential failure text.
  - **Does NOT Trigger Failover:**
    - HTTP 429 (`RESOURCE_EXHAUSTED` / rate limits / quota exhaustion).
    - HTTP 5xx (Google backend errors / transient service unavailability).
    - Generic HTTP 403 `PERMISSION_DENIED` (IAM permissions, model access permissions, caller does not have permission).
    - Project or consumer configuration failures (`CONSUMER_INVALID`, `SERVICE_DISABLED`, `BILLING_DISABLED`) — these represent project-wide or billing state that a replacement key cannot resolve.
    - Key restrictions applying to unrelated Google services (`metadata.service !== "generativelanguage.googleapis.com"`).
    - Unstructured HTTP 400/403 responses without positive API key invalidity proof.
    - Network socket timeouts, connection aborts, prompt schema errors, or safety blocks.
- **Logging:**
  Emits `[CREDENTIAL_ROTATION] [GEMINI] [ai]` with `AUTH_FAILURE_FAILOVER`. All secret patterns (`AIza...`) are automatically redacted before logging.

### 5.2 Pinecone Vector Database (`src/lib/vector/client.ts`)

Forge uses Pinecone for semantic memory, task embedding indexing, and retrieval.

- **Environment Variables:**
  - Non-Production: `PINECONE_API_KEY_DEV`, `PINECONE_INDEX_DEV`, `PINECONE_API_KEY_DEV_FALLBACK`
  - Production: `PINECONE_API_KEY_PROD`, `PINECONE_INDEX_PROD`, `PINECONE_API_KEY_PROD_FALLBACK`
- **Environment Isolation:**
  Dev and Prod configurations are strictly separated via Zod schemas (`vectorServerDevSchema` and `vectorServerProdSchema`). Dev will NEVER use Prod keys, and Prod will NEVER use Dev keys.
- **Runtime Architecture:**
  `getTenantVectorStore(orgId)` wraps operations (`query`, `upsert`, `deleteRecord`, `deleteByTask`) in `executeWithFailover`. Exactly one fallback attempt is made.
- **Error Classification (`isPineconeAuthenticationError`):**
  - **Triggers Failover:** `PineconeAuthorizationError` (solely mapped by Pinecone SDK to HTTP 401 API key rejection).
  - **Does NOT Trigger Failover:** HTTP 403 / `PineconeBadRequestError` (insufficient permissions), HTTP 404 (`PineconeNotFoundError`), HTTP 429 (rate limits), HTTP 5xx (`PineconeInternalServerError` / `PineconeUnavailableError`), network timeouts, or schema errors.
- **Idempotency:**
  Upserts use deterministic IDs (`${entityId}#${chunkIndex}`). Retrying an upsert on fallback after a 401 produces identical state with zero duplicate side effects.

### 5.3 Upstash QStash Asynchronous Queue (`src/lib/events/worker.ts`, `src/lib/events/queue.ts`)

Forge uses Upstash QStash for decoupled workflow execution, agent recovery, and event fan-out.

- **Environment Variables:**
  - REST Token: `QSTASH_TOKEN`
  - Inbound Verification: `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`
- **Worker Webhook Dual-Key Verification:**
  `verifySignatureAppRouter` in `src/lib/events/worker.ts` instantiates Upstash's `Receiver({ currentSigningKey, nextSigningKey })`.
  The receiver automatically verifies against `currentSigningKey`, and if that fails, tests `nextSigningKey`.
- **Zero-Downtime Signature Key Rotation:**
  1. Open Upstash Console -> QStash -> Signing Keys.
  2. Click **Rotate Keys**. The old next key becomes current, and a new next key is created.
  3. Upstash QStash console displays both keys simultaneously.
  4. In Forge, configure `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` to match.
  5. During the rotation window, incoming webhooks signed with either key are successfully authenticated.

### 5.4 Single-Credential Subsystems

For components that do not support dual-key overlap:
- **PostgreSQL (`DATABASE_URL`):**
  Use connection pooler failover (e.g. Supabase or PgBouncer). Provision a new database role/password, verify connection in a staging branch, update `DATABASE_URL`, and terminate old idle connections after deployment.
- **Upstash Redis (`UPSTASH_REDIS_REST_TOKEN`):**
  Upstash Redis supports active read-write tokens. Generate a secondary token in the Upstash console, update Forge configuration, and revoke the previous token.
- **Pusher (`PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`):**
  Create new Pusher app credentials. Deploy updated client and server environment variables simultaneously.
- **Auth Secret (`AUTH_SECRET`):**
  Rotating `AUTH_SECRET` invalidates active user sessions/JWTs. Plan rotation during low-traffic maintenance windows, alerting active users that re-authentication will be required.

---

## 6. Verification Checklist

Before closing any credential rotation operational ticket:

- [ ] Subsystem health check succeeds on new credentials.
- [ ] No `EnvValidationError` diagnostics present on server boot.
- [ ] No unauthorized (401/403) errors observed in production logs.
- [ ] Any temporary fallback variables removed after verification window.
- [ ] Retired credentials confirmed revoked in provider consoles.
- [ ] Secret scan confirms zero credential leakage in commit history and logs.
