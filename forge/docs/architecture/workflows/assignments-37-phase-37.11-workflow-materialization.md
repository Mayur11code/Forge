# Assignment 37 — Phase 37.11: Production-Grade Workflow Materialization

```text
Phase:            37.11 — workflow materialization
Status:           IMPLEMENTED (2026-10-20 — submitted for independent acceptance)
Classification:   P2
Depends on:       37.10 IMPLEMENTED (deterministic projection); 37.9 IMPLEMENTED (approval); 37.8 IMPLEMENTED (durable lifecycle, unapplied migration); 37.7 IMPLEMENTED (criticality contract); 37.4 IMPLEMENTED (compiler); 37.0A/37.0B VERIFIED (tenant update, node validation)
Blocks:           37.12 (execution handoff)
Resolves:         F1 (canvas-first persistence), F2 (placeholder provenance/naming)
Writes workflows: Yes — one `Workflow` row, triggerless, inactive
Writes anything:  One `AgentToolExecution.proposalState` CAS (APPROVED → MATERIALIZED) in the same transaction
Runtime changed:  No (no evaluator, no executor, no lock, no queue)
Resolver changed: No
Schema migration: None — uses the existing (UNAPPLIED) 37.8 migration
```

Companion documents: `assignments-37-plan.md` (Phase 37.11, F1/F2),
`assignments-37-tracker.md` (37.11), `assignments-37-issue-register.md` (§5 F1/F2),
[`assignments-37-phase-37.10-ui-graph-projection.md`](./assignments-37-phase-37.10-ui-graph-projection.md),
[`assignments-37-phase-37.9-proposal-review.md`](./assignments-37-phase-37.9-proposal-review.md).

**Status — `IMPLEMENTED`, not `VERIFIED`.** The service, route, session-read
change, UI and their tests are implemented and locally verified; this document is
submitted for independent acceptance. **The real-database round-trip and the
unique-constraint enforcement are OPEN**: the 37.8 migration is still UNAPPLIED
(its own comment records `prisma migrate status` reporting it unapplied). Nothing
here was proven against a live database, and no migration command was run. This
document does not self-accept.

---

## 1. Purpose and Scope

Turn an approved, durably stored `WorkflowProposal` into a persisted Forge
`Workflow`. This is the assignment's core boundary: *the deterministic backend
materializes the proposal and hands it to the existing workflow execution engine.*
Phase 37.11 owns materialization; **37.12 owns the handoff.**

In scope:

- One server-side path `materializeProposal({ sessionId, userId, interactionId })`
  that authorizes the caller, re-derives the proposal from the durable row,
  re-verifies the revision, applies the human's criticality, persists BOTH the
  canonical execution definition and the verbatim 37.10 UI projection, and
  transitions the proposal `APPROVED → MATERIALIZED` — atomically and idempotently.
- A strict ingress `POST /api/agent/session/[sessionId]/proposal-materialize`.
- An additive session-read projection exposing the `MATERIALIZED` outcome and a
  durable `workflowId`.
- UI: an explicit **Create workflow** action and, once materialized, an **Open
  workflow** link.
- Tests: service, route, the persistence boundary, and the card.
- Resolution of F1 and F2.

Explicitly out of scope: executing the materialized workflow, creating a
`WorkflowRun`, enqueuing QStash / `AGENT_LOOP_REQUESTED`, restarting the model
loop, adding a trigger, or any change to the evaluator, executor, lock, compiler,
criticality contract or projection. Those belong to 37.12 and the pre-existing
engine.

## 2. Decisions

- **A — Option B from the audit: one re-parsed proposal feeds two artifacts.**
  `materializeProposal` derives the execution `definition` from the canonical
  compiler with `applyCriticalityDecisions`, and the stored canvas graph from the
  verbatim 37.10 `projectProposalToUIGraph` — both from the SAME re-parsed
  proposal. There is exactly one proposal→UI algorithm and one definition
  compiler; a second copy of either would be free to drift. The two persisted
  artifacts are provably consistent: re-compiling the stored nodes reproduces the
  stored `dependsOn` (proven by the boundary suite).
- **B — CAS first, create second, one transaction.** The proposal is moved
  `APPROVED → MATERIALIZED` with `updateMany({ where: { id, sessionId,
  proposalState: APPROVED }, data: { proposalState: MATERIALIZED } })` BEFORE
  `tx.workflow.create`. A lost CAS (count ≠ 1) means a competing caller already
  advanced the row, and the transaction is abandoned before a workflow exists.
- **C — The unique `sourceProposalId` index is the second defense.** After the CAS,
  `workflow.create` writes `sourceProposalId = AgentToolExecution.id`. The existing
  `@unique` index makes a second insert impossible; a P2002 is resolved to the
  winner's workflow rather than surfaced as an error.
- **D — Triggerless by design (F1).** A proposal carries action steps and no
  human-approved trigger. The materializer stores `eventId: null` / `isActive:
  false` and never inserts a synthetic trigger. This required **no schema change**.
- **E — Provenance and naming (F2).** `Workflow.name` = `proposal.name`;
  `Workflow.description` = `proposal.description ?? null`;
  `Workflow.sourceProposalId` = the durable `AgentToolExecution.id`. The
  compiler's placeholder `definition.id`/`definition.name`, the session id and any
  UI label are never provenance. No new migration was needed — the column existed.
- **F — Explicit human action, not auto-materialization.** Approval does NOT
  create a workflow. The human clicks **Create workflow**; the card never
  optimistically reports success and never advances its own state — a 2xx only
  triggers an authoritative reread.
- **G — `MATERIALIZED` joins the settled READ set only.** It is added at the
  session GET boundary, not to the persisted `SETTLED_PROPOSAL_STATES` — a decision
  being "over" (37.8) and a workflow existing (37.11) are different questions.

## 3. Materialization Contract

```text
materializeProposal({ sessionId, userId, interactionId })
  → { ok: true,  sessionId, workflowId, state: "MATERIALIZED", idempotent? }
  | { ok: false, httpStatus: 400 | 404 | 409, code, error }
```

Order of checks, and each step's owner:

1. **Shape** (400) — a non-empty `interactionId` string.
2. **Ownership** (404) — `getAgentSessionForUser({ sessionId, userId })`; the
   session id in the URL is a lookup key, never authorization. The org is taken
   from the persisted `AgentSession.orgId`, never the client.
3. **Under the session lock** (`withAgentSessionLock`):
   - Load the proposal via `getProposalReviewExecution` (scoped to session +
     `generateWorkflow`); absent ⇒ 404.
   - `proposalFromExecutionResult` (37.4/37.9); not a proposal ⇒ 409
     `NOT_A_PROPOSAL`.
   - Re-derive `computeProposalCorrelationId` and compare to the stored
     `proposalFingerprint`; mismatch ⇒ 409 `REVISION_MISMATCH` (null stored
     fingerprint is a legacy row and is still guarded by the CAS).
   - Lifecycle: only `APPROVED` may materialize. `MATERIALIZED` resolves
     idempotently or fails `MATERIALIZED_WITHOUT_WORKFLOW`; `DECLINED` / `EXPIRED`
     / `SUPERSEDED` / `INVALID` / awaiting states return their own 409 codes.
   - Existing workflow for this source ⇒ return it idempotently and repair the
     lifecycle with the same CAS.
   - `expectValidMaterializationPayload(proposal, target.criticalityDecisions)` —
     validate the exact, complete criticality set against THIS revision and apply
     it to the canonical definition.
   - `projectProposalToUIGraph(proposal, decisions)` (37.10, unstubbed) and
     `validateWorkflowGraphForPersistence` (shared `IncomingNodesSchema` /
     `IncomingEdgesSchema`) — a failure is surfaced, not papered over.
   - `db.$transaction`: CAS then `workflow.create`, `select: { id: true }`.

A `null` return from `withAgentSessionLock` is `SESSION_BUSY` (409).

### Duplicate / conflict / recovery matrix

| Situation | Path | Outcome |
| --- | --- | --- |
| Repeat after success | state `MATERIALIZED`, matching workflow in org | 200, `idempotent`, same `workflowId` |
| Retry while still `APPROVED` but a workflow exists | recover existing, CAS repair | 200, `idempotent` |
| `MATERIALIZED` with no matching workflow | consistency failure | 409 `MATERIALIZED_WITHOUT_WORKFLOW` |
| `MATERIALIZED`, matching workflow in a DIFFERENT org | org-scoped read misses | 409 `MATERIALIZED_WITHOUT_WORKFLOW` |
| Competing caller, CAS lost | `count ≠ 1`, tx abandoned | resolve winner ⇒ 200 `idempotent`, else 409 |
| Competing caller, CAS won but insert collides | P2002 on `sourceProposalId` | resolve winner ⇒ 200 `idempotent` |

## 4. What Is Persisted

| Column | Value | Why |
| --- | --- | --- |
| `name` | `proposal.name` | the human-facing name (F2) |
| `description` | `proposal.description ?? null` | preserved |
| `orgId` | `session.orgId` (persisted) | tenant scope, never client-supplied |
| `uiNodes` | verbatim 37.10 `projection.uiNodes` | one projection algorithm |
| `uiEdges` | verbatim 37.10 `projection.uiEdges` | edges from `dependsOn` alone |
| `definition` | `expectValidMaterializationPayload(...).definition` | canonical compiler + applied criticality |
| `eventId` | `null` | triggerless (F1) |
| `isActive` | `false` | no trigger ⇒ inactive |
| `sourceProposalId` | `AgentToolExecution.id` | durable provenance; `@unique` duplicate defense |

`definition.id` / `definition.name` remain the compiler's placeholders
(`"proposal"` / `"Compiled Execution Graph"`); identity is the `Workflow.id` and
provenance is `sourceProposalId`. This is deliberate and matches F2.

## 5. The Ingress

```text
POST /api/agent/session/[sessionId]/proposal-materialize
body (strict): { interactionId: string }          ← the ONLY client field
```

`auth()` → 401 without a user. The body is `.strict()`, so `orgId`, `workflowId`,
proposal content, graph, fingerprint and criticality are all 400 — a client cannot
name a tenant or a target. On success the route returns
`{ sessionId, workflowId, state, status: "MATERIALIZED", idempotent? }`; a service
failure maps to its `httpStatus` and `code`.

## 6. Session Read and UI

- `src/app/api/agent/session/[sessionId]/route.ts`: the reviewed-proposal filter
  now includes `MATERIALIZED` (added at the READ boundary, not to
  `SETTLED_PROPOSAL_STATES`), and `proposalOutcome` gains an additive
  `workflowId`, resolved read-only via `findMaterializedWorkflowIdForSource(orgId,
  executionId)`. A `MATERIALIZED` row with no resolvable workflow reports
  `workflowId: null` — never presented as a successful creation.
- `ProposalReviewCard.tsx`: the APPROVED banner becomes an explicit **Create
  workflow** action — locked in flight, no optimistic success, conflict triggers a
  reread. In `MATERIALIZED` it shows an **Open workflow** link built from the
  server-supplied org slug and durable `workflowId` only when both are present, and
  otherwise a "find it in your workflows" note.
- `WorkflowProposalPanel.tsx`: passes `workflowId`, `orgSlug` and `onMaterialized`
  (a nonce bump) to the outcome card.

## 7. Test Coverage

| Suite | Tests | Subject |
| --- | --- | --- |
| `src/tests/agent/proposal-materialization.test.ts` (new) | 33 | authorization/ownership; happy path incl. name/description/provenance/triggerless/definition; exact 37.10 projection equality; revision mismatch + legacy null fingerprint; criticality missing/extra/non-boolean/null; lifecycle eligibility table; idempotency, `MATERIALIZED_WITHOUT_WORKFLOW`, cross-org miss; lost CAS; P2002 collision; no outbox side effect |
| `src/tests/agent/proposal-materialize-route.test.ts` (new) | 17 | 401 unauthenticated; strict body (missing/malformed/empty/extra/`workflowId`/`uiNodes`); result→status mapping incl. 500 |
| `src/tests/agent/proposal-materialization-boundary.test.ts` (new) | 10 | the projection survives the REAL `IncomingNodes`/`EdgesSchema`; re-compiling the STORED nodes reproduces the canonical `dependsOn`/action/config/isCritical; triggerless accepted; boundary rejections |
| `src/tests/agent/proposal-review-card.test.tsx` (extended) | +9 | Create workflow POST body/states; no fabricated MATERIALIZED; failure + conflict handling; Open workflow link gated on slug+id |
| `src/tests/agent/session-read.test.ts`, `workflow-proposal-panel.test.tsx` (extended) | — | MATERIALIZED outcome exposed; panel wiring unchanged behaviour |

The service double (`src/tests/agent/helpers/prisma-double.ts`) gained a `workflow`
delegate that models the two properties correctness rests on: the `@unique`
`sourceProposalId` (throws P2002) and the org-scoped read. A double that ignored
either would let the duplicate and cross-tenant cases pass for the wrong reason.

## 8. Verification Commands and Results

```text
npx jest <4 new/extended suites>        PASS (33 / 17 / 10 / +9)
npx jest                                PASS — 56 suites / 1074 tests
npx tsc --noEmit                        0 errors                PASS
npx eslint <changed + new files>        0 warnings/errors       PASS
npx prisma validate                     schema valid            PASS
git diff --check                        no whitespace errors    PASS (only autocrlf notices)
```

No `prisma migrate` command was run; no database was contacted. The test suite runs
at the mocked boundary and `jest.setup-db-guard.ts` fails any real connection.

## 9. Migration Safety

- **No new migration.** 37.11 reads/writes `Workflow.sourceProposalId` and the
  `AgentProposalState.MATERIALIZED` enum value, both of which already exist in
  `prisma/schema.prisma` and in the UNAPPLIED migration
  `20261017120000_agent_proposal_lifecycle`. Creating another would duplicate it.
- **The migration is still UNAPPLIED.** `sourceProposalId`, its unique index, its
  FK and the enum value exist only in the migration file, not necessarily in any
  database. Source-file presence is not rollout proof.
- Consequently, **the real-DB round-trip and the unique-constraint enforcement are
  unverified.** They are named as open acceptance gates and were deliberately not
  exercised against a shared or production database.

## 10. Boundaries — What 37.11 Does NOT Do

- Does **not** execute the workflow: no `WorkflowRun`, no QStash / outbox enqueue,
  no `AGENT_LOOP_REQUESTED`, no model-loop restart or resume. That is 37.12.
- Does **not** insert a synthetic trigger, and does not alter the evaluator,
  executor, lock or queue.
- Does **not** add a second compiler, validator, projection, transition rule or
  lock. The compiler is 37.4, the criticality contract is 37.7, the projection is
  37.10, the boundary schemas are 37.0B's.
- Does **not** touch 37.6–37.10 behaviour, routes, schemas or lifecycle rules;
  their suites are unmodified and green.
- Does **not** weaken or work around I6, does not address F4, and does not claim
  cold-restart or multi-process verification.
- Does **not** stage or commit anything.

## 11. Known Risks and Open Gates

- **Real-DB acceptance is OPEN.** The migration is unapplied; the unique index and
  the transaction's rollback are properties of Postgres, not of the double.
- **F1/F2 resolved by construction, not by live evidence.** The design avoids any
  schema change and any new path, but "no schema change needed" was argued from the
  code, not observed on a database.
- **`MATERIALIZED` is exposed only at the read boundary.** If a future write path
  ever consults `SETTLED_PROPOSAL_STATES` to decide materializability, the two must
  not be conflated — the reason for keeping them separate is documented inline.
- **I6 remains the only open P0** and still gates 37.12. This phase does not
  execute anything, so it is not gated by I6.

## 12. Acceptance Checklist and Recommendation

- [x] An approved proposal materializes into exactly one `Workflow`; a repeat
      creates nothing and returns the same id.
- [x] Transition is atomic (CAS before create in one transaction) and idempotent;
      the CAS-lost and P2002 paths resolve to the winner.
- [x] Definition is the canonical compiler output with the human's exact
      criticality; UI graph is the verbatim 37.10 projection; both pass the shared
      boundary; re-compiling the stored nodes reproduces the stored `dependsOn`.
- [x] Provenance is the durable `AgentToolExecution.id`; name is `proposal.name`;
      no placeholder is provenance.
- [x] Triggerless storage (`eventId: null` / `isActive: false`); no synthetic
      trigger; no schema change; no new migration.
- [x] Ingress is auth-gated, strict, org-from-session; `MATERIALIZED` and
      `workflowId` are exposed additively and read-only.
- [x] UI has an explicit Create workflow action (no optimistic success) and an
      Open workflow link gated on slug + durable id.
- [x] No execution, no run, no enqueue, no loop restart.
- [x] 56 suites / 1074 tests; tsc, eslint, `prisma validate`, `git diff --check`
      clean.
- [ ] **Real-database round-trip and unique-constraint enforcement (OPEN — 37.8
      migration unapplied).**
- [ ] Independent acceptance (out of this document's hands).

**Recommendation:** record 37.11 in the tracker as `IMPLEMENTED` pending
independent verification; do not mark `VERIFIED`; treat the real-DB round-trip as
an open gate tied to the 37.8 migration; do not begin 37.12.
