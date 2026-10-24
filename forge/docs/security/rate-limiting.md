# Production Hardening H3 — Distributed Rate Limiting & AI Admission Control

## 1. Executive Summary

This document establishes the architecture, policy specifications, enforcement invariants, and deferred design specifications for distributed rate limiting and AI admission control in Engineered Forge.

Distributed rate limiting in Forge is powered by `@upstash/ratelimit` over the centralized `@upstash/redis` infrastructure established in H1. It provides two distinct security and stability mechanisms:
1. **Token-Bucket Admission Control:** Applied exclusively to user-initiated, resource-intensive AI operations (autonomous agent initialization, interactive RAG chat streaming, and structured bug triage) to allow controlled bursts while capping sustained utilization.
2. **Sliding-Window Rate Limiting:** Applied to selected user/tenant API operations (task creation, interactive agent confirmations, and workflow canvas test runs) to prevent rapid automated replay and abuse.

---

## 2. Universal Principles & Enforcement Invariants

1. **Server-Only Enforcement (`server-only`):**
   All rate limiting logic, Redis client instantiation, and policy evaluations are strictly isolated to server runtimes. Privileged Redis credentials are never bundled into client components.
2. **Configuration Validation:**
   Redis credentials are read exclusively through H1's validated accessor `getRedisEnv()` from `src/lib/env/server.ts`.
3. **No Raw PII in Redis Keys:**
   Redis keys use stable, non-PII identifiers: `u:<userId>`, `o:<orgId>`, and `ip:<sha256(ip)>`. Raw email addresses, passwords, and user tokens are strictly prohibited.
4. **Trusted Server Scoping:**
   Never trust browser-supplied `orgId` or `userId` parameters. All identities are derived from verified server sessions (`auth()`) and database authorization checks (`getOrgAccess()`).
5. **Fail-Closed on Expensive AI Admission:**
   For resource-intensive AI operations, unverified enforcement caused by Redis timeouts or network errors fails closed and returns HTTP `503 Service Unavailable` with `RATE_LIMITER_UNAVAILABLE`. No expensive AI task may execute unmetered.
6. **No Token Metering on Internal Iterations or Redeliveries:**
   Admission tokens are consumed exactly once at the entry boundary. Downstream agent loop iterations in background workers (`/api/worker`) and QStash message redeliveries do NOT consume additional admission tokens.
7. **Transparent Observability & Safe Metadata:**
   Responses on rejection return HTTP `429 Too Many Requests` with standard `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers. No internal Redis keys or stack traces are leaked.

---

## 3. Centralized Policy Specifications

All numeric policies are centralized in `src/lib/security/rate-limit.ts` under `RATE_LIMIT_POLICIES`.

### 3.1 Token-Bucket AI Admission Policies

| Policy Key | Target Operation | Scope | Capacity (Burst) | Refill Rate | Timeout | Fail-Mode | Rationale |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `AI_ADMISSION_AGENT_INIT` | `POST /api/agent/init` | User | 5 tokens | 1 token / 2 min | 3000 ms | **Fail-Closed (503)** | Agent sessions run multi-step tool execution loops. Burst capacity of 5 permits interactive iteration; 2-minute refill caps sustained cost. |
| `AI_ADMISSION_AGENT_INIT` | `POST /api/agent/init` | Org | 15 tokens | 2 tokens / 1 min | 3000 ms | **Fail-Closed (503)** | Protects aggregate tenant compute and background QStash worker concurrency across team members. |
| `AI_ADMISSION_CHAT` | `POST /api/chat` | User | 10 tokens | 3 tokens / 1 min | 3000 ms | **Fail-Closed (503)** | Interactive RAG chat requires low latency for back-and-forth dialogue; 10 tokens allows rapid queries while throttling bots. |
| `AI_ADMISSION_CHAT` | `POST /api/chat` | Org | 30 tokens | 6 tokens / 1 min | 3000 ms | **Fail-Closed (503)** | Protects Pinecone vector query throughput and Gemini Flash token quotas across the organization. |
| `AI_ADMISSION_TRIAGE` | `POST /api/triage` | User | 10 tokens | 2 tokens / 1 min | 3000 ms | **Fail-Closed (503)** | Structured issue extraction with Gemini Flash. 10 burst tokens accommodates batch bug filing. |

### 3.2 Sliding-Window Request Policies

| Policy Key | Target Operation | Scope | Limit | Window | Timeout | Fail-Mode | Rationale & Enforcement State |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `REQUEST_TASK_CREATE` | `createTask` Action | User | 10 req | 10 sec | 2000 ms | Fail-Open | **Active.** Blocks UI spam clicking or automated task generation while accommodating fast human typing. |
| `REQUEST_TASK_CREATE` | `createTask` Action | Org | 100 req | 1 min | 2000 ms | Fail-Open | **Active.** Safeguards PostgreSQL database write pool from bulk script inundation across the organization. |
| `REQUEST_AGENT_ACTION` | `POST .../executions/[id]/confirm` | User | 20 req | 1 min | 2000 ms | Fail-Open | **Active.** Interactive human approvals (confirmations, clarifications, reviews) are sporadic; 20/min is ample for legitimate humans. |
| `REQUEST_WORKFLOW_TEST_RUN` | `POST .../test-run` | User | 5 req | 1 min | 2500 ms | **Fail-Closed (503)** | **Active.** Dispatches workflow orchestration DAGs; limits ad-hoc test execution queue congestion per user. |
| `REQUEST_WORKFLOW_TEST_RUN` | `POST .../test-run` | Org | 20 req | 1 min | 2500 ms | **Fail-Closed (503)** | **Active.** Protects tenant-wide workflow runner dispatch capacity and compute queues. |
| `UNAUTHENTICATED_PUBLIC_IP` | N/A (Defined only) | IP | 30 req | 1 min | 2000 ms | Fail-Open | **Intentionally Unused (Defined, Not Active).** See §3.3 for architectural rationale. |

### 3.3 Architectural Rationale for Unused Public-IP Rate Limiting

Forge does not bind `UNAUTHENTICATED_PUBLIC_IP` to active endpoints for the following architectural reasons:
1. **Authenticated Application Airgap:** All custom Forge API endpoints enforce strict server-side session authentication via NextAuth (`auth()`) and tenant access control (`getOrgAccess()`). There are no unauthenticated public mutation sinks or open query endpoints in the application.
2. **Cryptographic Ingress Protection for Webhooks:** All non-session external ingress endpoints (`/api/worker/*`, `/api/webhooks/razorpay`, `/api/uploadthing`) require cryptographic signature verification (Upstash QStash HMAC signatures, Razorpay HMAC webhooks, or UploadThing JWT tokens).
3. **Provider Delivery Contract Integrity:** Applying coarse IP-based sliding-window rate limiting to webhook endpoints would drop legitimate retries or parallel batch notifications originating from provider IP ranges (e.g., Upstash or Razorpay webhook dispatch fleets), causing silent data loss and violating external delivery contracts. NextAuth routes (`/api/auth/*`) similarly handle federated OAuth callbacks from trusted identity provider IP blocks.
4. **Conclusion:** `UNAUTHENTICATED_PUBLIC_IP` is retained in policy definitions for future unauthenticated public marketing or onboarding endpoints, but is **intentionally inactive** across existing Forge routes.

---

## 4. Multi-Limiter Evaluation Semantics

When both user-level and organization-level limiters are defined for an operation (e.g. `AI_ADMISSION_AGENT_INIT` or `REQUEST_TASK_CREATE`):
1. **Sequential Evaluation:** The user limiter is evaluated first. If permitted, the organization limiter is evaluated second.
2. **Non-Atomic Consumption:** If the user check passes but the organization check fails, the user token was consumed. This sequential behavior is documented and expected in distributed Redis architectures to avoid complex distributed two-phase locking.
3. **Response Headers:** When both limiters pass, response headers convey the most restrictive remaining budget (`Math.min(userRemaining, orgRemaining)`) and the furthest reset epoch (`Math.max(userReset, orgReset)`).

---

## 5. Redis Failure & Enforcement Semantics

1. **Timeout Detection:**
   `@upstash/ratelimit` defaults to resolving `{ success: true, reason: "timeout" }` when a Redis network timeout occurs. Forge's evaluation wrapper inspects `result.reason === "timeout"`.
2. **Fail-Closed (Critical AI Admission & Test Runs):**
   When `policy.failClosed === true`, unverified enforcement due to timeout or network exception immediately aborts the protected operation and returns:
   - Status: HTTP `503 Service Unavailable`
   - Code: `RATE_LIMITER_UNAVAILABLE`
   - Header: `Retry-After: 5`
   - Diagnostic: Logged to server console without leaking Redis connection strings or exception internals to the client.
3. **Fail-Open (Standard CRUD Requests):**
   When `policy.failClosed === false`, Redis exceptions or timeouts log a warning (`[RATE_LIMIT] Fail-open on limiter unavailable`) and permit the operation to proceed, ensuring transient Redis blips do not disrupt basic CRUD actions.

---

## 6. Frontend Countdown & Read-Only Status Architecture

### 6.1 Advisory Client Countdown (`WorkflowProposalPanel.tsx`)
On receiving HTTP `429 Too Many Requests`:
1. The client parses the authoritative `Retry-After` header (or JSON `retryAfter`).
2. A local countdown state `retryCountdown` is initialized with the wait duration in seconds.
3. An advisory warning banner informs the user: `"Admission limit reached. Try again in {retryCountdown}s."`
4. The submit button is disabled during the countdown.
5. A local 1-second interval timer decrements the counter without polling the server.
6. When the countdown reaches zero, the button is re-enabled, allowing the user's next attempt to be decided authoritatively by the server.

### 6.2 Non-Mutating Read-Only Status Route (`GET /api/agent/rate-limit`)
- Endpoint: `GET /api/agent/rate-limit?orgSlug=<slug>&operation=agent_init`
- Requires valid user session (`auth()`) and verified organization access (`getOrgAccess()`).
- Calls Upstash's `limiter.getRemaining(identifier)`: **Zero tokens are consumed**.
- Returns safe metadata:
  ```json
  {
    "operation": "AI_ADMISSION_AGENT_INIT",
    "available": true,
    "limit": 5,
    "remaining": 4,
    "reset": 1729812400000,
    "retryAfterSeconds": undefined
  }
  ```
- Cached with `Cache-Control: no-store, max-age=0`.

---

## 7. Deferred Architecture & Design Decisions

The following architectural components are explicitly deferred to future hardening milestones and documented here for alignment:

### 7.1 Multi-Tenant Tiered Rate-Limit Mapping
- **Deferred Reason:** Forge's commercial packaging, tenant archetypes (Individual, Team, Enterprise), and monetization tiers have not been finalized. Introducing hardcoded plan enums (`FREE`, `PRO`, `ENTERPRISE`) into database schemas or code today would create premature technical debt.
- **Future Extension Pipeline:**
  ```
  Authenticated Request → Session & Org Authorization → Trusted Plan Resolver → Plan-Scoped Quota Policy → Distributed Limiter
  ```
- **Enterprise BYOK Invariant:**
  When Bring-Your-Own-Key (BYOK) for LLM providers is later introduced, BYOK tenants must **still be subject to Forge infrastructure rate limits**. While provider token costs are borne by the customer, Forge's own serverless instances, PostgreSQL connection pool, Redis instances, and QStash worker capacity must remain protected.

### 7.2 Downstream Circuit Breaker Design
- **Deferred Reason:** Requires shared Redis sliding-window error counters and coordination across distributed serverless runtimes. Deferred to a dedicated reliability hardening milestone.
- **Proposed Failure Score Model:**
  The breaker evaluates an eligible downstream dependency (e.g. Gemini API, Pinecone) using:
  - $R_f$: Eligible failure ratio in a rolling observation window (e.g. 60 seconds).
  - $T_f$: Configured failure ratio threshold (e.g. 0.50).
  - $D_u$: Duration for which the dependency has continuously remained unhealthy above $T_f$.
  - $T_d$: Required persistence duration (e.g. 30 seconds).
  
  The normalized score $S$ is calculated as:
  $$S = \min\left(\frac{R_f}{T_f}, \frac{D_u}{T_d}\right)$$
  
  An opening transition occurs when $S \ge 1.0$ and the minimum sample threshold (e.g. $N \ge 20$) is satisfied.
- **Qualifying Failures:**
  - Qualify: Upstream `5xx` errors, network connection drops, gateway timeouts.
  - Excluded: User validation errors (`400`), prompt safety blocks, authentication rejections (handled by H2 failover), normal user cancellations.
  - Provider `429` (Quota/Rate Limit): Managed under a distinct provider backoff policy, not treated as dependency outages.
- **State Machine:**
  $$\text{CLOSED} \xrightarrow{S \ge 1} \text{OPEN} \xrightarrow{\text{Cooldown (30s)}} \text{HALF-OPEN} \xrightarrow{\text{Probes Succeed}} \text{CLOSED}$$

### 7.3 Downstream Retry & QStash Backoff
- **Deferred Reason:** QStash worker retry behavior is governed by message deduplication and dead-letter queues. A naive retry loop in worker routes would risk infinite loops and quote exhaustion.
- **Future Design Requirements:**
  - Jittered exponential backoff for transient downstream errors.
  - Extraction and propagation of provider `Retry-After` headers into QStash delivery delays.
  - Preservation of message idempotency keys across retry cycles.

### 7.4 Concurrency Limits vs. Rate Limits
- Rate limits (token bucket and sliding window) meter transaction velocity over time; they do **not** bound the number of simultaneously active in-flight executions.
- Before introducing custom distributed semaphores in Redis, Forge will leverage **QStash Flow Control** to govern maximum concurrent in-flight worker dispatches for asynchronous jobs.

---

## 8. Verification Environment & Test Strategy

Verification of Forge's rate limiting and admission control implementation encompasses unit, integration, and security route boundary suites:

1. **Deterministic Test-Double Verification:**
   All automated Jest suites (`src/tests/security/rate-limit.test.ts` and `src/tests/security/rate-limit-routes.test.ts`) run against test-doubles and in-memory mocks of `@upstash/ratelimit` and `@upstash/redis`. This guarantees:
   - Zero external network dependency or flaky test execution.
   - Deterministic assertion of token bucket capacity, refill behavior, sliding windows, identifier hashing, fail-closed/fail-open branches, and route boundary enforcement.
   - Zero disclosure or requirement of live Upstash Redis production credentials in CI or test runners.
2. **Live Distributed Redis Verification Limitation:**
   Verification against a live, distributed multi-region Upstash Redis cluster (validating real Redis latency, Redis Lua script execution under high concurrency, clock drift, and actual serverless instance boundaries) cannot be performed within the offline local test environment. Live cluster end-to-end load testing must be performed in dedicated staging or pre-production deployment validation gates.
