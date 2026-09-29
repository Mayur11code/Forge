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
| `RUNTIME VERIFIED` | Exercised in a running process against real infrastructure. | **ACHIEVED** — QStash, Redis, Neon, and Gemini were all driven live (see *Live verification*) |
| `LIVE VERIFIED` | Exercised against the deployed production stack. | **NOT CLAIMED** — everything ran against a local Next.js dev server behind a temporary `ngrok-free.dev` tunnel, against the real Neon and QStash accounts. This is a real Neon primary, not a disposable database. |

> **Update, later on 2026-09-29.** This document was first written when the
> subsystem had never been executed. That is no longer true: the five migrations
> have been applied, the QStash schedule exists and has delivered real signed
> ticks, and the approval, reaper, and outbox paths have all run against live
> infrastructure. The sections that said "does not exist yet" have been corrected
> in place. Two things remain genuinely unproven and are called out as such:
> the re-drive of a session whose `AGENT_LOOP_REQUESTED` was already published,
> and the stale-execution reaper firing in the same tick as a session re-drive.

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

`AGENT_MAINTENANCE_REQUESTED` runs **five** bounded duties — approval expiry,
orphan reaping, confirmed-execution redelivery, **stalled-session re-drive**, and
outbox drain — and reports per-duty counts. One failing duty does not stop the
others, and the pass throws *after* all five settle so the broker records a
failed tick and retries it.

**The trigger is a QStash schedule, and it now exists.** `scd_6x2LU8qSUyNjxuveHoyM8tPo4ykj`
was created and verified against the real account via the regional endpoint from
`QSTASH_URL`, POSTing to `/api/worker` every five minutes. Ticks have been
observed arriving signed and executing the sweep; see *Live verification*.

`scripts/qstash-maintenance-schedule.mjs` creates and verifies the schedule, and
deliberately **refuses** loopback, plaintext and temporary-tunnel destinations
outright — but because there was no stable public origin, the tunnel case had to
be admitted for development. That is an explicit, hard-to-miss opt-in
(`AGENT_MAINTENANCE_ALLOW_TUNNEL=yes`) rather than a relaxed check, because
QStash accepts these destinations without complaint and then fails every tick,
which looks configured and reports nothing.

> The original finding here was that the four recovery duties had **no caller in
> any running environment.** That is resolved: the schedule is created, delivery
> is signed, and the duties execute. The remaining gap is narrower and is about
> *recovery of recovery* — see *Stalled-session re-drive*.

The replayed body omits CloudEvents `id` and `time`. A schedule body is a static
template, so anything baked into it is re-fabricated on every tick; the dispatcher
derives `id` from the QStash message id and `time` from actual arrival, and an
explicit `id` still wins so outbox retries keep their identity.

### Stalled-session re-drive

`redriveStalledSessions` closes a gap the other three duties could not see. The
orphan reaper deals with executions that exist; confirmed redelivery deals with
executions stuck in `PENDING`. Neither covers a session that claimed a step, got
`AGENT_LOOP_REQUESTED` published, and then died with **no execution row at all** —
the Gemini turn simply never started. Such a session is `RUNNING` forever, and
nothing selects it.

**Staleness is decided in two stages, and only the second is authoritative.**

1. `updatedAt < now - AGENT_STALLED_SESSION_AGE_MS` (10 min) is an *indexed
   pre-filter* only. It is deliberately not the liveness signal.
2. The session lock is. `withAgentSessionLock` is acquired, and the session is
   **re-read under that lock**; the session is only a candidate if it is still
   `RUNNING`, still stale, and still has no in-flight execution.

This matters because `updatedAt` is only written when a step is *claimed*. A
worker mid-Gemini-turn holds the lock and refreshes the execution heartbeat, but
the session row does not move. Treating `updatedAt` as proof of death would let
two sweeps collide with healthy in-flight work — the exact failure the lock
exists to prevent. The pre-filter is only allowed to make us *look*; the lock is
allowed to *decide*.

**In-flight means three statuses, not two.** The guard excludes sessions with a
`PENDING`, `RUNNING`, or `PENDING_CONFIRMATION` execution. `PENDING_CONFIRMATION`
is not optional: a session awaiting human approval is still `RUNNING` at the
session level, so a predicate written as "no PENDING/RUNNING execution" would
drag the model back into a turn nobody approved. This is covered by a
mutation-checked test — removing the `PENDING_CONFIRMATION` guard fails it.

**Recovery reuses the existing outbox, and that reuse has a sharp edge.** The
duty records an `AGENT_LOOP_REQUESTED` intent under the deterministic key
`AGENT_LOOP_REQUESTED:<sessionId>#redrive#<currentStep>` and lets the ordinary
dispatcher publish it. There is no new event type, no new worker, and no direct
publish. Delivery therefore still passes through `claimNextAgentStep`'s step CAS
and the session lock.

The edge: the sweep publishes the re-drive **while still holding that same
session's lock**, and the loop worker treats lock contention as a successful,
already-acknowledged delivery — it logs and returns `200`. QStash marks the
message delivered and never retries. This was observed live, not theorised:

```
stalled:{redriven:2, queued:2, scanned:2}
[AGENT] Session cmumu6ja20006uogc4zrxpeft completed.
[AGENT] Session cmumucij5000duogcti32doo1 is already being processed.
```

Redis held no lock keys afterwards, so this was a race, not a stuck lock. Worse,
the row is now `PUBLISHED` and `recordAgentEvent` will never resurrect a
`PUBLISHED` row — so the session was **permanently** stranded, and the sweep
re-selected it every tick doing nothing.

`rearmOutboxEvent` is the deliberate, bounded exception: it CAS-transitions a
single row from `PUBLISHED` back to `PENDING` (`attempts` incremented,
`availableAt = now`, `publishedAt`/`lastError` cleared). The CAS on
`status: PUBLISHED` means it can neither double-queue a `PENDING` row nor race a
dispatcher that is mid-publish.

**Recovery is bounded, and giving up is a terminal transition.** After
`AGENT_STALLED_SESSION_MAX_REDRIVES` (3) attempts the session is `FAILED` with
`terminalReason: "ERROR"` and an explicit message, and a `FAILED` status event is
published. This mirrors the execution reaper's terminate-don't-spin behaviour. A
session that survives three re-drives is not going to recover, and leaving it
`RUNNING` forever is how a reaper becomes a lie.

> **Known remaining gap (not fixed).** The loop worker still acknowledges
> deliveries it refuses on lock contention (`agent-loop/al.ts`). Re-arm makes this
> self-healing within 3 attempts for *re-drive* traffic, but an ordinary
> tool→loop handoff that loses the race is still dropped silently. Left
> deliberately as its own change rather than folded into a recovery fix.

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
7. **QStash rejected the deduplication id.** The outbox passed
   `AGENT_LOOP_REQUESTED:<id>` as `deduplicationId` and QStash refused the `:`.
   Now hashed to `agent-outbox-<hex>`; the readable key is still stored in the row.
   Found only by publishing live.
8. **Signature failures were reported `500`,** so QStash retried a body that could
   never authenticate. Now `401` for non-retryable verification failures, with
   genuine failures still `500`.
9. **A re-drive could be acknowledged without being delivered.** Found live, not
   theorised: the sweep publishes while holding the session's own lock, the loop
   worker logs the contention and returns `200`, QStash marks it delivered and
   never retries, and the `PUBLISHED` outbox row can never be re-recorded. The
   session was stranded *permanently* while the sweep re-selected it every tick
   doing nothing. Fixed with the bounded `rearmOutboxEvent` CAS. This is the most
   important defect in the group, because it was invisible to every existing test
   and would have shipped as a working recovery subsystem.

## Migrations

Five agent migrations exist. **All five have been applied** to the configured
Neon primary, in order.

| Migration | Contents |
| --- | --- |
| `20260929120000_agent_session_terminal_reason` | `AgentSession.terminalReason` + index |
| `20260929140000_agent_tool_execution_confirmation` | `PENDING_CONFIRMATION` / `CANCELLED`, `confirmedAt` / `cancelledAt` |
| `20260929150000_agent_session_prompt_version` | `promptVersion`, defaulted to legacy `v1` |
| `20260929160000_agent_approval_expiry` | `EXPIRED`, `expiresAt` / `expiredAt`, `[status, expiresAt]` index |
| `20260929200000_agent_outbox` | `AgentOutboxEvent` + indexes |

`npx prisma generate` has been run; the client matches the schema. The
stalled-session duty adds **no** migration — it introduces no column, only a
constant and a reader over existing `AgentSession` / `AgentToolExecution` rows.

> The only `DATABASE_URL` configured in this environment is a live Neon primary
> (`ep-muddy-water-ah607io6-pooler.c-3.us-east-1.aws.neon.tech`, database
> `neondb`). Applying the migrations was an operational decision taken
> deliberately. Only `prisma migrate deploy` was used; `prisma db push`,
> `migrate reset`, and any data deletion were never run, and all `verify-*`
> fixture data was left in place. The database is a real primary and not a
> disposable target, so this should be re-confirmed before doing it again.

## Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean |
| Tests | `npx jest` | 20 suites, **304 tests**, passing |
| Lint (scoped) | `npx eslint` over changed agent code | clean |
| Lint (repository) | `npx eslint .` | **not clean** — pre-existing `no-explicit-any` in `src/lib/events/event-bus.ts:5,7` and unrelated worker files, left alone as out of scope |
| Client generation | `npx prisma generate` | pass |
| Direct-publish audit | search over agent + agent API paths | only the outbox dispatcher |
| 27–34 scope | diff review of candidate paths | no intended changes |
| Migrations | `prisma migrate deploy` | all five applied |
| QStash schedule (real account) | `scripts/qstash-maintenance-schedule.mjs verify` | schedule `scd_6x2LU8qSUyNjxuveHoyM8tPo4ykj` exists, enabled, every 5 min, targeting `/api/worker` |
| Schedule script guard | `… plan` | refuses `localhost`; requires `AGENT_MAINTENANCE_ALLOW_TUNNEL=yes` before admitting a `ngrok-free.dev` destination |
| Destination reachability | real QStash tick through the tunnel | **delivered and signed** — the worker rejected a replayed body unsigned |

### Live verification

Each of these was exercised against real infrastructure, not a mock:

- **QStash publish → tunnel → signed delivery.** Ticks arrived at
  `https://…ngrok-free.dev/api/worker` and were accepted only with a valid
  signature. An unsigned replay was rejected.
- **Redis lock acquire / renew / release**, including token-guarded renewal and
  deliberate contention with a second holder.
- **The maintenance sweep running for real**, returning
  `stalled:{redriven:2, queued:2, scanned:2}` against two genuinely stranded
  sessions.
- **End-to-end session recovery.** `cmumu6ja20006uogc4zrxpeft` was re-driven and
  went on to `completed`.
- **The orphan reaper.** Execution `cmumvvsf5000tj4gcg0x2cr3d` was observed
  `CANCELLED`, its session `FAILED` with `terminalReason=ERROR`.
- **Gemini** tool-call and tool-result round-trips, plus approval expiry,
  cancellation, confirmation, and continuation.
- **Duplicate delivery** staying harmless under a real at-least-once broker.

## Quality-audit closure pass

A final pass walked the seven audit topics against the source rather than against
the prose above. One genuine defect was found and fixed; the other six held up.
Nothing else was changed.

### The defect: a validation failure the model cannot act on

Every tool reported a schema rejection as `parsed.error.issues[0]?.message` —
the first issue, with no field name. The loop is a *self*-healing one, so this
is a correctness problem, not cosmetics. A model that sent `limit: "many"` to
`listTasks`, which has four optional fields, was told:

```
Invalid input: expected number, received string
```

It cannot tell which field is wrong, so the only ways forward are to guess or to
resend the same call. The prompt, meanwhile, said only *"report the returned
error honestly and do not retry blindly"* — which points at surfacing the
complaint to the user rather than fixing it, and collides with the prompt's own
rule against revealing internal implementation detail.

Both halves were wrong in the same direction, so neither alone was a finding.
The observation was not machine-readable, and the prompt had no rule that made
it actionable.

**Fix.** One shared builder, `buildValidationFailure` in
`forge/src/lib/ai/agent/tools/shared-output.ts`, used by all three tools. It
returns every issue with a dotted `path` and the schema's own `code`, caps the
list at 8 and says how many were dropped, and includes the field name in the
human-readable line. `AGENT_PROMPT_VERSION` is now `v3`, whose
`<TOOL_CONTRACT>` states that `INVALID_INPUT` is feedback on the model's own
arguments, that the named field is what to fix, and that two identical
rejections mean stopping and asking the user.

No value from the submitted input is ever echoed. Zod's `unrecognized_keys`
message names offending *keys* — which the model itself just wrote — and never
their values, so an injected `orgId` or a hallucinated credential cannot be
reflected back into the transcript. This is asserted directly.

### Topic verdicts

| Topic | Status | Evidence | Change made? |
| --- | --- | --- | --- |
| A. Input validation and authority | `COMPLETE` | All three schemas are `.strict()` and `safeParse` before any domain call. `orgId`/`userId` come from the persisted `AgentSession` via `getToolExecutionForWorker`, never from the payload. No write is reachable on rejection. | No |
| B. Self-healing loop | `FIXED` | Real path: model tool call → execution → `safeParse` reject → structured `INVALID_INPUT` → tool result **and** `AGENT_LOOP_REQUESTED` in one transaction → next model turn. The failure observation was unusable; now every issue names its field. | **Yes** |
| C. Tool-result correctness | `COMPLETE` | AI SDK v6 shape (`role: "tool"` → `tool-result`) is valid. The `toolCallId` is the persisted one, unchanged. `markToolExecutionRunning` CAS makes the result write happen at most once under redelivery. | No |
| D. State rehydration | `COMPLETE` | The worker rehydrates from `getAgentSessionForWorker` + `getMessages`; no in-memory request state. `getMessages` sorts on `createdAt` alone with no tie-breaker, which was examined and left alone — see below. | No |
| E. Success/failure synthesis | `COMPLETE` | Prompt carries honesty rules, "never claim success without `ok: true`", and a decline is final. `CANCELLED` and `APPROVAL_TIMEOUT` results are self-describing, so they need no prompt rule. `INVALID_INPUT` was the gap, and is now covered. | No (covered by B) |
| F. Typed continuation | `COMPLETE BY DESIGN` | Grep finds no `isSystemWakeup`, keyword selector, `streamText`, `parallelToolCalls`, or `RegExp` in the agent paths. A user turn is orchestrated at step 0; a tool result re-drives via the typed outbox. One path. | No |
| G. Error safety | `COMPLETE` | `MAX_AGENT_STEPS = 5` and every continuation claims a new step, so a model that retries bad arguments is bounded at five model calls. A separate circuit breaker would be a second layer over a cap that already exists. | No |

### On `getMessages` ordering

`orderBy: { createdAt: "asc" }` with no secondary key is not a total order in
SQL, so it was worth checking rather than assuming.

It is not a defect here. All three `createMessage(..., tx)` call sites write
exactly one message per transaction, so no two messages that must stay in
relative order can share a timestamp. The pair that matters — an assistant
tool-call and the tool result answering it — is always separated by a queue
delivery and therefore by a transaction boundary. The only remaining tie window
is several assistant messages from one model turn, which are the same role and
the same `step`, so reordering among them breaks nothing.

A secondary `id` tie-breaker would make the query formally deterministic, but it
would guard against a case with no demonstrated failure. Leaving it out is
consistent with the rest of this pass.

## What is NOT verified

- **The re-drive of a session whose `AGENT_LOOP_REQUESTED` was already
  `PUBLISHED`.** `rearmOutboxEvent` is covered by unit tests and the race that
  motivates it was observed live, but the re-arm path itself has not completed a
  live cycle. The live re-test was blocked by the Neon endpoint resetting every
  connection (`P1017` / `ECONNRESET`), not by anything in the code.
- **The stale-execution reaper firing in the same tick as a session re-drive.**
  The reaper is verified live on its own; the combined pass is not.
- **Transaction rollback behaviour.** The prisma double does not simulate
  rollback, so no test proves a mid-transaction failure would undo its writes.
  This remains the single largest caveat in the document.
- **Production.** Everything ran against a dev server on a temporary tunnel. No
  claim is made about a stable public origin, and `APP_URL` is still
  `http://localhost:3000`.
- **The `CRON_DAILY_DIGEST` schedule and the `events` topic** still point at the
  tunnel; they were left alone rather than repointed at a temporary origin.

## Not done, and deliberately so

- **The agent UI.** Nothing in the app calls `/api/agent/init`, the session GET,
  or the confirm/cancel endpoints. Unchanged from Assignment 34.
- **The worker-side lock-contention drop.** See the known remaining gap under
  *Stalled-session re-drive*. Left as its own change.
- **The `EventLog` `FAILED → PENDING` re-arm CAS** still returns `200` without
  doing work when it loses. Phase 5.
- **Destructive tools.** `DESTRUCTIVE` policy exists and is unused; the domain has
  no safe deletion semantics.
- **Message ordering, persisted-message validation, per-message prompt hash.**
  Phase 5. `getMessages` ordering was re-examined in the closure pass and is not
  a defect; the other two stand.
- **Assignment 37.** Not started.

## Operational preconditions

Items 1–3 and 5 are **done**. Item 2 is only done in the weak sense, and item 4
and 6 remain open.

1. ~~Confirm a non-production database target; back it up; apply the five
   migrations in order.~~ **Done** — applied via `prisma migrate deploy` to the
   configured Neon primary.
2. ~~Deploy the worker to a **stable public HTTPS origin** and set `APP_URL` to
   it.~~ **Partially done.** The worker is reachable and delivering through a
   temporary `ngrok-free.dev` tunnel, which is enough to exercise everything
   live but is *not* stable and must not be treated as a deployment. `APP_URL` is
   still `http://localhost:3000`. This remains the real blocker for production.
3. ~~Create the schedule and verify it.~~ **Done.**
   ```bash
   node scripts/qstash-maintenance-schedule.mjs apply
   node scripts/qstash-maintenance-schedule.mjs verify
   ```
   A readback is **not** a delivered message — but real delivered ticks have now
   also been observed, which the readback alone could never have shown.
4. **Open.** Repoint the `events` topic and the existing `CRON_DAILY_DIGEST`
   schedule at the stable origin once one exists. Both still point at the
   temporary tunnel.
5. ~~Confirm the deployed QStash consumer points at `/api/worker`.~~ **Done** and
   confirmed by live delivery. `USE_MULTI_TOPICS = false` means every event goes
   to topic `events`, so the old per-topic consumer would have received nothing.
6. **Open.** Rotate credentials that appeared in earlier working transcripts.
   New Gemini and Redis credentials were supplied for this session; the ones in
   the transcripts are still considered exposed.

