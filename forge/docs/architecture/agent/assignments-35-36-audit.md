# Assignments 35/36 — Closure Audit

Date: 2026-09-29. Scope: Assignments 35 and 36 (provider binding, approval
expiry, recovery scheduling, worker authentication, transactional outbox).
Explicitly out of scope: Assignments 27–34 and Assignment 37.

This is a closure report, not a summary. It records what is **proven**, what is
**implemented but unproven**, and what is **not done**, so the next person does
not have to re-derive it from the diff.

## Verification levels

| Level | Meaning | Status here |
| --- | --- | --- |
| `SOURCE VERIFIED` | Implemented, read back against its own comments, and covered by tests or static analysis. | **ACHIEVED** |
| `RUNTIME VERIFIED` | Exercised in a running process against real infrastructure. | **NOT CLAIMED** |
| `LIVE VERIFIED` | Exercised against the deployed production stack. | **NOT CLAIMED** |

`SOURCE VERIFIED` is a real claim and it is not the same as working software.
Nothing below has been run against a database, a queue, Redis, Pusher, or Gemini.

## Assignment 35

### Provider binding

`src/lib/ai/agent/model.ts` resolves through the shared `googleProvider`
singleton in `src/lib/ai/provider.ts` (sourced from `GEMINI_API_KEY`, model
`gemini-2.5-flash`) rather than constructing a provider. `provider-binding.test.ts`
covers the model id, the key requirement, and fail-closed behaviour when
`GEMINI_API_KEY` is absent.

> Note: the brief's `src/lib/ai/agent/provider.ts` path does not exist in this
> repository. The validated singleton is `src/lib/ai/provider.ts`. No file was
> created at the briefed path to satisfy the wording.

### Approval expiry

- `AgentToolExecutionStatus.EXPIRED`, `expiresAt`, `expiredAt`, and a
  `[status, expiresAt]` index.
- `getAgentApprovalTimeoutMs()` — 15-minute default,
  `AGENT_APPROVAL_TIMEOUT_MS` override.
- `expireStaleApprovals` selects only rows that are actually due. A `NULL`
  `expiresAt` is never expired, because `NULL <= now` is not true in SQL.
- `expireToolExecutionAndContinue` commits the CAS, the `APPROVAL_TIMEOUT`
  tool-result and the re-arm intent **in one transaction**.
- A terminal or deleted session closes the execution without continuing; there is
  no turn left to continue and no step to claim.

### Recovery scheduling

`AGENT_MAINTENANCE_REQUESTED` runs four bounded duties — approval expiry, orphan
reaping, stalled redelivery, outbox drain — and reports per-duty counts. One
failing duty does not stop the others, and the pass throws *after* all four settle
so the broker records a failed tick and retries it.

**The trigger is a QStash schedule, and it does not exist yet.** The QStash account
was queried directly (not inferred from source) using the regional endpoint from
`QSTASH_URL`:

- The account's schedule list contains **no** `AGENT_MAINTENANCE_REQUESTED`
  schedule.
- One other schedule exists, `CRON_DAILY_DIGEST`, and it is in `FAIL` state.
- Both that schedule and the `events` topic point at
  `https://…ngrok-free.dev/api/worker`, which returns `404` — the tunnel is dead,
  and no local Next.js or `ngrok` process is running.
- `APP_URL` is `http://localhost:3000`, so there is no public origin to point a
  schedule at.

`scripts/qstash-maintenance-schedule.mjs` creates and verifies the schedule, and
deliberately **refuses** loopback, plaintext and temporary-tunnel destinations:
QStash accepts them without complaint and then fails every tick, which looks
configured and reports nothing.

> This is the single most important finding in this audit. The four recovery
> duties have **no caller in any running environment.** A tested sweeper that is
> never delivered is indistinguishable, in every document and every code review,
> from one that works.

The replayed body omits CloudEvents `id` and `time`. A schedule body is a static
template, so anything baked into it is re-fabricated on every tick; the dispatcher
derives `id` from the QStash message id and `time` from actual arrival, and an
explicit `id` still wins so outbox retries keep their identity.

### Worker authentication

`isUnsignedWorkerAllowed()` is `ALLOW_UNSIGNED_LOCAL_WORKER === "true"`. The
previous `NODE_ENV === "development"` bypass is gone. `worker-auth.test.ts` asserts
that `"0"` and `"false"` do **not** enable it, which a truthiness check would have
got backwards.

Maintenance no longer has a secret of its own. The deleted cron route compared a
static bearer value against a copy of itself; the replacement inherits QStash's
per-delivery signing from the shared worker dispatcher, which is a stronger
boundary with nothing left to leave unset.

### Queue client region

`lib/events/queue.ts` constructed its `Client` with no `baseUrl`. The SDK defaults
to `qstash.upstash.io` in `eu-central-1`, and this account is US East 1, so every
publish would have returned a 404 reading `user (...) not found in this region` —
which reads as a revoked credential, not a wrong endpoint. `QSTASH_URL` is now
required, passed as `baseUrl`, and validated *before* the try block so the error is
not rewritten to `Failed to queue background job`.

## Assignment 36

### Transactional outbox

- `AgentOutboxEvent` with `idempotencyKey` (unique), `status` (`PENDING` /
  `PUBLISHED`), `attempts`, `availableAt`, `publishedAt`, `lastError`.
- `recordAgentEvent` requires a transaction client. All critical agent event
  paths use it; `publishEvent` appears in exactly one place in the agent code —
  the dispatcher.
- Claiming is a **lease on `availableAt`**, not a status read, so two overlapping
  maintenance ticks cannot both win.
- Failed publishes return to `PENDING` with an incremented attempt count and a
  backoff along `AGENT_OUTBOX_BACKOFF_MS` (`1s, 5s, 15s, 1m, 5m`). A failed
  publish is never dropped.
- `sessionId` / `executionId` are plain strings, **not** foreign keys.

### Atomic approval paths

Confirmation, cancellation, expiry, tool-result-plus-rearm, session start, and
stalled redelivery each write their domain state, their transcript, and their
delivery intent in one transaction.

### Queue changes

`publishEvent` accepts a deterministic `messageId` and `deduplicationId`; the
outbox supplies both from the outbox row. `PublishDelay` is a template literal
type converted to QStash's seconds, replacing a cast that type-checked `"30s"`
and then failed at runtime.

## Guarantees: what is and is not claimed

| Claim | Status |
| --- | --- |
| Domain state and its delivery intent commit together | **Guaranteed** by construction and asserted in tests |
| Delivery happens at least once | **Guaranteed** |
| Delivery happens exactly once | **NOT CLAIMED** — not achievable with an at-least-once broker |
| Duplicate delivery is harmless | Made safe by consumer CAS (`PENDING` claim, step claim) and the deterministic `deduplicationId` |
| A crashed dispatcher loses no event | Row stays `PENDING`; lease expiry releases it within `AGENT_OUTBOX_CLAIM_LEASE_MS` |
| A transaction rolls back correctly on partial failure | **NOT VERIFIED** — the prisma double does not simulate rollback |

That last row is the most important caveat in this document. Every test asserting
"this is atomic" is asserting that the work is *enclosed* in a transaction and
that the writes are correct. None of them prove a mid-transaction failure would
undo the writes. That requires a real database.

## Defects found and fixed during this work

1. **The outbox claim was not exclusive.** It selected `status = PENDING` and did
   not change `status`, so two concurrent dispatchers both published — the
   duplicate was manufactured inside the application. The first fix (CAS on
   `attempts`) was also wrong: a later batch reads the already-incremented value
   and matches again. Fixed with a lease on `availableAt`. The test was verified
   non-vacuous by removing the lease write and confirming the failure.
2. **Approval expiry was terminal-then-write.** The CAS committed `EXPIRED`
   before the transcript and re-arm. A crash in that gap left a row that no sweep
   would ever select again, stranding the session permanently. Fixed by making all
   three writes one transaction.
3. **The redelivery sweep published directly**, doing the dispatcher's job
   without the durability. It now re-records intent, which collapses onto the
   existing row through the unique `idempotencyKey`.
4. **`NODE_ENV` was a security boundary** in the queue worker and the maintenance
   route. Replaced with an exact-match opt-in and a required secret.
5. **QStash delays were a runtime lie** — `"30s"` was cast to a number and
   rejected by the client. Now a template type plus explicit conversion.
6. **Tests could reach a live database.** `jest.setup-db-guard.ts` now makes any
   real `PrismaClient` construction a hard failure.

## Migrations

Five agent migrations exist. **None has been applied to any database.**

| Migration | Contents |
| --- | --- |
| `20260929120000_agent_session_terminal_reason` | `AgentSession.terminalReason` + index |
| `20260929140000_agent_tool_execution_confirmation` | `PENDING_CONFIRMATION` / `CANCELLED`, `confirmedAt` / `cancelledAt` |
| `20260929150000_agent_session_prompt_version` | `promptVersion`, defaulted to legacy `v1` |
| `20260929160000_agent_approval_expiry` | `EXPIRED`, `expiresAt` / `expiredAt`, `[status, expiresAt]` index |
| `20260929200000_agent_outbox` | `AgentOutboxEvent` + indexes |

`npx prisma generate` has been run; the client matches the schema.

> The only `DATABASE_URL` configured in this environment is a live Neon primary
> (`ep-muddy-water-ah607io6-pooler.c-3.us-east-1.aws.neon.tech`, database
> `neondb`). Applying migrations is therefore an operational decision that
> requires an explicitly confirmed non-production target and a backup. It was not
> performed. `prisma db push`, `migrate reset`, and any data deletion were also
> not run.

## Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean |
| Tests | `npx jest` | 19 suites, 253 tests, passing |
| Lint (scoped) | `npx eslint` over changed agent code | clean |
| Lint (repository) | `npx eslint .` | **not clean** — pre-existing `no-explicit-any` in `src/lib/events/event-bus.ts:5,7` and unrelated worker files, left alone as out of scope |
| Client generation | `npx prisma generate` | pass |
| Direct-publish audit | search over agent + agent API paths | only the outbox dispatcher |
| 27–34 scope | diff review of candidate paths | no intended changes |
| QStash schedule (real account) | `schedules.list()` via the regional endpoint | **no `AGENT_MAINTENANCE_REQUESTED` schedule exists**; one unrelated `CRON_DAILY_DIGEST` schedule in `FAIL` state |
| Schedule script guard | `node scripts/qstash-maintenance-schedule.mjs plan` | refuses the localhost destination, exit 1 |
| Destination reachability | request to the endpoint in the QStash topic/schedule config | `404` — tunnel is dead, no local server or `ngrok` process running |

## What is NOT verified

- No live Gemini tool-call/tool-result round-trip.
- No live QStash publish, delivery, signature verification, or deduplication.
- No live Redis lock acquire/renew/release, or lock contention.
- No live Pusher authorization or delivery.
- **No maintenance schedule exists, and no maintenance tick has ever been
  observed.** There is no public destination to point one at.
- No migration has been applied, so none of the new state — `EXPIRED`,
  `expiresAt`, `AgentOutboxEvent` — exists in any database.
- Rollback behaviour of any transaction is untested (see above).

## Not done, and deliberately so

- **The agent UI.** Nothing in the app calls `/api/agent/init`, the session GET,
  or the confirm/cancel endpoints. Unchanged from Assignment 34.
- **Sessions frozen mid-turn with no execution in flight.** The reaper covers
  executions, not their absence.
- **The `EventLog` `FAILED → PENDING` re-arm CAS** still returns `200` without
  doing work when it loses. Phase 5.
- **Destructive tools.** `DESTRUCTIVE` policy exists and is unused; the domain has
  no safe deletion semantics.
- **Message ordering, persisted-message validation, per-message prompt hash.**
  Phase 5.
- **Assignment 37.** Not started.

## Operational preconditions before any of this runs

1. Confirm a non-production database target; back it up; apply the five
   migrations in order.
2. Deploy the worker to a **stable public HTTPS origin** and set `APP_URL` to it.
   This is the blocker for the recovery subsystem.
3. Create the schedule and verify it:
   ```bash
   node scripts/qstash-maintenance-schedule.mjs apply
   node scripts/qstash-maintenance-schedule.mjs verify
   ```
   `verify` reports `delivery: NOT VERIFIED` until a tick has actually run and
   QStash records it as delivered. A successful readback is **not** a delivered
   message.
4. Repoint the `events` topic and the existing `CRON_DAILY_DIGEST` schedule at that
   origin. Both still point at the dead `ngrok-free.dev` tunnel; they were left
   alone because the replacement origin did not exist to point them at.
5. Confirm the deployed QStash consumer points at `/api/worker` rather than the
   removed `/api/worker/agent-tool-execution`. `USE_MULTI_TOPICS = false` means
   every event goes to topic `events`, so the old per-topic consumer would
   receive nothing.
6. Rotate credentials that appeared in earlier working transcripts.
