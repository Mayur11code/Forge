# Forge — Security Audit & Remediation (2026-10-20)

> Scope: repository-wide security review of the maintained application before
> Assignment 37.12. Evidence-backed findings, verified fixes, regression tests.
> This record is authoritative for the audit performed on 2026-10-20.

## 1. Scope and limitations

**Inspected.** Next.js 16 App Router application under `forge/`: all HTTP route
handlers (`src/app/api/**`), all Server Actions (`src/app/actions/**`,
`src/app/org/**/action.ts`), auth configuration (`src/lib/auth/*`,
`src/middleware.ts`), tenant helper (`src/features/organizations/getOrgAccess.ts`),
workflow execution entrypoints, agent/AI tool-execution boundary, webhook
handlers, UploadThing file router, Prisma schema and query predicates, and
`console` usage across `src/` excluding tests.

**Not inspected / out of scope.** Generated build output (`.next`), dependency
source (`node_modules`), and non-application scripts beyond their secret/env
contact. No live database, provider, or multi-process integration run was
performed (see §7).

**Baseline.** `feat/37.1-action-capability-catalog` @ `3e4998a`; full Jest suite
**58 suites / 1087 tests** green; `tsc --noEmit` clean before changes.

## 2. Findings register

Severity follows repository convention: P0 = critical cross-tenant/auth bypass,
P1 = exploitable auth/validation/sensitive-data, P2 = confirmed defect limited
scope, P3 = low-risk weakness.

### CONFIRMED findings

| ID | Sev | Location | Finding | Fix | Regression test |
|---|---|---|---|---|---|
| **S1** | **P0** | `src/app/actions/Tasks/attachments.ts:7,37,57` | Three `"use server"` actions have **no authentication and no tenant scope**. `getAttachments(taskId)` returns any tenant's attachment metadata (incl. `fileKey`); `getSignedDownloadUrl(fileKey)` mints a signed download URL for any bucket key; `createAttachment({taskId,...})` writes an attachment to any task. Reachable as server actions regardless of UI. | `auth()` first; resolve the task via a tenant-scoped predicate (`project.organization.memberships.some({userId})`); for downloads verify the `fileKey` resolves to an attachment in the caller's org. | `src/tests/security/attachment-actions-scope.test.ts` |
| **S2** | **P1** | `src/app/api/razerpay/create-order/route.ts:10` | Public POST with **no auth**. Attacker-supplied `orgId` is stamped into the Razorpay subscription `notes`; the (legitimately signed) webhook then writes `razorpaySubscriptionId`/`subscriptionStatus`/`currentPeriodEnd` onto **any organization** — cross-tenant billing-state tampering. | Require `auth()`; require ADMIN membership via `membership.findUnique({userId_orgId})` before creating the subscription; the webhook additionally verifies the target org exists before writing. | `src/tests/security/http-route-authz.test.ts`, `src/tests/security/error-disclosure-and-webhook.test.ts` |
| **S3** | **P2** | `src/app/api/stream-audit/route.ts:8` | Public POST, **no auth**, no rate limit — unauthenticated streamed Gemini generations against the shared key (cost/quota abuse). | Require `auth()`; return 401 for anonymous callers. | `src/tests/security/http-route-authz.test.ts` |
| **S4** | **P2** | `src/app/api/uploadthing/core.ts:31-77` | `taskAttachment` middleware verifies the org and quota but **never checks `taskId` belongs to that org**; the untrusted `taskId` is passed through into upload metadata that is persisted by `createAttachment`. | Extracted `assertTaskInOrg(orgId, taskId)` (predicate `project.orgId === access.organization.id`); reject before the quota increment when it does not match. | `src/tests/security/http-route-authz.test.ts` |
| **S5** | **P2** | `src/app/api/agent/session/[sessionId]/route.ts:281` (+ `src/lib/ai/agent/services/tool-execution-service.ts:643-646`) | Persisted `error.stack` is returned to the client in the session JSON in **production**, disclosing internal file paths and dependency internals. | Persist `error.message` only; project the response boundary through an **allowlist** (`src/lib/security/public-error.ts` → `toPublicError`), so only authored user-facing messages survive and DB/FS/provider/stack values collapse to a generic message. | `src/tests/security/public-error.test.ts`, `src/tests/agent/session-read.test.ts` |
| **S6** | **P3** | `src/app/api/webhooks/razerpay/route.ts:26` | Signature compared with `!==` (hex strings) — not constant-time. Sole auth gate on a billing write path. | `crypto.timingSafeEqual` on equal-length buffers (length check first). | `src/tests/security/error-disclosure-and-webhook.test.ts` |
| **S7** | **P3** | `src/app/api/triage/route.ts:54-68` | Project-existence oracle: 404 vs 403 distinguishes "project exists in some tenant" from "does not exist". | Return an identical 404 for both. | `src/tests/security/http-route-authz.test.ts` |
| **S8** | **P3** | `src/app/api/workflow/test/[workflowId]/test-run/route.ts:63-76` | 500 body echoes `error.message` and (in dev) `error.stack`. | Generic 500 message; log server-side. | `src/tests/security/http-route-authz.test.ts` |

### INFORMATIONAL / non-actionable

| ID | Sev | Location | Note |
|---|---|---|---|
| S9 | — | `src/app/api/uploadthing/deleteAttachment.ts:6` | No auth, but the function has **no caller anywhere** in the repository and is not a server action, so it is not HTTP-reachable. Hardened defensively: added `auth()` + tenant-scoped lookup (`attachment.findFirst` scoped by task→project→org membership), preserving the signature. Test: `src/tests/security/attachment-actions-scope.test.ts`. |
| S10 | P3 | `src/lib/events/worker.ts:26-28` | `ALLOW_UNSIGNED_LOCAL_WORKER` disables QStash verification. **Follow-up:** `isUnsignedWorkerAllowed()` now returns `false` under `NODE_ENV=production` regardless of the flag; outside production it still requires the exact named value. Tests: `src/tests/agent/worker-auth.test.ts` (19). |
| S11 | — | `.env` (gitignored) | Live credentials for ~12 providers sit in plaintext; `OPENAI_API_KEY` appears orphaned (unused). **Follow-up (metadata-only check):** `forge/.env` is NOT tracked (`git ls-files` no match), IS ignored (`.gitignore:34: .env*`), and appears in NO commit (`git log --all -- forge/.env` empty). The only tracked env file is `forge/.env.example`, whose values are empty strings / `localhost` placeholders — no real secrets. Residual: value-level rotation remains **owner hygiene**, not a confirmed exposure. |
| S12 | P3 | `prisma/seed.ts:17` | Hardcoded seed password. **Follow-up:** replaced by `src/lib/security/seed-password.ts` — `resolveSeedPassword(env)` fails closed (requires `SEED_PASSWORD`, or explicit `ALLOW_INSECURE_SEED=true` outside production; refuses the insecure path in `NODE_ENV=production`); literal fallback and password print removed. Tests: `src/tests/security/seed-password.test.ts` (9). |

## 3. Correctly protected (verified, no change)

All ten agent-session routes, `pusher/auth`, `chat`, `workflow` worker
(`verifySignatureAppRouter`), `worker` (QStash except the documented escape
hatch), `org/[orgId]/projects/meta`, `uploadthing` (org + role + quota + magic
bytes), `razerpay` webhook (raw-body HMAC + idempotency), and 8 of 9 server
actions enforce authentication and tenant/ownership scope. Agent mutations
re-check session ownership via `getAgentSessionForUser` and bind `executionId`
to the session.

## 4. I6 remediation (see issue register for full detail)

I6 — cross-tenant workflow execution — was implemented in this
working tree (uncommitted); its **source fix** authorizes every reachable caller.
`startWorkflow` is tenant-scoped
(`startWorkflow(orgId, workflowId, …)`, lookup predicate carries `orgId`);
`triggerWorkflowRun` and the test-run route authenticate and authorize
independently. `WorkflowRun.create` occurs in exactly one place
(`src/lib/workflow/execution/trigger.ts`). Evidence:
`trigger-tenant-scope.test.ts` (4/4), `workflow-run-boundary-scope.test.ts`
(8/8, incl. client-identity-cannot-override and no-run-on-denial), and
`src/tests/security/workflow-worker-ingress.test.ts` (proves the worker POST is
the `verifySignatureAppRouter` wrapper).

**I6 is now `VERIFIED` (2026-10-20).** The mocked suites above were necessary but
not sufficient; the Gate G evidence is a **real-PostgreSQL** cross-tenant
acceptance run (`src/tests/security/i6-cross-tenant.realdb.test.ts`, 10/10) that
exercises the **real** Prisma client, `getOrgAccess` and `startWorkflow`:
an org-A caller cannot start org B's workflow, `workflowRun.count(...) === 0` on
every refusal, foreign and missing are indistinguishable, and the same-org
positive path still creates a `RUNNING` run. Fixtures are removed with a verified
zero-leftover check. See `docs/dev-log/2026-10-20-i6-real-db-acceptance.md`.
**37.12 is unblocked.** See the issue register §I6.

## 5. Console-logging cleanup (Phase 3)

Debug breadcrumbs, per-request noise, and logs that disclosed tenant data or
credentials were removed or downgraded. Retained logs are operational/audit-grade
(worker lifecycle, idempotency/duplicate-delivery signalling, billing audit,
counts-only maintenance summaries).

Removed / redacted:

- `src/app/actions/Tasks/attachments.ts` client signer — signed download URL no
  longer logged (`TaskAttachmentModalClient.tsx`).
- `src/app/api/workflow/route.ts` — resolved step inputs (tenant data) no longer
  logged.
- `src/app/api/workflow/test/[workflowId]/test-run/route.ts` — debug breadcrumb
  removed.
- `src/app/api/worker/cron-worker/cw.ts` — per-user recipient email, project
  names, and task titles no longer logged; replaced by an aggregate count.
- `src/core/events.ts` — invited-member email no longer logged.
- `src/app/api/worker/email-worker/ew.ts`, `ai-worker/ai-worker.ts` — noisy
  breadcrumbs removed.
- `src/app/api/org/[orgId]/projects/meta/route.ts` — `"🔥 META ROUTE HIT"`
  removed.
- `src/lib/events/queue.ts` — EVENT PUBLISHED/Message ID/Topic block removed.
- `src/lib/workflow/execution/wrapper.ts` — `console.log(kind, "kind")` and
  claim/auto-complete debug lines removed.
- `src/hooks/useWorkflowLiveStream.ts` — `[PUSHER EVENT]` payload dump removed.
- `src/lib/ai/semantic-cache.ts`, `src/lib/vector/retreiver.ts` — per-query
  cache hit/miss and retriever breadcrumbs removed.
- `src/lib/workflow/actions/core/create-task.ts` — task title/project logged
  before creation removed.
- `src/lib/workflow/actions/core/generate-report.ts` — `userName` (PII) removed
  from the pre-generation log.
- `src/app/api/uploadthing/core.ts` — rejected-upload line downgraded to
  `console.warn`.
- `prisma/seed.ts` — literal seed password no longer printed.

## 6. Verification (Phase 4)

- Focused security suite: `src/tests/security/` — **6 suites / 45 tests** green.
- Full Jest: **64 suites / 1142 tests** green (baseline 58 / 1087; +6 suites,
  +55 tests).
- `tsc --noEmit`: exit 0.
- `eslint` over changed application + security test files: exit 0 (no errors).
- `prisma validate`: schema valid.
- `git diff --check`: exit 0 (CRLF autocrlf warnings only, no whitespace
  errors).

**Level of assurance.** Unit / route-level with mocked boundaries and a mocked
Prisma client, **plus** a real-PostgreSQL acceptance run for the I6 tenant
boundary (§7). No multi-process or live-provider execution was performed.

## 7. Outstanding gates

- Real-PostgreSQL verification: **CLOSED for I6** — the cross-tenant execution
  boundary was accepted against a real database on 2026-10-20 (10/10). Other
  boundaries remain mocked.
- 37.11 real-DB materialization/idempotency gate: **OPEN**.
- 37.8 migration-applied gate: **RESOLVED** — `prisma migrate status` reports the
  schema up to date; the `20261017120000_agent_proposal_lifecycle` migration is
  applied.
- Credential rotation (S11): **owner action** — no confirmed exposure (see §8).

## 8. Follow-up remediation coverage

Each originally flagged gap, its status, and the evidence that closes it.

| Gap | Status | Evidence |
|---|---|---|
| 1. I6 proof (cross-tenant execution) | **Verified (source + mocked + real-DB, 2026-10-20)** | `src/tests/security/i6-cross-tenant.realdb.test.ts` (10/10, real PostgreSQL; no run on refusal, same-org positive control); mocked: `workflow-worker-ingress.test.ts`, `workflow-run-boundary-scope.test.ts` (8), `trigger-tenant-scope.test.ts` (4); `WorkflowRun.create` is a single call site (`trigger.ts`). |
| 2. Seed-password fallback | **Remediated** | `src/lib/security/seed-password.ts` (fail-closed) + `src/tests/security/seed-password.test.ts` (9). |
| 3. Unsigned-worker guard | **Remediated** | `src/lib/events/worker.ts` `isUnsignedWorkerAllowed()` production refusal + `src/tests/agent/worker-auth.test.ts` (19). |
| 4. Error sanitization allowlist | **Remediated** | `src/lib/security/public-error.ts` + `src/tests/security/public-error.test.ts` (8) + route-level projection in `src/tests/agent/session-read.test.ts`. |
| 5. Credential exposure | **No confirmed exposure; owner hygiene remains** | Metadata-only: `forge/.env` untracked, ignored, never committed; only `forge/.env.example` (empty placeholders) tracked. |
| 6. Dependency audit | **Run; classified (see §9)** | `npm audit --json`: 55 advisories (4 critical / 31 high / 14 moderate / 6 low). |
| 7. Audit-coverage matrix | **This section.** | — |
| 8. Final verification | **Green** | §6 counts; tsc/eslint/prisma/diff-check all exit 0. |

## 9. Dependency audit (`npm audit`)

> **Amendment (2026-10-20, post-remediation).** The baseline below was recorded
> **before** the runtime-dependency remediation. That remediation was subsequently
> applied and verified; the authoritative account, including the shadow advisory
> reconciliation `npm audit` missed, is
> `docs/architecture/security/2026-10-20-runtime-dependency-remediation.md`.
> Reconciled outcome: `npm audit` **55 → 39** advisories (**0 critical** / 20 high /
> 13 moderate / 6 low). Runtime bumps applied: `next` **16.4.1**, `sharp`
> **0.35.5**, `next-auth` **5.0.0-beta.32**, `@auth/prisma-adapter` **2.11.3**,
> `html-to-text` **10.0.1**, plus `overrides` (`effect`, `deepmerge-ts`, `defu`,
> `eslint-plugin-react-hooks`). The three 2026-10-14 Next.js advisories
> (`next` 16.x) are invisible to `npm audit` and were reconciled from upstream
> (GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw/CVE-2026-96889, GHSA-p3m5-59mp-jv5r) —
> all resolved by version at 16.4.1. The baseline figures and recommendations
> below are retained as the pre-remediation record.

Run against the committed `package-lock.json` with the installed tree. Totals:
**55 advisories — 4 critical, 31 high, 14 moderate, 6 low.** Classified by
runtime reachability:

**Runtime-reachable (production, HTTP-reachable surface):**

| Package | Installed | Sev | Fix | Note |
|---|---|---|---|---|
| `next` | 16.1.3 (pinned) | **critical** | **16.4.1 (applied)** | 37 advisories: DoS via Image Optimizer / RSC, request smuggling in rewrites, middleware/proxy bypass, cache poisoning, SSRF, unauthenticated RCE on Windows-hosted servers and in the Image Optimization API. Highest-impact item; every route runs on this runtime. |
| `next-auth` | 5.0.0-beta.30 | **critical** | next beta (major flag) | Auth.js: existence-based auth checks can *fail open*, email homoglyph `@` bypass, uncaught `getToken()` on malformed Bearer, OAuth state/nonce/PKCE cookies not bound to provider. Directly relevant to this app's JWT identity gate. |
| `@auth/core` | 0.41.1 | **critical** | available | Transitive of `next-auth`; same advisories. |
| `@auth/prisma-adapter` | 2.11.1 | **critical** | available | Transitive chain via `@auth/core`. |
| `uploadthing` / `@uploadthing/react` / `@uploadthing/shared` | 7.7.4 / 7.3.3 | high | major flag | File-upload pipeline; `effect`/`defu`/`deepmerge-ts` in the chain. |
| `html-to-text` | 10.0.0 | high | available | Used at runtime in `src/lib/vector/text-extractor.ts` for ingested HTML. |

**Build / dev tooling only (not in the production request path):**
`prisma`/`@prisma/config`/`@prisma/dev`/`mysql2`/`@hono/node-server`
(CLI tooling); `eslint-config-next`/`@next/eslint-plugin-next`/`fast-glob`/
`micromatch`/`braces` (lint); `postcss`/`browserslist`/`sharp` (build);
`lodash`/`chevrotain` (Prisma AST tooling); plus transitive tooling
(`axios`, `form-data`, `follow-redirects`, `defu`, `effect`, `nanoid`,
`js-yaml`, `brace-expansion`, `picomatch`, `minimatch`, `flatted`,
`source-map-js`, `baseline-browser-mapping`). `axios` is **not** imported
anywhere in `src/`.

**Recommended remediation (owner action):** the 2026-10-20 remediation **applied**
items 1–3 against the runtime surface (see the amendment note above and the
remediation report). Remaining:
1. ~~Bump `next`~~ — **applied: `next` 16.4.1.** Re-run the full suite (done: 64
   suites / 1142 tests green).
2. ~~Track a `next-auth` beta bump~~ — **applied: 5.0.0-beta.32.**
3. ~~Plan major-version upgrades~~ — **applied: `html-to-text` 10.0.1**; `uploadthing`
   refreshed via `overrides` (`effect`/`defu`/`deepmerge-ts`).
4. Dev-tooling advisories are lower priority (not internet-reachable) and remain
   **deferred** — clear opportunistically (see the remediation report §9 and the
   issue register's deferred follow-ups).

Additional residual after remediation: a moderate `resend`/`svix` advisory (no
compatible upstream fix) and the dev/CLI advisories above; monitor for patched
releases. No blanket `npm audit fix` was run.

## 10. Owner actions

- **Credential hygiene (S11):** No confirmed leak — `.env` is untracked,
  git-ignored, and absent from all commits. Still recommended: rotate any
  credential that has ever been shared out-of-band, and remove the unused
  `OPENAI_API_KEY` if present.
- **Dependency upgrades:** §9 recommendations 1–4.
- **Open integration gates:** §7.
