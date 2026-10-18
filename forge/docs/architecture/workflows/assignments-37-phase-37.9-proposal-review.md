# Assignment 37 — Phase 37.9: Human Proposal Review

```text
Phase:            37.9 — Human review / approve / decline / expiry
Status:           IMPLEMENTED (2026-10-18 — submitted for independent acceptance)
Classification:   P1
Depends on:       37.8 IMPLEMENTED (durable proposal lifecycle; F4 open); 37.7 IMPLEMENTED (human criticality); 35/36 IMPLEMENTED (tool confirmation — unchanged)
Blocks:           37.10 (UI representation), 37.11 (materialization)
Resolves:         — (decision recorded in Decision 23; no issue closed)
Writes workflows: No
Writes anything:  Sets AgentToolExecution.proposalState to APPROVED / DECLINED / EXPIRED; writes one audit AgentMessage per decision (none on expiry)
Runtime changed:  No
Resolver changed: No
Schema migration: Amended in place on the unreleased 37.8 migration; NOT applied
```

Companion documents: `assignments-37-plan.md` (Phase 9),
`assignments-37-tracker.md` (37.9), `assignments-37-issue-register.md`,
`../agent/decisions.md` (Decision 23),
[`assignments-37-phase-37.8-proposal-lifecycle.md`](./assignments-37-phase-37.8-proposal-lifecycle.md).

**Status — `IMPLEMENTED`, not `VERIFIED`.** Phase 2 of 37.9 is implemented and
locally verified; it is submitted for independent acceptance. **F4 remains
open.** This document does not self-accept.

---

## 1. Purpose and Scope

Give the human the last checkpoint before materialization: review the parked
proposal, approve it or decline it, and have an unanswered review close itself
without wedging the session. This is the "review surface" of plan Phase 9 plus
the mechanism that plan Phase 9 wrongly believed already existed.

In scope:

- A **proposal-specific** decision ingress: `proposal-approval` and
  `proposal-decline` endpoints over one shared service.
- The two terminal human outcomes, `APPROVED` and `DECLINED`, as compare-and-set
  transitions from `AWAITING_APPROVAL`, recorded with a self-describing audit
  line.
- Review **expiry**: a deadline stamped when a proposal enters
  `AWAITING_APPROVAL`, and a maintenance sweep that closes an overdue review to
  `EXPIRED` silently.
- Expose the pending review and the terminal outcome on the session read
  endpoint, and render it with a self-contained review card.
- Tests for each of the above, plus regression protection for the untouched
  35/36 tool-confirmation machinery.

Explicitly out of scope (deferred): materializing an approved proposal (37.11),
the full UI representation (37.10), and any change to tool-confirmation
semantics.

## 2. Decisions (owner A / B / C)

Recorded in full in [Decision 23](../agent/decisions.md). In brief:

- **A — a new ingress, not the tool gate.** The 35/36 confirm endpoint is bound
  to `PENDING_CONFIRMATION`; a proposal's `generateWorkflow` execution is already
  `COMPLETED`. Confirming it through the tool gate would queue a second
  execution of a tool that already ran. Approval/decline therefore get their own
  endpoints and their own service, reusing the *patterns* (ownership, lock,
  backend re-derivation, fingerprint binding, CAS, idempotency, audit) but not
  the tool endpoint. Tool-confirmation code is unchanged.
- **B — `DECLINED` is a first-class terminal state.** No workflow, no action, no
  `AGENT_LOOP_REQUESTED`; the loop is not re-entered.
- **C — review expiry is a sibling sweep, not the approval sweep.** A tool
  approval expiring *continues the loop*; a proposal review expiring is a silent
  terminal transition that writes no transcript line. New terminal state
  `EXPIRED`, distinct from `DECLINED` and from cancellation.

## 3. Endpoints and Request Contract

```text
POST /api/agent/session/[sessionId]/proposal-approval   -> approve
POST /api/agent/session/[sessionId]/proposal-decline    -> decline
Body (both, .strict()): { "interactionId": "<AgentToolExecution.id>" }
```

Both routes are thin: authenticate, parse the body with a closed schema, call
`submitProposalDecision`, and map the result. Success is `200`:

```json
{ "sessionId": "...", "step": 3, "state": "APPROVED", "status": "ACCEPTED",
  "idempotent": true }
```

Failure is `{ "error": "...", "code": "<CODE>" }` at `400` (bad body), `404`
(unknown/foreign session or proposal), or `409` (every other conflict). The
client never sends a revision; it sends only `interactionId`.

## 4. Service — Order of Checks

`submitProposalDecision` (`proposal-decision-service.ts`) resolves in this order,
and the order is the contract:

1. **Shape (400).** `decision` must be `APPROVED`/`DECLINED`; `interactionId`
   must be a non-empty string. No lock is taken for a malformed request.
2. **Ownership (404).** `getAgentSessionForUser` — a session id in the URL is a
   lookup key, never authorization.
3. **Liveness (409).** The session must be `RUNNING`.
4. **Lock.** `withAgentSessionLock`; not acquired → `SESSION_BUSY`. This is what
   serialises a decision against a worker and against a second decision.
5. **Resolve the proposal.** `getProposalReviewExecution`; missing → `404`. The
   execution must be `COMPLETED` and its persisted `result` must re-parse as a
   proposal, else `NOT_A_PROPOSAL`.
6. **Bind the revision.** `computeProposalCorrelationId` is recomputed on the
   backend from the persisted proposal and compared with the stored
   `proposalFingerprint`; a mismatch is `REVISION_MISMATCH`. A `null` stored
   fingerprint is a legacy row: nothing to compare, and the state CAS still
   guards the transition.
7. **Classify from durable state.** See §5.
8. **CAS first, audit second, one transaction.** `recordProposalDecision` then
   `createMessage`. A lost CAS commits no transcript line.

## 5. Idempotency and Conflict Classification

Every branch is resolved from the durable row, never from the request and never
from an in-memory marker:

| Row state / condition | Result |
| --- | --- |
| already equals the requested decision | `200` `{ idempotent: true }`, no write |
| `AWAITING_CRITICALITY` | `409 NEEDS_CRITICALITY` |
| `EXPIRED` | `409 PROPOSAL_EXPIRED` |
| other terminal (`APPROVED`/`DECLINED`) | `409 PROPOSAL_ALREADY_DECIDED` |
| superseded / materialized / invalid / null legacy | `409 PROPOSAL_NOT_AWAITING_APPROVAL` |
| lost CAS | `409 PROPOSAL_NOT_APPLIED` |
| lock not acquired | `409 SESSION_BUSY` |
| session not `RUNNING` | `409 SESSION_NOT_RUNNING` |
| result is not a proposal | `409 NOT_A_PROPOSAL` |
| fingerprint mismatch | `409 REVISION_MISMATCH` |
| malformed body | `400 INVALID_REQUEST` |

The audit line is tagged `AgentMessage.toolCallId = interactionId`, content
`PROPOSAL_DECISION_MARKER = "forge:proposal-decision:v1"` plus `interaction`,
`proposal` fingerprint, `revision`, and `decision: approved|declined`. It is
deliberately distinct from the criticality marker and clarification text even
though they share the `toolCallId` tag.

## 6. Review Expiry

- **Deadline.** `recordCriticalityDecision` stamps
  `expiresAt = now + getAgentApprovalTimeoutMs()` in the **same** CAS that enters
  `AWAITING_APPROVAL`, so review expiry and tool-approval expiry cannot drift.
- **Sweep.** `expireStaleProposalReviews` in `reaper.ts` selects due candidates
  (`AWAITING_APPROVAL` AND `expiresAt <= now`) via
  `findDueProposalReviewCandidates`, then CASes each to `EXPIRED` with
  `expiredAt = now`. `expiresAt: null` is never due. It runs as the sixth duty of
  the maintenance worker (`agent-maintenance/am.ts`), reported as
  `MaintenanceSummary.proposalReviews`. No new scheduler, no outbox event, and
  **no transcript line** — the durable state is the record.
- **Race.** A decision and a sweep that overlap are serialised by the CAS. The
  state predicate makes it a CAS (two passes cannot both claim one proposal);
  the `expiresAt` predicate means nothing is expired early. A human who decided
  just before the sweep wins, and the sweep counts that candidate as *skipped*,
  not expired.
- **Stalled-session exemption (addition beyond the literal deliverable).**
  `redriveStalledSessions` already parked a session holding a *pending*
  proposal. A decided/expired proposal is no longer pending, so a new
  `hasSettledProposal` check keeps such a session from being re-driven by the
  10-minute stall timer. It is grouped with the existing `waiting` outcome; only
  the reason differs. This guard is called out because it is not literally in
  the 37.9 scope line.

## 7. Read Projection and UI

- `proposal-review.ts` is a pure, client-safe projection:
  `buildProposalReviewModel` (workflow name from `proposal.name` — **not**
  `definition.name`, per F2) and a deterministic Kahn `orderProposalSteps`.
- The session GET (`session/[sessionId]/route.ts`) gains: a
  `buildReviewForExecution` helper over the selected `settledProposalExecution`;
  `pendingProposal` extended with `expiresAt` and `review`; and a top-level
  `proposalOutcome` for the terminal case (`decidedAt = expiredAt ?? updatedAt`).
- `ProposalReviewCard.tsx` (`src/features/organizations/components/ai/`) is a
  self-contained client leaf over that payload: it renders the review, shows
  Approve/Decline only while `AWAITING_APPROVAL`, shows terminal banners
  otherwise, surfaces errors, and calls a `onDecided` callback. It posts to
  `proposal-approval` / `proposal-decline`.
- **Why a card and not a page.** The agent subsystem is API-only: no client
  creates agent sessions (`/api/chat` is the RAG path and does not), so there is
  nowhere to mount the card yet. It is delivered as a leaf so it can be wired
  once an agent-session client exists; wiring it into `ChatWorkspace` would mean
  faking a session. That is 37.10's concern, not 37.9's.

## 8. Schema and Migration

The `20261017120000_agent_proposal_lifecycle` migration is committed but
**unapplied and unreleased**, so it was amended in place rather than chained:
`DECLINED` and `EXPIRED` added to `AgentProposalState`, and
`@@index([proposalState, expiresAt])` added (with the matching index in the SQL).
`npx prisma validate` passes. **The migration is applied to no database.**

## 9. Test Coverage

New suites (Assignment 37.9):

| Suite | Tests | Subject |
| --- | --- | --- |
| `proposal-decision.test.ts` | 19 | shape, ownership/liveness, resolution, fingerprint binding, idempotency/conflict, CAS + audit, no outbox |
| `proposal-approval-route.test.ts` | 44 | both endpoints (`describe.each`): auth, strict body, error mapping, success shapes, 500 |
| `proposal-review-expiry.test.ts` | 25 | deadline stamp, approve/decline CAS, expiry CAS, candidate selection, `hasSettledProposal`, sweep incl. skipped/error/bounds, stalled-session exemption + control |
| `proposal-review-model.test.ts` | 12 | pure projection + Kahn ordering |
| `proposal-review-card.test.tsx` | 13 | jsdom/RTL: render, Approve/Decline visibility, POST target, terminal banners, errors, `onDecided` |
| `session-read.test.ts` (extended) | 12 | proposal-review projection (null cases, unparseable result, pending, decided-as-outcome, EXPIRED dated by `expiredAt`, deadline exposure) |
| `maintenance.test.ts` (extended) | 18 | sixth duty wiring, `proposalReviews` summary |

## 10. Verification Commands and Results

```text
npx jest                                49 suites / 911 tests   PASS (0 fail)
npx tsc --noEmit                        0 errors                PASS
npx eslint <changed+new source>         0 warnings/errors       PASS
npx prisma validate                     schema valid            PASS
git diff --check                        no whitespace errors    PASS (only autocrlf notices)
```

Non-vacuity mutations (each applied to source, failing test confirmed, then
reverted):

| Mutation | Test that failed |
| --- | --- |
| fingerprint binding neutered | `REVISION_MISMATCH` (1 fail) |
| `expiresAt` predicate removed from expiry CAS | both `never expires …` guards (2 fail) |
| `APPROVED`/`DECLINED` terminal branch removed | `PROPOSAL_ALREADY_DECIDED` (1 fail) |

Each mutation made its intended test fail and nothing else; all were reverted and
the affected suites re-run green.

## 11. Boundaries — What 37.9 Does NOT Do

- Does not apply the migration to any database.
- Does not materialize an approved proposal (37.11) and does not create a
  Workflow, a `Task`, or any action execution.
- Does not re-enter the model on any decision (no `AGENT_LOOP_REQUESTED`).
- Does not change tool-confirmation semantics, the confirm endpoint, cancel, or
  tool-approval expiry. The 35/36 suites are untouched and pass.
- Does not add a review page or an agent-session client.

## 12. Regression Surface and Known Limitations

- **No live-database evidence.** The in-memory double simulates *enclosure*
  only; it has no rollback injection, so "CAS and audit commit atomically"
  remains a property of the real database that the double cannot prove. The
  migration is unapplied. A cold-restart-against-Postgres test is owed and is
  named here.
- **Concurrency is reasoned, not multi-process tested.** The session lock and the
  CAS serialise the realistic races (decision vs. worker, decision vs. sweep,
  sweep vs. sweep), and each is tested single-process; no cross-process test
  exists, and no new lock order was introduced.
- **Legacy rows.** A proposal written before `proposalFingerprint` existed has a
  `null` fingerprint, so revision binding is skipped for it and only the state
  CAS guards the transition. This is intentional (no false mismatch) and covered
  by a test.
- **F4 is not closed.** This document and its implementation are evidence for
  acceptance; they are not acceptance.

## 13. Acceptance Checklist and Recommendation

- [x] Proposal-specific approve/decline ingress; tool gate untouched.
- [x] `DECLINED` and `EXPIRED` terminal states; no workflow, no action, no loop
      re-entry.
- [x] Review deadline stamped in the criticality→approval CAS; silent expiry via
      the maintenance reaper; settled-proposal stall exemption.
- [x] Session read exposes pending review and terminal outcome; card renders it.
- [x] 49 suites / 911 tests pass; tsc, eslint, prisma validate, diff --check
      clean; three non-vacuity mutations confirmed and reverted.
- [ ] Independent acceptance (out of this document's hands).
- [ ] Live-database / cold-restart verification (owed).

**Recommendation:** accept into the 37.9 tracker as `IMPLEMENTED` pending
independent verification; do not mark `VERIFIED`, do not close F4, and do not
apply the migration as part of this phase.

---

## 14. Addendum — 37.9.1 Human-Input UI surface (2026-10-19)

**Status: `IMPLEMENTED`, not `VERIFIED`.** The backend of 37.9 shipped a
`ProposalReviewCard` but, as §7 recorded, *nothing mounted it* — the agent
subsystem was API-only, so the proposal lifecycle could not be exercised through
the product without manual API calls. This addendum closes that gap: it adds the
client surface that drives the **existing** 37.6 clarification and 37.9 approval
contracts and adds the missing 37.7 criticality controls to the review card. No
service, route, migration, or lifecycle rule was changed.

### 14.1 What was added

| File | Change |
| --- | --- |
| `src/features/organizations/components/ai/WorkflowProposalPanel.tsx` | **New.** Workflow-builder surface: starts one agent session via `POST /api/agent/init`, then polls the authoritative `GET /api/agent/session/[sessionId]` until the server parks the session; mounts the review card or the clarification card. |
| `src/features/organizations/components/ai/ClarificationRequestCard.tsx` | **New.** Answers the pending `NEEDS_USER_INPUT` request over the existing clarification endpoint. |
| `src/features/organizations/components/ai/ProposalReviewCard.tsx` | **Extended.** Per-step criticality radio controls while `AWAITING_CRITICALITY`; `onCriticalitySubmitted` callback. Existing approve/decline behaviour unchanged. |

### 14.2 Authority rules preserved

The surface is deliberately a thin client over the existing APIs and does not
re-implement any lifecycle rule:

- **One session, only on submit.** A session is created only by
  `POST /api/agent/init` in response to an explicit user submit. Every other
  operation is a `GET`; a page reload rereads the stored session (per-org
  `localStorage`) and never forks a second session.
- **No fabricated state.** After a 2xx criticality or clarification submit, the
  card locks its controls and asks the panel to reread authoritative state. It
  never sets `AWAITING_APPROVAL` locally and never claims the agent has resumed —
  the session read reports the new state.
- **Remount per authoritative state.** The review card is keyed by
  `${interactionId}:${state}` so a stale local decision cannot survive into the
  next server-reported state; the clarification card is keyed by
  `${interactionId}:${correlationId}`.
- **Poll only while unsettled.** A `setTimeout` chain (not `setInterval`) stops on
  any pending proposal, pending clarification, terminal proposal outcome, or a
  non-`RUNNING` session, so a slow response cannot stack requests.

### 14.3 Request contracts (exact)

```text
POST /api/agent/session/[sessionId]/criticality
Body: { "interactionId": "<AgentToolExecution.id>",
        "decisions": { "<localRef>": true|false, ... } }   // one entry per step

POST /api/agent/session/[sessionId]/clarification
Body: { "interactionId": "<AgentToolExecution.id>",
        "correlationId": "<proposal-revision fingerprint>",
        "answers": { "<field path>": <value>, ... } }      // one entry per pending field
```

Both are sent with no fingerprint/revision on the criticality route (the service
recomputes it) and the clarification `correlationId` exactly as projected by the
session read. A conflict (`409`) on either route triggers a reread rather than an
in-place retry; `SESSION_BUSY` is retryable in place and therefore not a reconcile
code on the clarification card.

### 14.4 Test Coverage (additions)

| Suite | Tests | Subject |
| --- | --- | --- |
| `proposal-review-card.test.tsx` (extended) | 19 | criticality groups per step, incomplete-set submission blocked, exact POST body, no fabricated approval + reread, validation error keeps controls, `409` reconcile |
| `clarification-request-card.test.tsx` (new) | 11 | render, select vs text field, completeness validation, exact POST body, candidate value, duplicate-submit prevention, success/reread, validation error, stale reconcile, transport failure |
| `workflow-proposal-panel.test.tsx` (extended) | 15 | full criticality → reread → approval flow, reload restores pending criticality, clarification answer → reread → resume, reload restores the same clarification, terminal outcome after refresh, no duplicate session |

### 14.5 Verification Commands and Results

```text
npx jest src/tests/agent/proposal-review-card.test.tsx       19 passed
npx jest src/tests/agent/clarification-request-card.test.tsx 11 passed
npx jest src/tests/agent/workflow-proposal-panel.test.tsx    15 passed
npx jest src/tests/agent                                   34 suites / 647 tests  PASS
npx jest (full suite)                                      51 suites / 954 tests  PASS
npx tsc --noEmit                                           0 errors              PASS
npx eslint <changed/new files>                             0 warnings/errors     PASS
npx eslint (repo)                                          0 errors / 29 pre-existing warnings
npx prisma validate                                        schema valid          PASS
git diff --check                                           no whitespace errors  PASS (only autocrlf notices)
```

### 14.6 Boundaries — What 37.9.1 Does NOT Do

- Does not create a `Workflow`, a `Task`, or run any action: an approved proposal
  still materializes nothing (that is 37.11).
- Does not re-enter the model on any decision (no `AGENT_LOOP_REQUESTED`).
- Does not change any service, route, schema, migration, or lifecycle rule; it
  consumes the 37.6/37.7/37.9 contracts as-is.
- Does not implement the deterministic graph projection / layout (37.10) — the
  review card renders the linear review model only.

### 14.7 Known Limitations

- **No live end-to-end evidence in this addendum.** The panel and cards are
  covered by jsdom/RTL tests against a mocked `fetch`; the authoritative reread
  and session idempotency are asserted at the request/response boundary, not
  against a running server in this change.
- **Manual API verification was performed earlier against a real session** during
  37.9 (session `cmve7kue90000qsgc6oci5tnq`, proposal `cmve7mxjr0008qsgcrpltquka`,
  `proposalState=APPROVED`, `materializedWorkflows=0`); the UI path exercises the
  same endpoints but has not yet been driven against that live session.
- **F4 remains open**, and this addendum is not acceptance of 37.9.

### 14.8 Status History

| Date | Status | Change | Evidence |
| --- | --- | --- | --- |
| 2026-10-19 | IMPLEMENTED | Added the human-input UI surface (workflow-builder panel, clarification answer card, per-step criticality controls) over the existing 37.6/37.7/37.9 contracts, with mocked-boundary tests | 3 focused suites (19/11/15); agent 34 suites / 647; full 51 suites / 954; tsc exit 0; eslint 0 on changed files; `prisma validate` valid; `git diff --check` clean |
