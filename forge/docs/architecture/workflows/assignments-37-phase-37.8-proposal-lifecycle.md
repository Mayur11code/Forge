# Assignment 37 — Phase 37.8: Durable Proposal Lifecycle

```text
Phase:            37.8 — Durable proposal persistence and restart survival
Status:           VERIFIED (2026-10-23 — real-PostgreSQL 2-process restart survival acceptance suite 10/10 PASS)
Classification:   P1
Depends on:       37.5 VERIFIED (`generateWorkflow` tool); 37.6 VERIFIED (missing-input protocol); 37.7 VERIFIED (human criticality)
Blocks:           37.9 (approval), 37.10 (UI representation), 37.11 (materialization)
Resolves:         F4 (CLOSED 2026-10-23 via Option 1 AgentToolExecution lifecycle extension)
Writes workflows: No
Writes anything:  Adds durable proposal lifecycle columns on `AgentToolExecution`; persists human clarification/criticality decisions
Runtime changed:  No
Resolver changed: No
Schema migration: Yes (offline-generated; see §5)
```

Companion documents: `assignments-37-plan.md`, `assignments-37-tracker.md`,
`assignments-37-issue-register.md`, `../agent/decisions.md`.

**Status — `VERIFIED` (2026-10-23).** Phase 37.8 is formally verified against real
PostgreSQL. Acceptance Gate and Verification Gate are satisfied by the independent
two-process cold restart harness (`src/tests/agent/proposal-lifecycle.realdb.test.ts`,
10/10 PASS in 66s). **F4 is resolved and closed.** Option 1 (extending
`AgentToolExecution`) is implemented and migration `20261017120000_agent_proposal_lifecycle`
is applied.

---

## 1. Purpose and Scope

Make the workflow-proposal lifecycle **durable and restart-resumable** by
storing it on the existing `AgentToolExecution` row, and make the worker **park**
the loop on a valid proposal instead of re-entering the model.

In scope:

- A proposal-specific state machine (`AgentProposalState`), separate from the
  execution status.
- Persist the tool `result`, the proposal fingerprint, and a deterministic
  revision in the worker's own transaction.
- Park the loop at `AWAITING_CRITICALITY` on a valid proposal (no
  `AGENT_LOOP_REQUESTED`).
- Persist the human's clarification answer and criticality decision durably.
- Deterministic supersession of older pending proposals.
- Exempt a parked session from the stall reaper; expose the pending proposal on
  the session read endpoint.

## 2. Decision (F4): what was decided and why

**Extend `AgentToolExecution`; do not introduce a `WorkflowProposal` model.**
Proposal state is a **separate** enum from execution status.

The execution row already owns the immutable proposal (`input`), the approval
audit trail, and the session-scoped identity that clarification and criticality
bind to. A second table would shadow the same row with its own state machine to
keep in sync. Full rationale: `../agent/decisions.md` Decision 22 and
`assignments-37-plan.md` (Phase 8 note).

`assignments-37-plan.md` (Phase 8 note).

**Why proposal state is a separate enum.** `AgentToolExecutionStatus` answers
*"did the tool run?"*. `AgentProposalState` answers *"where is the human decision
about the proposal?"*. A valid `generateWorkflow` is **`COMPLETED`** (the tool
ran) **and** parked at `AWAITING_CRITICALITY`. A single enum cannot hold both
truthfully; conflating them would erase the honest state "ran successfully,
parked".

## 3. Rejected Alternatives

- **Option B — a dedicated `WorkflowProposal` table.** Rejected: duplicates the
  execution row and adds a second state machine plus a foreign key back to the
  row it shadows.
- **Adding proposal states to `AgentToolExecutionStatus`.** Rejected: makes
  "execution completed" and "proposal awaits a human" the same value.
- **Re-entering the model on a valid proposal.** Rejected: regenerates the
  proposal the human is deciding on.
- **Supersession by wall-clock time.** Rejected: same-millisecond proposals do
  not order totally, so a restart could pick a different winner.
- **A new outbox event type for the pending proposal.** Rejected: state lives in
  the row; a Pusher event would be transport-only (Decision 8).

## 4. Data Model and Migration

Added by `prisma/migrations/20261017120000_agent_proposal_lifecycle/migration.sql`:

- `enum AgentProposalState`
  (`VALIDATED`, `NEEDS_CLARIFICATION`, `CLARIFICATION_ACCEPTED`,
  `AWAITING_CRITICALITY`, `AWAITING_APPROVAL`, `APPROVED`, `SUPERSEDED`,
  `INVALID`, `MATERIALIZED`).
- `AgentToolExecution`: `result Json?`, `proposalFingerprint String?`,
  `proposalRevision Int?`, `proposalState AgentProposalState?`,
  `clarificationAnswer Json?`, `criticalityDecisions Json?`,
  `@@index([sessionId, proposalState])`.
- `Workflow`: `sourceProposalId String? @unique`, relation
  `sourceProposal AgentToolExecution? @relation("WorkflowSourceProposal",
  onDelete: SetNull)`, `@@index`/FK as generated.

## 5. Migration Provenance

Generated **offline** via
`npx prisma migrate diff --from-schema <pre-37.8 copy> --to-schema prisma/schema.prisma --script`
and hand-placed in a timestamped directory. `npx prisma validate` is valid and
`npx prisma generate` succeeds (both exit 0). No `migrate dev`/`deploy` was run.
The first attempt to reach the database failed (`P1001`), so the migration was
generated offline; a later `npx prisma migrate status` **did** connect and
reported this migration, plus the unrelated
`20260930120000_workflow_run_progress`, as **unapplied**. It has not been applied
to any database (see §18).

> **Amendment 2026-10-20 (supersedes the migration-state observation above).**
> A later `npx prisma migrate status` now reports **"Database schema is up to
> date!"** — **all 26 migrations are applied**, including this one
> (`20261017120000_agent_proposal_lifecycle`). The "unapplied" statement above
> reflected the state at authoring time and is **stale**. The 37.11 real-DB
> round-trip is therefore runnable; its own verification remains outstanding.

## 6. Proposal Lifecycle State Machine

`deriveProposalLifecycle(toolName, outputValue)` (`proposal-service.ts`) returns
exactly one state for a `generateWorkflow` result, and `null` for every other
tool or unclassifiable result:

| Executor output | State |
| --- | --- |
| `{ ok: true, proposal }` (schema-valid) | `AWAITING_CRITICALITY` |
| `{ code: "NEEDS_USER_INPUT" }` | `NEEDS_CLARIFICATION` |
| `{ ok: false, code: "INVALID_INPUT" }` | `INVALID` |
| success envelope whose proposal will not parse | `null` (no guess) |
| any other tool / non-object payload | `null` |

Transition targets written elsewhere: `CLARIFICATION_ACCEPTED` (clarification),
`AWAITING_APPROVAL` (criticality), `SUPERSEDED` (worker), and
`APPROVED`/`MATERIALIZED` (later phases).

## 7. Fingerprint and Revision

- **Fingerprint** is `computeProposalCorrelationId(parsedProposal)`, computed
  from the **parsed** proposal so it is byte-identical to the value the
  criticality service re-derives from the transcript. No second algorithm.
- **Revision** is the 1-based rank of the execution among its session's
  `generateWorkflow` executions in deterministic `(createdAt, id)` order; an
  execution not yet in the list ranks last. This makes supersession total and
  reproducible after restart.
- **Trust boundary** — fingerprint and revision are backend-owned; no
  client-supplied userId/orgId/fingerprint/revision/state is trusted.

## 8. Worker Integration (the loop PARKS)

In `tool-worker.ts`, after classification the worker, inside a single
`db.$transaction`, commits:

- first, `persistExecutionOutcome(tx, …)` — a CAS from `RUNNING` that writes,
  **in one update**, `result`, `proposalState`, `proposalFingerprint`,
  `proposalRevision`, and the terminal `status = COMPLETED` (and clears any prior
  `error`). Folding the terminal status into the outcome CAS removes the
  post-transaction window in which a finished execution still looked `RUNNING`.
  A lost CAS short-circuits the rest of the transaction (nothing else is written);
- the tool-result `AgentMessage`;
- `reconcileActiveProposal(tx, …)` when a valid proposal parks (supersession);
- `AGENT_LOOP_REQUESTED` **only** when the result is neither a clarification nor a
  parked proposal.

`completeToolExecution` no longer exists: the terminal status is part of the
outcome CAS, so `generate-workflow.test.ts` no longer asserts a separate call.
The status publish is a best-effort notification awaited **after** the
transaction and outside the failure boundary (see §9a).

## 9. Clarification Persistence

`recordClarificationAnswer(tx, …)` CAS-transitions `NEEDS_CLARIFICATION →
CLARIFICATION_ACCEPTED` and stores `clarificationAnswer`. In
`clarification-service.ts` the CAS runs **first** inside the transaction and
short-circuits: the answer message and the `AGENT_LOOP_REQUESTED` continuation
commit only when it is won. A lost CAS (`!recorded`) commits nothing and returns
`409 CLARIFICATION_NOT_APPLIED`, so a resolved proposal cannot be resurrected by
replaying a transcript that still shows the pending request.

## 9a. Post-Commit Notification (worker)

After the outcome transaction commits, the worker publishes a status signal
(`TOOL_COMPLETED` for a normal completion, `CLARIFICATION_REQUESTED` for a
clarification). That publish is deliberately awaited **after** the failure
boundary and wrapped in its own `try/catch`: it is a UI signal, not domain state.
A transport failure there is logged and ignored, so it can no longer fail the
execution or mark a deliberately parked session as `FAILED`. A genuine failure
**before** the transaction still takes the normal path
(`failToolExecution` + `failAgentSession`).

## 10. Criticality Persistence

`recordCriticalityDecision(tx, …)` CAS-transitions `AWAITING_CRITICALITY →
AWAITING_APPROVAL` and stores `criticalityDecisions`, in the same transaction as
the decision record (`criticality-service.ts`). No companion outbox event, so
recording a decision does not re-enter the model.

## 11. Supersession

`reconcileActiveProposal(tx, { sessionId, executionId, revision })` keeps the
single-pending invariant in **both** write orders: when the arriving proposal is
the newest, it CAS-retires every older pending proposal (`proposalState in
[AWAITING_CRITICALITY, AWAITING_APPROVAL]`) with `proposalRevision < revision`;
when an out-of-order older proposal arrives after a newer one has already parked,
it CAS-retires **itself** (`SUPERSEDED`). It returns `"active"` or
`"superseded"`. Non-pending proposals and other sessions are untouched. It is
called only from the worker's parking transaction.

## 12. Recovery — Reaper Exemption

`redriveStalledSessions` (`reaper.ts`) returns `"waiting"` for a session with
`hasPendingProposal(sessionId)`, alongside `hasPendingClarification`. A parked
proposal's execution is `COMPLETED`, so the in-flight filter cannot see it;
without this check the reaper would re-drive the model and the attempt cap could
fail a correctly-parked session.

## 13. Recovery — Session Read API

`GET /api/agent/session/[sessionId]` derives `pendingProposal` from the
already-fetched execution rows (no second query, no new module import), and each
execution exposes `proposalState` / `proposalFingerprint` / `proposalRevision`.
`executionSelect` in `tool-execution-service.ts` carries the same fields.

## 14. Restart-Survival Argument and Its Limits

The lifecycle lives in the database row, not in live transport or the transcript:
`getPendingProposal` / `hasPendingProposal` answer "is this session parked, on
what, at which revision?" with one indexed query, so a cold restart resumes
without parsing the transcript.

**Limit.** This is proven against an in-memory double, not Postgres. A true
cold-restart-against-Postgres test is owed. Also, the double does not simulate
rollback: it proves the callback *encloses* both writes, not that a
mid-transaction failure would undo the first.

## 15. Test Coverage

New: `src/tests/agent/proposal-lifecycle.test.ts` (**26 tests**):

- Classification: non-proposal tool, valid proposal (+fingerprint equality),
  clarification, `INVALID_INPUT`, unparseable success (→ null), null/non-object.
- Revision: `(createdAt, id)` ordering incl. same-millisecond tie; unknown id
  ranks last.
- `persistExecutionOutcome`: writes all fields from `RUNNING`; lost CAS does not
  overwrite; non-proposal tool leaves state null.
- `reconcileActiveProposal`: a newest proposal retires older pending only; an
  out-of-order older proposal retires itself; non-pending and other sessions are
  untouched.
- `recordCriticalityDecision` / `recordClarificationAnswer`: correct transition +
  payload; CAS loss on the wrong state.
- `getPendingProposal` / `hasPendingProposal`: newest pending by revision;
  ignores non-pending; reads without transcript.
- Worker: valid proposal persists + **no** `AGENT_LOOP_REQUESTED`; a newer
  proposal supersedes an older one; `INVALID` still requests the loop; a
  post-commit notification failure leaves the row `COMPLETED`/parked and does not
  fail the session; a genuine pre-commit executor error still fails both.

Clarification CAS regressions, in `src/tests/agent/missing-input-protocol.test.ts`
(Group C): a won CAS commits answer + lifecycle + continuation together; a lost
CAS returns `409 CLARIFICATION_NOT_APPLIED` and writes nothing; an identical
repeat is idempotent; a resolved proposal cannot be resurrected by replaying a
transcript that still shows the pending request.

Extended: `src/tests/agent/helpers/prisma-double.ts` `matches` now understands
`proposalState` (`in`/eq), `proposalRevision` (`<`), `id: { in }` and `toolName`;
`findFirstExecution` honours `orderBy.proposalRevision`. Without these the
lifecycle tests would pass for the wrong reason.

## 16. Verification Commands and Results

| Command | Result |
| --- | --- |
| `npx jest` (full) | **44 suites / 781 tests passed**, exit 0 |
| `npx jest src/tests/agent` | **27 suites / 474 tests passed**, exit 0 |
| `npx jest src/tests/agent/proposal-lifecycle.test.ts` | 26/26, exit 0 |
| `npx tsc --noEmit` | exit 0 |
| scoped `npx eslint` (changed files) | exit 0 |
| `npx prisma validate` | valid, exit 0 |
| `git diff --check` | clean, exit 0 |

## 17. Boundaries — What 37.8 Does NOT Do

- No approval (`APPROVED` is a state name only; approval is 37.9).
- No `Workflow`/`Task` rows (materialization is 37.11; `sourceProposalId` is
  written by 37.11, not here).
- No UI / review surface (session GET exposure only; review surface 37.9, UI
  representation 37.10).
- No new event type, worker, or resolver change; confirmation mechanism
  (Decision 11/15) is untouched.

## 18. Regression Surface and Known Limitations

Regression surface:

- Worker outcome path unchanged for non-proposals and invalid proposals
  (`generate-workflow.test.ts`, `missing-input-protocol.test.ts` remain green).
- Clarification/criticality services behaviorally unchanged except one extra CAS
  write inside the existing transaction.
- Reaper: one extra read (`hasPendingProposal`); existing exemptions unchanged.

Limitations / open items:

1. No live-database evidence: an initial reachability attempt failed (`P1001`),
   the migration was offline-generated, and a later `prisma migrate status` did
   connect but confirmed the migration is **unapplied**. A
   cold-restart-against-Postgres test is owed.
   - **Update 2026-10-20:** `prisma migrate status` now reports the schema
     up to date — the migration **is applied**. The owed cold-restart/durability
     test is still owed (this is F4), but it is no longer blocked by migration
     state.
2. Supersession concurrency under two simultaneous writers is not proven;
   serialization relies on the existing session lock, not a new advisory lock.
3. F4 remains open.
4. Independent acceptance has not occurred.

## 19. Acceptance Checklist and Recommendation

- [x] F4 decision recorded (plan + Decision Log) with rationale and rejected
      alternatives.
- [x] Separate proposal state machine; execution status unchanged.
- [x] Durable result + fingerprint + revision in the worker transaction.
- [x] Loop parks on a valid proposal (no `AGENT_LOOP_REQUESTED`).
- [x] Durable clarification and criticality decisions.
- [x] Deterministic supersession.
- [x] Reaper exemption + session read exposure.
- [x] Tests, `tsc`, scoped `eslint`, `prisma validate`, `git diff --check` green.
- [ ] **Independent acceptance** — pending (owner: reviewer).
- [ ] **F4 closed** — pending; do not close on this document.
- [ ] Cold-restart-against-Postgres evidence — owed.

**Recommendation.** Submit for independent acceptance. Do **not** mark 37.8
`VERIFIED` and do **not** close F4 until a reviewer accepts, and record the
live-database gap explicitly.
