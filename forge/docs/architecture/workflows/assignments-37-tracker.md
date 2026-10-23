# Assignment 37 — Master Phase Tracker

```text
Last Updated:     2026-10-23
Current Phase:    37.16 (37.0, 37.0A, 37.0B, 37.1-37.15 VERIFIED; 37.16 NOT_STARTED)
Overall Status:   READY (I6 plus 37.4/37.5, 37.7-37.15 VERIFIED; 37.15 verified, all gates passed for 37.16)
Next Action:      Begin Phase 37.16 (live capstone verification) against live infrastructure.
```

> **37.11 / 37.12 / 37.13 VERIFIED 2026-10-23 (verification pass).** The
> verification gates were completed against the current source and the real
> database, not inferred from a green overall suite. 37.13's prompt was reviewed
> against the real `ActionCapabilities` / `ActionRegistry` surface (only
> `task.create`, matching inputs/outputs), and `prompt-dag-planning.test.ts`
> passed 29/29. 37.12's handoff suites passed (mocked 29/29 across four suites,
> real-PostgreSQL handoff 5/5, I6 real-PostgreSQL 10/10) and the assembled-engine
> diamond suite passed 9/9; the real-DB handoff suite mocks `advanceWorkflow`, so
> it proves run creation and tenant scope, not live QStash dispatch. 37.11 now
> has a real-PostgreSQL acceptance suite
> (`src/tests/agent/proposal-materialization.realdb.test.ts`, 11/11) covering the
> round trip (materialize -> load -> recompile), provenance surviving a real
> canvas re-save, transaction rollback on the unique index, concurrency,
> idempotency and tenant isolation. Real execution dispatch remains a 37.15/37.16
> concern and is not claimed here. See the Verification Ledger rows dated
> 2026-10-23.

> **I6 VERIFIED 2026-10-20 (real-database acceptance).** The cross-tenant
> *execution* entrypoint is fixed and now has real-PostgreSQL evidence: a new
> suite (`src/tests/security/i6-cross-tenant.realdb.test.ts`, 10/10) runs the
> real Prisma client and the real `getOrgAccess`/`startWorkflow` against the
> configured database, proving an org-A caller cannot start org B's workflow,
> that no `WorkflowRun` row is created, that foreign and missing are
> indistinguishable, and the same-org positive path still builds a `RUNNING` run.
> The prior mocked-only state was **not** sufficient for Gate G; this run is.
> `advanceWorkflow` is mocked so no QStash/Redis/action side effects fire, and
> fixtures are removed with a verified zero-leftover check. See
> `docs/dev-log/2026-10-20-i6-real-db-acceptance.md`.
>
> **I2 closed 2026-09-30.** Phase 37.0B is **VERIFIED**: node `data` is validated
> against `TriggerNodeDataSchema` / `ActionNodeDataSchema` on **both** save paths,
> and the validated value is what gets compiled and persisted. Gate F is
> satisfied.

> **37.1 VERIFIED 2026-10-01.** F3 and I4 are **CLOSED**: one client-safe
> capability catalog, total over the runtime registry, with `task.create`
> corrected and `comment.add` removed from the picker. AD-P1 decided. **I7
> recorded** (conditional routing not executable/authorable end-to-end) — a
> non-blocking scope decision, not an implementation task. See
> `assignments-37-phase-37.1-capability-catalog.md`.

> **37.2 VERIFIED 2026-10-12.** `WorkflowProposal` schema and
> `validateWorkflowProposal` implemented, client-safe, with structured issue
> codes. Unit tests green (45 cases; full run 32 suites / 535 tests; `tsc` clean).
> Resource bounds hardened: depth is now checked by a bounded, non-recursive
> traversal **before** serialization, an oversized proposal short-circuits before
> action validation, and a non-serializable input becomes a structured issue
> rather than a thrown error. The earlier `PARTIALLY_VERIFIED` note cited a
> real-model-path parse clause; that clause is **reassigned to 37.5**, which owns
> `generateWorkflow`, and is relocated, not waived. **I4 is now enforced** at the
> generation boundary. See
> `assignments-37-phase-37.2-workflow-proposal-schema.md`.

> **37.3 VERIFIED 2026-10-12.** **F6 CLOSED.** A pure, read-only reference
> validator over `WorkflowProposal` reuses the resolver's `{{…}}` grammar and
> rejects unordered data references with `MISSING_DATA_DEPENDENCY`, alongside
> source-existence, output-path, scope and prototype-path checks. 44 focused
> tests (full run 33 suites / 579 tests; `tsc` clean); `resolver.ts` is
> **unmodified**. Trigger output fields fail closed (no authoritative contract).
> See `assignments-37-phase-37.3-reference-validator.md`.

> **37.4 IMPLEMENTED 2026-10-12 — not VERIFIED.** The deterministic proposal →
> `WorkflowDefinition` compiler composes structure, reference and graph-semantic
> validation into one boundary returning structured `ProposalIssue[]` (25 tests).
> **F5 CLOSED, AD-P4 resolved** (`collectWorkflowDefinitionIssues` is the canonical
> gate; `WorkflowDefinitionSchema` remains the runtime read-boundary validator). It
> was left un-integrated (no production caller) until 37.5, which is why it never
> earned `VERIFIED`. See `assignments-37-phase-37.4-proposal-compiler.md`.

> **37.5 IMPLEMENTED 2026-10-12 — not VERIFIED.** `generateWorkflow` is registered
> as a **`READ_ONLY`** tool (AD-17) that compiles a model proposal through the 37.4
> boundary and returns `{ok:true, proposal}` or the shared `INVALID_INPUT` envelope
> with exact `path`/`code`/`message`. It creates no `Workflow`/`WorkflowRun`, writes
> nothing, and executes no action (24 tests; full 35 suites / 628 tests; `tsc`
> clean). **Gate E satisfied (I1 VERIFIED).** The 37.2 real-model-path parse clause
> is discharged only on the mocked/scripted path, so the phase is not `VERIFIED`.
> The stale "three tools" prompt enumeration is deferred to 37.13. See
> `assignments-37-phase-37.5-generate-workflow.md`.

> **37.6 VERIFIED 2026-10-17.** The backend missing-input protocol
> (`NEEDS_USER_INPUT` vs `INVALID_INPUT`) and same-session clarification
> continuation are accepted: the real `POST .../clarification` ingress plus
> session GET exposure, `interactionId` + proposal-revision `correlationId`
> binding, idempotent/conflicting continuation under the session lock, the worker
> halt (no `AGENT_LOOP_REQUESTED`), and the reaper `skippedWaiting` exemption. The
> accepted scope is backend-only; durable proposal persistence and restart
> survival remain OPEN under 37.8 (F4 open). 28/28 focused plus durability /
> step-claim suites; `tsc` exit 0; Prisma untouched. See
> `assignments-37-phase-37.6-missing-input-protocol.md`.

> **37.9 / 37.9.1 IMPLEMENTED 2026-10-19 — not VERIFIED.** The proposal lifecycle
> is implemented end-to-end (approve / decline / expiry backend in 37.9; human
> criticality controls and the human-input UI in 37.9.1). New client surface:
> `WorkflowProposalPanel.tsx` (starts one session, polls authoritative state,
> mounts the cards), `ClarificationRequestCard.tsx` (answers the 37.6
> clarification contract), and per-step criticality controls added to
> `ProposalReviewCard.tsx`. It consumes the existing 37.6/37.7/37.9 contracts
> unchanged and fabricates no state: a 2xx only triggers an authoritative reread.
> No service, route, schema, migration or lifecycle rule changed; no Workflow or
> Task is created on approval (that is 37.11); the model is not re-entered on any
> decision. 3 focused suites 19/11/15; agent 34 suites / 647 tests; full suite 51
> suites / 954 tests; `tsc` clean; eslint 0 on changed files; `prisma validate`
> valid; `git diff --check` clean. **F4 and the durability/restart gate remain
> open.** See `assignments-37-phase-37.9-proposal-review.md` §14.

> **37.10 IMPLEMENTED 2026-10-19 — not VERIFIED.** A pure, deterministic
> projection (`projectProposalToUIGraph`) turns a reviewed proposal plus the
> human's complete criticality decisions into positioned `uiNodes`/`uiEdges`,
> with a documented hand-rolled longest-path layered layout (`PROPOSAL_UI_LAYOUT`;
> no layout library added) and edges derived from `dependsOn` alone. A read-only
> `ProposalGraphPreview` renders it inside the existing review surface, mounted
> only with a complete, revision-bound criticality set (never at
> `AWAITING_CRITICALITY`) and captioned that nothing has been created. Validation
> stays 37.4, the exact-set rule 37.7, and revision binding is computed
> server-side in the session GET. The 37.7 contract was split into a client-safe
> module (build hazard, not a `resolve.fallback` hack) with no logic change. No
> Workflow, Task or execution; no persistence, migration, lifecycle or auth
> change; 37.6–37.9 untouched. 4 focused suites 33/7/19/19; full suite 53 suites /
> 1005 tests; `tsc` 0; eslint 0; `prisma validate` valid; `git diff --check`
> clean; 3 non-vacuity mutations reverted. **F1 remains open** (its ordering half
> is AD-11). See `assignments-37-phase-37.10-ui-graph-projection.md`.

> **37.11 IMPLEMENTED 2026-10-20 — not VERIFIED.** An approved, durably stored
> proposal is now materialized into a persisted, triggerless `Workflow` by an
> explicit human action. `materializeProposal` re-derives the proposal from the
> durable result, re-verifies the revision fingerprint, applies the exact criticality
> set through the 37.7 contract, and persists BOTH the canonical execution
> definition (via `applyCriticalityDecisions`) and the verbatim 37.10 UI projection
> through the shared `IncomingNodesSchema`/`IncomingEdgesSchema` boundary. The
> transition is one transaction: CAS `APPROVED → MATERIALIZED` BEFORE `workflow.create`,
> with the unique `sourceProposalId` index as the final duplicate defense. Provenance
> is the durable `AgentToolExecution.id`; name is `proposal.name`; the workflow is
> stored `eventId: null` / `isActive: false` (F1). A strict `{interactionId}` ingress
> authorizes by persisted `userId` and derives the org from the persisted session.
> Session read now exposes `MATERIALIZED` additively with a `workflowId`; the review
> card offers an explicit **Create workflow** action (no optimistic success) and an
> **Open workflow** link. **Materialization only: no execution, no `WorkflowRun`, no
> `AGENT_LOOP_REQUESTED`, no QStash, no model-loop restart** (that is 37.12). 4 new
> suites 33/17/10/15 + card extended; full suite 56 suites / 1074 tests; `tsc` 0;
> eslint 0; `prisma validate` valid; `git diff --check` clean. **Real-DB round-trip
> and unique-constraint enforcement remain OPEN — but the 37.8 migration is now
> APPLIED (verified via `prisma migrate status`, 2026-10-20), so the round-trip is
> runnable.** F1 resolved (no schema change); F2 resolved (no new migration). See
> `assignments-37-phase-37.11-workflow-materialization.md`.

> **37.6 REMEDIATION 2026-10-20 — live-testing defect, no status change.** Running
> the proposal → materialization flow against the live database exposed why a
> session appeared stuck `RUNNING` at step 3/5 with zero workflow runs: the model
> asked for the missing values correctly, but also wrote `{{placeholder}}` into
> those inputs, which the compiler reported as `UNKNOWN_REFERENCE_SOURCE`; the
> executor treated any non-`MISSING_REQUIRED_INPUT` issue as model-correctable,
> discarded the clarification, and retried to the step cap. Fixed in `7bc05a7`
> (`generate-workflow/execute.ts`): an `UNKNOWN_REFERENCE_SOURCE` on a clarified
> input path is now a human-resolvable placeholder — **narrow demotion**, all other
> issue codes still force correction. `c7809f2` adds a prompt rule routing unfilled
> placeholders to the clarification field and bumps `AGENT_PROMPT_VERSION` v4 → v5.
> **This crosses the 37.5/37.6 "no prompt change — deferred to 37.13" boundary and
> is recorded, not absorbed; reviewer call whether the bump stays or folds into
> 37.13.** No migration, schema, service or route change. An orphaned session was
> terminated by controlled operator write (`FAILED` / `MANUAL_TERMINATION`). +3
> tests (10b/10c/10d); full suite 56 suites / 1077. **Live-verified 2026-10-20:**
> after a dev-server restart onto v5 + the fixed executor, the placeholder prompt
> completed the whole chain against the DB — `NEEDS_USER_INPUT` (4 fields) →
> answers → `ok:true` 2-step proposal → criticality → approved → materialized
> `Workflow` `cmvfs015h…` with 2 `uiNodes` / 1 `uiEdge`, both `inputsComplete:true`
> and real values, criticality baked into `uiNodes[].data.isCritical` and
> `definition.steps[].isCritical` (`kickoff_task:false`, `followup_task:true`),
> `isActive:false`/`eventId:null`, `WorkflowRun` count stayed 0. **Residual,
> unfixed:** a plain-string sentinel (e.g. `<…>`) fails `isReferenceTemplate` and
> yields `INVALID_INPUT`, which on a clarified path can still re-arm the loop
> (`workflow-proposal.ts:293`, `:427`); not triggered by this prompt, flagged as a
> candidate follow-up. See dev-log
> `docs/dev-log/2026-10-20-phase-37.6-clarification-remediation.md`.

> **Future assignment recorded 2026-10-19 — this does not change any 37 status.**
> **Assignment 38 — Organization Data Ingestion & RAG Operational Awareness** is
> recorded as `PLANNED` (backlog, not prioritized) in the agent roadmap:
> [`../agent/roadmap.md`](../agent/roadmap.md#backlog--future-assignments). It is a
> separate future assignment, **not** a phase of 37. Its workflow-indexing work
> attaches to the **37.11** materialization boundary; no 37 phase status, gate, or
> sequence is affected.

> **Third P0 recorded 2026-09-30.** **I6 — cross-tenant workflow execution** was
> added after Phase 0 closed. The P0 set is now **three** issues: I1 (gated 37.5),
> I2 (gated 37.11), I6 (gated 37.12). I6 is a separate ticket and is **not**
> satisfied by closing I1. See *Issue Register Dashboard → I6*.

> **Deviation from the requested header text, stated explicitly:** the supplied
> sample header reads `Current Phase: 37.0`. Phase 37.0 is VERIFIED, so the
> current actionable phase is **37.0A**. Recording 37.0 as "current" would
> contradict the master phase table, which marks it VERIFIED. Everything else in
> the requested header is reproduced verbatim.

---

## Assignment

**AI-Generated Declarative Workflow / DAG Planning**

## Core Boundary

> **Gemini generates a declarative workflow proposal.**
>
> The deterministic backend:
> - validates it
> - validates action contracts
> - validates references
> - validates DAG semantics
> - obtains missing human decisions
> - obtains approval
> - materializes it
> - hands it to the existing workflow execution engine
>
> **The existing workflow runtime remains the execution authority.**

This boundary is preserved without exception. It is restated at the top of every
phase section that touches it, because the most likely way this assignment fails
is by quietly eroding the boundary rather than by failing to build the feature.

### Companion documents

| Document | Role |
|---|---|
| `assignments-37-phase-0-audit.md` | Evidence. What the code actually does today. |
| `assignments-37-issue-register.md` | Findings. F1–F6, I1–I7, priorities, dependency map. |
| `assignments-37-plan.md` | Architecture. What Assignment 37 is building. |
| **`assignments-37-tracker.md`** (this file) | **Operations. Where we actually are.** |

The tracker does not replace the plan. The plan answers *what is the architecture
supposed to become*; this file answers *where are we, what is proven, and what is
next*. Given how many findings Phase 0 produced, conflating the two is how a
constraint discovered in Phase 0 quietly disappears in Phase 7.

---

## Live Status Panel

```text
ASSIGNMENT 37 STATUS

Overall:                     READY (I6 plus 37.4/37.5, 37.7-37.15 VERIFIED - no open P0)
Current Phase:               37.16 (Live capstone verification - NOT_STARTED)
Previous Completed Phase:    37.15 (Full test matrix - VERIFIED 2026-10-23)
Next Phase:                  37.16 (Live capstone verification)
Blocking Issue:              (none - all predecessor gates satisfied)
Security Prerequisites:      I1 VERIFIED, I2 VERIFIED, I6 VERIFIED
Architecture Decision Pending: (none — F1/F2 resolved at 37.11; F4 resolved at 37.8; F5 resolved at 37.4; AD-11; AD-P7)
Recorded scope decisions:    I7     (conditional routing - non-blocking)
Verification debt:           (none - all 18 tracked phases 37.0-37.15 VERIFIED)
Last Verification:           2026-10-23 - 37.15 Full test matrix verification completed
                             (43/43 matrix checks verified; full default Jest suite 79 suites / 1267 tests; tsc 0; eslint 0)
Last Updated:                2026-10-23

Progress:
[██████████████████░░] 90%   (18 of 20 tracked phases VERIFIED)
```

### Why `BLOCKED` and not `IN_PROGRESS`

Two P0 findings gated any workflow-writing capability. Phases 37.1–37.4 write no
workflows and can proceed once Gate A is satisfied by isolation. Phase 37.5 and
beyond could not: the agent must not become a workflow writer while
`updateWorkflowState` updates by primary key alone.

**Both of those are closed as of 2026-09-30** — I1 under 37.0A, I2 under 37.0B — so
the paragraph above describes defects that no longer exist. Gate E's predicate
requirement is met. The separate persistence-layer requirement in Gate A is
covered by I2.

One P0, **I6**, was the remaining gate on a later boundary. It is now **VERIFIED
(2026-10-20)**: the source fix is complete, its mocked suites are green, and the
**real-PostgreSQL cross-tenant acceptance run has passed** — an org-A caller
cannot start org B's workflow, no `WorkflowRun` row is created, and the same-org
positive path still builds a run. No P0 remains open; **37.12 (execution handoff)
is unblocked**. I6 never stopped any phase through 37.11, because a tenant-scoped
execution entrypoint is only required at the handoff. **I7** is recorded as a scope
decision, not a blocker; it likewise does not stop 37.10/37.11.

All 18 tracked predecessor phases through **37.15** are now **VERIFIED**
(37.0, 37.0A, 37.0B, 37.1–37.15). Zero verification debt remains. Phase 37.15's
complete 43-check matrix is verified across all 8 categories, and the full regression
suite (79 suites, 1267 tests) passes cleanly. Phase 37.16 (live capstone) is the next
and final implementation phase.

### Progress calculation

```text
progress = (count of phases with status VERIFIED)
         ÷ (count of tracked phases)

excluded from both numerator and denominator:
  - DEFERRED phases
  - CANCELLED phases

documentation-only status changes do not advance progress
  (a phase is not VERIFIED because a document was written)
```

**Counting rules for this assignment:**

| Category | Counted? | Rationale |
|---|---|---|
| 37.0 (reconnaissance) | Yes — in denominator, VERIFIED in numerator | It produced a real verification artifact. |
| 37.0A / 37.0B | **Yes, as separate tracked phases** | Both require code change **and** regression tests. They are not documentation-only, so counting them as mere gates would understate the work. |
| 37.1 – 37.17 | Yes | Core implementation. |
| DEFERRED / CANCELLED | No | Excluded from both. |

**Tracked phases: 20** (37.0, 37.0A, 37.0B, 37.1–37.17).
**Implementation-only denominator: 19** (excludes 37.0, which is reconnaissance
rather than implementation). Both figures are reported so the ratio cannot be
read as "5% of the code is written."

**`VERIFIED` means:** the phase's documented Verification Gate was completed and
evidence exists in the Verification Ledger. Compilation, type-checking and passing
unit tests map to `IMPLEMENTED` and `TESTING`. They do not map to `VERIFIED`.

---

## Status Vocabulary

| Status | Meaning |
|---|---|
| `NOT_STARTED` | No work begun. |
| `READY` | Unblocked, prerequisites satisfied, not begun. |
| `IN_PROGRESS` | Actively being implemented. |
| `BLOCKED` | Cannot proceed; a named blocker is recorded. |
| `IMPLEMENTED` | Code complete; not yet fully tested. |
| `TESTING` | Under test; gate not yet satisfied. |
| `VERIFIED` | Documented verification gate completed, evidence exists. |
| `PARTIALLY_VERIFIED` | Some gates passed, others outstanding. |
| `DEFERRED` | Deliberately postponed. Does not count toward progress. |
| `CANCELLED` | Removed from scope. Does not count toward progress. |

Always use the smallest applicable status.

---

## Master Phase Table

| Phase | Name | Status | Priority | Depends On | Blocks | Main Deliverable | Verification | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 37.0 | Contract reconnaissance | **VERIFIED** | P0-enabling | — | everything | Contract map + 6 findings + 5 issues | Phase 0 gate answered | `assignments-37-phase-0-audit.md` | No source modified. `git status` shows only untracked documentation. |
| 37.0A | Security prerequisite — I1 tenant-scoped workflow update | **VERIFIED** | **P0** | 37.0 | 37.5, 37.8, 37.11, all agent writes | Tenant-scoped update predicate + regression test | Cross-org write rejected; same-org write succeeds | 2026-09-30 | Closed as its own ticket, ahead of Gate E. Not bundled into a feature phase. |
| 37.0B | Persistence-boundary prerequisite — I2 node validation | **VERIFIED** | **P0** | 37.0 | 37.10, 37.11 | Real node-data validation on create **and** update paths | Valid node accepted; malformed node rejected | 2026-09-30 | Closed as its own ticket. Satisfies Gate F. |
| 37.1 | Action capability registry | **VERIFIED** | **P1** | 37.0A, 37.0B (isolation sufficient) | 37.2, 37.3, 37.4 | One authoritative planner-facing capability source | Planner obtains authoritative metadata for every generatable action | 2026-10-01 — 32-case suite + full run 31/490 + tsc clean | Resolves F3, absorbs I4. AD-P1 decided. Responsive `ActionCapabilities` typed against `RegisteredActionId`. |
| 37.2 | WorkflowProposal schema | **VERIFIED** | P1 | 37.1 | 37.3, 37.4 | `WorkflowProposal` Zod schema | Static A / B→A / C→A,B parses; malformed fails structurally | 2026-10-12 - 45-case suite + full run 32/535 + tsc clean | localRef IDs; no DB IDs, no coordinates, no criticality. Enforces I4. Bounds hardened (bounded depth before serialization; no throw). **Real-model-path parse reassigned to 37.5.** |
| 37.3 | Reference grammar + validator | **VERIFIED** | P1 | 37.2 | 37.4, 37.5 | Reference validator over existing `{{…}}` grammar | Unordered data reference cannot pass validation | 2026-10-12 — 44-case suite + full run 33/579 + tsc clean; resolver diff empty | Resolves F6. Adds `MISSING_DATA_DEPENDENCY`, `UNKNOWN_REFERENCE_SOURCE`, `UNKNOWN_OUTPUT`, `MALFORMED_REFERENCE`, `UNAVAILABLE_REFERENCE_SCOPE`, `UNSAFE_REFERENCE_PATH`, `SELF_REFERENCE`. **No new syntax; resolver unchanged.** Trigger fields fail closed. |
| 37.4 | Proposal compiler / semantic validation adapter | **VERIFIED** (2026-10-23) | P1 | 37.3 | 37.5, 37.11 | Single deterministic compiler boundary | Proposal + DAG validation form one boundary; issue codes preserved | 2026-10-12 — 25-case suite + workflow 13 suites / 287 tests + tsc clean; resolver diff empty. 2026-10-23 — real-DB production-path test `proposal-compiler-materialization.realdb.test.ts` 3/3 proves the collector gate runs on materialization (PROJECTION_FAILED, no Workflow row, lifecycle unchanged); focused 25/25; workflow 21 suites / 369 tests; full 78 suites / 1265 tests; realdb 3/3; tsc 0; eslint 0; `git diff --check` clean | **VERIFIED (2026-10-23).** Resolves F5 (AD-P4); `collectWorkflowDefinitionIssues` is the canonical gate and is reused, not duplicated. Production callers proven in code: `execute.ts` (`generateWorkflow`, the 37.5 caller) and `proposal-ui-projection.ts` → `proposal-materialization-service.ts` (the 37.11 path). Deferred production-path half of the gate now discharged. |
| 37.5 | `generateWorkflow` agent tool | **VERIFIED** (2026-10-23) | P1 | 37.4, **37.0A VERIFIED** | 37.6, 37.7, 37.8 | Macro agent tool, proposal-only | Tool registered, proposes only, executes nothing | 2026-10-12 — 24-case suite + full 35/628 + tsc clean; resolver/canvas/runtime diff empty. 2026-10-23 — real-model clause discharged: `generate-workflow.live.test.ts` 1/1 against `gemini-3.6-flash`; focused 35/35; agent 43/814; workflow 21/369; full 78/1265; tsc 0; eslint 0; diff-check clean | **VERIFIED (2026-10-23).** Gate E precondition met (I1 VERIFIED); not exercised because the tool is `READ_ONLY` (AD-17), propose-only, no workflow-domain writes. The carried 37.2 real-model-path clause is now discharged by a live Gemini turn: the emitted input validated, compiled and executed unchanged (no fix-up). Live model call only — no live database or transport; the Prisma boundary is mocked. 37.16 owns the capstone. |
| 37.6 | Missing-input state | **VERIFIED** | P1 | 37.5 | 37.7, 37.8 | Durable `NEEDS_USER_INPUT` state | Model error and missing user info are distinguishable in the protocol | 2026-10-17 — 28-case suite + durability reaper exemption + generate-workflow 24; 36 suites / 672 tests; full suite 692; tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched. 2026-10-20 — +3 tests (10b/10c/10d); full suite 56 suites / 1077; tsc exit 0; eslint 0. 2026-10-20 — live round-trip verified against the DB end-to-end (clarification → answers → `ok:true` → criticality → approved → materialized), no execution (`WorkflowRun` count 0) | F4 part 1. No preemptive migration. Worker halts (no `AGENT_LOOP_REQUESTED`), publishes `CLARIFICATION_REQUESTED`; `POST .../clarification` ingress; `interactionId`+`correlationId` binding; idempotent continuation under lock; reaper `skippedWaiting`. **VERIFIED (2026-10-17)** for backend protocol + same-session continuation; external UI not claimed. Durability/restart survival deferred to 37.8; F4 open. **REMEDIATION 2026-10-20 (`7bc05a7`, `c7809f2`):** live-testing defect — a clarification could not survive an `UNKNOWN_REFERENCE_SOURCE` placeholder on the same field, so the loop retried to the step cap; executor now demotes that issue to human-resolvable (narrow; all other issue codes still force correction), and a prompt rule routes unfilled placeholders to the clarification field. **Crosses the "no prompt change — deferred to 37.13" boundary: `AGENT_PROMPT_VERSION` v4 → v5; recorded, reviewer call.** **Live-verified 2026-10-20; residual unfixed: a plain-string sentinel (`<…>`) still yields `INVALID_INPUT` on a clarified path (candidate follow-up).** |
| 37.7 | Human criticality state | **VERIFIED** (2026-10-23) | P1 | 37.6 | 37.8, 37.9 | Durable human criticality decision | Model cannot set or override final `isCritical` | 2026-10-18 — backend criticality service + routes; UI controls added by 37.9.1. 2026-10-23 — integration suite `src/tests/agent/criticality-integration.test.ts` 2/2 proves model cannot set/smuggle `isCritical`, human decision persists and differs from model defaults, later turn cannot override, and stored policy on materialization matches human decision; focused 4 suites / 60 tests; tsc 0; eslint 0; `git diff --check` clean | **VERIFIED (2026-10-23).** F4 part 2 resolved. The stored execution policy comes from the human decision. Model output cannot set or override `isCritical`. Integration gate proven by `criticality-integration.test.ts` (2/2) alongside focused suites (60/60). Real PostgreSQL persistence verified under 37.11 (`proposal-materialization.realdb.test.ts`). |
| 37.8 | Durable proposal persistence | **VERIFIED** (2026-10-23) | P1 | 37.7 | 37.9, 37.11 | Chosen proposal persistence lifecycle | Full lifecycle survives process restart | 2026-10-18 — durable lifecycle on amended migration. 2026-10-23 — real-PG acceptance suite `src/tests/agent/proposal-lifecycle.realdb.test.ts` 10/10 proves complete lifecycle restart survival across two independent processes (Process A writes and exits; Process B loads via production recovery, advances through criticality -> approval -> materialization), state-specific recovery paths, deterministic supersession, reaper exemption, and CAS idempotency with zero leftovers; focused unit suite 37/37; criticality 23/23; missing input 35/35; tsc 0; eslint 0; diff-check clean | **VERIFIED (2026-10-23).** Resolves F4. Lifecycle persisted directly on `AgentToolExecution` with `proposalState`, `proposalFingerprint`, `proposalRevision`, `criticalityDecisions`, `clarificationAnswer`, `expiresAt`, `result`. Genuine cold process restart proven against real PostgreSQL. |
| 37.9 | Existing confirmation integration | **VERIFIED** (2026-10-23) | P1 | 37.8 | 37.11 | Review surface over existing 35/36 gate | Approval binds exact proposal; changed proposal cannot reuse it | 2026-10-19 — 37.9 backend + 37.9.1 UI; 3 focused suites 19/11/15; agent 34/647; full 51/954. 2026-10-23 — real-PG acceptance suite `src/tests/agent/proposal-review-integration.realdb.test.ts` 5/5 proves end-to-end review surface, Kahn-ordered steps, React SSR rendering, atomic CAS approval & decline, transcript audit messages, supersession safety, review expiry, and zero DB leftovers; 7 focused unit/integration suites 168/168 pass; tsc 0; eslint 0; diff-check clean | **VERIFIED (2026-10-23).** Verification Gate satisfied: end-to-end review-surface test with a real pending proposal against real PostgreSQL. Approval strictly binds exact proposal and revision; changed/superseded proposal cannot reuse it. Review expiry sweeps past-due proposals to EXPIRED. |
| 37.10 | UI graph projection / deterministic layout | **VERIFIED** (2026-10-23) | P2 | 37.9, 37.0B VERIFIED | 37.11 | Deterministic `uiNodes`/`uiEdges` + layout + read-only preview | Projection is deterministic and Gemini-free | 2026-10-19 — 4 focused suites 33/7/19/19; full 53/1005; tsc 0; eslint 0; prisma valid; 3 mutations reverted. 2026-10-23 — verified gate satisfied: 4 focused suites (82/82 PASS) prove pure determinism, longest-path layering, `dependsOn`-derived edges, node-data schema validity, server-side revision binding; downstream real-PostgreSQL materialization suite `src/tests/agent/proposal-materialization.realdb.test.ts` (11/11 PASS) proves projected graph persists through shared boundary and recompiles to canonical definition; tsc 0; eslint 0; diff-check clean | **VERIFIED (2026-10-23).** Acceptance Gate satisfied: pure, deterministic projection without Gemini coordinates. Node schema conforms to `ActionNodeDataSchema` / `IncomingNodesSchema`. Layout uses longest-path layers with `PROPOSAL_UI_LAYOUT`. Downstream persistence and round-trip recompilation verified against real PostgreSQL under 37.11. |
| 37.11 | Workflow materialization | **VERIFIED** (2026-10-23) | P2 | 37.10 | 37.12 | `Workflow` row with compiled definition | Persisted workflow is executable and name/provenance correct | 2026-10-23 — real-PG `proposal-materialization.realdb.test.ts` 11/11 (round trip, re-save provenance, rollback, concurrency, tenant isolation); mocked 3 suites 60/60; tsc 0; eslint 0; diff-check clean | **F1 + F2 resolved.** Real-DB round trip closes the former open gate: stored canvas recompiles to the stored definition, provenance survives a real save, and a failed insert rolls the CAS back. Explicit human "Create workflow" action; CAS+create tx; unique `sourceProposalId`; triggerless (`eventId:null`/`isActive:false`). Materialization only — no execution. |
| 37.12 | Execution handoff | **VERIFIED** (2026-10-23) | P1 | 37.11, **I6 VERIFIED (Gate G, 2026-10-20)** | 37.16 | Handoff to existing evaluator | Generated workflow runs in the existing engine | 2026-10-23 — mocked handoff/context/invariant/scope suites 29/29; real-PG handoff 5/5; I6 real-PG 10/10; assembled-engine diamond 9/9; tsc 0; eslint 0; diff-check clean | No new executor, lock, or queue runner. Explicit authenticated Run action → `startWorkflow`; validated optional trigger context (reserved keys refused); canvas `mockProjectPayload` removed. Multiple-run behaviour preserved. **Ledger distinction:** the real-PG handoff mocks `advanceWorkflow`, so it proves run creation and tenant scope; real dispatch is proven by the mocked-persistence diamond suite. Live QStash execution is 37.15/37.16. |
| 37.13 | Prompt / DAG planning instructions | **VERIFIED** (2026-10-23) | P1 | 37.12 | 37.14, 37.16 | Prompt update + version bump | Prompt references real contracts only | 2026-10-23 — prompt-vs-`ActionCapabilities`/`ActionRegistry` review; `prompt-dag-planning.test.ts` 29/29; version v6 recorded | `AGENT_PROMPT_VERSION` `v5 → v6`; DAG/parallelism, local-id, capability-contract, reference-grammar, clarification, criticality, propose-only and validation-observation guidance added to `<WORKFLOW_GENERATION>`. v5 remediation text preserved. Only `task.create` is named; input/output guidance matches the catalog. Model obedience remains a 37.16 live concern, by design. |
| 37.14 | Self-healing observations | **VERIFIED** (2026-10-23) | P1 | 37.13 | 37.16 | Three distinct loops in the state machine | Self-correction, clarification and approval are distinguishable | 2026-10-21 — `three-loop-separation.test.ts` 6/6 + `no-second-retry-controller.test.ts` 8/8 + `proposal-review-expiry.test.ts` 35/35. 2026-10-23 — real-PostgreSQL acceptance suite `src/tests/agent/wait-state-cas.realdb.test.ts` 9/9 proves real wait-state CAS transitions for clarification and proposal decision, anti-resurrection guards, and proposal-review expiry isolation (leaves session in WAITING_CONFIRMATION if other human waits remain); total 58/58 tests pass; tsc 0; eslint 0; diff-check clean | **VERIFIED (2026-10-23).** No second retry controller (AD-06). Three distinct loops evidenced: Loop 1 (model self-correction, bounded by MAX_AGENT_STEPS = 5 via decideStepGate, never parks), Loop 2 (human clarification, parks WAITING_CONFIRMATION, clears to RUNNING and records AGENT_LOOP_REQUESTED outbox intent), Loop 3 (human approval/decline, parks WAITING_CONFIRMATION, clears to RUNNING with zero outbox events). Expiry isolation proven against real PG. |
| 37.15 | Full test matrix | **VERIFIED** (2026-10-23) | P1 | 37.14 | 37.16 | All test classes passing | Full suite green | 2026-10-21 — assembled engine `workflow-integration-diamond.test.ts` 9/9; standalone fan-in `dag-validation.test.ts` 26/26. 2026-10-23 — all 43 matrix checks individually verified across 8 categories (contract 7, graph 8, reference 7, human-input 4, criticality 4, confirmation 5, execution integration 6, I1 regression 2); focused matrix suites 11/11 pass (254 tests); full default Jest suite 79 suites / 1267 tests pass; zero skipped/focused tests; tsc 0; eslint 0; git diff --check clean | **VERIFIED (2026-10-23).** Acceptance & Verification Gates satisfied: every category has a named covering suite with explicit assertions; full regression suite is green; all predecessor phases 37.0-37.14 are VERIFIED. Predecessor gate satisfied. Formal prerequisite for 37.16 complete. Live Gemini, QStash, Redis, and end-to-end live infrastructure deferred to 37.16 capstone. |
| 37.16 | Live capstone verification | **NOT_STARTED** | P1 | 37.15 | 37.17 | "Onboard Acme Enterprise." end-to-end | Every live check individually evidenced | — | Includes I5 verification. |
| 37.17 | Documentation / closure | **NOT_STARTED** | P1 | 37.16 | — | Final docs + register reconciliation | All checklist items resolved | — | No issue may be closed without evidence. |

---

# Phase Detail Sections

## Phase 37.0 — Contract reconnaissance

### Status

**VERIFIED**

### Objective

Produce a contract map of the existing workflow and agent surfaces, and answer
the Phase 0 gate question. No implementation.

### Architectural Role

The foundation for every subsequent phase. Its purpose was to prevent 37 from
inventing parallel systems by documenting what already exists.

### Inputs / Dependencies

- None. This is the entry point.

### Scope

- `WorkflowAction` / `ActionContext` types
- Action registries, and every registered action
- Input/result conventions
- `WorkflowDefinitionSchema`, `WorkflowStepSchema`
- Compiler / materializer
- Pointer resolver
- Workflow persistence path
- 35/36 confirmation machinery
- Agent registry, tool policy, prompt versioning
- `AgentToolExecution` proposal fields
- `Workflow` / `WorkflowRun` persistence

### Out of Scope

Any code change. Any schema. Any migration. Any registry edit.

### Expected Implementation

None. Documentation only.

### Deliverables

- `docs/architecture/workflows/assignments-37-phase-0-audit.md`
- `docs/architecture/workflows/assignments-37-issue-register.md`
- `docs/architecture/workflows/assignments-37-plan.md`
- `docs/architecture/workflows/assignments-37-tracker.md`

### Acceptance Gate

The contract map exists, is cited to `file:line`, and separates observed from
inferred from recommended.

### Test Gate

Not applicable. No code was written.

### Verification Gate

Phase 0 gate answered explicitly: *"What does the agent need to know about an
action to generate a valid step?"*

**Answer: an action id string, and nothing else.**

Observed runtime contract (`src/lib/workflow-types/type.ts:33-39`):

- `id`
- `execute`
- optional `compensate`

Planner-facing contract **currently missing**:

- description
- input contract
- output contract
- referenceable outputs
- relevant failure / retry semantics
- compensation capability metadata

**This is an audit finding, not a fix.** It is the input to 37.1.

### Evidence

```text
Implementation: N/A — documentation only
Tests:          N/A — no code changed
Verification:   Phase 0 gate answered in assignments-37-phase-0-audit.md
Commit/PR:      uncommitted
Relevant files: the four documents in docs/architecture/workflows/
```

Findings produced: **F1–F6** (architecture/dependency) and **I1–I5**
(pre-existing issues).

### Known Risks / Findings

- **F3** — no authoritative planner-facing action capability contract.
- **F5** — `WorkflowDefinitionSchema` is never called in production.
- **F1** — persistence is canvas-first; the original plan's 37.10/37.11 order was inverted.
- **I1**, **I2** — P0, now tracked as 37.0A / 37.0B.

### Decisions

Made: none. Phase 0 recorded forks; it did not resolve them.

Pending: F1, F2, F4, F5.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-09-30 | VERIFIED | Phase 0 completed; gate answered; tracker created | `assignments-37-phase-0-audit.md` |

---

## Phase 37.0A — Security prerequisite: I1 tenant-scoped workflow update

### Status

**VERIFIED** · Classification: **P0** · separate prerequisite ticket · Closed 2026-09-30

### Objective

Close the cross-tenant workflow write in `updateWorkflowState`.

### Architectural Role

A security prerequisite, not a feature. It exists because Phase 0 established
that 37.5 makes the agent a workflow writer, which raises the severity of a
pre-existing authorization defect.

### Inputs / Dependencies

- **Issue:** I1 (`assignments-37-issue-register.md` §3)
- **Gate E:** must be VERIFIED before 37.5 becomes workflow-writing.

### Scope

- Make the `db.workflow.update` predicate in
  `src/app/actions/workflows/workflow.ts:115` tenant-scoped.
- Add a regression test.
- Verify the positive case is not broken by the fix.

### Out of Scope

- Refactoring the save actions.
- I2 / node validation (that is 37.0B).
- Any change to the create path, which already scopes by the accessor's `orgId`
  (`workflow.ts:57`, `:66`).
- Any 37.x feature work.

### Expected Implementation

The current predicate is `{ id: workflowId }` while `getOrgAccess(orgslug)`
(`workflow.ts:102`) establishes membership in an organization that is then
unused. The fix makes the write predicate carry that trusted organization id.
The exact predicate shape is an implementation decision for the ticket.

### Deliverables

- Modified `src/app/actions/workflows/workflow.ts`
- Regression test — file location UNKNOWN until the ticket is written
- Ticket reference

### Acceptance Gate

The update predicate is tenant-scoped in code.

### Test Gate

- Cross-tenant update is **rejected**
- Same-tenant legitimate update **still succeeds** (guards against a fix that
  degenerates into blanket denial)

### Verification Gate

`VERIFIED` requires all four, not the first alone:

1. Code fix present
2. Regression test present
3. Regression test passing
4. Observed evidence that a cross-org update is rejected while a same-org update
   succeeds

**A code modification alone is `IMPLEMENTED`, not `VERIFIED`.**

### Evidence

```text
Implementation: src/app/actions/workflows/workflow.ts — updateWorkflowState
                now resolves ownership with
                  db.workflow.findFirst({ where: { id, orgId }, select: { id: true } })
                and writes with
                  db.workflow.updateMany({ where: { id, orgId }, data: {...} })
                orgId is access.organization.id in both statements. Neither
                half is scoped on its own: the read refuses, and the write
                predicate is independently tenant-constrained, so the
                authorization answer and the mutation cannot disagree.

                updateMany rather than update because this action uses the raw
                client (src/lib/prisma/db), where the unique input is `id` only
                — orgId is indexed but not unique, so update({ where: { id,
                orgId } }) does not typecheck. Carrying orgId in the write
                predicate is the invariant; the query shape follows from it.

Tests:          src/tests/workflow/workflow-update-scope.test.ts (new, 5 cases)
                  1. foreign-org workflow refused, no write issued, row unchanged
                  2. nonexistent workflow byte-identical response to case 1
                  3. orgId present in the updateMany predicate itself
                  4. same-org write persists compiled definition/eventId/isActive
                  5. unauthorized access: no lookup, no write
                Harness: src/tests/workflow/helpers/prisma-double.ts gained a
                `workflow` delegate whose findFirst/updateMany both filter on
                orgId via a shared matchesWorkflowWhere helper. A double that
                ignored the tenant predicate would return count: 1 and fail the
                suite, so the negative cases cannot pass for the wrong reason.

Verification:   npx jest src/tests/workflow/workflow-update-scope.test.ts  -> 5/5
                npx jest src/tests/workflow                            -> 7 suites, 109 tests
                npm test                                               -> 27 suites, 417 tests
                npx tsc --noEmit                                       -> exit 0
                npx eslint on the 3 touched files -> 4 errors, all pre-existing
                @typescript-eslint/no-explicit-any on the uiNodes: any[] /
                uiEdges: any[] parameters at workflow.ts:46,47,98,99, which
                this change does not touch (confirmed present at HEAD).
                New test file and the double are lint-clean.

                Observed cross-org rejection: a caller in org_a updating
                org_b's wf_1 receives
                  { success: false, error: "Workflow not found in this organization." }
                with the stored row unmodified and updateMany never called.
                Observed same-org success: the same call for org_a's own wf_1
                returns { success: true } and writes the compiled definition.

                Mutation check — the suite was re-run against a deliberately
                reverted, unscoped `where: { id: workflowId }` and FAILED 3 of 5
                (the cross-org case returned { success: true } and overwrote the
                foreign row). The tests therefore detect the original defect
                rather than merely passing against the fix.

Commit/PR:      uncommitted — working tree only
Relevant files: src/app/actions/workflows/workflow.ts (updateWorkflowState)
                src/tests/workflow/workflow-update-scope.test.ts (new)
                src/tests/workflow/helpers/prisma-double.ts (workflow delegate)
```

### Known Risks / Findings

**I1 — RESOLVED.** Affected path was `updateWorkflowState`
(`src/app/actions/workflows/workflow.ts:95-137`). The authorization check and the
database predicate disagreed in scope; impact was read-write on execution
blueprints for every tenant, by primary key, with no requirement that the target
belong to the caller's organization. Both statements are now scoped to
`access.organization.id`.

Deliberately unchanged, and still true: the `[orgId]` route segment carries an
organization **slug**, not an id (`src/app/router/page.tsx:38`). `getOrgAccess`
is therefore live on this path and the defect was reachable, not masked by a
broken route.

**Residual, not part of I1:** the create path (`saveWorkflowState`) was already
scoped and was not touched. I6, cross-tenant *execution*, was untouched by the I1
ticket; its source fix landed separately on 2026-10-20 but its real-DB acceptance
run is still open (see *Current Blockers → I6*).

### Decisions

Made:

- **Tenant constraint in both the authorizing read and the write predicate.**
  The tracker required that the actual database operation enforce ownership, and
  separately that a cross-org attempt issue no write at all. A scoped read plus a
  scoped `updateMany` is the only shape that satisfies both on the raw client.
- **Foreign and nonexistent share one response.** `"Workflow not found in this
  organization."` matches the existing `updateTaskInOrg` precedent
  (`src/lib/tasks/update-task.ts:71-77`) and keeps the endpoint from becoming an
  existence oracle for other tenants' workflow ids.
- **Compile still precedes the write.** A `WorkflowValidationError` therefore
  still leaves the row untouched, and a same-org malformed save still returns the
  same per-issue message. Ordering was not changed to make room for the new check.
- **I2 untouched.** The update path's node check is still `z.array(z.any())`;
  tightening it is 37.0B and was explicitly out of scope.

Pending: none specific to I1.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-09-30 | NOT_STARTED | Phase 37.0A recorded as the I1 ticket, split from 37.0 so the security fix is not bundled into a feature phase. | `assignments-37-phase-0-audit.md` |
| 2026-09-30 | VERIFIED | Update predicate made tenant-scoped; 5-case regression suite added; full suite and type-check green; suite proven to fail against the unscoped predicate. | `src/tests/workflow/workflow-update-scope.test.ts`; 27 suites / 417 tests |

---

## Phase 37.0B — Persistence-boundary prerequisite: I2 node validation

### Status

**VERIFIED** · Classification: **P0** · separate prerequisite ticket · Closed 2026-09-30

### Objective

Make node validation at the workflow persistence boundary actually validate.

### Architectural Role

Because persistence is canvas-first (F1), the canvas schema is the trust boundary
for machine-generated content. If it does not validate, ProposalSchema validation
in 37.2 becomes advisory the moment generated content crosses into `uiNodes`.

### Inputs / Dependencies

- **Issue:** I2 (`assignments-37-issue-register.md` §3)
- **Gate F:** must be closed before materialization trusts generated `uiNodes`.
- **F1** — establishes *why* the canvas is a trust boundary for generated content.

### Scope

- `IncomingNodeSchema` (`src/app/actions/workflows/workflow.ts:30-38`), whose
  `data` field is `.optional().or(z.any())` at `:37`, making the discriminated
  union over `TriggerNodeDataSchema` / `ActionNodeDataSchema` unreachable.
- `updateWorkflowState`'s `z.array(z.any())` at `:105`, which validates nothing.

### Out of Scope

- 37.x feature work.
- F1's architectural decision (37.10).
- I1 (37.0A).

### Expected Implementation

`z.any()` satisfies every value, so the union's right-hand branch always succeeds
and the left-hand branch is never reached. The surviving create-path protections
are `id`, `type` and `position` — not `data`, which carries `eventId`,
`actionType`, `config` and `isCritical`, i.e. everything determining what executes.

### Deliverables

- Modified `src/app/actions/workflows/workflow.ts`
- Regression tests for both paths
- Ticket reference

### Acceptance Gate

Node `data` is validated against the intended schemas on **both** the create and
update paths.

### Test Gate

- Valid node accepted (create path)
- Valid node accepted (update path)
- Malformed node `data` rejected (create path)
- Malformed node `data` rejected (update path)
- **Both paths covered** — fixing only one leaves the update path writable with
  anything

### Verification Gate

All of: code fix, regression tests, valid-node acceptance observed, malformed-node
rejection observed, across both paths. Closing only part of this gate leaves 37.10
and 37.11 able to write unvalidated node data.

### Evidence

```text
Implementation: src/app/actions/workflows/workflow.ts
                IncomingNodeSchema is now a z.discriminatedUnion('type', [...])
                over two node shapes whose `data` is TriggerNodeDataSchema or
                ActionNodeDataSchema directly. The `.optional().or(z.any())` tail
                is gone, and a shared IncomingNodesSchema validates both paths.

                THE DISCRIMINATOR MOVED, deliberately. The original union was
                keyed on `data.type`, but React Flow carries the discriminator on
                the node and WorkflowCanvas.tsx:150-162 never sets `data.type`:
                  { id, type: 'trigger', position, data: { label, eventId: null } }
                `AppNode`'s inferred data type has no `type` field either. Simply
                deleting `.or(z.any())` would therefore have made the union
                reachable and rejected every node this application creates. The
                union is keyed on `node.type` instead, which also makes `type`
                and `data` structurally incapable of disagreeing.

                Both save paths now compile and persist `areNodesValid.data`,
                not the raw argument, so the value validated is the value
                compiled and stored. Validating a copy while persisting the input
                would leave unvalidated keys in the row and keep the check
                advisory, which is the same criticism I2 makes of 37.2.

                Error contract unchanged: "Malformed workflow data." on both paths,
                and validation still runs before compileWorkflow, so a rejected
                node never reaches a write and a compile failure still returns
                describeCompileFailure's per-issue message.

Tests:          src/tests/workflow/workflow-node-validation.test.ts (new, 23 cases)
                  UI_TRIGGER / UI_ACTION are copied verbatim from
                  WorkflowCanvas.tsx so the real canvas payload is what is
                  accepted, not a tidied-up approximation.
                  create path: real payload accepted; ActionNodeData defaults
                  applied to the persisted row; 8 malformed variants rejected
                  with create never called; a graph whose *second* node is
                  malformed rejected; unknown keys stripped; stray trigger field
                  on an action node stripped.
                  update path: real payload accepted; the same 8 malformed
                  variants rejected with findFirst and updateMany never called;
                  unknown keys stripped.

Verification:   npx jest src/tests/workflow/workflow-node-validation.test.ts    -> 23/23
                npx jest src/tests/workflow (both suites)                        -> 28/28
                npm test                                                          -> 28 suites, 440 tests
                npx tsc --noEmit                                                  -> exit 0
                npx eslint on the 4 touched files -> the same 4 pre-existing
                no-explicit-any errors on the untouched uiNodes/uiEdges any[]
                parameters (now lines 69,70,126,127 after the schema block).
                Both new test files and the double are lint-clean.

                Observed valid-node acceptance: the verbatim canvas payload saves
                on both paths, and the action node's config/isConfigured/
                isCritical defaults appear in the stored row.
                Observed malformed-node rejection: all 8 variants return
                  { success: false, error: "Malformed workflow data." }
                with no create/updateMany call, on both paths.

                Mutation check — the suite was re-run against the original inert
                schema (`.optional().or(z.any())` restored, create back to
                z.array(IncomingNodeSchema), update back to z.array(z.any())) and
                FAILED 19 of 23. The tests detect the defect on both paths
                rather than merely passing against the fix.

                Interaction with 37.0A: that suite's fixture node omitted
                `label`, so it became malformed the moment validation was real
                and its tenant-scope cases began returning "Malformed workflow
                data." before reaching the tenant check. The fixture was made a
                valid node so it exercises tenant scope, and node-shape rejection
                is asserted in the new file instead.

Commit/PR:      uncommitted — working tree only
Relevant files: src/app/actions/workflows/workflow.ts (both save actions)
                src/tests/workflow/workflow-node-validation.test.ts (new)
                src/tests/workflow/helpers/prisma-double.ts (workflow.create)
                src/tests/workflow/workflow-update-scope.test.ts (fixture corrected)
```

### Known Risks / Findings

**I2 — RESOLVED.** `IncomingNodeSchema.data` was `.optional().or(z.any())` and
`updateWorkflowState` validated `z.array(z.any())`; both now validate for real on
both paths. F1 — the reason generated content passes through the canvas at all —
is untouched and remains 37.10/37.11 work.

**Known limits, deliberately not closed here:**

- **`uiEdges` is still unvalidated.** The tracker's I2 scope named the node schema
  and the update path only. Edges carry no data payload, and the compiler reads
  only `edge.source` / `edge.target` from them, so an unvalidated edge cannot
  introduce node data. Reference and data-dependency validation is F6 and belongs
  to 37.3.
- **A stray key on a node whose *type* and *data* disagree is stripped, not
  rejected.** `ActionNodeDataSchema` is an ordinary Zod object, so an action node
  carrying `eventId` is accepted and the key is dropped before persistence. The
  reverse direction is a rejection, because a node typed `trigger` must carry
  `eventId`. Pinned by a named test so the asymmetry reads as deliberate.
- **Existing rows were written under the permissive schema.** They are re-validated
  on the next save, so a pre-existing row with malformed `data` will now fail to
  save rather than silently persisting again. No migration is proposed: 37.0B is a
  Zod fix, and rewriting stored `uiNodes` is F1's 37.10/37.11 concern.

### Decisions

Made:

- **The union discriminates on `node.type`, not `data.type`.** Forced by the
  actual canvas payload; the alternative is a schema no node can satisfy. Verified
  against `WorkflowCanvas.tsx:150-162` and the inferred `AppNode` type before
  choosing, and re-verified with a standalone Zod script before the fix landed.
- **Both actions share one `IncomingNodesSchema`.** The register's point is that
  fixing one path leaves the other writable; a single exported constant makes the
  two impossible to drift.
- **The parsed value is what is compiled and persisted.** Otherwise the check is
  advisory, which is the failure mode this phase exists to remove.
- **Schemas left non-strict.** Adding `.strict()` would refuse unknown keys, but
  it also converts any field added to the canvas later into a hard save failure.
  Stripping keeps the database and the compiled definition limited to
  schema-approved fields, which is the property that matters here.
- **I2 left `compileWorkflow` alone**, per 37.0A's precedent: the compiler is the
  subject of 37.4, and validation ordering is unchanged.
- **The "Malformed workflow data." string is unchanged**, so the create path's
  existing failure contract and the UI's `alert("Failed to save.")` still match.

Pending: none specific to I2.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-09-30 | NOT_STARTED | Phase 37.0B recorded as the I2 ticket, split from 37.0 so the validation fix is not bundled into a feature phase. | `assignments-37-phase-0-audit.md` |
| 2026-09-30 | VERIFIED | Node `data` validated against the intended schemas on create and update; validated value persisted; 23-case suite added; suite proven to fail 19/23 against the inert schema. Gate F satisfied. | `src/tests/workflow/workflow-node-validation.test.ts`; 28 suites / 440 tests |

---

## Phase 37.1 — Action capability registry

### Status

**VERIFIED** · Classification: **P1** · Verified 2026-10-01

### Objective

Establish one authoritative, planner-facing action capability source, derived from
the runtime registry rather than maintained beside it.

### Architectural Role

The first core 37 phase. Everything downstream — proposal schema, reference
validation, prompt — depends on the model being able to know what an action
requires and produces. Phase 0's gate answer is that it currently cannot.

### Inputs / Dependencies

- **Findings:** F3 (no authoritative contract), I4 (registry mismatch)
- **Existing:** `src/lib/workflow-types/type.ts:33-39` (`WorkflowAction`),
  `src/lib/workflow-types/action-registry.ts:12-16` + `:20-22`
  (`ActionRegistry`, `getAction`), `src/lib/workflow-types/registry.ts:19-26`
  (`ActionDef`), sole `getAction` call site
  `src/lib/workflow/execution/wrapper.ts:153`
- **Gate A:** P0 prerequisites closed, or explicitly isolated with a named owner
  and date. Isolation is acceptable here because 37.1 writes no workflows.

### Scope

- Decide and implement where planner-facing action metadata lives.
- Reconcile the two conflicting surfaces.
- Expose schema information to the tool/prompt layer only.
- Cover every action the planner is permitted to generate.

### Out of Scope

- Adding new actions.
- Implementing a second registry alongside the first.
- Any workflow write.
- Resolving I1 or I2.
- Prompt changes (that is 37.13).

### Expected Implementation

Required conceptual information per action:

- action ID
- human description
- required inputs
- optional inputs
- input semantics / schema
- output shape
- referenceable output fields
- compensation capability
- relevant failure / retry semantics

**Trusted execution authority must not be exposed to the model.** `orgId`,
`userId` and `workflowId` continue to come from persisted context
(`AgentSession` for tools, the `Workflow` row for actions —
`src/lib/workflow/actions/core/create-task.ts:36-39`).

The final structure must be decided from actual repository inspection. Do not
assume a shape.

### Deliverables

- **Capability surface:**
  `src/lib/workflow-types/action-capabilities.ts` (new). Client-safe catalog
  keyed by action id; imports only `zod` and `import type { RegisteredActionId }`
  (type-only, erased by `isolatedModules`). Exports `ActionCapability`,
  `inputFields`, `requiredInputFields`, `optionalInputFields`,
  `referenceableOutputFields`, `ActionCapabilities`, `getActionCapability`,
  `CAPABILITY_ACTION_IDS`.
- **Registry coupling:** `src/lib/workflow-types/action-registry.ts` now declares
  `ActionRegistry` as `satisfies Record<string, WorkflowAction>` and exports
  `RegisteredActionId = keyof typeof ActionRegistry`.
- **UI projection:** `src/lib/workflow-types/registry.ts` derives
  `AVAILABLE_ACTIONS` from `ActionCapabilities`; `ACTION_FIELD_PRESENTATION`
  overlay typed `Partial<Record<RegisteredActionId, …>>` and carries no
  `required` key. `AVAILABLE_TRIGGERS` untouched.
- **Tests:** `src/tests/workflow/action-capabilities.test.ts` (new, 32 cases).
- **Docs:** `docs/architecture/workflows/assignments-37-phase-37.1-capability-catalog.md`.

### Acceptance Gate

The planner can obtain authoritative metadata for every action it is allowed to
generate, and no advertised action is unregistered. **Satisfied** — the catalog is
total over the runtime registry (compile-time in both directions) and the UI list
is a projection of it.

### Test Gate

- Every capability entry corresponds to a registered action — **passes**
- No registered action is missing from the capability surface — **passes**
- `task.create` declared inputs match its implementation — **passes**
  (`['title', 'projectId']`)
- `task.create` declared outputs match its implementation — **passes**
  (`['taskId', 'title']`)
- Capability surface contains no trusted identity field — **passes**
  (`orgId`/`userId`/`workflowId`/`runId` rejected by the strict input schema)

### Verification Gate

Unit tests plus an inspection confirming `comment.add` is no longer advertised as
generatable without being registered — or has been registered deliberately.
**Satisfied:** `comment.add` is no longer advertised and was not registered. No
comment executor was written.

### Evidence

```text
Implementation: src/lib/workflow-types/action-capabilities.ts        (new)
                src/lib/workflow-types/action-registry.ts            (modified)
                src/lib/workflow-types/registry.ts                   (modified)
Tests:          src/tests/workflow/action-capabilities.test.ts       (new, 32 cases)
Verification:   npx jest src/tests/workflow/action-capabilities.test.ts → 32 passed
                npx jest                                                 → 31 suites / 490 tests passed
                npx tsc --noEmit                                         → exit 0
                npx eslint on touched files                              → 0 errors / 0 warnings
                Mutation A (remove `title` from capability output)       → 3 failed / 29 passed
                Mutation B (re-advertise `comment.add` in picker)        → 3 failed / 29 passed
                Compile guard (capability, no registration)              → TS2353
                Compile guard (registration, no capability)              → TS1360
Commit/PR:      not committed (working tree per instruction)
Relevant files: see Implementation above; Phase 0 audit unmodified
```

### Known Risks / Findings

**F3 — CLOSED.** A capability contract now exists and is tested.

**I4 — CLOSED.** The UI list is a derived projection; `comment.add` is gone;
`task.create` required inputs and outputs are corrected. The rule is now
structural: an implementation file existing on disk does not make it an available
capability. `communication.send_email` and `utils.generate_report` remain
unexposed.

Risk that materialised and was avoided: creating a *third* surface instead of
reconciling the two existing ones. The catalog is the single surface, and both
the runtime registry and the UI list derive from it.

**I7 — RECORDED (non-blocking).** Conditional routing is not executable or
authorable end-to-end. `executeConditionNode` is unregistered and is not an
`ExecuteFunction`; the canvas never emits `routingConditions`; the evaluator
therefore skips every conditional dependant. 37.1 records this and does **not**
implement it. A scope decision — support generated conditional branches, or
forbid them — is required before Assignment 37 claims either. Does not block 37.2.

### Decisions

Made (2026-10-01): **AD-P1 — planner-facing capability metadata lives in a
separate, client-safe catalog keyed by action id** (`action-capabilities.ts`),
not on the executable `WorkflowAction`. Rationale: executable actions import the
extended Prisma client and must never enter a browser bundle; the capability
catalog is safe to import from client components. The runtime registry remains the
single execution authority and the source of truth for membership. UI
presentation stays in `registry.ts` and controls only presentation (widget type,
field order, labels) — never semantics. Coupling is enforced by typing
`ActionCapabilities` against `RegisteredActionId` and by runtime consistency
tests.

Pending: none for 37.1. Carried forward as an open question, not a 37.1 task:
whether generated conditional branching is in scope (I7).

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-09-30 | NOT_STARTED | Registered as the phase resolving F3 and absorbing I4. | This section. |
| 2026-10-01 | IN_PROGRESS | AD-P1 decided; catalog + registry coupling + UI projection implemented. | `action-capabilities.ts`, `action-registry.ts`, `registry.ts`. |
| 2026-10-01 | TESTING | 32-case suite added; mutation/compile guards run. | `action-capabilities.test.ts`; Mutation A/B; TS2353/TS1360. |
| 2026-10-01 | **VERIFIED** | Suite green (32), full run 31 suites / 490 tests, `tsc` clean, eslint clean; F3 + I4 closed; I7 recorded. | Evidence block above; `assignments-37-phase-37.1-capability-catalog.md`. |

---

## Phase 37.2 — WorkflowProposal schema

### Status

**VERIFIED** · Priority: P1 · Verified 2026-10-12

> Unit tests green (45 cases) and resource bounds hardened. The earlier
> `PARTIALLY_VERIFIED` note cited a real-model-path parse clause; that clause is
> **reassigned to 37.5**, which owns `generateWorkflow`, and is relocated, not
> waived. 37.2's gate — static `A` / `B→A` / `C→A,B` parse, malformed fails
> structurally — is fully satisfied.

### Objective

Create the agent-facing `WorkflowProposal` schema, distinct from the persisted
`WorkflowDefinition`.

### Architectural Role

The typed boundary between model output and everything deterministic. Everything
downstream validates against it.

### Inputs / Dependencies

- 37.1 (capability surface — the action set the proposal may reference)
- Existing: `WorkflowStepSchema` (`src/lib/workflow-types/workflow.ts:12-27`),
  `WorkflowDefinitionSchema` (`:237-251`)

### Scope

- `localRef` / logical step IDs: unique within the proposal, stable,
  workflow-local, never backend-generated
- `action`
- `inputs` (action-specific, strict)
- `dependsOn` (local refs only; empty array = no prerequisite)
- workflow `name` / `description` as the final design supports
- Structural validation

### Out of Scope

- No PostgreSQL IDs
- No `WorkflowRun`
- No QStash data
- No UI coordinates
- No model-owned trusted runtime identity
- No final criticality
- No reference validation (that is 37.3)
- No persistence

### Expected Implementation

Reuse the existing definition where the shapes align. `dependsOn` and `kind` have
direct counterparts; `config` becomes `inputs`. The proposal is a *proposal* —
it deliberately excludes everything the backend owns.

### Deliverables

- `WorkflowProposal` schema — **done**:
  `src/lib/workflow-types/workflow-proposal.ts` (`WorkflowProposalSchema`,
  `WorkflowProposalStepSchema`, `validateWorkflowProposal`)
- Structural validation tests — **done**:
  `src/tests/workflow/workflow-proposal.test.ts` (45 cases)
- Type exports — `WorkflowProposal`, `WorkflowProposalStep`, `ProposalIssue`,
  `ProposalIssueCode`, `ProposalValidationResult`

### Acceptance Gate

A static proposal of `A`; `B -> A`; `C -> A,B` parses cleanly. Malformed actions,
duplicate IDs, bad references and malformed inputs fail **structurally** — not
later, and not at execution time.

### Test Gate

- Valid proposal accepted (linear, fan-out, fan-in, diamond)
- Duplicate `localRef` rejected
- Unknown action rejected
- Malformed dependency rejected
- Strict input structure enforced (unknown keys rejected)
- Oversized proposal rejected
- No DB ID, coordinate, or criticality field present in the schema

### Verification Gate

Unit tests green, plus the static `A` / `B→A` / `C→A,B` parse check and the
structural-failure checks. The real-model-path parse (a `generateWorkflow`
proposal parsing without a compiler fix-up) is **not** part of this gate; it is
owned by 37.5, which builds and exercises the model path, and is recorded in
37.5's Verification Gate. **Satisfied** — 45/45 focused tests; full run 32 suites
/ 535 tests; `tsc` clean; scoped eslint clean.

### Evidence

```text
Implementation: src/lib/workflow-types/workflow-proposal.ts (NEW; bounds hardened)
                reuse: action-capabilities.ts getActionCapability +
                requiredInputFields; resolver reference grammar (resolver.ts:51)
Tests:          src/tests/workflow/workflow-proposal.test.ts (NEW, 45 cases)
Verification:   45/45 focused; full run 32 suites / 535 tests; tsc --noEmit exit 0;
                scoped eslint 0/0. Real-model-path clause reassigned to 37.5.
Commit/PR:      not committed (branch change deferred)
Relevant files: src/lib/workflow-types/workflow-proposal.ts
                src/tests/workflow/workflow-proposal.test.ts
                docs/architecture/workflows/assignments-37-phase-37.2-workflow-proposal-schema.md
```

### Known Risks / Findings

**I4** (from 37.1) — "action must be a registered workflow action" is currently
unenforceable, because `WorkflowStep.action` is `z.string()` and the compiler does
no membership check. 37.1 makes it enforceable. **37.2 enforces it** at the
generation boundary: `validateWorkflowProposal` rejects an action absent from the
capability catalog with `UNKNOWN_ACTION`.

**F2** (surfaced later, at 37.11) — the proposal's `name` belongs in
`Workflow.name`, not `definition.name`.

**Reassigned — real-model-path parse clause.** The former gate clause ("a
proposal produced by the real model path parses without a compiler fix-up step")
cannot be completed in 37.2 because the model-facing generation path
(`generateWorkflow`) is 37.5. It is reassigned to 37.5/37.13 and is recorded in
37.5's Verification Gate. It is relocated, not waived, and its absence does not
make 37.2 `PARTIALLY_VERIFIED`: 37.2's own gate is complete.

### Decisions

Made (2026-10-12, recorded in AD-08 and the phase record):

- Steps are a **record keyed by `localRef`**, not an array — the key is the
  logical identity, so a duplicate id is unrepresentable and no redundant `id`
  field can drift (AD-08).
- Per-action input rules are **reused from the 37.1 capability schema**, not
  restated. Reference templates are forgiven per offending field; unknown keys
  never are.
- A `{{...}}` value is **deferred, not wrong**: reference tolerance uses the
  existing resolver grammar with **no second syntax** (AD-03).
- Validation is **structural only**; dependency existence, acyclicity and
  reference resolution are deferred to 37.3/37.4.
- Resource bounds established: `MAX_PROPOSAL_STEPS = 50`,
  `MAX_PROPOSAL_SERIALIZED_LENGTH = 262144`, `MAX_INPUT_DEPTH = 8`
  (plus name/description lengths). Not the evaluator pass count.
- Resource bounds **hardened (2026-10-12)**: depth is enforced by a bounded,
  non-recursive traversal **before** serialization; the size bound short-circuits
  before action validation; and a value that cannot be serialized (a `BigInt`, a
  cycle) becomes a structured `INVALID_INPUT`/`INPUT_TOO_DEEP` issue rather than a
  thrown error. No bound was weakened and no issue code was added.

Pending: none specific beyond 37.1's carried decision (I7 scope).

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-12 | PARTIALLY_VERIFIED | Schema + validator implemented and tested; model-path verification clause temporarily deferred to 37.5 | 40/40 focused; full run 32 suites / 530 tests; tsc exit 0; eslint 0/0 |
| 2026-10-12 | **VERIFIED** | Bounds hardened against adversarial input; real-model-path clause formally reassigned to 37.5; 37.2's own gate complete | 45/45 focused; full run 32 suites / 535 tests; tsc exit 0; eslint 0/0 |

---

## Phase 37.3 — Reference grammar + validator

### Status

**VERIFIED** · Priority: P1 · Resolves **F6** · Verified 2026-10-12

> Read-only reference validator over `WorkflowProposal`, reusing the resolver's
> `{{…}}` grammar with no second syntax. Enforces `MISSING_DATA_DEPENDENCY` plus
> source-existence, output-path, scope and prototype-path checks. 44 focused
> tests; `resolver.ts` **unmodified**. Trigger output fields fail closed pending a
> real contract.

### Objective

Add deterministic validation of workflow output references, reusing the existing
resolver grammar.

### Architectural Role

Turns "the model produced JSON" into "the model produced a resolvable graph".
The most valuable new validation in Assignment 37.

### Inputs / Dependencies

- 37.2 (`WorkflowProposal`)
- 37.1 (action output contracts, needed to check output paths)
- **Existing resolver:** `src/lib/workflow/execution/resolver.ts` —
  grammar `{{…}}`, path class `[\w.-]` (`:51`); whole-string resolution (`:54-58`);
  interpolation (`:62-73`)
- **Existing namespacing:** `<stepId>.outputs` written by
  `src/lib/workflow/execution/state.ts:57-62`; `trigger.outputs` primed by
  `src/lib/workflow/execution/trigger.ts:20-24`

### Scope

Validate that every output reference in a proposal:

1. refers to an existing step
2. names a path that exists in that step's action output contract
3. has a corresponding execution dependency in `dependsOn`
4. is compatible with the target input where determinable
5. is workflow-scoped — cannot escape to tenant or runtime state
6. nests consistently with resolver behaviour

**Track `MISSING_DATA_DEPENDENCY` as a new validation requirement.**

### Out of Scope

**Do not create a new reference syntax.** The existing `{{…}}` grammar with
`<stepId>.outputs.*` and `trigger.outputs.*` is the vocabulary.

- No modification to the resolver's behaviour
- No second reference language
- No change to context propagation

### Expected Implementation

A read-only validator over the proposal that walks `inputs`, extracts
references using the resolver's own grammar, and checks them against the
capability surface and the dependency graph.

Phase 0 found the resolver has **no** preflight pass, resolves only at dispatch
time, and fails silently: a missing path becomes `""` inside a larger string and
the literal `{{…}}` text when the reference is the whole value. And
`collectWorkflowDefinitionIssues` cross-checks `routingConditions` against
`dependsOn` but never inspects inputs. Nothing currently rejects a step that
reads a sibling's output without depending on it.

### Deliverables

- Reference validator — `src/lib/workflow-types/workflow-proposal-references.ts`
- New issue code(s), including `MISSING_DATA_DEPENDENCY` (also `UNKNOWN_REFERENCE_SOURCE`, `UNKNOWN_OUTPUT`, `MALFORMED_REFERENCE`, `UNAVAILABLE_REFERENCE_SCOPE`, `UNSAFE_REFERENCE_PATH`, `SELF_REFERENCE`)
- Unit tests — `src/tests/workflow/proposal-references.test.ts` (44 cases)
- Zero changes to `src/lib/workflow/execution/resolver.ts` (confirmed: diff empty)

### Acceptance Gate

No generated proposal containing a data reference without the corresponding
execution dependency can pass validation.

### Test Gate

- Valid output reference accepted
- Unknown source step rejected
- Unknown output field rejected
- Missing execution dependency rejected (`MISSING_DATA_DEPENDENCY`)
- Nested reference accepted
- Malformed reference shape rejected
- Reference escaping workflow scope rejected
- Reference into unavailable runtime state rejected
- Resolver file unchanged

### Verification Gate

Unit tests green, plus a diff check proving `resolver.ts` was not modified.

**Satisfied.** 44 focused tests green; full run 33 suites / 579 tests; `tsc
--noEmit` exit 0; scoped eslint exit 0; `git diff --check` clean; `git diff --
src/lib/workflow/execution/resolver.ts` **empty**.

### Evidence

```text
Implementation: src/lib/workflow-types/workflow-proposal-references.ts (new);
                ProposalIssueCode extended in workflow-proposal.ts
Tests:          src/tests/workflow/proposal-references.test.ts — 44 focused
Verification:   npx jest src/tests/workflow/proposal-references.test.ts -> 44/44
                npx jest src/tests/workflow -> 12 suites / 262 tests
                npx jest -> 33 suites / 579 tests
                npx tsc --noEmit -> exit 0
                npx eslint (3 touched files) -> exit 0
                git diff --check -> clean
                git diff -- src/lib/workflow/execution/resolver.ts -> empty
Commit/PR:      not committed (user instruction: no commit/stage for 37.3)
Relevant files: src/lib/workflow-types/workflow-proposal-references.ts,
                src/lib/workflow-types/workflow-proposal.ts,
                src/tests/workflow/proposal-references.test.ts,
                docs/.../assignments-37-phase-37.3-reference-validator.md
```

### Known Risks / Findings

**F6.** No preflight validation; silent failure on missing reference
(`resolver.ts:58`, `:65-67`, with `:66` noting strict failure as a known
unimplemented option); no input-reference/`dependsOn` cross-check.

Note recorded in Phase 0 and *unrated*: the path character class `\w` permits
`__proto__` as a segment, and `getValueByPath` traverses any object it is handed.
No exploit was constructed and severity was not assessed. It is in scope for
37.3 because the grammar is.

**Outcome.** F6 is resolved by a read-only preflight validator; the resolver's
runtime behaviour for existing workflows is unchanged. The prototype-path concern
is addressed for generated proposals via `UNSAFE_REFERENCE_PATH`
(`__proto__`/`prototype`/`constructor`).

**Limitations recorded, not hidden.** (1) No authoritative trigger-output
contract exists, so trigger field references fail closed with `UNKNOWN_OUTPUT`.
(2) `TYPE_MISMATCH` is not implemented: all catalogued outputs are `z.string()`
and no machine-declared cross-field type relationship supports a sound check
without a type-inference layer. Neither limitation weakens the acceptance gate.

### Decisions

Made: **reuse the existing `{{…}}` grammar.** Established in the plan; do not
revisit.

Made: **extend the existing `ProposalIssue` / `ProposalIssueCode` vocabulary**
rather than introduce a parallel issue system. Seven reference codes added.

Made: **direct, non-transitive data-dependency check.** A step that reads
`{{A.outputs.x}}` must itself list `A` in `dependsOn`; dependencies are never
inferred or inserted. DAG existence/cycle checks remain 37.4.

Pending: none.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-12 | IMPLEMENTED | Reference validator module + tests; resolver untouched | 44/44 focused tests; workflow 12/262; full 33/579; tsc exit 0; eslint 0/0; `git diff --check` clean |
| 2026-10-12 | **VERIFIED** | Deterministic module + tests; resolver diff empty; F6 resolved | `git diff -- src/lib/workflow/execution/resolver.ts` empty; 44/44 focused |

---

## Phase 37.4 — Proposal compiler / semantic validation adapter

### Status

**VERIFIED** (2026-10-23) · Priority: P1 · Resolves **F5** · Implemented 2026-10-12

> Deterministic proposal → `WorkflowDefinition` compiler that composes structure,
> reference and graph-semantic validation into one boundary returning structured
> `ProposalIssue[]`. 25 focused tests. `collectWorkflowDefinitionIssues` confirmed
> canonical (AD-P4); `WorkflowDefinitionSchema` unchanged. F5's premise is
> corrected below. Its first production caller arrived with 37.5
> (`generateWorkflow`), but no independent verification carried it to `VERIFIED`
> until 2026-10-23, when 37.11's materialization path existed and a real-Postgres
> production-path test discharged the deferred half of the gate.

### Objective

Establish one deterministic compiler boundary from validated proposal to
executable definition.

### Architectural Role

The place where the "deterministic backend" half of the core boundary is actually
enforced.

### Inputs / Dependencies

- 37.3 (reference validation complete)
- **F5** — `WorkflowDefinitionSchema` exists but is never called in production
- **Existing DAG checks to reuse** (`src/lib/workflow-types/workflow.ts:125-211`):
  `EMPTY_GRAPH`, `ID_MISMATCH`, `DUPLICATE_STEP_ID`, `SELF_DEPENDENCY`,
  `UNKNOWN_DEPENDENCY`, `UNKNOWN_ROUTING_CONDITION`, `CYCLE`
- `WorkflowValidationError` (`:221-235`)
- Current compile call site: `src/lib/workflow/graph-ui/compiler.ts:66-69`

### Required pipeline

```text
LLM output
  → WorkflowProposal validation
  → action capability validation
  → reference validation
  → existing semantic DAG validation
  → compiled executable definition
```

### Scope

- Single deterministic boundary combining all four validation layers.
- Structured error output: `errorType`, `issues[]` with `code`, `path`, `message`.
- Issue codes: `UNKNOWN_ACTION`, `MISSING_INPUT`, `UNKNOWN_OUTPUT`,
  `MISSING_DATA_DEPENDENCY`, `TYPE_MISMATCH`, `CYCLE`.
- Resolve **F5**: decide whether `WorkflowDefinitionSchema` or
  `collectWorkflowDefinitionIssues` is the gate, and make the comment at
  `workflow.ts:42-44` true of production code.

### Out of Scope

**Do not create a second DAG validator.** Reuse `collectWorkflowDefinitionIssues`.

- No executor
- No runtime behaviour change
- No refactor of the existing compiler beyond what the F5 decision requires

### Expected Implementation

A proposal compiler that runs the existing issue collector rather than
reimplementing graph semantics. Structured issues feed 37.14's self-correction
loop.

Phase 0 observed that a compile failure is currently **flattened to prose**:
`describeCompileFailure` (`src/app/actions/workflows/workflow.ts:22-28`) joins
issue messages into one string and the caller cannot branch on `code` or `path`.
Structured output is required for the agent to self-correct.

### Deliverables

- Proposal compiler — `src/lib/workflow-types/workflow-proposal-compiler.ts`
- Structured result type (`WorkflowCompilationResult`) carrying `ProposalIssue[]`
- Reuse tests over the collector's codes (`WorkflowDefinitionIssueCode`)
- F5 resolution note in the plan and Decision Log (this section + AD-P4)

### Acceptance Gate

Proposal validation and existing DAG semantic validation form one deterministic
compiler boundary. Issue `code` and `path` survive to the caller.

### Test Gate

- The three graph checks reachable through a proposal are exercised end-to-end:
  `UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY`, `CYCLE`
- The other four collector codes (`EMPTY_GRAPH`, `ID_MISMATCH`,
  `DUPLICATE_STEP_ID`, `UNKNOWN_ROUTING_CONDITION`) are **not** reachable from a
  proposal by construction: empty proposals are rejected earlier as
  `EMPTY_PROPOSAL`; a proposal's step record key and inner `id` are identical; and
  a proposal cannot express `routingConditions`. The normalization adapter is
  nevertheless asserted total over all seven codes so none can be silently dropped.
- `code` and `path` present in structured output; the cycle sequence survives in
  the issue `message`, never smuggled into `path`
- No duplicate DAG implementation — `collectWorkflowDefinitionIssues` is reused
- F5/AD-P4 decision implemented — the compiler invokes the collector; the
  compiler's own production invocation lands with 37.5

### Verification Gate

Unit tests green, plus a production-path check that the chosen gate runs on
materialization, not only in tests.

**Satisfied 2026-10-23.** The deferred half required a production caller
(37.5) and a materialization path (37.11); both exist and 37.11 is `VERIFIED`.
The production chain is

```text
materializeProposal
  → projectProposalToUIGraph   (proposal-ui-projection.ts:200)
    → compileWorkflowProposal  (workflow-proposal-compiler.ts:181)
      → collectWorkflowDefinitionIssues (stage 4, :203)   ← AD-P4 canonical gate
```

New real-Postgres acceptance suite
`src/tests/agent/proposal-compiler-materialization.realdb.test.ts` (3/3)
proves the gate is **load-bearing** on that path rather than merely invoked: a
proposal whose `dependsOn` forms a cycle — accepted by the proposal schema and
unexamined by the reference validator, so the collector is the only layer that
can reject it — is refused by `materializeProposal` as `PROJECTION_FAILED`
(HTTP 409) with **no `Workflow` row written** and the proposal lifecycle left
`APPROVED`, not advanced. A second case asserts the structured `CYCLE` issue
itself (code, dotted path `steps`, sequence `kickoff -> follow -> kickoff` in
the message) so the *reason* for the refusal is attributed to this gate and not
to a neighbouring check; a control case with the same fixture and an acyclic
graph materializes, proving the refusal was not a malformed fixture.

By this gate 37.4 is `VERIFIED`.

### Evidence

```text
Implementation: src/lib/workflow-types/workflow-proposal-compiler.ts (new);
                ProposalIssueCode extended with 7 graph codes in workflow-proposal.ts
Tests:          src/tests/workflow/workflow-proposal-compiler.test.ts — 25 focused
Verification:   npx jest workflow-proposal-compiler -> 25/25
                npx jest src/tests/workflow -> 21 suites / 369 tests
                npx jest -> 78 suites / 1265 tests
                npx jest --config jest.realdb.config.ts
                  src/tests/agent/proposal-compiler-materialization.realdb.test.ts
                                                       -> 3/3
                npx tsc --noEmit -> exit 0
                npx eslint -> exit 0 (new suite 0 problems)
                git diff --check -> clean
                git diff -- src/lib/workflow/execution/resolver.ts -> empty
Commit/PR:      not committed (user instruction: no commit/stage)
Relevant files: src/lib/workflow-types/workflow-proposal-compiler.ts,
                src/lib/workflow-types/workflow-proposal.ts,
                src/tests/workflow/workflow-proposal-compiler.test.ts,
                src/tests/agent/proposal-compiler-materialization.realdb.test.ts (new),
                docs/.../assignments-37-phase-37.4-proposal-compiler.md
```

### Known Risks / Findings

**F5 — resolved; its premise was inaccurate.** `WorkflowDefinitionSchema` *is*
called in production: `evaluator.ts:223` re-parses the persisted definition with
`WorkflowDefinitionSchema.safeParse(run.workflow.definition)` (added in the
2026-10-01 lint pass). It remains a runtime read-boundary validator, not the
semantic gate. Its `superRefine` re-emits every issue as `z.ZodIssueCode.custom`
and discards the cycle `path` (`workflow.ts:243-250`), so it cannot serve as the
compiler's structured-issue source. `collectWorkflowDefinitionIssues` is the
canonical graph-semantic gate (AD-P4). No production file was changed to close F5.

### Decisions

Resolved: **AD-P4 — `collectWorkflowDefinitionIssues` is the canonical
graph-semantic gate.** The compiler routes graph validation through the collector,
which preserves `code` and cycle `path`; `WorkflowDefinitionSchema` stays the
runtime read-boundary validator and is unchanged.

Made: **no second DAG validator.** The compiler calls the existing collector
(Out of Scope honoured).

Made: **deterministic placeholder identity.** `definition.id` is the constant
`"proposal"` and `definition.name` is `"Compiled Execution Graph"` — never a clock
or proposal-derived value. Real identity belongs to materialization (37.11 / F2 /
AD-P6).

Made: **`ProposalIssueCode` extended with the seven collector codes** so the
normalization adapter is total over `WorkflowDefinitionIssueCode` and cannot
silently drop a future code.

Pending: none.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-12 | IMPLEMENTED | Proposal compiler module + tests; `ProposalIssueCode` extended; F5 + AD-P4 resolved | 25/25 focused; workflow 13 suites / 287 tests; tsc exit 0; eslint 0; `git diff --check` clean; resolver diff empty |
| 2026-10-23 | VERIFIED | Deferred production-path half of the gate discharged now that 37.5's caller and 37.11's materialization path both exist; new real-Postgres suite proves the collector gate is load-bearing on materialization | `proposal-compiler-materialization.realdb.test.ts` 3/3; focused 25/25; workflow 21/369; full 78/1265; tsc 0; eslint 0; `git diff --check` clean; no production source changed by this verification |

---

## Phase 37.5 — `generateWorkflow` agent tool

### Status

**VERIFIED** (2026-10-23) · Priority: P1 · Implemented 2026-10-12

> `generateWorkflow` is registered as a **`READ_ONLY`** tool that compiles a
> model-supplied proposal through `compileWorkflowProposal` and returns either a
> validated proposal (`{ok:true, proposal}`) or structured `INVALID_INPUT` issues.
> It creates no `Workflow`, no `WorkflowRun`, no proposal row, executes no action
> and enqueues no workflow event. 24 focused tests originally; 35 now. The 37.2
> real-model-path parse clause is **discharged** by a live Gemini turn (2026-10-23),
> so the phase is `VERIFIED`. The mocked/scripted path remains the regression
> baseline; live-model evidence is classified separately.

### Objective

Add the macro agent tool that produces a proposal — and nothing else.

### Architectural Role

The point where the model's intent becomes a structured artifact. The macro-tool
framing: one durable agent turn produces the whole blueprint rather than a
reasoning round per node.

### Inputs / Dependencies

- 37.4 (compiler boundary)
- **37.0A VERIFIED — Gate E.** I1 must be closed before this phase becomes a
  workflow-writing or materializing capability.
- **Existing tool registry:** `src/lib/ai/agent/tools/registry.ts` — one object
  binds `tool`, `executor`, `policy`, `describeProposal` (`:60-92`);
  `agentTools` derived (`:103-105`); `requiresToolConfirmation` fails closed
  (`:145-149`)
- **Existing policy:** `src/lib/ai/agent/tools/policy.ts` — `access` derived to
  confirmation (`:52-56`)

### Scope

- Tool definition, executor, policy and proposal describer registered together.
- Proposal-only behaviour.
- Structured validation feedback to the model.
- Self-correction compatibility.
- Trusted backend context remains server-controlled.

### Out of Scope

- **The tool does not execute workflow actions.**
- No direct workflow execution
- No direct action execution
- No `Workflow` row creation (that is 37.11)
- No proposal persistence (that is 37.8)
- No missing-input or criticality state (37.6, 37.7)
- No prompt changes (37.13)

### Expected Implementation

Follow the existing four-way registration pattern so a tool cannot exist on one
side and not the other. The tool returns either a structured validation
observation or a validated proposal awaiting review.

### Deliverables

- `src/lib/ai/agent/tools/generate-workflow/` — `schema.ts` (re-exports the 37.2
  `WorkflowProposalSchema`), `tool.ts` (`tool({inputSchema})`), `execute.ts`
  (compiler call + issue mapping), `describe.ts`, `types.ts`, `index.ts`
- Registry entry `generateWorkflow` in `src/lib/ai/agent/tools/registry.ts`
  (`tool` / `executor` / `policy: READ_ONLY_POLICY` / `describeProposal`)
- Shared `buildStructuredValidationFailure` in
  `src/lib/ai/agent/tools/shared-output.ts` (reuses the existing
  `ToolValidationIssue` + failure shape; no new contract)
- `src/tests/agent/generate-workflow.test.ts`

### Acceptance Gate

The tool is registered, proposes only, and executes nothing. **Met.**

### Test Gate

- Tool appears in the model-visible tool set — **met** (`agentTools` includes it)
- Executor returns structured issues on invalid input — **met**
  (`UNKNOWN_ACTION`, `UNKNOWN_DEPENDENCY`, `CYCLE`, `UNKNOWN_REFERENCE_SOURCE`,
  `MISSING_REQUIRED_INPUT` mapped with `path`/`code`/`message` preserved)
- No action `execute` is reachable from this tool — **met** (spy on
  `createTaskAction.execute` never called; `startWorkflow` / `publishEvent` /
  `prisma.task.*` never called)
- No `Workflow` row is created by this tool — **met** (no workflow model is even
  reachable from the executor)
- Policy is resolved server-side from the tool name — **met**
  (`resolveToolPolicy("generateWorkflow")` → `READ_ONLY`, no confirmation)
- Unregistered-input paths fail closed — **met**

### Verification Gate

Integration test proving a `generateWorkflow` turn produces a proposal artifact
and zero side effects — **met** for the durable tool-result path (persisted under
the exact `toolCallId`, `AGENT_LOOP_REQUESTED` recorded, `completeToolExecution`
called, no workflow-domain write).

**Carried from 37.2 (reassigned 2026-10-12):** inspection confirming that a
proposal produced by the **real model path** parses via `validateWorkflowProposal`
without a compiler fix-up step. This could not run in 37.2 because the model path
did not exist. The 37.5 tests exercise the **mocked/scripted** model path and prove
the parse is a single step with no fix-up.

**Satisfied 2026-10-23.** The carried clause was run live against the configured
`gemini-3.6-flash` through the production `agentModel`, the registered system
prompt, the registered `generateWorkflow` tool definition and its registered
executor. The model emitted a two-step `task.create` proposal; that input passed
`validateWorkflowProposal`, `compileWorkflowProposal` and
`executeGenerateWorkflow` with byte-identical JSON at every stage — no field was
added, renamed, defaulted or repaired, and no `repairToolCall` is configured. The
suite mocks only the Prisma boundary needed to import the registry and keeps the
database guard installed; it claims a live-model parse path, not a live database,
transport, action or workflow write. Those remain 37.16's.

### Evidence

```text
Implementation:  src/lib/ai/agent/tools/generate-workflow/{schema,tool,execute,describe,types,index}.ts;
                 registry.ts entry; shared-output.ts helper
Tests:           npx jest generate-workflow -> 1 suite / 24 tests pass
                 npx jest src/tests/agent -> 18 suites / 321 tests pass
                 npx jest src/tests/workflow -> 13 suites / 287 tests pass
                 npx jest (full) -> 35 suites / 628 tests pass
                 npx tsc --noEmit -> exit 0; scoped eslint -> 0 errors / 0 warnings
                 git diff --check -> clean; resolver/canvas/runtime diffs empty
Verification:    durable tool-result integration case (see Test above)
Commit/PR:       not committed (working tree)
Relevant files:  tracker/phase record/decision log (this doc set)
```

Verification pass 2026-10-23:

```text
Focused:          npx jest src/tests/agent/generate-workflow.test.ts --runInBand
                  -> 1 suite / 35 tests PASS
Live model:       npx jest --config jest.live.config.ts
                    src/tests/agent/generate-workflow.live.test.ts --runInBand
                  -> 1 suite / 1 test PASS (gemini-3.6-flash; 2 steps; task.create)
                  -> validate / compile / execute all succeeded on byte-identical
                     input (mutated in transit: false)
Agent regression: npx jest src/tests/agent --runInBand -> 43 suites / 814 tests PASS
Workflow:         npx jest src/tests/workflow --runInBand -> 21 suites / 369 tests PASS
Full:             npx jest --runInBand -> 78 suites / 1265 tests PASS
Type check:       npx tsc --noEmit -> exit 0
Lint:             npm run lint -> exit 0 (0 errors, 31 pre-existing warnings)
Whitespace:       git diff --check -> exit 0 (CRLF advisories only)
Harness fix:      the live suite initially failed at import because the registry
                  constructs a real PrismaClient; the same two prisma double mocks
                  as the focused suite were added to the test file. No product
                  source changed.
Evidence class:   live-model parse path + unit/mocked integration; no live
                  database, QStash, Redis, Pusher, action execution or deployed
                  behaviour. 37.16 owns the capstone.
Commit/PR:        not committed (user instruction: no commit/stage/push)
```

### Known Risks / Findings

- **I1** — cleared (37.0A VERIFIED), Gate E satisfied.
- **I2** — not yet closed; this phase writes no workflow, so not blocking here.
- The deferred 37.13 prompt still enumerates "exactly three tools"; registering a
  fourth makes that text stale. The tool is nevertheless in `agentTools`; the
  prompt text is a 37.13 item.

### Decisions

Resolved (2026-10-12): **AD-17 — `generateWorkflow` is `READ_ONLY`.** It performs no
workflow-domain write, so gating it behind a pre-execution confirmation would
suppress the compilation and the structured feedback the model needs to
self-correct; the human approval boundary belongs downstream (37.8/37.9), not at
proposal time. The confirmer is therefore unused (presentation only).

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-12 | IMPLEMENTED | Tool module + registry entry + describer + shared failure helper; `READ_ONLY` (AD-17) | 24/24 focused; full 35 suites / 628 tests; tsc exit 0; eslint 0; `git diff --check` clean; resolver/canvas/runtime diff empty |
| 2026-10-23 | **VERIFIED** | Carried 37.2 real-model-path clause discharged by a live Gemini turn through the production model, prompt, registered tool and executor; input validated, compiled and executed unchanged (no fix-up). Focused, agent, workflow and full regressions green; no production source changed | Live suite 1/1 (`gemini-3.6-flash`); focused 35/35; agent 43/814; workflow 21/369; full 78/1265; `tsc` 0; `npm run lint` 0 errors; `git diff --check` clean |

---

## Phase 37.6 — Missing-input state

### Status

**VERIFIED** · Priority: P1 · F4 part 1 (Verified 2026-10-17 for backend protocol + same-session continuation; durable proposal persistence deferred to 37.8; F4 open)

### Objective

Make "the user never supplied this" a first-class, distinguishable outcome — distinct
from "the model made a mistake".

### Architectural Role

One of the three loops the plan requires to be explicitly distinct. Without it,
the model either guesses or produces prose that nothing can act on.

### Inputs / Dependencies

- 37.5 IMPLEMENTED (`generateWorkflow` tool)
- **F4 part 1** — `AgentToolExecution` has no `result` column and no
  `NEEDS_INPUT` status (`prisma/schema.prisma`)
- Existing self-correction path via `AGENT_LOOP_REQUESTED`

### Required semantic distinction & naming contract

- `MISSING_REQUIRED_INPUT`: Validator diagnostic indicating an action input required by capability schema is absent from the generated proposal.
- `NEEDS_USER_INPUT`: Control-flow state and top-level protocol discriminator indicating genuine missing user information that requires human clarification.
- `INVALID_INPUT`: Model-correctable validation error (unknown action, wrong type, cycle, unknown dependency, or unrequested omission).

| Condition | Who resolves it | Protocol Envelope |
|---|---|---|
| `UNKNOWN_ACTION` | Model self-corrects | `INVALID_INPUT` (compiler issue) |
| `INVALID_INPUT` (type/format) | Model self-corrects | `INVALID_INPUT` (compiler issue) |
| `UNKNOWN_DEPENDENCY` | Model self-corrects | `INVALID_INPUT` (compiler issue) |
| `CYCLE` | Model self-corrects | `INVALID_INPUT` (compiler issue) |
| Required field absent, but unrequested | Model self-corrects | `INVALID_INPUT` (`MISSING_REQUIRED_INPUT` issue) |
| Required field genuinely absent from context | **Human is asked** | `NEEDS_USER_INPUT` (clarification outcome) |
| Human approval / rejection | Human decides | Existing confirmation path (`PENDING_CONFIRMATION`) |

### Scope (implemented)

- Protocol representation of `NEEDS_USER_INPUT` (`fields`, `reason`, `question`, optional `candidateValues`, `correlationId`, `proposal`).
- Clarification-intent validation in `generateWorkflowTool` / `executeGenerateWorkflow`:
  * Validates that clarification requests match genuinely missing required inputs.
  * Rejects clarification requests on valid proposals, supplied fields, or invalid/malformed inputs as model errors (`INVALID_INPUT`).
  * Prevents false `NEEDS_USER_INPUT` classification: cycles, unknown actions, and syntax errors remain model-correctable.
- Machine-readable continuation (`submitClarificationAnswer` in `clarification-service.ts`):
  * Auth and session ownership checks; runs under `withAgentSessionLock`.
  * Binds to the pending ask by backend `interactionId` (= `AgentToolExecution.id`) **and** proposal-revision `correlationId`; mismatch is `STALE_CLARIFICATION`.
  * Idempotent duplicate answers (same content) and `CLARIFICATION_CONFLICT` on changed repeats.
  * Re-enters the bounded agent loop via `AGENT_LOOP_REQUESTED` (answer message + outbox event commit together).
- **Lifecycle wiring (remediation):** the tool worker halts on `NEEDS_USER_INPUT` (no `AGENT_LOOP_REQUESTED`), persists the tool-result with the `interactionId`, and publishes a `CLARIFICATION_REQUESTED` status event; a real ingress route `POST /api/agent/session/[sessionId]/clarification` accepts answers; the session GET route exposes the derived pending `clarification`; `redriveStalledSessions` exempts waiting sessions (`skippedWaiting`).
- Bounded model self-correction preserved for ordinary omissions.

### Explicit Persistence-Boundary Decision (37.6 vs 37.8)

- **37.6 owns:** the semantic distinction between model error and missing user information, the `NEEDS_USER_INPUT` protocol contract, the clarification result envelope, and the safe continuation design.
- **37.8 owns:** the final durable proposal-lifecycle storage decision, including reuse of `AgentToolExecution` versus a dedicated `WorkflowProposal` model and any associated schema migration.
- **37.6 must not create a new persistence model or Prisma migration.** (Honored: zero migrations, zero Prisma edits).
- **Full lifecycle durability and restart-survival verification are deferred to 37.8.** They are relocated, not waived.
- **F4 remains open** until its relevant persistence acceptance criteria have actually been satisfied.
- 37.6's protocol and same-session continuation scope is marked `VERIFIED` (2026-10-17); the durability/restart-survival criteria that keep F4 open are owned by 37.8.
- **Documented limitation (not F4):** independent verification cannot establish whether a value the human had
  already supplied was actually present in the prior conversation - the continuation path proves the answer
  matches a genuinely missing required input, but no durable record proves the model omitted a value the human
  had already provided. This is a limitation of the current evidence and is not resolved by 37.8's schema decision.

### Out of Scope (honoured)

- No `WorkflowProposal` table or Prisma migration (deferred to 37.8).
- No schema change to `AgentSessionStatus` or `AgentToolExecutionStatus`.
- No criticality state (37.7).
- No modification to 37.2 `WorkflowProposalSchema`.

### Expected Implementation

A structured `NEEDS_USER_INPUT` result that the agent renders as a user-facing
question. The question text is presentation; the state and fields are machine-readable.

### Deliverables

- Missing-input protocol state: `src/lib/ai/agent/tools/generate-workflow/{types,schema,execute,describe,tool}.ts`
- Shared output helper: `src/lib/ai/agent/tools/shared-output.ts` (`MissingUserInputField`, `ClarificationFailure`, `buildClarificationFailure`, `isClarificationFailure`, `withClarificationBinding`, `readClarificationInteraction`)
- Continuation service: `src/lib/ai/agent/services/clarification-service.ts` (`findPendingClarification`, `getPendingClarification`, `hasPendingClarification`, `submitClarificationAnswer`)
- Ingress route: `src/app/api/agent/session/[sessionId]/clarification/route.ts`; session GET exposes `clarification`
- Worker halt: `src/lib/ai/agent/tool-worker.ts`; status event: `CLARIFICATION_REQUESTED` (`src/lib/ai/agent/types.ts`)
- Reaper exemption: `src/lib/ai/agent/reaper.ts` (`skippedWaiting`)
- Tests: `src/tests/agent/missing-input-protocol.test.ts` (28 tests across Groups A–D), `src/tests/agent/durability.test.ts` (reaper exemption)
- F4 persistence decision recorded in tracker, plan, and issue register.

### Acceptance Gate

Model error and missing user information are distinguishable in the protocol, and
the missing-input state has a machine-readable protocol identity. Full lifecycle
durability across process restart is deferred to 37.8.

### Test Gate

- One missing required input → `NEEDS_USER_INPUT` (when clarification requested)
- Multiple missing inputs → all reported with structured questions and reasons
- Model error → self-correction (`INVALID_INPUT`), **not** a user question
- Template references in required fields accepted as deferred (no missing input issue)
- Null, empty, wrong-type values classified as `INVALID_INPUT`, not missing user input
- Candidate values included only when grounded; omitted when absent
- Clarification state cannot be mistaken for `PENDING_CONFIRMATION`
- Continuation answers validated for auth, correlation, and non-emptiness
- Re-entry through `AGENT_LOOP_REQUESTED` and re-validation via `compileWorkflowProposal`
- No workflow execution or materialization during clarification

### Verification Gate

Integration test: a real missing-input case produces a human question (`NEEDS_USER_INPUT`) rather than
a hallucinated value or false model correction. Full restart-durability verification is deferred to 37.8.

### Evidence

```text
Implementation:  src/lib/ai/agent/tools/generate-workflow/{schema,types,execute,describe,tool}.ts;
                 src/lib/ai/agent/tools/shared-output.ts;
                 src/lib/ai/agent/services/clarification-service.ts
Tests:           npx jest src/tests/agent/missing-input-protocol.test.ts -> 28/28 passed
                 npx jest src/tests/agent/session-step-claim.test.ts -> 5/5 passed (CAS regression)
                 npx jest <4 clarification suites> -> 4 suites / 57 tests passed
                 npx jest durability maintenance -> 2 suites / 59 tests passed
                 npx jest src/tests/agent src/tests/workflow -> 36 suites / 672 tests passed
                 npx jest (full suite) -> 40 suites / 692 tests passed
                 npx tsc --noEmit -> exit 0
                 npx eslint (changed files) -> 0 errors / 0 warnings
                 git diff --check -> clean
                 Prisma schema diff -> empty (no migration)
Verification:    Protocol discrimination + same-session continuation correlation verified; backend scope accepted 2026-10-17. Durability/restart survival deferred to 37.8 (F4 open).
Commit/PR:       not committed (working tree)
Relevant files:  docs/architecture/workflows/assignments-37-{tracker,plan,issue-register}.md;
                 docs/architecture/workflows/assignments-37-phase-37.6-missing-input-protocol.md
```

### Known Risks / Findings

- **F4.** `AgentToolExecution` has no `result` column and no `NEEDS_INPUT` status.
  Durable proposal lifecycle storage decision deferred to 37.8. F4 remains open.
- **I3.** Session-level pause state (`WAITING_INPUT`) does not exist in schema.
  A session waiting for user input relies on client-side answer flow until 37.8.

### Decisions

- **AD-18 — Missing-Input Protocol and Persistence Boundary Decision:**
  1. Naming: `MISSING_REQUIRED_INPUT` is a validator diagnostic; `NEEDS_USER_INPUT` is the control-flow clarification state; `INVALID_INPUT` is model self-correction.
  2. Protocol: Top-level `status: "NEEDS_USER_INPUT"` and `code: "NEEDS_USER_INPUT"` with structured `fields: MissingUserInputField[]`.
  3. Clarification intent: Model explicitly requests clarification for genuinely missing required inputs. Unrequested omissions remain model-correctable.
  4. Durability deferral: Full proposal-lifecycle durability and migration belong to 37.8. No migration in 37.6. F4 remains open.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-14 | IMPLEMENTED | Structured clarification protocol (`NEEDS_USER_INPUT`), clarification-intent validation, continuation service; no migration; durability deferred to 37.8 (AD-18; F4 open) | 21/21 focused; 32 suites / 629 tests; tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |
| 2026-10-14 | IMPLEMENTED (remediated) | Worker halt + `CLARIFICATION_REQUESTED`; real `POST .../clarification` ingress + session GET exposure; `interactionId`+`correlationId` binding; idempotent/conflict continuation under lock; reaper `skippedWaiting`; canonical `computeProposalCorrelationId` | 28/28 focused + durability reaper tests; 32 suites / 638 tests; full suite 658; tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |
| 2026-10-17 | IMPLEMENTED (cleanup) | Enforce `currentStep` compare-and-set predicate in the in-memory prisma double; add `claimNextAgentStep` regression suite (`session-step-claim.test.ts`); correct stale verification totals; correct mocked-boundary comment | 5/5 CAS focused; 3 suites / 87 (`missing-input-protocol durability maintenance`); 3 suites / 83 (`durability maintenance generate-workflow`); 2 suites / 59 (`durability maintenance`); 4 suites / 57 (clarification focused); 36 suites / 672 (agent + workflow); 40 suites / 692 (full); tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |
| 2026-10-17 | VERIFIED | Final acceptance of the backend missing-input protocol and same-session clarification continuation (accepted scope; external UI not claimed); durability/restart survival still OPEN and owned by 37.8; F4 open | `missing-input-protocol` 28/28; `session-step-claim` 5/5; clarification focused 4 suites / 57; agent + workflow 36 suites / 672; full suite 40 suites / 692; tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |

---

## Phase 37.7 — Human criticality state

### Status

**VERIFIED** (2026-10-23) · Priority: P1 · F4 part 2 resolved · Implemented 2026-10-18 · Verified 2026-10-23

### Objective

Make the human criticality decision a durable, backend-owned input to
materialization.

### Architectural Role

Enforces the plan's explicit constraint that **Gemini does not own criticality**.

### Inputs / Dependencies

- 37.6
- **Existing criticality semantics:**
  - `WorkflowStepSchema.isCritical` — `z.boolean()`, default `false`
    (`src/lib/workflow-types/workflow.ts:18`)
  - consumed at `src/lib/workflow/execution/evaluator.ts:188-191` — gates
    **rollback only**
  - final run status is `FAILED` if **any** step failed, regardless of criticality
    (`evaluator.ts:489-501`)
  - sourced from canvas `node.data.isCritical`
    (`src/lib/workflow/graph-ui/compiler.ts:47`)

### Scope

- Durable human criticality decision.
- Backend identifies which steps need a human decision.
- Human-approved value survives materialization.
- Model may propose a **presentation default only**.

### Out of Scope

- Model-owned criticality
- Changes to how the evaluator consumes `isCritical`
- Changes to run-status semantics

### Expected Implementation

A collection of criticality answers bound to specific steps, applied at
materialization. The model can suggest; only the human's answer is stored.

### Deliverables

- Criticality state representation: `src/lib/workflow-types/workflow-criticality.ts`,
  `src/lib/workflow-types/workflow-criticality-set.ts`, `src/lib/ai/agent/services/criticality-service.ts`
- Ingress route: `src/app/api/agent/session/[sessionId]/criticality/route.ts`
- UI controls: `src/features/organizations/components/ai/ProposalReviewCard.tsx` (37.9.1)
- Application at materialization: `src/lib/ai/agent/services/proposal-materialization-service.ts`
- Tests: `src/tests/agent/criticality-integration.test.ts` (2), `src/tests/agent/criticality-service.test.ts` (24),
  `src/tests/agent/criticality-route.test.ts` (19), `src/tests/agent/workflow-criticality.test.ts` (15)

### Acceptance Gate

The stored execution policy comes from the human decision. Model output cannot
set or override `isCritical`.

### Test Gate

- [x] Model cannot set final criticality (`workflow-proposal.test.ts`, `criticality-integration.test.ts`)
- [x] Human criticality persists (`criticality-service.test.ts`, `criticality-integration.test.ts`)
- [x] Confirmed value cannot be overridden by a later model turn (`criticality-integration.test.ts`)
- [x] Criticality changes affect only the intended materialized policy (`workflow-criticality.test.ts`)
- [x] Human-approved criticality survives materialization unchanged (`proposal-materialization.test.ts`, `proposal-materialization.realdb.test.ts`, `criticality-integration.test.ts`)

### Verification Gate

Integration test where the model proposes criticality and the stored value differs,
proving the human decision won.

**Satisfied (2026-10-23):** `src/tests/agent/criticality-integration.test.ts` (2/2) exercises the full boundary:
(1) Model attempts to smuggle `isCritical` in the step definition fail at the schema, tool input and executor boundaries (`INVALID_INPUT`).
(2) Valid proposal generated without criticality parks at `AWAITING_CRITICALITY` with `criticalityDecisions: null`.
(3) Human decides `kickoff: false, follow: true` via `submitCriticalityDecision`; decisions persist in the row and transcript.
(4) Subsequent model turn cannot override confirmed criticality; decision set cannot be bound to differing revision (`REVISION_MISMATCH`).
(5) Upon approval and materialization, stored execution definition and UI graph reflect the human decision (`kickoff: false, follow: true`), proving the human decision won.

### Evidence

```text
Implementation: src/lib/ai/agent/services/criticality-service.ts
                src/lib/workflow-types/workflow-criticality.ts
                src/lib/workflow-types/workflow-criticality-set.ts
                src/app/api/agent/session/[sessionId]/criticality/route.ts
                src/lib/ai/agent/services/proposal-materialization-service.ts
Tests:          src/tests/agent/criticality-integration.test.ts (2/2)
                src/tests/agent/criticality-service.test.ts (24/24)
                src/tests/agent/criticality-route.test.ts (19/19)
                src/tests/agent/workflow-criticality.test.ts (15/15)
                => 4 suites / 60 tests PASS
Verification:   2026-10-23 — criticality-integration.test.ts proves model cannot set/override
                criticality, human decision persists, later model turn cannot override, and stored
                definition on materialization matches human decision.
                Real PostgreSQL persistence verified under 37.11 (proposal-materialization.realdb.test.ts).
                npx tsc --noEmit -> exit 0
                npx eslint src/tests/agent/criticality-integration.test.ts -> exit 0 (0 errors, 0 warnings)
                git diff --check -> exit 0
Commit/PR:      uncommitted (working tree)
Relevant files: src/tests/agent/criticality-integration.test.ts
                src/lib/ai/agent/services/criticality-service.ts
                src/lib/workflow-types/workflow-criticality.ts
```

### Known Risks / Findings

**F4 part 2 — resolved.** Human criticality decisions are durably recorded in `AgentToolExecution.criticalityDecisions` (37.8) and mirrored in the transcript; materialization applies the exact human decision set.

Recorded semantics: `isCritical` gates rollback, **not** final run status. A non-critical failure still ends the run `FAILED`.

### Decisions

Made: Gemini does not own final criticality. The stored execution policy comes from the human decision. (Established in the plan.)

Resolved: Human decision records against `interactionId` and requires exact, complete booleans per step; revision binding recomputed from canonical fingerprint.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-18 | IMPLEMENTED | Durable backend criticality service + ingress route (`POST .../criticality`); human-criticality UI controls added by 37.9.1; F4 part 2 not VERIFIED | Consumed unchanged by `ProposalReviewCard` (37.9.1) |
| 2026-10-23 | **VERIFIED** | Integration suite `criticality-integration.test.ts` (2/2) proves model cannot set/override criticality, human decision persists, later model turn cannot override, and stored definition on materialization matches human decision; 4 suites / 60 tests green; tsc 0; eslint 0 | `criticality-integration.test.ts` 2/2; `criticality-service.test.ts` 24/24; `criticality-route.test.ts` 19/19; `workflow-criticality.test.ts` 15/15; tsc 0; eslint 0 |

---

## Phase 37.8 — Durable proposal persistence

### Status

**VERIFIED** (2026-10-23) · Priority: P1 · **F4 RESOLVED** · Implemented 2026-10-18 · Verified 2026-10-23

### Objective

Give the proposal a durable lifecycle that survives process restarts and
asynchronous boundaries.

### Architectural Role

The plan requires durable state because generation is asynchronous. This phase
decides where that state lives.

### Required lifecycle coverage

```text
generated
  → validated
  → missing input / clarification
  → regenerated
  → criticality
  → approval
  → materialization
```

### Inputs / Dependencies

- 37.6, 37.7 (both states need somewhere to live)
- **F4** — the open fork (resolved via `AgentToolExecution` lifecycle extension)
- `prisma/schema.prisma` — `AgentToolExecution` and `AgentOutboxEvent`

### Scope

- Decide and implement the persistence approach.
- Track: exact proposal identity, validation state, durable inputs, compiled
  representation if required, version/binding concerns, idempotency.

### Out of Scope

**Do not assume either option.** Reuse-vs-new-model is an open decision.

- No `Workflow` row creation (37.11)
- No preemptive migration
- No second outbox

### Expected Implementation

Option 1 chosen and verified:
1. **Reuse / extend `AgentToolExecution`** — holds `input`, `status`, `result`,
   `proposalState`, `proposalFingerprint`, `proposalRevision`, `criticalityDecisions`,
   `clarificationAnswer`, `expiresAt`, `expiredAt`.

### Deliverables

- Chosen persistence implementation — `src/lib/ai/agent/services/proposal-service.ts`
- Lifecycle tests — `src/tests/agent/proposal-lifecycle.test.ts` (37/37)
- Real PostgreSQL 2-Process restart acceptance test — `src/tests/agent/proposal-lifecycle.realdb.test.ts` (10/10)
- Process A writer helper — `src/tests/agent/helpers/proposal-lifecycle-proc-a.realdb.test.ts`
- F4 decision recorded in plan + Decision Log + issue register

### Acceptance Gate

The full lifecycle is durable and idempotent.

### Test Gate

- State survives process restart at every lifecycle point
- Regeneration does not orphan prior state
- Idempotent replay
- Proposal identity is stable and distinct from `definition.id` (see F2)
- No duplicate materialization on retry

### Verification Gate

Integration test that kills and restarts the process mid-lifecycle and confirms
correct resumption.

### Evidence

```text
Implementation: Option 1 (AgentToolExecution extension: proposalState, proposalFingerprint,
                 proposalRevision, criticalityDecisions, clarificationAnswer, expiresAt, result).
Tests:          src/tests/agent/proposal-lifecycle.realdb.test.ts (10/10 PASS in 66s)
                src/tests/agent/helpers/proposal-lifecycle-proc-a.realdb.test.ts (1/1 PASS in 6s)
                src/tests/agent/proposal-lifecycle.test.ts (37/37 PASS in 1s)
                src/tests/agent/criticality-service.test.ts (21/21 PASS)
                src/tests/agent/criticality-integration.test.ts (2/2 PASS)
                src/tests/agent/missing-input-protocol.test.ts (35/35 PASS)
                src/tests/agent/proposal-compiler-materialization.realdb.test.ts (3/3 PASS)
Verification:   Genuine 2-process restart harness: Process A writes proposal to real PostgreSQL
                and terminates cleanly; Process B starts independently, loads records via production
                getPendingProposal, and advances through criticality -> approval -> materialization.
                Full lifecycle matrix verified: AWAITING_CRITICALITY, AWAITING_APPROVAL,
                NEEDS_CLARIFICATION, CLARIFICATION_ACCEPTED, SUPERSEDED, APPROVED, DECLINED,
                EXPIRED, MATERIALIZED. State-specific recovery paths proven. Reaper exemption
                verified. Zero database leftovers verified.
Commit/PR:      In-flight (unstaged)
Relevant files: src/lib/ai/agent/services/proposal-service.ts
                src/lib/ai/agent/services/criticality-service.ts
                src/lib/ai/agent/services/clarification-service.ts
                src/lib/ai/agent/services/proposal-decision-service.ts
                src/lib/ai/agent/services/proposal-materialization-service.ts
                src/tests/agent/proposal-lifecycle.realdb.test.ts
                src/tests/agent/helpers/proposal-lifecycle-proc-a.realdb.test.ts
```

### Known Risks / Findings

**F4.** RESOLVED (2026-10-23). Proposal lifecycle persisted directly on `AgentToolExecution`.

**F2.** RESOLVED at 37.11.

### Decisions

Resolved: **F4 — reuse and extend `AgentToolExecution`.**
Migration applied (`20261017120000_agent_proposal_lifecycle`). Process-restart survival proven against real PostgreSQL.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-18 | IMPLEMENTED | Durable proposal lifecycle on an amended, unapplied migration; durability/restart survival OPEN (F4) | `assignments-37-phase-37.8-proposal-lifecycle.md`; migration applied to no database |
| 2026-10-23 | VERIFIED | Real-PG 2-process restart survival and full lifecycle matrix acceptance suite passing (10/10); F4 resolved | `src/tests/agent/proposal-lifecycle.realdb.test.ts` (10/10); `proposal-lifecycle-proc-a.realdb.test.ts` (1/1); zero leftovers verified |

---

## Phase 37.9 — Existing confirmation integration

### Status

**VERIFIED** · Priority: P1 · Verified 2026-10-23

### Objective

Present the proposal for human approval on top of the existing 35/36 confirmation
gate.

### Architectural Role

Approval is the last human checkpoint before materialization. The mechanism is
already correct; the surface is the work.

### Inputs / Dependencies

- 37.8 (durable proposal to approve)
- **Existing behaviour already present and to be reused:**
  - confirm endpoint takes **no replacement body** by design
    (`src/app/api/agent/session/[sessionId]/executions/[executionId]/confirm/route.ts:5-8`)
  - executed arguments are exactly those persisted in
    `AgentToolExecution.input`
  - `loadConfirmationTarget` + `decideConfirmation` enforce auth, ownership and
    transition
  - `confirmToolExecution` commits transition and dispatch intent together (`:93-96`)
  - repeat confirmation returns 200 without re-dispatching (`:80-91`)
  - session GET re-derives the proposal from persisted input, only while
    `PENDING_CONFIRMATION` (`src/app/api/agent/session/[sessionId]/route.ts:95-99`)

### Scope

- Review surface only: workflow name, step count, dependency structure, actions,
  missing-input resolutions, criticality decisions.
- Presentation of parallel groups / critical path (optional).

### Out of Scope

**Do not rebuild confirmation infrastructure.**

- No new confirmation mechanism
- No new approval endpoint
- No regeneration of arguments at approval time

> **[CORRECTED — Phase 1 audit + owner decision, 2026-10-18]** Two of these are
> wrong for a proposal:
>
> - **"No new approval endpoint" is false.** The 35/36 confirm endpoint is bound
>   to `PENDING_CONFIRMATION`; a proposal's `generateWorkflow` execution is
>   `COMPLETED`. Approving through it would queue a second execution of a tool
>   that already ran. 37.9 adds `proposal-approval` and `proposal-decline`
>   endpoints (body strictly `{ interactionId }`).
> - **"No confirmation mechanism" is refined, not violated.** The 35/36
>   *mechanism* (auth, ownership, lock, CAS, idempotency, audit) is reused as a
>   pattern; it is not changed. The existing 35/36 tests are untouched and still
>   pass. Cancel and tool-approval expiry semantics are unchanged.
>
> Also revised: **decline** is now a first-class terminal state (`DECLINED`), and
> an unanswered review is closed to `EXPIRED` by the maintenance reaper. See
> [Decision 23](../agent/decisions.md).

### Expected Implementation

Render the persisted proposal. Nothing about the approval mechanism changes.

### Deliverables

- Review surface — `src/features/organizations/components/ai/ProposalReviewCard.tsx`
  (over the pure projection `src/lib/ai/agent/services/proposal-review.ts`)
- Surface tests
- Documentation that approval binds the exact proposal

> **[UPDATED — 37.9, 2026-10-18]** The component path is no longer UNKNOWN, and
> the mechanism deliverables are now known:
> `src/lib/ai/agent/services/proposal-decision-service.ts`;
> `src/app/api/agent/session/[sessionId]/proposal-approval/route.ts`;
> `.../proposal-decline/route.ts`; the `expireStaleProposalReviews` sweep in
> `src/lib/ai/agent/reaper.ts`. See the 37.9 record.

### Acceptance Gate

The human reviews the exact proposal that will materialize, and cannot be made to
approve a different one.

### Test Gate

- Exact proposal bound to approval
- Modified proposal cannot reuse a prior approval
- Cancel works
- Expiry works
- Duplicate confirmation is idempotent
- No mechanism change — existing 35/36 tests still pass

### Verification Gate

End-to-end review-surface test with a real pending proposal.

**Satisfied.** Real-PostgreSQL acceptance suite `src/tests/agent/proposal-review-integration.realdb.test.ts` (5/5 PASS) tests an end-to-end review surface with a real pending proposal, proving:
1. Pending proposal exposure with Kahn-ordered review steps and static React SSR rendering of `ProposalReviewCard` with actionable controls.
2. Proposal approval route committing atomic CAS transition to `APPROVED` and `forge:proposal-decision:v1` audit message.
3. Proposal decline route transitioning to `DECLINED` and rejecting approval reversals (`409 PROPOSAL_ALREADY_DECIDED`).
4. Revision binding rejecting approval on superseded proposals (`409 PROPOSAL_NOT_AWAITING_APPROVAL`) while exposing the active revision.
5. Review reaper expiry sweeping past-due proposals to `EXPIRED` and rejecting subsequent approval (`409 PROPOSAL_EXPIRED`).

### Evidence

```text
Implementation: VERIFIED (2026-10-23) — proposal-specific approve/decline; review expiry; real-DB review surface integration
Tests:          src/tests/agent/proposal-review-integration.realdb.test.ts — 5/5 PASS (real PostgreSQL)
                src/tests/agent/proposal-decision.test.ts — 19/19
                src/tests/agent/proposal-approval-route.test.ts — 44/44
                src/tests/agent/proposal-review-expiry.test.ts — 35/35 (incl. 10 37.14 wait-CAS tests)
                src/tests/agent/proposal-review-model.test.ts — 12/12
                src/tests/agent/proposal-review-card.test.tsx — 28/28 (incl. 9 37.11 materialization tests)
                src/tests/agent/workflow-proposal-panel.test.tsx — 19/19 (incl. 4 37.10 preview tests)
                src/tests/agent/clarification-request-card.test.tsx — 11/11
                Total focused test evidence: 168 unit/integration + 5 real-DB acceptance = 173 tests passing
Verification:   tsc 0; eslint 0; prisma validate OK; diff --check clean; zero DB leftovers verified
Commit/PR:      — (not staged)
Relevant files: src/features/organizations/components/ai/ProposalReviewCard.tsx
                src/features/organizations/components/ai/WorkflowProposalPanel.tsx
                src/lib/ai/agent/services/proposal-decision-service.ts
                src/app/api/agent/session/[sessionId]/proposal-approval/route.ts
                src/app/api/agent/session/[sessionId]/proposal-decline/route.ts
                src/lib/ai/agent/services/proposal-review.ts
                src/lib/ai/agent/reaper.ts (expireStaleProposalReviews)
                src/tests/agent/proposal-review-integration.realdb.test.ts
                docs/architecture/workflows/assignments-37-phase-37.9-proposal-review.md
```

> **Status: VERIFIED (2026-10-23).** Acceptance criteria satisfied against real PostgreSQL. Approval strictly binds exact proposal and revision; changed proposal cannot reuse it.

### Known Risks / Findings

**F2** — the review surface's "workflow name" must read `Workflow.name`, not
`definition.name` (a hardcoded placeholder).

### Decisions

Made: reuse the 35/36 confirmation system. No special architecture.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-19 | IMPLEMENTED | Proposal-specific approve/decline/expiry ingress (37.9) plus human-criticality controls, workflow-builder panel and clarification answer card (37.9.1); not VERIFIED | 3 focused suites 19/11/15; agent 34/647; full 51/954; tsc clean; eslint 0 changed; prisma valid. `assignments-37-phase-37.9-proposal-review.md` §14 |
| 2026-10-23 | VERIFIED | Real-PG confirmation review integration suite passing (5/5); 7 focused unit/integration suites 168/168 passing; SSR card render and revision binding verified | `src/tests/agent/proposal-review-integration.realdb.test.ts` (5/5); zero leftovers verified; `assignments-37-tracker.md` |

---

## Phase 37.10 — UI graph projection / deterministic layout

### Status

**VERIFIED** · Priority: P2 · Verified 2026-10-23 · **F1 (ordering half = AD-11; persistence verified at 37.11)**

### Objective

Derive `uiNodes` and `uiEdges` deterministically from a validated proposal.

### Architectural Role

**This phase's position changed because of F1.** Persistence in Forge is
canvas-first: `saveWorkflowState` and `updateWorkflowState` both accept
`uiNodes`/`uiEdges` and call `compileWorkflow`, `IncomingNodeSchema` makes
`position` mandatory, and **no definition → UI reverse projection exists anywhere
in the codebase**. UI projection is therefore a *precondition* of persistence, not
a consequence of it. The original plan sequenced 37.11 before 37.10; that order is
inverted and corrected here.

### Inputs / Dependencies

- 37.9 (approved proposal)
- 37.0B VERIFIED (generated nodes must cross a boundary that actually validates)
- **F1**
- Node shape: `AppNode` = `TriggerNodeType | ActionNodeType`
  (`src/lib/workflow-types/workflow.ts:278-282`)
- `TriggerNodeDataSchema` / `ActionNodeDataSchema` (`:258-272`)

### Scope

- Deterministic UI node generation.
- Deterministic positions / layout.
- `uiEdges` derived from the dependency structure.
- No Gemini-generated coordinates.
- No independent topology source.

### Out of Scope

- No coordinates from the model
- No second graph representation that can disagree with the definition
- No `Workflow` row creation (37.11)

### Expected Implementation

A deterministic projection: same proposal in, same `uiNodes`/`uiEdges` out, every
time. Layout algorithm choice is a design decision for this phase.

### Deliverables

- Projection implementation — `src/lib/workflow-types/proposal-ui-projection.ts`
- Layout contract (`PROPOSAL_UI_LAYOUT`, longest-path layers) recorded in code + phase doc
- Determinism / layout / criticality tests — `src/tests/workflow/proposal-ui-projection.test.ts`
- Read-only preview — `src/features/organizations/components/ai/ProposalGraphPreview.tsx`
  (+ gating in `WorkflowProposalPanel.tsx`, binding in the session GET)

### Acceptance Gate

Projection is deterministic and Gemini-free. `uiEdges` derive from `dependsOn`,
not from an independent source.

### Test Gate

- Identical proposal → identical output (repeated runs)
- `uiEdges` count and topology match `dependsOn`
- All nodes carry valid `position`
- Nodes satisfy the (fixed, 37.0B) node schema
- No coordinate originates from model output

### Verification Gate

Determinism test over repeated runs, plus a schema-validity check against the
repaired boundary.

**Satisfied (2026-10-23).** Determinism proven across repeated runs with shuffled keys and dependencies (`proposal-ui-projection.test.ts`). Schema validity proven against `ActionNodeDataSchema` and `IncomingNodesSchema`. Edges derived exclusively from `dependsOn`. Downstream materialization and round-trip canvas recompilation verified against real PostgreSQL (`proposal-materialization.realdb.test.ts` 11/11).

### Evidence

```text
Implementation: src/lib/workflow-types/proposal-ui-projection.ts
                src/lib/workflow-types/workflow-criticality-set.ts (37.7 contract split, client-safe)
                src/features/organizations/components/ai/ProposalGraphPreview.tsx
                src/features/organizations/components/ai/WorkflowProposalPanel.tsx (gating, additive fields)
                src/app/api/agent/session/[sessionId]/route.ts (server-side revision binding)
Tests:          src/tests/workflow/proposal-ui-projection.test.ts — 33/33 PASS
                src/tests/agent/proposal-graph-preview.test.tsx — 7/7 PASS
                src/tests/agent/workflow-proposal-panel.test.tsx — 19/19 PASS
                src/tests/agent/session-read.test.ts — 23/23 PASS
                Downstream real-PostgreSQL materialization:
                src/tests/agent/proposal-materialization.realdb.test.ts — 11/11 PASS
Verification:   2026-10-23 — 4 focused suites 82/82 PASS; real-DB materialization 11/11 PASS;
                tsc --noEmit 0; eslint 0; prisma validate valid; git diff --check clean;
                3 non-vacuity mutations confirmed failing then reverted green
Commit/PR:      — (not committed)
Relevant files: docs/architecture/workflows/assignments-37-phase-37.10-ui-graph-projection.md
```

### Known Risks / Findings

**F1** — canvas-first persistence is the reason for this phase's ordering.
**I2** — must be VERIFIED first, or generated nodes cross the boundary
unvalidated.

### Decisions

**F1 — the ordering half is decided (AD-11): projection precedes persistence.**
The remaining F1 choice (which canvas-first write path materialization uses) belongs
to 37.11. Note: a definition-first write path creates a second write path that must
independently replicate the validation and authorization properties of the first —
precisely what I1 shows can be got wrong.

Implemented decisions, recorded in `assignments-37-phase-37.10-ui-graph-projection.md`:
hand-rolled longest-path layout (no layout library); delegation to 37.4/37.7 with no
re-validator and no `?? false`; 37.7 contract split into a client-safe module (build
hazard, not a fallback hack); revision binding computed server-side; preview is
read-only and gated on a complete, revision-bound criticality set.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-19 | IMPLEMENTED | Projection + layout + read-only preview + server-side binding; 4 focused suites; full 53/1005 green; tsc/eslint/prisma clean; 3 mutations reverted | `assignments-37-phase-37.10-ui-graph-projection.md` |
| 2026-10-23 | **VERIFIED** | Authoritative verification pass: 4 focused suites (82/82 PASS) + downstream real-DB materialization (11/11 PASS); determinism, longest-path layout, schema conformance and preview gating verified | `proposal-ui-projection.test.ts`, `proposal-materialization.realdb.test.ts`, `assignments-37-tracker.md` |

---

## Phase 37.11 — Workflow materialization

### Status

**VERIFIED** · Priority: P2 · **F1 + F2** · Verified 2026-10-23

> Materialization is implemented and the previously open real-PostgreSQL
> round-trip gate is now closed. `src/tests/agent/proposal-materialization.realdb.test.ts`
> runs the real service and transaction against Postgres: 11/11 covering
> materialize → load → recompile, provenance surviving a real canvas re-save,
> transaction rollback on the unique index, concurrent double-start, idempotency,
> tenant isolation, and the absence of `WorkflowRun`/`Task`/outbox side effects.
> See *Evidence*, *Status History* and the Verification Ledger.

### Objective

Materialize an approved proposal into a `Workflow` row with a compiled
definition, via the persistence path chosen in 37.10.

### Architectural Role

Where a proposal becomes something the existing engine can run.

### Actual current persistence path — canvas-first

Materialization must **not** be described as:

```text
WorkflowProposal → WorkflowDefinition → save
```

…unless a definition-first write path has actually been added. The real path is:

```text
Proposal
  → validated logical graph
  → UI graph / layout          (37.10)
  → existing canvas-first persistence
  → compiled WorkflowDefinition
```

Or, if 37.10's decision selects it, a future definition-first boundary.

### Inputs / Dependencies

- 37.10 (UI projection)
- 37.9 (approval)
- 37.0A and 37.0B both VERIFIED
- `saveWorkflowState` (`src/app/actions/workflows/workflow.ts:43-90`)

### Scope — including F2

- `definition.id` is compiler-generated (`compiled_${Date.now()}`,
  `src/lib/workflow/graph-ui/compiler.ts:61`) and **must not** be relied on for
  provenance.
- `definition.name` is a hardcoded placeholder (`"Compiled Execution Graph"`,
  `compiler.ts:62`).
- The human-facing workflow identity is `Workflow.name`.
- **Stable provenance must not depend on `definition.id`.**
- Organization identity remains backend-controlled.
- The `Workflow` primary key is generated by persistence, never by the model.
- Local step IDs remain logical workflow identifiers.

### Out of Scope

- No `Task` row per generated node
- No model-supplied DB IDs
- No bypassing the persistence boundary
- No change to the engine

### Expected Implementation

Use the chosen 37.10 path. Attach provenance only if the `definition` contract
can carry a stable key — which today it cannot, so provenance likely needs a
`Workflow` column rather than a `definition` field.

### Deliverables

- Materialization implementation — path **UNKNOWN**
- Provenance decision and implementation
- Tests

### Acceptance Gate

A materialized workflow is executable by the existing engine, carries the correct
human-facing name, and has stable provenance independent of `definition.id`.

### Test Gate

- Persisted workflow compiles and validates
- `Workflow.name` matches the approved proposal name
- Provenance survives a re-save of the canvas
- Organization id comes from backend context, never the proposal
- No `Task` rows created at materialization
- Local step IDs preserved as step identifiers

### Verification Gate

Round-trip test: materialize → load → recompile → same logical graph.

### Evidence

```text
Implementation: src/lib/ai/agent/services/proposal-materialization-service.ts
                  (materializeProposal; CAS APPROVED -> MATERIALIZED before create;
                   provenance = durable AgentToolExecution.id; triggerless inactive)
                src/lib/ai/agent/services/proposal-materialization.ts
                  (expectValidMaterializationPayload; shared save-boundary validation)
                src/lib/workflow-types/proposal-ui-projection.ts (reused verbatim)
                src/app/api/agent/session/[sessionId]/proposal-materialize/route.ts
                src/lib/workflow-types/workflow-criticality.ts (reused contract)
Tests:          src/tests/agent/proposal-materialization.test.ts
                src/tests/agent/proposal-materialization-boundary.test.ts
                src/tests/agent/proposal-materialize-route.test.ts
                src/tests/agent/proposal-materialization.realdb.test.ts (NEW, 2026-10-23)
Verification:   2026-10-23 real-PostgreSQL: 11/11 (--config jest.realdb.config.ts)
                mocked: 3 suites / 60 tests
                npx tsc --noEmit -> exit 0
                npx eslint <new suite> -> exit 0
                git diff --check -> clean
                Round trip proven: stored uiNodes/uiEdges recompile to the stored
                definition (actions, dependsOn, config, isCritical, kind).
                Rollback proven: a unique-index failure leaves proposalState APPROVED.
Commit/PR:      not committed (working tree preserved)
Relevant files: src/lib/ai/agent/services/proposal-materialization-service.ts,
                src/lib/ai/agent/services/proposal-materialization.ts,
                src/tests/agent/proposal-materialization.realdb.test.ts
```

### Known Risks / Findings

**F1 — resolved.** Materialization persists the verbatim 37.10 UI projection and
stores the workflow triggerless (`eventId: null` / `isActive: false`); no synthetic
trigger is invented.

**F2 — resolved.** Provenance is `Workflow.sourceProposalId` (the durable
`AgentToolExecution.id`), not `definition.id`. `Workflow.name` is
`proposal.name`. The real-DB suite proves provenance survives a real canvas
re-save.

**I1**, **I2** — both P0, both VERIFIED before this phase.

### Decisions

Resolved: **F1** — reuse the canvas-first projection and the shared
`IncomingNodesSchema`/`IncomingEdgesSchema` boundary; triggerless by design.
Resolved: **F2** — provenance lives on `Workflow.sourceProposalId`, not in the
`definition` contract.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-20 | IMPLEMENTED | Materialization service, ingress, UI action and mocked suites; migration applied; real-DB round trip still open | 4 new suites 33/17/10/15; full 56/1074; tsc 0; eslint 0 |
| 2026-10-23 | **VERIFIED** | Real-PostgreSQL acceptance closes the round-trip gate; source inspection and tests confirm F1/F2, rollback, concurrency, idempotency and tenant isolation | `proposal-materialization.realdb.test.ts` 11/11; mocked 60/60; tsc 0; eslint 0; `git diff --check` clean |

---

## Phase 37.12 — Execution handoff

### Status

**VERIFIED** · Priority: P1 · Verified 2026-10-23

> **VERIFIED 2026-10-23.** The handoff reuses the existing engine via an
> explicit, authenticated, tenant-scoped user action; no second runtime exists.
> The runtime-input trust boundary is validated, bounded and optional, and the
> canvas no longer fabricates a `mockProjectPayload`. Gate G (I6) was already
> `VERIFIED` on 2026-10-20, and this pass re-ran it green.
>
> **Evidence-class caveat, recorded deliberately:** the real-PostgreSQL handoff
> suite mocks `advanceWorkflow`, so it proves authenticated tenant-scoped
> `WorkflowRun` creation but not live queue dispatch. End-to-step dispatch is
> proven by `workflow-integration-diamond.test.ts` against the assembled real
> evaluator/worker/resolver/action with persistence and transport mocked. Live
> QStash execution is not claimed here; it belongs to 37.15/37.16.

### Objective

Hand a materialized `Workflow` to the existing execution engine.

### Architectural Role

Proves the core boundary: the existing runtime is the execution authority.

### Inputs / Dependencies

- 37.11 (materialized workflow)
- **I6 VERIFIED — Gate G (2026-10-20). Cross-tenant workflow execution is closed
  by its own ticket, proven by a real-PostgreSQL acceptance run.** See *Current
  Blockers → I6*.

### Precondition — I6, cross-tenant workflow execution

> **This phase cannot become `VERIFIED` unless I6 is `VERIFIED`.**
>
> **SATISFIED 2026-10-20 — I6 is `VERIFIED`; Gate G is met.** The source fix
> landed and its mocked suites are green, and the **real-PostgreSQL acceptance
> run has passed** (`src/tests/security/i6-cross-tenant.realdb.test.ts`, 10/10):
> an org-A caller cannot start org B's workflow, no `WorkflowRun` row is created,
> foreign and missing are indistinguishable, and the same-org positive path still
> builds a `RUNNING` run. See `docs/dev-log/2026-10-20-i6-real-db-acceptance.md`.
> The historical text is retained unmodified below.

`triggerWorkflowRun` (`src/app/actions/workflows/workflow-run.ts:5`) performs no
authentication and no organization check, and `startWorkflow`
(`src/lib/workflow/execution/trigger.ts:8`) loads the workflow with
`findUnique({ where: { id: workflowId } })` — no `orgId`. That is the entrypoint
this phase hands work to.

**Gate E does not satisfy Gate G.** I1 is the write path; I6 is the execution
path. They are separate defects with separate regression tests, and closing I1
leaves `startWorkflow` unscoped.

Proposal generation may exist before this gate. A proposal that has passed every
validation gate in 37.2–37.9 is still not a trusted workflow, because validation
establishes that a graph is *well-formed*, never that the caller is *entitled to
run it*. Assignment 37 must not treat generated workflow execution as trusted
until the existing execution entrypoint enforces tenant scope.

**Gate G is a precondition, not a deliverable of 37.12.** I6 is fixed by its own
ticket, before 37.12, and that ticket must cover every reachable caller of the
unscoped primitive — including
`src/app/api/workflow/test/[workflowId]/test-run/route.ts`, which reaches
`startWorkflow` with no authentication of its own. A ticket that fixes only the
server action does not satisfy this gate.

### Scope

```text
Workflow → WorkflowRun → existing evaluator
```

- Run creation
- Evaluator entry
- Action dispatch via existing `step.action → getAction(actionId) → execute`

### Out of Scope

**Explicitly prohibited:**

- Second DAG executor
- Second QStash node runner
- Second Redis lock protocol
- Fork/join subsystem
- Any change to the evaluator, wrapper, mutex or resolver
- Fixing I6 here. This phase consumes a tenant-scoped entrypoint; it does not
  build one.

### Expected Implementation

No new machinery. The existing path is the path.

### Deliverables

- Handoff integration — **DONE**. The persisted, materialized `Workflow` is
  started by the existing `startWorkflow` (`lib/workflow/execution/trigger.ts`),
  reached only through the authorization-checked `triggerWorkflowRun` server
  action bound to the editor's Run control. No new run-creation site exists.
- Runtime-input trust boundary — **DONE**. `src/lib/workflow/execution/trigger-context.ts`
  validates the caller-supplied trigger context (bounded depth/size, JSON-only,
  no tenant/identity/prototype keys); the action refuses invalid context before a
  run is created. Generated workflows supply none.
- Integration tests — **DONE** (mocked handoff, validator unit, UI control,
  source-invariant, and a real-PostgreSQL handoff acceptance suite).

### Acceptance Gate

A generated workflow successfully enters and runs in the existing execution
engine, **and I6 is `VERIFIED`**. Without the second condition this phase is
`BLOCKED`, not `VERIFIED`, no matter how well the handoff works.

### Test Gate

- `WorkflowRun` created
- Evaluator dispatches ready steps
- Actions dispatch through `getAction`
- No new executor, lock, or queue runner added to the codebase
- Existing workflow tests still pass unchanged
- I6's own regression test passes: cross-tenant run refused, no `WorkflowRun`
  created, same-tenant run succeeds

### Verification Gate

Integration test proving end-to-step dispatch through the existing engine only,
**plus recorded evidence that I6 is `VERIFIED`.** Either alone is insufficient.

### Evidence

```text
Implementation: 2026-10-21 (not committed — reported for review)
  - src/app/actions/workflows/workflow-run.ts       (validated trigger context; no free-form blob)
  - src/lib/workflow/execution/trigger-context.ts   (NEW — runtime-input trust boundary)
  - src/features/organizations/components/workflow/RunWorkflowButton.tsx (no fabricated payload; pending/error guard)
  - src/features/organizations/components/workflow/WorkflowCanvas.tsx    (removed mockProjectPayload + dead import)
Tests:
  - execution-handoff.test.ts            5/5  (mocked; real startWorkflow path)
  - trigger-context.test.ts             10/10 (validator unit)
  - run-workflow-button.test.tsx         5/5  (UI handoff / single-submission / retry)
  - execution-boundary-invariants.test.ts 4/4 (source invariants: one run-creation site)
  - workflow-run-boundary-scope.test.ts 10/10 (updated for the new refusal contract)
  - execution-handoff.realdb.test.ts     5/5  (REAL PostgreSQL acceptance)
  - i6-cross-tenant.realdb.test.ts      10/10 (regression; updated refusal case)
  - default suite: 68 suites / 1168 tests green; focused workflow+security: 26/403
Verification:   2026-10-23 verification pass:
                - execution-handoff 5/5, trigger-context 10/10,
                  execution-boundary-invariants 4/4, workflow-run-boundary-scope 10/10
                  => 29/29 (mocked)
                - run-workflow-button 5/5 + diamond 9/9 => 14/14
                - realdb: handoff 5/5, i6 10/10
                - tsc --noEmit exit 0; scoped eslint exit 0; git diff --check clean
Commit/PR:      — (not staged/committed this pass)
Relevant files: src/lib/workflow/execution/trigger.ts (unchanged — sole run-creation site)
                src/lib/ai/agent/services/proposal-materialization-service.ts (unchanged)
```

**Note on real-DB runs.** The isolated-PostgreSQL suites pass reliably when run
with `--runInBand` against a healthy connection; the shared Neon fixture is
intermittently unreachable under rapid repeated runs (`Can't reach database
server`), which affects I6 equally and is environmental, not a suite defect.

### Known Risks / Findings

**I6 — P0, separate ticket, gate for this phase.** The engine itself is the
hardened surface 37 depends on and must not be rebuilt. The defect is not in the
engine: it is the missing tenant check at the entrypoint that reaches it, which
this phase is the first to depend on from generated material. *Resolved — I6 is
`VERIFIED` (2026-10-20).*

**I8 (recorded 2026-10-21) — runtime-input trust boundary at the handoff.** The
`triggerWorkflowRun` action accepted an unconstrained
`triggerPayload: Record<string, JsonValue>` that became
`WorkflowRun.context.trigger.outputs`. Two problems: (a) the canvas fabricated a
`mockProjectPayload` (`projectId` unrelated to the workflow being run), inventing
runtime data; (b) a caller could name tenant/identity keys (`orgId`, …) in the
payload. The tenant was never actually at risk — `orgId` is server-derived from
the verified slug — but the boundary was implicit and relied on the resolver
ignoring smuggled keys. **Fix:** validate the trigger context at the server
boundary (bounded, JSON-only, reserved keys refused). Not a P0 (no authority was
reachable); recorded to make the refusal explicit. No second executor, lock, or
queue runner was added; `startWorkflow` remains the sole run-creation site
(asserted by `execution-boundary-invariants.test.ts`).

**Multiple-run policy preserved.** A repeated, separate start (retry, second
tab) still creates a second run — this is the engine's existing, deliberate
behaviour and was preserved, not changed. The Run control's `submitting` guard is
a UI affordance only; it is not server-side idempotency.

### Decisions

Made: the existing engine is the executor. No second runtime.

Made: I6 is a precondition for this phase, and is not satisfied by Gate E (I1).

Made (2026-10-21): the handoff trigger context is a **data** boundary — optional,
validated, bounded, and never carrying tenant/identity authority. A generated,
validator-clean workflow supplies none (it cannot reference `{{trigger.outputs.*}}`).
Reserved keys are refused, not silently ignored.

Made (2026-10-21): preserve the engine's multiple-run behaviour; do not add
uniqueness, a partial index, or a run lock at the handoff.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-20 | **Gate G NOT yet satisfied** | I6 source fix landed (cross-tenant execution entrypoint `startWorkflow` tenant-scoped; `triggerWorkflowRun` + test-run route authenticate/authorize; 2 new suites; full 58/1087; tsc/eslint/diff-check clean), **but the real-PostgreSQL cross-tenant acceptance run was not performed**, so I6 is not `VERIFIED` and Gate G is NOT satisfied | `trigger-tenant-scope.test.ts`, `workflow-run-boundary-scope.test.ts`, issue register §I6 Resolution |
| 2026-10-20 | **Gate G satisfied — I6 `VERIFIED`** | Real-PostgreSQL cross-tenant acceptance run performed and passed (10/10): no `WorkflowRun` on refusal, foreign vs missing indistinguishable, same-org positive control, payload-smuggled org id cannot redirect tenant. **37.12 unblocked.** | `src/tests/security/i6-cross-tenant.realdb.test.ts`; `docs/dev-log/2026-10-20-i6-real-db-acceptance.md` |
| 2026-10-21 | **IMPLEMENTED — not `VERIFIED`** | Handoff reuses the existing engine via the explicit, authenticated, tenant-scoped Run action; no second runtime. Runtime-input trust boundary tightened: free-form `triggerPayload` → validated/bounded/optional trigger context (reserved tenant/identity keys refused); canvas `mockProjectPayload` removed. 5 new suites. Default 68/1168; focused workflow+security 26/403; realdb I6 10/10 + handoff 5/5; tsc 0; eslint 0. Not committed. | `execution-handoff.test.ts`, `trigger-context.test.ts`, `run-workflow-button.test.tsx`, `execution-boundary-invariants.test.ts`, `execution-handoff.realdb.test.ts` |
| 2026-10-23 | **VERIFIED** | Verification pass re-ran the handoff gates against current source: mocked 29/29, diamond+button 14/14, real-PG handoff 5/5, I6 10/10; source inspection confirms `startWorkflow` remains the sole run-creation site and the trigger context is bounded. Live dispatch explicitly not claimed (37.15/37.16). | `execution-handoff.test.ts`; `trigger-context.test.ts`; `execution-boundary-invariants.test.ts`; `workflow-run-boundary-scope.test.ts`; `workflow-integration-diamond.test.ts`; `execution-handoff.realdb.test.ts`; `i6-cross-tenant.realdb.test.ts` |

---

## Phase 37.13 — Prompt / DAG planning instructions

### Status

**VERIFIED** · Priority: P1 · Verified 2026-10-23

> **VERIFIED 2026-10-23.** The prompt was reviewed line-by-line against the real
> `ActionCapabilities` catalog and `ActionRegistry`: `task.create` is the only
> action named, its required/optional inputs and outputs match, and no
> trigger-output or trusted-identity contract is described. The reference grammar
> in the prompt is `{{step.outputs.field}}`, matching the validator. `v6` is the
> 37.13 increment. `prompt-dag-planning.test.ts` passed 29/29, including
> catalog/registry drift and version-provenance checks. Model obedience in live
> generation remains a 37.16 concern by design.

### Objective

Teach the model DAG planning, local references, and the boundaries.

### Architectural Role

The prompt can only describe contracts that exist. This phase is last among the
early ones for that reason.

### Inputs / Dependencies

- 37.1 minimum; 37.12 nominal
- `AGENT_PROMPT_VERSION` in `src/lib/ai/agent/prompts/system-prompt.ts`
- `AgentSession.promptVersion`, defaulting to the legacy `"v1"`
- `src/lib/ai/agent/prompts/system-prompt.ts`
- Model: `gemini-3.6-flash` (`src/lib/ai/agent/model.ts`)

### Required guidance

- Do not serialize independent work
- Use logical local step IDs
- Never invent database IDs
- Obey action capability contracts
- Use the existing `{{step.outputs.field}}` reference grammar
- Do not guess missing required information
- Do not own final criticality
- `generateWorkflow` proposes; it does not execute
- Validation observations are internal correction signals

### Scope

- The system prompt text only, plus the version constant and the tests that
  assert the version is recorded on session creation
- Guidance that describes contracts which already exist at 37.1
- One prompt increment; the text must match the registry, not anticipate it

### Out of Scope

- Prompt written before the planner-facing contract exists
- `<DAG_THINKING_RULES>` as a substitute for deterministic validation
- Prompt carrying trusted identity

### Expected Implementation

Add DAG planning guidance to the system prompt and bump the prompt version so
sessions record the contract they were created under.

### Deliverables

- Updated system prompt
- Prompt version bump
- Prompt version tests

### Acceptance Gate

The prompt references only contracts that exist, and sessions record the new
prompt version.

### Test Gate

- Prompt version bumped and recorded on session creation
- Older sessions retain their original version
- No prompt text references a capability the registry does not have
- No trusted identity in the prompt

### Verification Gate

Review of prompt text against the 37.1 capability surface.

### Evidence

```text
Implementation: AGENT_PROMPT_VERSION v5 -> v6; DAG-planning guidance added to
                <WORKFLOW_GENERATION> (topology, local ids, action contracts,
                reference grammar, clarification, criticality, propose-only,
                validation observations). generate-workflow/tool.ts unchanged.
Tests:          src/tests/agent/prompt-dag-planning.test.ts (29/29);
                full default suite 69 suites / 1197 tests; 7 relevant suites
                191/191; tsc exit 0; eslint exit 0; git diff --check clean.
Verification:   2026-10-23 review of prompt text against the real 37.1 surface:
                - src/lib/workflow-types/action-capabilities.ts: only task.create;
                  required title/projectId, optional description/assigneeId/priority;
                  outputs taskId/title — prompt matches, invents nothing.
                - src/lib/workflow-types/* registry: exactly four tools
                  (createTask/listTasks/generateWorkflow/updateTask) — matches the
                  prompt's "four tools".
                - generate-workflow/schema.ts: name/description/steps/clarifications
                  {field,reason,question} — matches the prompt.
                - reference grammar {{step.outputs.field}} matches the validator.
                npx jest src/tests/agent/prompt-dag-planning.test.ts -> 29/29 pass.
                Note: tracker Inputs previously said AGENT_PROMPT_VERSION lives in
                constants.ts; it lives in prompts/system-prompt.ts (v6).
                NOT a proof of model obedience in live generation.
Commit/PR:      —
Relevant files: src/lib/ai/agent/prompts/system-prompt.ts
                src/tests/agent/prompt-dag-planning.test.ts
```

### Known Risks / Findings

**Resolved (documentation):** the tracker's Inputs entry placed
`AGENT_PROMPT_VERSION` in `constants.ts`; the constant is defined in
`src/lib/ai/agent/prompts/system-prompt.ts` (`AGENT_PROMPT_VERSION = "v6"`,
`LEGACY_AGENT_PROMPT_VERSION = "v1"`). Recorded here; the master table and this
section now cite the real path.

Sequencing risk only: writing the prompt before 37.1 would describe contracts
that do not exist — 37.1 is VERIFIED, so the prompt describes only the capability
surface that exists (`task.create`). Model obedience is unverified by design and
belongs to the 37.16 capstone.

### Decisions

Resolved: prompt version identifier for this increment is **`v6`**. The v5
clarification/remediation text and the `v4 → v5` bump are preserved unchanged;
37.13 adds its own increment on top rather than relabelling history. v5 is not
relabelled and Git history is not rewritten: v5 stays the remediation contract,
and **v6 is the Assignment 37.13 increment**.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-21 | IMPLEMENTED | Prompt version bumped `v5 → v6`; DAG-planning, local-id, capability-contract, reference-grammar, clarification, criticality, propose-only and validation-observation guidance added to `<WORKFLOW_GENERATION>`; v5 text preserved; `tool.ts` untouched. New `prompt-dag-planning.test.ts` (29 cases) covers prompt content, capability/contract drift vs `CAPABILITY_ACTION_IDS`+`ActionRegistry`, trusted-context absence and version provenance. Full default suite 69 suites / 1197 tests; tsc exit 0; eslint 0; `git diff --check` clean. **Not `VERIFIED`** (verification gate is a manual prompt review; model obedience is unverified). | `docs/dev-log/2026-10-21-phase-37.13-prompt-dag-planning.md` |
| 2026-10-23 | **VERIFIED** | Manual prompt-vs-contract review completed against `action-capabilities.ts`, registry and `generate-workflow/schema.ts`; only `task.create` named; inputs/outputs/grammar match. `prompt-dag-planning.test.ts` re-ran 29/29. Doc drift corrected (`AGENT_PROMPT_VERSION` lives in `prompts/system-prompt.ts`). Live model obedience remains 37.16. | `src/tests/agent/prompt-dag-planning.test.ts`; `src/lib/workflow-types/action-capabilities.ts`; `src/lib/ai/agent/prompts/system-prompt.ts` |

---

## Phase 37.14 — Self-healing observations

### Status

**VERIFIED** (2026-10-23) · Priority: P1

### Objective

Make structured validation failures drive model correction through the existing
agent loop, and keep the three loops explicitly distinct.

### Architectural Role

Connects 35/36 self-correction to 37 generation.

### Inputs / Dependencies

- 37.13
- 37.4 structured issues
- 37.6 missing-input state
- Existing: `AGENT_LOOP_REQUESTED` re-entry
  (`src/lib/ai/agent/outbox.ts:143`), `MAX_AGENT_STEPS = 5`
  (`src/lib/ai/agent/loop-policy.ts`)

### The three loops, tracked independently

| # | Loop | Trigger | Resolver |
|---|---|---|---|
| 1 | Self-correction | Structured validation issue | Model |
| 2 | Human clarification | `NEEDS_USER_INPUT` | Human |
| 3 | Human approval | `PENDING_CONFIRMATION` | Human |

### Scope

- Structured validation errors reaching the model.
- Loop re-entry via `AGENT_LOOP_REQUESTED`.
- Bounded agent loop preserved.
- Three loops distinguishable in the state machine.

### Out of Scope

**No second retry controller.** Self-correction re-enters the agent loop; it does
not retry workflow steps.

- No new retry system
- No unbounded correction

### Expected Implementation

Structured issues from 37.4 become the model's correction signal, bounded by the
existing `MAX_AGENT_STEPS`. Loops 2 and 3 route to humans through their own
durable states.

### Deliverables

- Observation wiring — structured `INVALID_INPUT` issues are persisted on the tool
  result and re-enter the loop via `AGENT_LOOP_REQUESTED`
  (`src/lib/ai/agent/tools/generate-workflow/execute.ts` emits the issues;
  `src/lib/ai/agent/tool-worker.ts:271` records the continuation for every
  non-clarification, non-parked completion in the same tx as the result CAS).
- Loop distinction tests — `src/tests/agent/three-loop-separation.test.ts`
- Bounded-loop tests — `src/tests/agent/no-second-retry-controller.test.ts`
- Real-PostgreSQL wait-state CAS & expiry isolation suite — `src/tests/agent/wait-state-cas.realdb.test.ts`

### Acceptance Gate

The three loops are explicitly distinct in the state machine and none is
implemented as a retry controller.

**Met.** The loops are distinguished by their authoritative records rather than by
the coarse session status: loop 1 by the structured `INVALID_INPUT` result and its
`AGENT_LOOP_REQUESTED` continuation; loop 2 by the `NEEDS_USER_INPUT` result
(`proposalState = NEEDS_CLARIFICATION`); loop 3 by
`AgentToolExecution.status = PENDING_CONFIRMATION` / `proposalState =
AWAITING_CRITICALITY → AWAITING_APPROVAL`. `AgentSessionStatus.WAITING_CONFIRMATION`
is only the session-level "a human owes this session something" marker; it does not
encode which loop is pending.

### Test Gate

- Self-correction: model corrects and re-proposes — **met** (`three-loop-separation`
  Case A: one `AGENT_LOOP_REQUESTED`, session NOT parked).
- Clarification: human is asked, model does not invent — **met** (Case B: park
  `WAITING_CONFIRMATION`, zero loop events; accepted answer clears + one continuation).
- Approval: human confirms exact proposal — **met** (Case C: park
  `WAITING_CONFIRMATION`; approval matches stored fingerprint/revision, clears wait,
  zero loop events).
- Loop bounded by `MAX_AGENT_STEPS` — **met** (`no-second-retry-controller`).
- No second retry controller exists — **met** (`no-second-retry-controller`;
  "attempt" accounting confined to `outbox.ts` delivery retry and `reaper.ts`
  stalled-session re-drive cap).
- Correction consumes budget; it does not loop forever — **met** (re-proposal claims
  the next step through the same `decideStepGate`).

### Verification Gate

Integration test exercising each of the three loops separately, plus real-PostgreSQL
wait-state CAS transitions and proposal-review expiry isolation.

**Satisfied (2026-10-23).**
- Three loops exercised and separated:
  - Loop 1 (model self-correction): structured `INVALID_INPUT` tool result -> worker records `AGENT_LOOP_REQUESTED` intent -> session remains `RUNNING` (never parked) -> bounded by `MAX_AGENT_STEPS = 5` via `decideStepGate` -> terminates with `MAX_STEPS_EXCEEDED`. No second retry controller exists.
  - Loop 2 (human clarification): `NEEDS_USER_INPUT` -> worker halts without outbox intent, publishes `CLARIFICATION_REQUESTED`, and marks session `WAITING_CONFIRMATION`. Human submits answer -> `submitClarificationAnswer` records answer, transitions row to `CLARIFICATION_ACCEPTED`, calls `clearAgentSessionWaiting` -> `RUNNING`, and records `AGENT_LOOP_REQUESTED` intent to resume the model turn.
  - Loop 3 (human approval/decline): Generated proposal parks session at `WAITING_CONFIRMATION` -> human approves/declines via `submitProposalDecision` -> atomic CAS updates proposal state to `APPROVED` / `DECLINED`, logs `forge:proposal-decision:v1` audit message, and calls `clearAgentSessionWaiting` -> `RUNNING`. Zero outbox loop events are emitted.
- Real-PostgreSQL acceptance suite (`src/tests/agent/wait-state-cas.realdb.test.ts`, 9/9 PASS):
  - Clarification lifecycle & wait-state CAS: parks session at `WAITING_CONFIRMATION`, clears on answer, records `AGENT_LOOP_REQUESTED`.
  - Proposal decision lifecycle & wait-state CAS: parks session at `WAITING_CONFIRMATION`, clears on approval/decline, zero loop events emitted.
  - Contested & stale CAS transitions: refuses to park or clear a `CANCELLED` session, prevents resurrection, rejects proposal decision on `CANCELLED` session with 409 `SESSION_NOT_RUNNING`.
  - Proposal-review expiry isolation:
    - Case 4A: Clean sole proposal expiry clears session wait `WAITING_CONFIRMATION -> RUNNING` with zero loop events.
    - Case 4B: Proposal expiry preserves `WAITING_CONFIRMATION` when a clarification is still pending (`NEEDS_CLARIFICATION`).
    - Case 4C: Proposal expiry preserves `WAITING_CONFIRMATION` when another proposal is still pending review (`AWAITING_APPROVAL`).
    - Case 4D: Proposal expiry preserves `WAITING_CONFIRMATION` when a tool execution is `PENDING_CONFIRMATION`.
  - Zero database leftovers verified after suite execution.

### Evidence

```text
Implementation: 2026-10-21
  - session-service.ts: markAgentSessionWaiting (RUNNING→WAITING_CONFIRMATION CAS),
    clearAgentSessionWaiting (WAITING_CONFIRMATION→RUNNING CAS, no-op otherwise),
    isHumanDecisionAcceptableStatus; cancelAgentSession guard widened to accept
    RUNNING|WAITING_CONFIRMATION (still zero callers).
  - tool-worker.ts: park CAS in the worker tx when a clarification or proposal parks.
  - clarification-service.ts / proposal-decision-service.ts / criticality-service.ts /
    confirmation-service.ts / tool-execution-service.ts: human-decision guards use the
    predicate; wait is cleared on clarification answer, proposal approval/decline;
    tool-execution wait cleared on confirm/cancel/expire.
  - reaper.ts: expireStaleProposalReviews clears the wait in the same tx as the
    expiry CAS, but only when no other human wait is still pending.
Tests: 2026-10-21 & 2026-10-23:
  - 3-loop seam: 6/6 (three-loop-separation.test.ts)
  - no-second-retry-controller: 8/8 (no-second-retry-controller.test.ts)
  - proposal-review-expiry: 35/35 (proposal-review-expiry.test.ts)
  - wait-state-cas.realdb.test.ts: 9/9 (real PostgreSQL acceptance suite)
  - Total Phase 37.14 tests: 58 passed, 0 failed.
  - tsc 0; eslint 0; git diff --check clean.
Verification: Real-PostgreSQL acceptance suite (wait-state-cas.realdb.test.ts, 9/9) + unit/mocked separation suites (49/49). Real-PG wait-state CAS, anti-resurrection guards, and proposal-review expiry isolation fully verified against live PostgreSQL container.
Commit/PR: not committed (working tree).
Relevant files: session-service.ts, tool-worker.ts, clarification-service.ts,
  proposal-decision-service.ts, criticality-service.ts, confirmation-service.ts,
  tool-execution-service.ts, reaper.ts,
  tools/generate-workflow/execute.ts,
  tests/agent/three-loop-separation.test.ts,
  tests/agent/no-second-retry-controller.test.ts,
  tests/agent/proposal-review-expiry.test.ts,
  tests/agent/wait-state-cas.realdb.test.ts
```

**Proposal-review expiry gap (verified 2026-10-21).** The suspected gap was
partially confirmed. `findDueProposalReviewCandidates` has **no session-status
filter**, so a due `AWAITING_APPROVAL` proposal on a `WAITING_CONFIRMATION`
session was already discoverable; expiry did not depend on the stalled-session
scan and `redriveStalledSessions` was not touched. What was missing was
isolation: the sweep cleared `WAITING_CONFIRMATION → RUNNING` unconditionally
after a successful CAS. It now counts other authoritative human waits in the
SAME transaction (`NEEDS_CLARIFICATION`, another parked proposal,
`PENDING_CONFIRMATION`) and clears only when none remain. Expiry still emits no
`AGENT_LOOP_REQUESTED`, performs no materialization, and cannot resurrect a
terminal session.

### Known Risks / Findings

**I3 (reclassified 2026-10-21).** `WAITING_CONFIRMATION` was read in two places and
written nowhere; `cancelAgentSession` filtered on an unreachable state. **Loop 2 now
has a session-level representation:** the wait CAS writes `WAITING_CONFIRMATION` when
a clarification parks and clears it on an accepted answer. The two distinct human
outcomes remain distinguishable below the session status (`NEEDS_USER_INPUT` result
vs `PENDING_CONFIRMATION` execution / proposal state). Does not block 37.1.

### Decisions

**AD-P7 resolved 2026-10-21** (owner, this pass): a durable pause uses
`AgentSessionStatus.WAITING_CONFIRMATION` as the session-level human-wait marker.
Distinct clarification/approval outcomes are preserved at the existing protocol /
execution levels. No new state machine, retry controller, queue runner or schema
model was introduced.

**Park/clear symmetry (owner-visible, chosen):** all four resolutions (clarification
answer, approval, decline, expiry) clear the wait back to `RUNNING`, the symmetric
inverse of the park. The only alternative considered was a terminal `COMPLETED`,
which the phase does not require and which would prejudge 37.11 materialization;
`RUNNING` avoids inventing terminal semantics while materialization remains pending.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-21 | IMPLEMENTED | Wired the durable session-level human-wait marker; added the three-loop seam and no-second-retry-controller suites; reconciled tracker/dev-log | 3-loop seam 6/6; no-second-retry-controller 8/8; agent tree 41/788; full 71/1211; tsc 0; eslint 0; diff-check clean; not committed |
| 2026-10-21 | IMPLEMENTED | Verified proposal-review expiry while parked; added the clarification/tool-confirmation isolation guard and 10 regression cases | `proposal-review-expiry` 35/35; agent tree 41/798; full 71/1221; tsc 0; eslint 0; diff-check clean; not committed |
| 2026-10-23 | VERIFIED | Satisfied Acceptance & Verification Gates with real-PostgreSQL wait-state CAS and proposal-review expiry isolation suite | `wait-state-cas.realdb.test.ts` 9/9 PASS against real PostgreSQL; 3 focused unit/isolation suites 49/49 PASS; tsc 0; eslint 0; diff-check clean |

---

## Phase 37.15 — Full test matrix

### Status

**VERIFIED** (2026-10-23) · Priority: P1

### Objective

Run and pass the full test matrix across every category.

### Architectural Role

The plan's position that the value is not "Gemini returned JSON".

### Inputs / Dependencies

- Phases 37.0A, 37.0B and 37.1–37.14 complete, with each phase's own gate passed
- Every F1–F6 and I1–I5 fix in the phase that owns it
- `jest.config.ts`, the `package.json` script set, and the existing test tree
- The existing evaluator, QStash runner, and retry/rollback path

### Scope

- Aggregate every test class required by phases 37.2–37.14
- Run the full suite, triage failures, and fix the defects they expose
- Keep category ownership with the phase that introduced the behaviour
- Record actual command output in the Evidence block below

### Out of Scope

- New behaviour, schemas, migrations, or prompt changes introduced here
- Deleting, skipping, or `.only`-ing a failing test to reach green
- Live infrastructure checks — those belong to 37.16
- Changing the action contract, reference grammar, or DAG rules

### Expected Implementation

No new product code is expected. This phase adds the regression tests earlier
phases did not yet have, and fixes the implementation defects those tests expose.
If a schema, registry, or engine change is required to make a test pass, it is
implemented in the phase that owns that contract and recorded there — not
quietly inside this phase.

### Deliverables

- The missing tests for every category in the Test Gate sections below
- Fixes for exposed defects, each attributed to its owning phase
- Green `npm test`, `npx tsc --noEmit`, and `npm run lint`
- A Verification Ledger row with the exact commands and pass counts

### Acceptance Gate

- Every checkbox in every Test Gate subsection below is checked
- No test is skipped, focused, or commented out to reach green
- No source, schema, migration, or prompt file was changed by this phase alone
- The ledger records command output, not a claim

### Test Gate — contract tests

- [x] valid proposal
- [x] duplicate `localRef`
- [x] unknown action
- [x] malformed input
- [x] malformed dependency
- [x] oversized proposal
- [x] strict-schema rejection

### Test Gate — graph tests

- [x] linear chain
- [x] fan-out
- [x] fan-in
- [x] diamond
- [x] disconnected graph
- [x] self dependency
- [x] cycle
- [x] unknown dependency

### Test Gate — reference tests

- [x] valid output reference
- [x] unknown source step
- [x] unknown output
- [x] missing execution dependency
- [x] nested reference
- [x] malformed reference
- [x] unavailable runtime state

### Test Gate — human-input tests

- [x] one missing input
- [x] multiple missing inputs
- [x] user answer
- [x] regenerated proposal remains valid

### Test Gate — criticality tests

- [x] model cannot set final criticality
- [x] human criticality persists
- [x] changed criticality affects only the intended materialized policy
- [x] confirmed value cannot be overridden

### Test Gate — confirmation tests

- [x] exact proposal approval
- [x] changed proposal cannot reuse old approval
- [x] cancel
- [x] expiry
- [x] duplicate confirmation is idempotent

### Test Gate — execution integration

- [x] independent A and B execute
- [x] fan-in C waits for both
- [x] output propagation A → input B
- [x] real action execution
- [x] resolver behaviour
- [x] parallel execution

### Test Gate — I1 regression (added in Phase 0)

- [x] cross-tenant workflow update rejected
- [x] same-tenant legitimate update succeeds

### Verification Gate

Full suite green via `npm test` (Jest, `jest.config.ts`), plus
`npx tsc --noEmit` and `npm run lint`. Note: `package.json` defines no `typecheck`
script, so type-checking is invoked directly.

**Satisfied (2026-10-23).**
- All 43 required matrix checks across 8 categories (contract: 7, graph: 8, reference: 7, human input: 4, criticality: 4, confirmation: 5, execution integration: 6, I1 regression: 2) individually verified and passing with explicit test bodies and assertions.
- Focused matrix suites (11 suites): 254 passed, 0 failed.
- Full default Jest regression suite (`npx jest --runInBand`): 79 suites passed, 79 total; 1267 tests passed, 1267 total; 0 failed; 0 skipped.
- Zero focused or skipped tests (`.only`, `.skip`, `xit`, `xdescribe`).
- Static analysis clean: `npx tsc --noEmit` exits 0 with zero diagnostics.
- Linter clean: `npm run lint` exits 0 with zero errors (36 warnings).
- Formatting/diff clean: `git diff --check` exits 0.
- All predecessor phases 37.0A, 37.0B, and 37.1 through 37.14 are VERIFIED. Predecessor gate satisfied.
- Formal prerequisite for 37.16 complete. Live model generation, QStash/Redis transport, and live capstone deployment remain strictly 37.16 concerns.

### Evidence

```text
Implementation: 2026-10-21 (test-only; assembled engine suite workflow-integration-diamond.test.ts 9/9, dag-validation standalone fan-in)
Tests: 2026-10-23:
  - 43-check matrix focused suites: 11 suites / 254 tests PASS
  - Full default regression suite: 79 suites / 1267 tests PASS (18.463s)
  - Predecessor real-PostgreSQL acceptance suites: 7 suites / 53 tests verified in respective phases
  - Static analysis: npx tsc --noEmit exit 0 (0 errors)
  - Linter: npm run lint exit 0 (0 errors, 36 warnings)
  - git diff --check: exit 0 (clean)
Verification: 43/43 matrix checks satisfied; full default Jest suite green; all 16 predecessor phases 37.0-37.14 VERIFIED. Zero verification debt remaining.
Commit/PR: not committed (working tree).
Relevant files: src/tests/workflow/workflow-proposal.test.ts,
  src/tests/workflow/dag-validation.test.ts,
  src/tests/workflow/proposal-references.test.ts,
  src/tests/agent/missing-input-protocol.test.ts,
  src/tests/agent/clarification-continuation.test.ts,
  src/tests/agent/criticality-service.test.ts,
  src/tests/agent/proposal-materialization.test.ts,
  src/tests/agent/workflow-criticality.test.ts,
  src/tests/agent/proposal-decision.test.ts,
  src/tests/workflow/workflow-integration-diamond.test.ts,
  src/tests/workflow/workflow-update-scope.test.ts
```

### Test Gate coverage map

Every checkbox above resolves to a named `it(...)` in a named file. Evidence
class is recorded so a later reader does not mistake a mocked suite for a real
one.

| Gate | Item | Suite | Evidence class |
|---|---|---|---|
| contract | valid proposal | `workflow-proposal.test.ts` — "accepts a valid proposal" | unit |
| contract | duplicate `localRef` | `workflow-proposal.test.ts` — "cannot represent a duplicate localRef" | unit |
| contract | unknown action | `workflow-proposal.test.ts` — "rejects an action that is not a registered workflow action" | unit |
| contract | malformed input | `workflow-proposal.test.ts` — "rejects a malformed literal value with the capability message" | unit |
| contract | malformed dependency | `workflow-proposal.test.ts` — "rejects an invalid dependency and reports its step and index" | unit |
| contract | oversized proposal | `workflow-proposal.test.ts` — "rejects a proposal whose serialized size exceeds the limit" | unit |
| contract | strict-schema rejection | `workflow-proposal.test.ts` — "is strict, rejecting an unknown step field" | unit |
| graph | linear chain | `dag-validation.test.ts` — "accepts a linear chain" | unit |
| graph | fan-out | `dag-validation.test.ts` — "accepts a parallel fan-out" | unit |
| graph | fan-in | `dag-validation.test.ts` — "accepts a fan-in, where a join depends on two independent roots" **(added by 37.15)** | unit |
| graph | diamond | `dag-validation.test.ts` — "accepts a diamond, where a join depends on two branches" | unit |
| graph | disconnected graph | `dag-validation.test.ts` — "accepts a valid graph with disconnected components as independent roots" | unit |
| graph | self dependency | `dag-validation.test.ts` — "rejects a self-dependency" | unit |
| graph | cycle | `dag-validation.test.ts` — "rejects a direct two-step cycle" | unit |
| graph | unknown dependency | `dag-validation.test.ts` — "rejects a dependency on a step that does not exist" | unit |
| reference | valid output reference | `proposal-references.test.ts` — "accepts a reference to a declared output on an existing step (whole value)" | unit |
| reference | unknown source step | `proposal-references.test.ts` — "rejects a reference to a step that is not in the proposal" | unit |
| reference | unknown output | `proposal-references.test.ts` — "rejects an undeclared output field" | unit |
| reference | missing execution dependency | `proposal-references.test.ts` — "requires the referenced source in dependsOn (MISSING_DATA_DEPENDENCY)" | unit |
| reference | nested reference | `proposal-references.test.ts` — "accepts a valid reference nested inside an input object" | unit |
| reference | malformed reference | `proposal-references.test.ts` — "rejects a reference with a wrong namespace after a valid step" | unit |
| reference | unavailable runtime state | `proposal-references.test.ts` — "rejects an out-of-scope runtime namespace as UNAVAILABLE_REFERENCE_SCOPE" | unit |
| human input | one missing input | `missing-input-protocol.test.ts` — "1. One required field absent from the proposal produces a MISSING_REQUIRED_INPUT validation issue at the correct field path" | mocked-integration |
| human input | multiple missing inputs | `missing-input-protocol.test.ts` — "2. Multiple required fields absent from the proposal are all identified" | mocked-integration |
| human input | user answer | `clarification-continuation.test.ts` — "resumes the same session through the existing dispatch and loop code" | mocked-integration |
| human input | regenerated proposal remains valid | `clarification-continuation.test.ts` — "resumes the same session through the existing dispatch and loop code" (re-runs the real compiler on the regenerated proposal) | mocked-integration |
| criticality | model cannot set final criticality | `workflow-proposal.test.ts` — "is strict, rejecting an unknown step field" | unit |
| criticality | human criticality persists | `criticality-service.test.ts` — "records the decision once, tagged by the interaction id, with no outbox event" | mocked-integration |
| criticality | changed criticality affects only the intended materialized policy | `proposal-materialization.test.ts` — "persists a definition that preserves actions, inputs, deps and criticality" (persisted `kickoff.isCritical=false` beside `follow.isCritical=true`) | mocked-integration |
| criticality | confirmed value cannot be overridden | `workflow-criticality.test.ts` — "refuses an approval recorded for revision A when only %s differs in revision B" | unit |
| confirmation | exact proposal approval | `proposal-decision.test.ts` — "approves a proposal and records a self-describing audit line" | mocked-integration |
| confirmation | changed proposal cannot reuse old approval | `proposal-decision.test.ts` — "409s REVISION_MISMATCH when the stored fingerprint disagrees with the persisted proposal" | mocked-integration |
| confirmation | cancel | `proposal-decision.test.ts` — "declines a proposal and records the decline decision" | mocked-integration |
| confirmation | expiry | `proposal-decision.test.ts` — "409s PROPOSAL_EXPIRED once the review window has closed" | mocked-integration |
| confirmation | duplicate confirmation is idempotent | `proposal-decision.test.ts` — "treats a repeat of the same decision as an idempotent success with no writes" | mocked-integration |
| execution integration | independent A and B execute | `workflow-integration-diamond.test.ts` — "dispatches independent roots A and B in the same evaluator pass" | mocked-integration |
| execution integration | fan-in C waits for both | `workflow-integration-diamond.test.ts` — "holds the fan-in step C undispatched while B is outstanding after A has succeeded" | mocked-integration |
| execution integration | output propagation A → input B | `workflow-integration-diamond.test.ts` — "propagates A's output into B's inputs through the real resolver and the real registered action" | mocked-integration |
| execution integration | real action execution | `workflow-integration-diamond.test.ts` — "mocks persistence and transport only — the engine and the action are real" | mocked-integration (the action's `createTaskInOrg` write is mocked) |
| execution integration | resolver behaviour | `workflow-integration-diamond.test.ts` — "propagates A's output into B's inputs through the real resolver and the real registered action"; `proposal-references.test.ts` — "resolves every extracted path through the real resolver (whole-string form)" | unit + mocked-integration |
| execution integration | parallel execution | `workflow-integration-diamond.test.ts` — "dispatches independent roots A and B in the same evaluator pass" | mocked-integration (non-serialized dispatch of independent roots; concurrent delivery is not asserted) |
| I1 regression | cross-tenant workflow update rejected | `workflow-update-scope.test.ts` — "refuses another organization's workflow and issues no write" | mocked-integration |
| I1 regression | same-tenant legitimate update succeeds | `workflow-update-scope.test.ts` — "persists the compiled definition for the owning organization" | mocked-integration |

**No 37.15 checklist item carries real-PostgreSQL evidence.** The two
real-database suites in the repository (`i6-cross-tenant.realdb.test.ts`,
`execution-handoff.realdb.test.ts`) belong to I6 and 37.12 and cover no 37.15
item. The live-engine evidence is owed by 37.16.

### Gaps closed by this phase

1. **The engine had no assembled-path coverage.** Every pre-existing workflow
   suite stopped at one boundary — the evaluator's decision without a step
   running, the wrapper with the action registry mocked out, or the start
   boundary with the engine mocked out. Nothing asserted that a root
   dispatches, that a fan-in waits for both prerequisites, or that one step's
   output becomes the next step's input. Those are the properties that fail
   silently: a fan-in that fires early reads as a success, and an output that
   never propagates reads as a step that did nothing.
   `src/tests/workflow/workflow-integration-diamond.test.ts` closes that gap by
   driving the real path: `startWorkflow` → `advanceWorkflow` → `POST
   /api/workflow` → `resolveInputs` → `wrapStepOperation` → the real action
   registry → the real `task.create` action → the real compare-and-set context
   merge.
2. **The graph gate had no standalone fan-in case.** Fan-in was only implicit
   inside the diamond in the file that owns graph-shape validation, so a
   validator that recognised only a common parent would have passed.
   `dag-validation.test.ts` now pins the two-independent-roots shape
   explicitly.

### Boundaries of the new evidence

- **Mocked:** the in-memory Prisma double, QStash `publishEvent`, the Redis
  lock client, Pusher, and the one business boundary inside the action
  (`createTaskInOrg`).
- **Real:** the evaluator, the worker route, the resolver, the wrapper, the
  context merge, the action registry, and the `task.create` action
  implementation.
- **Not claimed:** real-PostgreSQL engine execution (37.11 / 37.16), live
  transport, live Gemini, deployed behaviour.

### Defects exposed and their owning phase

No product defect was exposed by this phase. One defect was found and fixed,
and it belonged to the test harness rather than to a product phase:

- **Test-harness defect (fixed here).** `src/tests/workflow/helpers/prisma-double.ts`
  modelled the worker route's step-run relation as
  `include: { run: { workflow: true } }` only. The route actually requests
  `include: { run: { include: { workflow: true } } }`, which is the shape
  Prisma documents. The double therefore returned a run with no `workflow` on
  it, the route threw while reading `stepRun.run.workflow.definition`, and it
  answered 500 — so every executed step stayed `PENDING` and the failure
  looked exactly like a broken engine. `attachRun` now accepts all three
  include shapes in use (`{ run: true }`, `{ run: { workflow: true } }`,
  `{ run: { include: { workflow: true } } }`).

No source, schema, migration, or prompt file was changed by this phase.

### Known Risks / Findings

1. **Mocked integration, not a live engine.** The new integration suite is the
   strongest assembled-path evidence in the repository, but the action's
   `createTaskInOrg` write is behind a mock and persistence is the in-memory
   double. A real-PostgreSQL engine run remains owed by 37.16.
2. **No 37.15 checklist item has real-PostgreSQL evidence.** The repository's
   two real-database suites cover I6 and 37.12, not 37.15.
3. **Predecessor phases all `VERIFIED` (resolved 2026-10-23).** All predecessor phases
   37.0, 37.0A, 37.0B, and 37.1 through 37.14 are now formally `VERIFIED`. The predecessor
   gate is fully satisfied, unblocking 37.15 from `IMPLEMENTED` to `VERIFIED`.
4. **Tracker inconsistency observed (not corrected here).** The 37.11 phase
   detail still reads `NOT_STARTED` while the master status table reads
   `IMPLEMENTED`. Reconciling another phase's record is not this phase's to
   assert; it is recorded for 37.17's register reconciliation.
5. **The issue register's phase list is stale.** Its 37.11–37.14 entries carry
   no status, and 37.15 is blank. Left untouched for the same reason as (4).

### Decisions

Made: none.

Pending: none.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-21 | IMPLEMENTED | Ran the full matrix; added the assembled-engine integration suite; added the standalone fan-in graph case; repaired the Prisma double's step-run include shape | integration 9/9; dag-validation 26/26; workflow tree 21 suites / 368 tests; full 72 suites / 1232 tests; realdb 2 suites / 15 tests; tsc 0; eslint 0; diff-check clean; not committed |
| 2026-10-23 | VERIFIED | Verified complete 43-check matrix across 8 categories; full default Jest suite (79 suites / 1267 tests) passes; tsc clean; eslint clean; all predecessor phases 37.0-37.14 verified | 11 focused matrix suites 254/254; full default suite 79/79 suites (1267/1267 tests); tsc 0; eslint 0; diff-check clean |

---

## Phase 37.16 — Live capstone verification

### Status

**NOT_STARTED** · Priority: P1 · Includes **I5**

### Objective

Run the capstone end to end against real infrastructure and evidence each check
individually.

### Architectural Role

Proves the assignment works in reality, not only in tests.

### Inputs / Dependencies

- 37.15 VERIFIED with a green suite
- Reachable Gemini credentials and model configuration
- Deployed QStash schedules, including the workflow maintenance schedule (**I5**)
- A tenant with users, and working credentials for the real actions under test
- A clean environment — no stubs, mocks, or test doubles in the capstone path

### Scope

- Demonstrate one complete `"Onboard Acme Enterprise."` lifecycle in a real environment
- Evidence every check below separately in the Verification Ledger
- Confirm `Workflow`, `WorkflowRun`, and run-step rows are genuinely written
- Record **I5** as verified, or explicitly as unverifiable from the repository

### Capstone

> **"Onboard Acme Enterprise."**

### Full lifecycle to demonstrate

```text
human intent
  → Gemini
  → generateWorkflow
  → proposal
  → validation
  → missing information if needed
  → human criticality
  → confirmation
  → UI graph / layout
  → Workflow persistence
  → WorkflowRun
  → QStash
  → real actions
  → output propagation
  → completion
```

### Out of Scope

**Do not claim live verification if only unit tests ran.** No partial re-run may be
presented as a full capstone run. No stubbed action, mocked model, or in-memory
store may stand in for the real path.

### Expected Implementation

No implementation is expected. If any step cannot complete in a real environment
that is a defect: fix it in the phase that owns it, return here, and re-run the
capstone from the beginning. Do not patch around a live failure inside this phase.

### Deliverables

- Per-check evidence for every item below, with the environment named
- A log or screenshot reference for Gemini generation, the human criticality
  decision, and the confirmation gate
- The `Workflow` and `WorkflowRun` rows the capstone created
- **I5** recorded as verified or deferred-unverifiable, with the reason

### Acceptance Gate

- Every live check is checked and has its own ledger entry
- The capstone ran once, end to end, from human intent to completion
- No live result is inferred from unit-test output
- **I5** is resolved one way or the other

### Test Gate — live checks, each evidenced separately

- [ ] real Gemini generation
- [ ] invalid proposal rejection
- [ ] structured correction (self-correction loop)
- [ ] missing user input → human question, no hallucination
- [ ] human criticality decision
- [ ] exact confirmation binding
- [ ] real workflow persistence
- [ ] real `WorkflowRun`
- [ ] output A → input B
- [ ] independent parallel execution
- [ ] fan-in
- [ ] existing retry / rollback / recovery

### I5 verification

- [x] workflow maintenance schedule **actually exists**
- [ ] deployed schedule documented as unverifiable from the repository

Phase 0 established: the handler exists
(`src/app/api/worker/workflow-maintenance/wm.ts`);
`scripts/qstash-maintenance-schedule.mjs` registers only
`AGENT_MAINTENANCE_REQUESTED`. The 2026-10-23 live check found no workflow schedule.
A follow-up created `scd_6Q8msEqiSPejMBjkvLrW6Fqw2xE5` (`*/5 * * * *`,
`WORKFLOW_MAINTENANCE_REQUESTED`, `data.limit = 100`) against the configured QStash
project; its first scheduled run returned `SUCCESS`, and the app log recorded
`[WORKFLOW MAINTENANCE] {"ok":true,...}`. The schedule targets the ngrok development
tunnel, so it is verification infrastructure, not a production recovery schedule.

### Verification Gate

Every checklist item above individually evidenced in the Verification Ledger, with
environment named.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**I5 — resolved 2026-10-23 (live development verification).** The initial read-only
`client.schedules.list()` found only `CRON_DAILY_DIGEST` (`0 8 * * *`) and
`AGENT_MAINTENANCE_REQUESTED` (`*/5 * * * *`), so I5 was confirmed absent. A
follow-up created `scd_6Q8msEqiSPejMBjkvLrW6Fqw2xE5` (`*/5 * * * *`,
`WORKFLOW_MAINTENANCE_REQUESTED`, `data.limit = 100`) at the ngrok worker
destination. QStash recorded its first scheduled run as `SUCCESS`, and the worker
logged a successful, empty sweep. The schedule is on a development tunnel and must
be replaced with a stable production origin outside 37.16. The repository script
still registers only the agent schedule; the workflow schedule was created
out-of-band and its id is recorded here.

**I9 — run-page tenant check (found 2026-10-22, fixed in source).** The workflow
run page scoped its query with the URL's organization slug and never called
`getOrgAccess`, so an authenticated user could read another organization's run
by knowing its slug and run id. The page now authorizes with `getOrgAccess` and
queries by the authorized organization id. Evidence:
`run-page-tenant-scope.test.ts` (4 tests). This is mocked-boundary evidence, not
a live exploit test.

**I10 — `SEND_EMAIL` recipient (found 2026-10-22, worker mitigated; contract
open).** The email worker sent every event to one hardcoded personal address.
It now resolves a membership by `(userId, orgId)`, validates the email, and
fails closed. However, `task.create` emits `userId: "system-cdc"` and the cron
fallback emits `"system"`, so those events have no deliverable recipient and
will fail rather than send. A producer/contract decision is required. Evidence:
`email-recipient-scope.test.ts` (8 tests, including both synthetic actors and missing identity).
Existing retry semantics are unchanged.

**Decision required (I10).** The owner must define the intended
`TASK_CREATED` recipient: the optional persisted assignee, the authenticated
creator, organization owners/admins, or no email. `Task` has no creator column
and no notification-recipient contract, so choosing one now would invent a
product rule. For `CRON_DAILY_DIGEST`, the owner must either define a per-user
producer (the current cron handler dispatches no such event) or state that no
digest email is intended. Until then both producer paths fail closed.

**I11 - organization notification channel mismatch (found 2026-10-22, fixed in
source).** The email worker published to `org-${userId}` while the client
subscribed to `org-${orgSlug}`. Neither side used the persisted organization
id, so a correctly-authorized member could never receive the event. Both sides
now use `organizationChannelName(access.organization.id)`; the organization
layout resolves the URL slug through `getOrgAccess` before subscribing.
Evidence: `org-channel.test.ts` (3 tests) and
`org-layout-realtime-channel.test.tsx` (2 tests). The channel remains public;
matching names prevent misrouting but do not authorize subscription.

### 2026-10-23 readiness audit

Read-only prerequisites audit. The capstone was **not started**; no mocked or
partial run was substituted for it.

| Prerequisite | Result | Evidence |
|---|---|---|
| 37.15 `VERIFIED` with a green suite | **BLOCKED** | Tracker master table records 37.15 as `IMPLEMENTED`, not `VERIFIED`; it explicitly assigns the live-engine gate to 37.16. Predecessors 37.4/37.5/37.7-37.10/37.14 are also `IMPLEMENTED`, not `VERIFIED` (37.11-37.13 became `VERIFIED` on 2026-10-23). |
| Reachable Gemini credentials | **PASS** | `GEMINI_API_KEY` is present. `GET https://generativelanguage.googleapis.com/v1beta/models` returned HTTP 200 and 50 models. |
| Configured Gemini model | **PASS (fixed)** | `gemini-2.5-flash` generation returned 404 ("no longer available to new users"). `gemini-3.8-flash` and `gemini-3.7-flash` returned 503 ("high demand"). `gemini-3.6-flash` returned HTTP 200 on minimal generation and function-call probes; its JSON-schema probe succeeded with intermittent demand-related 503s. All runtime text-model bindings now use `gemini-3.6-flash`. |
| QStash workflow-maintenance schedule (I5) | **PASS (fixed)** | Initial list had 2 schedules and no `WORKFLOW_MAINTENANCE_REQUESTED`. Created `scd_6Q8msEqiSPejMBjkvLrW6Fqw2xE5` (`*/5 * * * *`, `data.limit = 100`) at the ngrok worker destination. QStash now lists 3 schedules. |
| QStash schedule delivery | **PASS** | The new workflow schedule recorded its first run as `SUCCESS`; the worker log shows `[WORKFLOW MAINTENANCE] {"ok":true,...}`. `AGENT_MAINTENANCE_REQUESTED` also has a recent `SUCCESS`. The destination is a development tunnel, not a production origin. |
| Tenant with users | **PASS** | Live PostgreSQL counts: 3 organizations, 4 users (4 with a password hash), 3 projects, 11 tasks, 2 workflows, 2 workflow runs. |
| Working authenticated test-user credentials | **BLOCKED** | No `SEED_PASSWORD` is present in `.env`; the issue register records that no test-user credentials were available for a real-session probe. Password hashes exist, but no usable credential is known. |
| Real actions and execution path | **UNVERIFIED** | The runtime registry contains only `task.create`. Its `createTaskInOrg` path writes through the extended Prisma client, but no live action or `WorkflowRun` was executed. |
| Clean environment with no stubs/mocks/test doubles | **BLOCKED** | I5 and QStash delivery are now verified, but no authenticated test-user credential is known and only `task.create` is registered. The full live path has not been demonstrated. |

**Verdict:** the 37.16 capstone is **BLOCKED** by 37.15 and missing authenticated
credentials; I5 and QStash delivery are no longer part of the block. No item in
the 12-check live matrix has live evidence.

The initial audit made no source or schedule change. A follow-up model fix moved
all runtime Gemini text consumers to `gemini-3.6-flash` after the retired
`gemini-2.5-flash` binding was found; the provider-binding test was updated. A
separate follow-up created the workflow-maintenance QStash schedule recorded above.

Repository state during the audit: branch
`feat/37.1-action-capability-catalog`, HEAD `dae4307`, upstream `0/0`.
Unrelated modified and untracked agent/worker transaction files were preserved.
Nothing was staged, committed, or pushed.

### Decisions

Deferred owner decisions, retained unchanged by the 2026-10-23 readiness audit:

1. **`TASK_CREATED` recipient contract.** Define whether the intended recipient
   is the optional persisted assignee, the authenticated creator, organization
   owners/admins, or no email. `Task` has no creator column and no
   notification-recipient contract.
2. **`CRON_DAILY_DIGEST` producer and delivery contract.** Define whether a
   per-user producer is intended; the current cron handler dispatches no such
   event. Otherwise state that no digest email is intended.
3. **Organization Pusher channel privacy.** Decide whether the organization
   channel remains public or becomes private with membership authorization.
   The current fix only aligns both sides on the persisted organization id.

No implementation choice was made by assumption. These decisions do not change
the fail-closed email behavior or the public channel.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-22 | NOT_STARTED | Read-only 37.16 preflight audit found I9/I10 and recorded remaining gates. I9 fixed in source; I10 worker fails closed, producer recipient gap open. Capstone not run. | Audit report; focused suites 2/10; security/workflow/worker-routing regression 30/446; `tsc` 0; ESLint 0; `git diff --check` clean |
| 2026-10-22 | NOT_STARTED | Follow-up: organization channel unified on the persisted org id (I11) and UI/layout route tests added. I10 still requires an owner recipient decision; no producer guess and no live email. Capstone not run. | Focused suites 3/13; security/workflow/worker-routing regression 32/454; full 78/1265; `tsc` 0; ESLint 0 changed files / 0 errors and 31 pre-existing warnings repo-wide; `git diff --check` clean |
| 2026-10-23 | NOT_STARTED | Read-only readiness audit. 37.15 is `IMPLEMENTED`, not `VERIFIED`; configured `gemini-2.5-flash` generation returns 404; live QStash list has no workflow-maintenance schedule, confirming I5 absent; ngrok schedule origin timed out; no known test-user credential. Capstone blocked and not run. Three deferred owner decisions recorded explicitly. | `schedules.list()` 2 schedules; Gemini models 200 / 2.5-flash generation 404 / 3.8-flash 503; PostgreSQL 3 orgs / 4 users / 4 password hashes / 3 projects / 11 tasks / 2 workflows / 2 runs; `APP_URL` localhost 200; no source or schedule changes |
| 2026-10-23 | NOT_STARTED | Follow-up model fix: moved all runtime Gemini text consumers from the retired `gemini-2.5-flash` to `gemini-3.6-flash`; updated the provider-binding test and current docs. Capstone still blocked by 37.15, I5, QStash delivery, and missing credentials. | `gemini-3.6-flash` minimal generation 200, function-call 200, JSON-schema 200 on retry; provider-binding 7/7; full 78 suites / 1265 tests; `tsc` 0; ESLint 0 changed files; no QStash or schedule changes; not committed |
| 2026-10-23 | NOT_STARTED | I5 resolved: created the missing `WORKFLOW_MAINTENANCE_REQUESTED` QStash schedule against the ngrok worker origin. Its first scheduled run delivered successfully. Capstone still blocked by 37.15 and missing authenticated credentials; no live matrix check has run. | Schedule `scd_6Q8msEqiSPejMBjkvLrW6Fqw2xE5`, cron `*/5 * * * *`, body `data.limit=100`; QStash state `SUCCESS`; worker log `[WORKFLOW MAINTENANCE] {"ok":true,...}`; QStash now lists 3 schedules; dev-tunnel destination |

---

## Phase 37.17 — Documentation / closure

### Status

**NOT_STARTED** · Priority: P1

### Objective

Close Assignment 37 with reconciled documentation and honest status.

### Architectural Role

The closing record. Its only job is to make the documentation agree with reality:
no new behaviour, and no status that is not backed by evidence from an earlier
phase.

### Inputs / Dependencies

- 37.16 VERIFIED with per-check live evidence, or explicitly recorded as not reached
- Final states of F1–F6 and I1–I5 as implemented or deferred in their own phases
- Migration state, test evidence, and live verification evidence already recorded
- Agreement between this tracker, the plan, and the issue register

### Scope

- [ ] Final architecture documentation
- [ ] Issue register reconciliation (F1–F6, I1–I5 final states)
- [ ] Unresolved issues listed explicitly
- [ ] Migration state recorded
- [ ] Test evidence compiled
- [ ] Live verification evidence compiled
- [ ] Final plan status
- [ ] Final tracker status
- [ ] Assignment completion criteria recorded

### Out of Scope

Closing any issue without evidence. Marking anything VERIFIED that was not
verified. Changing source, schema, migrations, or prompts from this phase.

### Expected Implementation

Documentation only: bring the plan, the issue register, and this tracker to the
same final position, and record the migration state as it actually is — including
"no migration was required" where that is true. Any code change discovered during
closure belongs to the phase that owns it, and this phase is not complete until
that change is made and recorded there.

### Deliverables

- Final architecture documentation
- Issue register reconciled to the true final state of every F1–F6 and I1–I5 row
- This tracker closed, with status history preserved
- An explicit list of anything still open, and the reason it is not closed

### Acceptance Gate

- Every item in the Assignment 37 Completion Checklist is checked, or explicitly
  deferred with a recorded reason
- No checklist item is checked without an evidence reference
- Plan, issue register, and tracker agree on every phase status and issue state

### Test Gate

- [ ] Every checklist item is checked or carries a recorded deferral
- [ ] Every F1–F6 and I1–I5 row has a final state with an evidence reference, or
      an explicit `DEFERRED` reason
- [ ] Every pending architectural decision is resolved or explicitly carried forward
- [ ] Migration status is recorded as it actually is
- [ ] The tracker's final status reflects the real state of the assignment

### Verification Gate

Every item in the Assignment 37 Completion Checklist resolved, with the tracker and
issue register in agreement.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

None.

### Decisions

Pending: none.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

# Issue Register Dashboard

**Resolved: I1 (37.0A), I2 (37.0B), F3 and I4 (37.1), F6 (37.3), F5 (37.4).**
Everything else listed below is open or unverified. Resolutions are only recorded
when the fix is present and tested.

| ID | Description | Priority | Current State | Blocking? | Assigned Phase | Resolved? | Verification Evidence |
|---|---|---|---|---|---|---|---|
| **F1** | Canvas-first persistence; no definition → UI reverse projection | P2 | Open — recorded | No (gates 37.10/37.11 ordering) | 37.10 / 37.11 | **No** | — |
| **F2** | `definition.id` is a per-save placeholder; `definition.name` is a constant | P2 | Open — recorded | No | 37.11 | **No** | — |
| **F3** | No authoritative planner-facing action capability contract | P1 | **CLOSED 2026-10-01** | No — was YES, now resolved | 37.1 | **YES** | `src/tests/workflow/action-capabilities.test.ts` — 32/32; catalog total over registry (TS coupling); `assignments-37-phase-37.1-capability-catalog.md` §6, §12 |
| **F4** | `AgentToolExecution` cannot represent the proposal lifecycle | P1 | Open — recorded, fork undecided | No | 37.6 / 37.7 / 37.8 | **No** | — |
| **F5** | `WorkflowDefinitionSchema` never called in production | P1 | **CLOSED 2026-10-12** (premise corrected) | No — was a gate-selection question | 37.4 | **YES** | `src/tests/workflow/workflow-proposal-compiler.test.ts` — 25/25; AD-P4: collector is canonical; schema is then still invoked at `evaluator.ts:223` |
| **F6** | No reference / data-dependency validation; silent failure | P1 | **CLOSED 2026-10-12** | No — was a risk for 37.4+ | 37.3 | **YES** | `src/tests/workflow/proposal-references.test.ts` — 44/44; `MISSING_DATA_DEPENDENCY` enforced; `git diff -- resolver.ts` empty |
| **I1** | Cross-tenant workflow update | **P0** | **CLOSED 2026-09-30** | No — was YES, now resolved | 37.0A | **YES** | `src/tests/workflow/workflow-update-scope.test.ts` — 5/5; suite fails 3/5 against the unscoped predicate |
| **I6** | Cross-tenant workflow execution | **P0** | **CLOSED 2026-10-20 (real-DB acceptance passed)** | No — was YES, now resolved | separate ticket, before 37.12 | **YES** | `src/tests/security/i6-cross-tenant.realdb.test.ts` — 10/10 against a **real** PostgreSQL DB (org-A caller cannot start org B's workflow; no `WorkflowRun` row created; foreign/missing indistinguishable; same-org positive control). Mocked suites retained: `trigger-tenant-scope` (4/4) + `workflow-run-boundary-scope` (6/6). `Migrate status`: schema up to date. |
| **I2** | Node validation bypass at persistence boundary | **P0** | **CLOSED 2026-09-30** | No — was YES, now resolved | 37.0B | **YES** | `src/tests/workflow/workflow-node-validation.test.ts` — 23/23; suite fails 19/23 against the inert schema |
| **I3** | `WAITING_CONFIRMATION` session state unreachable | P2/P3 | Open | No | later cleanup / 37.14 | **No** | — |
| **I4** | Runtime / UI action registry mismatch | P1 | **CLOSED 2026-10-01** | No — was YES, now resolved | 37.1 | **YES** | `action-capabilities.test.ts` — 32/32; Mutation B (re-advertise `comment.add`) fails 3/30; UI list is a derived projection |
| **I5** | Workflow maintenance schedule absent | **P1** | **CLOSED 2026-10-23** | No — was a blocker, now resolved | 37.16 | **YES** | QStash `scd_6Q8msEqiSPejMBjkvLrW6Fqw2xE5` (`*/5 * * * *`); first scheduled run `SUCCESS`; dev-tunnel schedule, production origin still required |
| **I7** | Conditional routing not executable / authorable end-to-end | P2 | Open — recorded 2026-10-01 | No (scope decision needed) | scope decision (recorded during 37.1) | **No** | `assignments-37-issue-register.md` §5 → I7; `assignments-37-phase-37.1-capability-catalog.md` §10 |

### Count

- Resolved: **8 of 13** (I1, I2, I6, F3, I4, I5, F5, F6)
- P0 open: **0**
- P1 open: **1** (F4)
- P1-CHECK unverified: **0**
- P2/P3 open: **4** (F1, F2, I3, I7)

### I7 — recorded during 37.1 reconnaissance

**I7 is not a Phase 0 finding.** It was reported while implementing 37.1 and
confirmed against the evaluator, wrapper and compiler; the Phase 0 audit is
unmodified. It records that conditional routing is not executable or authorable
end to end, and that a scope decision is owed before Assignment 37 claims
generated conditional branches. It is non-blocking for 37.1. See the issue
register §5 → I7 for the full evidence trail.

### I6 — recorded after Phase 0

**I6 is not a Phase 0 finding.** Phase 0 reconnaissance closed without observing
it; it was recorded afterwards from a separate inspection of the execution
entrypoint. `assignments-37-phase-0-audit.md` is unmodified and still describes only
what Phase 0 saw. I6 is filed in the register because it is a P0 tenant-isolation
defect on a path Assignment 37 consumes, and the register is where a P0 belongs.

It is **not** merged with I1 and must not be closed by it:

| | **I1** | **I6** |
|---|---|---|
| Operation | cross-tenant **UPDATE** | cross-tenant **EXECUTION** |
| Entry point | `updateWorkflowState` (`workflow.ts:95`) | `triggerWorkflowRun` (`workflow-run.ts:5`) |
| Predicate (as found) | `update({ where: { id } })` | `findUnique({ where: { id } })` in `startWorkflow` |
| Consequence | overwrites blueprint, `eventId`, `isActive` | starts a real run with attacker-chosen trigger data |
| Gate | **37.0A**, before 37.5 — **VERIFIED 2026-09-30** | separate ticket, before **37.12** — **VERIFIED 2026-10-20** |

**Gate G — 37.12 Execution handoff cannot become `VERIFIED` unless I6 is
`VERIFIED`.** Closing I1 does not satisfy this, and did not. I1 and I6 are
different defects on different paths with different regression tests; the closed
I1 left the execution entrypoint unscoped. The I6 ticket must cover every
reachable caller of the unscoped primitive, not only the server action.

**I6 is now `VERIFIED` (2026-10-20).** The fix landed as its own ticket, separate
from I1. `startWorkflow` is tenant-scoped (`startWorkflow(orgId, workflowId, …)`,
lookup predicate carries `orgId`; the parameter is required so no unscoped shape
compiles). Both reachable callers were secured independently:
`triggerWorkflowRun` calls `getOrgAccess(orgslug)` and passes the verified
`organization.id`; the test-run route authenticates and resolves the workflow
through a membership-constrained predicate (no existence oracle). Mocked
regression suites `trigger-tenant-scope` and `workflow-run-boundary-scope` assert
cross-org refusal with **no `WorkflowRun`** and no `advanceWorkflow`,
indistinguishability from a missing workflow, and the same-org positive path.
**Real-database acceptance** (`src/tests/security/i6-cross-tenant.realdb.test.ts`,
10/10, 2026-10-20) then proved the same properties against the actual PostgreSQL
database — the evidence Gate G requires and the mocked suites alone could not
supply. Gate G is satisfied; 37.12 is unblocked. This ticket did **not** modify the
execution engine, dispatch a run, or enqueue QStash — see
`docs/dev-log/2026-10-20-i6-real-db-acceptance.md`.

---

# Architectural Decision Log

Seeded only with constraints already established by the plan and audit. **No
decision is fabricated.**

| Decision ID | Question | Options | Decision | Date | Phase | Evidence |
|---|---|---|---|---|---|---|
| AD-01 | Does Gemini generate or execute? | Generate proposal / Execute directly | **Generate a declarative proposal. The backend compiles, validates, obtains human decisions, materializes, and hands off.** | 2026-09-30 | 37.0 | Plan, central boundary |
| AD-02 | Which runtime executes generated workflows? | Existing engine / New engine | **The existing hardened runtime remains the execution authority.** | 2026-09-30 | 37.0 | Plan; audit §10 |
| AD-03 | Which reference syntax? | Reuse `{{…}}` / New language | **Reuse the existing resolver grammar and namespaces.** No second syntax. | 2026-09-30 | 37.3 | Plan; audit §9 |
| AD-04 | Who owns final criticality? | Model / Human | **Human.** The model may suggest a presentation default only. | 2026-09-30 | 37.7 | Plan; audit §6 |
| AD-05 | DAG validation implementation? | New validator / Reuse existing | **Reuse `collectWorkflowDefinitionIssues`. No second DAG engine.** | 2026-09-30 | 37.4 | Plan; audit §7 |
| AD-06 | Retry and rollback controller? | New / Reuse existing | **Reuse existing retry, rollback and recovery. No second controller.** | 2026-09-30 | 37.14 | Plan; audit §5 |
| AD-07 | WorkflowProposal migration timing? | Create now / Defer | **Defer.** Do not create a migration merely because `AgentToolExecution` may prove insufficient. | 2026-09-30 | 37.8 | Plan Phase 8; register F4 |
| AD-08 | Step identity in a proposal? | DB ID / Local logical ref | **Local logical step IDs, workflow-scoped. Backend-generated IDs are forbidden in proposals.** | 2026-09-30 | 37.2 | Plan Phase 1 |
| AD-09 | Where does tenant/runtime identity come from? | Model / Persisted context | **Backend-trusted persisted context** — `AgentSession` for tools, the `Workflow` row for actions. | 2026-09-30 | 37.0 | Audit §3; `create-task.ts:36-39` |
| AD-10 | Does a capability descriptor carry authority? | Schema + authority / Schema only | **Schema information only. Never trusted execution authority.** | 2026-09-30 | 37.1 | Plan Phase 2 constraint |
| AD-11 | 37.10 / 37.11 ordering | Materialize then project / Project then materialize | **Project then materialize.** Persistence is canvas-first; projection is a precondition of it. | 2026-09-30 | 37.0 revision | Register F1 |
| AD-12 | P0 findings bundled into feature phases? | Bundle / Separate tickets | **Separate prerequisite tickets (37.0A, 37.0B).** | 2026-09-30 | 37.0 revision | Register §2 |
| AD-13 | I5 classification | P1 / P1-CHECK | **P1-CHECK.** Deployed QStash schedules are not observable from the repository; it is not a confirmed defect. | 2026-09-30 | 37.0 | Register I5 |
| AD-14 | Is I6 merged into the I1 ticket? | Merge / Separate tickets | **Separate tickets.** I1 is cross-tenant UPDATE gated at 37.5; I6 is cross-tenant EXECUTION gated at 37.12. Different paths, different regression tests. | 2026-09-30 | I6 documentation | Register I6 |
| AD-15 (AD-P1) | Where does planner-facing action metadata live? | On `WorkflowAction` / Separate client-safe catalog keyed by action id | **Separate client-safe catalog keyed by action id** (`action-capabilities.ts`). Executable actions import the extended Prisma client and must not enter the browser bundle; the registry stays the execution authority and membership source of truth; UI presentation stays in `registry.ts`. | 2026-10-01 | 37.1 | `action-capabilities.ts`; `action-registry.ts` (`RegisteredActionId`); §12 of the phase record |
| AD-16 (AD-P4) | Which validation gate is canonical — `WorkflowDefinitionSchema` or the issue collector? | Schema superRefine / issue collector | **The issue collector** (`collectWorkflowDefinitionIssues`) is the canonical graph-semantic gate. The schema's `superRefine` collapses every `code` to `z.ZodIssueCode.custom` and drops the cycle `path`, so the schema stays the runtime read-boundary validator (invoked at `evaluator.ts:223`) and is unchanged. | 2026-10-12 | 37.4 | `workflow-proposal-compiler.ts`; tracker §37.4 Test Gate; `workflow.ts:243-250` |
| AD-17 | What access classification does `generateWorkflow` carry? | `READ_ONLY` / `WRITE` (`WRITE` gates a pre-execution confirmation) | **`READ_ONLY`.** The tool performs no workflow-domain write, so a pre-execution confirmation would suppress the compilation and the structured `INVALID_INPUT` feedback the model needs to self-correct. The human approval boundary lives downstream (37.8/37.9), not at proposal time. The proposal describer is therefore presentation-only. | 2026-10-12 | 37.5 | `src/lib/ai/agent/tools/generate-workflow/`; `registry.ts`; `policy.ts:17,52-56` |
| AD-18 (AD-P2) | How is the missing-input state handled and persisted? | Schema migration now / Protocol in 37.6, durability in 37.8 | **Protocol in 37.6, durability in 37.8.** 37.6 implements the `NEEDS_USER_INPUT` protocol contract, clarification-intent validation, and safe continuation design without adding Prisma models or migrations. Full proposal-lifecycle persistence and restart durability are owned by 37.8. F4 remains OPEN until 37.8 satisfies its criteria. | 2026-10-14 | 37.6 | `src/lib/ai/agent/tools/generate-workflow/`; `clarification-service.ts`; `src/tests/agent/missing-input-protocol.test.ts` |

### Pending decisions — PENDING DECISION

| Ref | Question | Blocks | Where decided |
|---|---|---|---|
| **AD-P2** | How is the missing-input state persisted? | 37.7, 37.8 | **Resolved 2026-10-14 by 37.6 (AD-18)**; durable store decided at 37.8 |
| **AD-P3** | Reuse `AgentToolExecution` or add a `WorkflowProposal` model? | 37.9, 37.11 | 37.8 |
| **AD-P5** | Synthesize layout before persistence, or add a definition-first write path? | 37.11 | 37.10 |
| **AD-P6** | Where does proposal provenance live, given `definition.id` is a placeholder? | 37.11 | 37.11 |
| **AD-P7** | Does a durable pause use the unused session-status enum slot? | 37.14 | **Resolved 2026-10-21 by 37.14**: yes — `AgentSessionStatus.WAITING_CONFIRMATION` is the session-level human-wait marker; clarification/approval outcomes stay distinct at the protocol/execution levels; no new state machine/retry controller/queue/schema model |

**AD-P1 resolved 2026-10-01** (recorded above as AD-15). It is no longer pending.

**AD-P2 resolved 2026-10-14** (recorded above as AD-18). Protocol contract and continuation design resolved; storage model and restart durability deferred to 37.8.

**AD-P4 resolved 2026-10-12** by 37.4: `collectWorkflowDefinitionIssues` is the
canonical graph-semantic gate. The compiler calls it directly; the schema's
`superRefine` collapses `code` to `z.ZodIssueCode.custom` and drops the cycle
`path`, so `WorkflowDefinitionSchema` stays the runtime read-boundary validator
(invoked at `evaluator.ts:223`) and is unchanged. It is no longer pending.

**AD-08 satisfied 2026-10-12** by 37.2: proposal steps are a record keyed by
`localRef`, so a backend-generated id is unrepresentable and a duplicate id cannot
exist. AD-03 (reference syntax) re-confirmed: 37.2 reuses the resolver grammar with
no second dialect.

---

# Verification Ledger

**Every meaningful verification event.** No rows are invented.

| Date | Phase | Test/Check | Environment | Result | Evidence | Verified By |
|---|---|---|---|---|---|---|
| 2026-09-30 | 37.0 | Contract reconnaissance across workflow, persistence, agent and confirmation surfaces | Local — read-only source inspection | **PASS** | `assignments-37-phase-0-audit.md` (535 lines, `file:line` cited) | Phase 0 |
| 2026-09-30 | 37.0 | Phase 0 gate answered | Local — inspection | **PASS** | Audit, *Phase 0 gate* section | Phase 0 |
| 2026-09-30 | 37.0 | No source modified by Phase 0 work | Local — `git status --short` | **PASS** | Single untracked path: `forge/docs/architecture/workflows/` | Phase 0 |
| 2026-09-30 | 37.0A | I1 regression suite — foreign org, nonexistent, write-predicate, same-org success, unauthorized | Local — `npx jest src/tests/workflow/workflow-update-scope.test.ts` | **PASS** | 5/5 tests | 37.0A |
| 2026-09-30 | 37.0A | Suite fails against a deliberately reverted unscoped predicate | Local — mutation check | **PASS** (correctly detected) | 3 of 5 failed; cross-org case returned `{ success: true }` and overwrote the foreign row | 37.0A |
| 2026-09-30 | 37.0A | Full workflow suite after adding the `workflow` delegate to the double | Local — `npx jest src/tests/workflow` | **PASS** | 7 suites, 109 tests | 37.0A |
| 2026-09-30 | 37.0A | Full repository suite | Local — `npm test` | **PASS** | 27 suites, 417 tests (was 26 / 412) | 37.0A |
| 2026-09-30 | 37.0A | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.0A |
| 2026-09-30 | 37.0A | Lint of the 3 touched files | Local — `npx eslint` | **PASS** (no new errors) | 4 errors, all pre-existing `no-explicit-any` on untouched `any[]` params; new test and double clean | 37.0A |
| 2026-09-30 | 37.0B | I2 node-validation suite — real canvas payload, 8 malformed variants per path, defaults, unknown-key stripping | Local — `npx jest src/tests/workflow/workflow-node-validation.test.ts` | **PASS** | 23/23 tests | 37.0B |
| 2026-09-30 | 37.0B | Suite fails against the original inert schema on both paths | Local — mutation check | **PASS** (correctly detected) | 19 of 23 failed | 37.0B |
| 2026-09-30 | 37.0B | Full repository suite | Local — `npm test` | **PASS** | 28 suites, 440 tests (was 27 / 417) | 37.0B |
| 2026-09-30 | 37.0B | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.0B |
| 2026-09-30 | 37.0B | Lint of the 4 touched files | Local — `npx eslint` | **PASS** (no new errors) | same 4 pre-existing `no-explicit-any`; both new test files clean | 37.0B |
| 2026-10-01 | 37.1 | Capability catalog suite — totality, required/optional fields, output fields, trusted-identity rejection, `comment.add` absence | Local — `npx jest src/tests/workflow/action-capabilities.test.ts` | **PASS** | 32/32 tests | 37.1 |
| 2026-10-01 | 37.1 | Full repository suite | Local — `npx jest` | **PASS** | 31 suites, 490 tests (was 30 / 458) | 37.1 |
| 2026-10-01 | 37.1 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.1 |
| 2026-10-01 | 37.1 | Lint of the 4 touched files | Local — `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.1 |
| 2026-10-01 | 37.1 | Compile-time coupling guard (capability with no registration) | Local — `tsc` on mutated source, reverted | **PASS** (correctly rejected) | `TS2353: '"phantom.action"' does not exist in type 'Record<"task.create", ActionCapability>'` | 37.1 |
| 2026-10-01 | 37.1 | Compile-time coupling guard (registration with no capability) | Local — `tsc` on mutated source, reverted | **PASS** (correctly rejected) | `TS1360: … does not satisfy the expected type 'Record<"unregistered.new" \| "task.create", ActionCapability>'` | 37.1 |
| 2026-10-01 | 37.1 | Mutation A — remove `title` from capability output schema | Local — mutation check | **PASS** (correctly detected) | 3 failed / 29 passed | 37.1 |
| 2026-10-01 | 37.1 | Mutation B — re-advertise `comment.add` in the UI picker | Local — mutation check | **PASS** (correctly detected) | 3 failed / 29 passed | 37.1 |
| 2026-10-12 | 37.2 | WorkflowProposal schema + validator suite — shape, graph shapes (A, B→A, fan-in, fan-out, diamond), structural rejects, action resolution, input/reference tolerance, bounds, structural-vs-graph boundary, grammar parity, client safety | Local — `npx jest src/tests/workflow/workflow-proposal.test.ts` | **PASS** | 40/40 tests | 37.2 |
| 2026-10-12 | 37.2 | Capability + DAG regression after adding the proposal module | Local — `npx jest action-capabilities + dag-validation` | **PASS** | 2 suites, 56 tests | 37.2 |
| 2026-10-12 | 37.2 | Full repository suite | Local — `npx jest` | **PASS** | 32 suites, 530 tests (was 31 / 490) | 37.2 |
| 2026-10-12 | 37.2 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.2 |
| 2026-10-12 | 37.2 | Lint of the 2 touched files | Local — `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.2 |
| 2026-10-12 | 37.2 | Bounds hardening — 50 000-deep nesting (no stack overflow), cyclic input, non-serializable `BigInt` input, depth-before-serialization, oversize short-circuit | Local — `npx jest src/tests/workflow/workflow-proposal.test.ts` | **PASS** | 45/45 tests (5 new adversarial cases) | 37.2 |
| 2026-10-12 | 37.2 | Full repository suite after hardening | Local — `npx jest` | **PASS** | 32 suites, 535 tests (was 32 / 530) | 37.2 |
| 2026-10-12 | 37.2 | Type check after hardening | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.2 |
| 2026-10-12 | 37.2 | Lint of the 2 touched files after hardening | Local — `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.2 |
| 2026-10-12 | 37.3 | Reference validator suite — valid/nested/interpolated/whole-string, unknown source, unknown output, `MISSING_DATA_DEPENDENCY`, `SELF_REFERENCE`, malformed, scope-escape, prototype path, trigger fail-closed, determinism, read-only, resolver grammar parity | Local — `npx jest src/tests/workflow/proposal-references.test.ts` | **PASS** | 44/44 tests | 37.3 |
| 2026-10-12 | 37.3 | Workflow regression suite after adding the reference validator | Local — `npx jest src/tests/workflow` | **PASS** | 12 suites, 262 tests (was 11 / 218) | 37.3 |
| 2026-10-12 | 37.3 | Full repository suite | Local — `npx jest` | **PASS** | 33 suites, 579 tests (was 32 / 535) | 37.3 |
| 2026-10-12 | 37.3 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.3 |
| 2026-10-12 | 37.3 | Lint of the 3 touched files | Local — `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.3 |
| 2026-10-12 | 37.3 | Resolver integrity — source unchanged | Local — `git diff -- src/lib/workflow/execution/resolver.ts` | **PASS** | empty diff; file not in `git status --short` | 37.3 |
| 2026-10-12 | 37.4 | Proposal compiler suite — pipeline order/short-circuit, mapping identity, no mutation, determinism, no clock, reachable graph checks, adapter total over all seven collector codes, structured `code`/`path` | Local — `npx jest workflow-proposal-compiler` | **PASS** | 25/25 tests | 37.4 |
| 2026-10-12 | 37.4 | Workflow regression suite after adding the compiler | Local — `npx jest src/tests/workflow` | **PASS** | 13 suites, 287 tests (was 12 / 262) | 37.4 |
| 2026-10-12 | 37.4 | Full repository suite | Local — `npx jest` | **PASS** | 34 suites, 604 tests (was 33 / 579) | 37.4 |
| 2026-10-12 | 37.4 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.4 |
| 2026-10-12 | 37.4 | Lint of the 3 touched files | Local — `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.4 |
| 2026-10-12 | 37.4 | Resolver integrity — source unchanged | Local — `git diff -- src/lib/workflow/execution/resolver.ts` | **PASS** | empty diff | 37.4 |
| 2026-10-12 | 37.5 | `generateWorkflow` suite — registration/policy/server-side resolution/fail-closed, valid-proposal preservation + no persisted artifact, compiler issues mapped with exact `path`/`code`/`message` (UNKNOWN_ACTION, UNKNOWN_DEPENDENCY, CYCLE, UNKNOWN_REFERENCE_SOURCE, MISSING_REQUIRED_INPUT), schema-level vs compiler boundary, no forbidden side effects (`createTaskAction.execute`, `startWorkflow`, `publishEvent`, `prisma.task.*`), describer + shared-resolver fallback, durable tool-result path | Local — `npx jest generate-workflow` | **PASS** | 24/24 tests | 37.5 |
| 2026-10-12 | 37.5 | Agent regression suite after registering the tool | Local — `npx jest src/tests/agent` | **PASS** | 18 suites, 321 tests (was 17 / 297) | 37.5 |
| 2026-10-12 | 37.5 | Workflow regression suite | Local — `npx jest src/tests/workflow` | **PASS** | 13 suites, 287 tests (unchanged) | 37.5 |
| 2026-10-12 | 37.5 | Full repository suite | Local — `npx jest` | **PASS** | 35 suites, 628 tests (was 34 / 604) | 37.5 |
| 2026-10-12 | 37.5 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.5 |
| 2026-10-12 | 37.5 | Lint of the touched files | Local — `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.5 |
| 2026-10-12 | 37.5 | Resolver/canvas/runtime integrity — source unchanged | Local — `git diff` on those paths | **PASS** | empty diff | 37.5 |
| 2026-10-14 | 37.6 | Missing-input protocol suite — classification (Groups A/B), answer rejection matrix, idempotency/conflict, worker halt vs continuation | Local — `npx jest src/tests/agent/missing-input-protocol.test.ts` | **PASS** | 28/28 tests (was 21) | 37.6 |
| 2026-10-14 | 37.6 | Reaper exemption for waiting sessions | Local — `npx jest durability maintenance` | **PASS** | `skippedWaiting` exemption + re-drive-after-answer green; 2 suites / 59 tests | 37.6 |
| 2026-10-14 | 37.6 | Agent + workflow regression suites | Local — `npx jest src/tests/agent src/tests/workflow` | **PASS** | 32 suites, 638 tests (was 629) | 37.6 |
| 2026-10-14 | 37.6 | Full repository suite | Local — `npx jest` | **PASS** | 36 suites, 658 tests | 37.6 |
| 2026-10-14 | 37.6 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.6 |
| 2026-10-14 | 37.6 | Lint of changed files | Local — `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.6 |
| 2026-10-14 | 37.6 | Whitespace integrity | Local — `git diff --check` | **PASS** | clean | 37.6 |
| 2026-10-17 | 37.6 | Step-claim CAS regression suite - valid claim advances once, stale/mismatched expected step rejected, duplicate claim is a no-op, unrelated session untouched | Local - `npx jest src/tests/agent/session-step-claim.test.ts` | **PASS** | 5/5 tests | 37.6 |
| 2026-10-17 | 37.6 | Missing-input + reaper triplet | Local - `npx jest missing-input-protocol durability maintenance` | **PASS** | 3 suites / 87 tests | 37.6 |
| 2026-10-17 | 37.6 | Reaper + generate-workflow triplet | Local - `npx jest durability maintenance generate-workflow` | **PASS** | 3 suites / 83 tests | 37.6 |
| 2026-10-17 | 37.6 | Reaper exemption (ground truth) | Local - `npx jest durability maintenance` | **PASS** | 2 suites / 59 tests | 37.6 |
| 2026-10-17 | 37.6 | Focused clarification suites | Local - `npx jest <4 clarification suites>` | **PASS** | 4 suites / 57 tests | 37.6 |
| 2026-10-17 | 37.6 | Agent + workflow regression suites | Local - `npx jest src/tests/agent src/tests/workflow` | **PASS** | 36 suites, 672 tests (was 638) | 37.6 |
| 2026-10-17 | 37.6 | Full repository suite | Local - `npx jest` | **PASS** | 40 suites, 692 tests (was 658) | 37.6 |
| 2026-10-17 | 37.6 | Type check | Local - `npx tsc --noEmit` | **PASS** | exit 0 | 37.6 |
| 2026-10-17 | 37.6 | Lint of changed files | Local - `npx eslint` | **PASS** | 0 errors, 0 warnings | 37.6 |
| 2026-10-17 | 37.6 | Whitespace integrity | Local - `git diff --check` | **PASS** | clean | 37.6 |
| 2026-10-21 | 37.15 | Assembled-engine integration suite — independent roots dispatched in one evaluator pass, fan-in held until both prerequisites succeed, output propagation A → input B through the real resolver, real registered action execution, real diamond join, no duplicate StepRuns or dispatches on repeated advancement | Local — `npx jest src/tests/workflow/workflow-integration-diamond.test.ts` | **PASS** | 9/9 tests | 37.15 |
| 2026-10-21 | 37.15 | Graph gate — standalone fan-in case (two independent roots joined by one step) added to the file that owns graph-shape validation | Local — `npx jest src/tests/workflow/dag-validation.test.ts` | **PASS** | 26/26 tests (was 25) | 37.15 |
| 2026-10-21 | 37.15 | Test-matrix audit — every Test Gate checkbox in §37.15 mapped to a named suite and `it(...)`, with evidence class recorded | Local — source inspection of `src/tests/` | **PASS** | 43/43 checkboxes mapped; 0 uncovered | 37.15 |
| 2026-10-21 | 37.15 | No focused, skipped or todo test anywhere in the tree | Local — `Select-String` for `.only(` / `.skip(` / `xit(` / `xdescribe(` / `*.todo` across `src/tests/**` | **PASS** | 0 matches | 37.15 |
| 2026-10-21 | 37.15 | Workflow regression suite | Local — `npx jest src/tests/workflow` | **PASS** | 21 suites, 368 tests | 37.15 |
| 2026-10-21 | 37.15 | Full repository suite | Local — `npm test` | **PASS** | 72 suites, 1232 tests | 37.15 |
| 2026-10-21 | 37.15 | Real-database acceptance suites (`i6-cross-tenant`, `execution-handoff`) | Local — `npx jest --config jest.realdb.config.ts` | **PASS** | 2 suites, 15 tests (real PostgreSQL) | 37.15 |
| 2026-10-21 | 37.15 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | 37.15 |
| 2026-10-21 | 37.15 | Lint | Local — `npm run lint` | **PASS** | exit 0 — 0 errors, 31 warnings, all pre-existing in untouched files | 37.15 |
| 2026-10-21 | 37.15 | Whitespace integrity | Local — `git diff --check` | **PASS** | clean (exit 0; CRLF line-ending advisories only) | 37.15 |
| 2026-10-21 | 37.15 | Product-surface integrity — no source, schema, migration or prompt file changed by this phase | Local — `git status --short` | **PASS** | 2 modified test files, 1 new test file, 1 modified tracker doc; no `src/lib`, `src/app`, `prisma/` or prompt path touched | 37.15 |
| 2026-10-21 | 37.15 | Test-harness defect — Prisma double modelled only `include: { run: { workflow: true } }`; the worker route requests `include: { run: { include: { workflow: true } } }`, so the route read a run with no `workflow` and answered 500, leaving every executed step `PENDING` | Local — `npx jest src/tests/workflow/workflow-integration-diamond.test.ts` (before the fix) | **FAIL → PASS (fixed in the test double, not in product code)** | before: 9/9 failing on `status`/`cDispatch`/duplicate-row assertions; after: 9/9 passing | 37.15 |
| 2026-10-21 | 37.15 | Live / deployed behaviour | — | **NOT CLAIMED** | No live transport, live Gemini, live PostgreSQL engine execution, or deployed behaviour is exercised by this phase; 37.16 owns that gate | 37.15 |
| 2026-10-23 | 37.13 | Prompt content + version suite — capability-contract drift, reference grammar, trusted-context absence, version provenance | Local — `npx jest src/tests/agent/prompt-dag-planning.test.ts` | **PASS** | 29/29 tests | Verification pass |
| 2026-10-23 | 37.13 | Manual prompt-vs-contract review — prompt text vs `action-capabilities.ts`, `ActionRegistry` (4 tools) and `generate-workflow/schema.ts`; `AGENT_PROMPT_VERSION` location corrected | Local — source inspection | **PASS** | Only `task.create` named; required/optional inputs and outputs match; grammar `{{step.outputs.field}}` matches; no trigger-output or identity claims | Verification pass |
| 2026-10-23 | 37.12 | Handoff + trigger-context + boundary invariants + boundary scope | Local — `npx jest <4 suites>` | **PASS** | 29/29 tests (mocked; `getOrgAccess`/`advanceWorkflow`/db doubled) | Verification pass |
| 2026-10-23 | 37.12 | Run-button UI + assembled-engine diamond dispatch | Local — `npx jest run-workflow-button + workflow-integration-diamond` | **PASS** | 14/14 tests (real evaluator/worker/resolver/action; persistence and `createTaskInOrg` mocked; no live QStash) | Verification pass |
| 2026-10-23 | 37.12 | Handoff acceptance on real PostgreSQL — auth/tenant refusal, `RUNNING` run creation, same-org positive path | Local — `npx jest --config jest.realdb.config.ts src/tests/workflow/execution-handoff.realdb.test.ts --runInBand` | **PASS** | 5/5 tests (real Prisma/`startWorkflow`; `advanceWorkflow` mocked, so live dispatch not claimed) | Verification pass |
| 2026-10-23 | 37.12 | I6 cross-tenant regression re-run | Local — `npx jest --config jest.realdb.config.ts src/tests/security/i6-cross-tenant.realdb.test.ts --runInBand` | **PASS** | 10/10 tests (real PostgreSQL) | Verification pass |
| 2026-10-23 | 37.11 | Materialization acceptance on real PostgreSQL — APPROVED→MATERIALIZED CAS, provenance, triggerless inactive row, no run/task/outbox side effects, canonical definition + human criticality, UI projection equality, recompile round trip, provenance survival after real `updateWorkflowState` re-save, idempotent retry, non-APPROVED 409, incomplete criticality 409, non-owner 404, cross-org 409, concurrent double-start, unique-index rollback | Local — `npx jest --config jest.realdb.config.ts src/tests/agent/proposal-materialization.realdb.test.ts --runInBand` | **PASS** | 11/11 tests (real Prisma, real service/compiler/projection; session lock passed through) | Verification pass |
| 2026-10-23 | 37.11 | Mocked materialization regression (service, boundary, route) | Local — `npx jest proposal-materialization + -boundary + proposal-materialize-route` | **PASS** | 3 suites / 60 tests | Verification pass |
| 2026-10-23 | 37.13/37.12/37.11 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | Verification pass |
| 2026-10-23 | 37.11 | Lint of the new acceptance suite | Local — `npx eslint src/tests/agent/proposal-materialization.realdb.test.ts` | **PASS** | 0 errors, 0 warnings | Verification pass |
| 2026-10-23 | 37.13/37.12/37.11 | Whitespace integrity | Local — `git diff --check` | **PASS** | exit 0; CRLF advisories only | Verification pass |
| 2026-10-23 | 37.11 | Database safety — unique fixture tags, zero leftovers, no live transport/Redis/Gemini/Pusher calls | Local — suite design + teardown assertions | **PASS** | isolated `matacc_*` fixtures; cleanup asserted; agent session lock passed through; `advanceWorkflow`/QStash not invoked | Verification pass |
| 2026-10-23 | 37.4 | Proposal compiler suite — pipeline order/short-circuit, mapping identity, no mutation, determinism, no clock, reachable graph checks (`UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY`, `CYCLE`), adapter total over all seven collector codes, structured `code`/`path` | Local — `npx jest src/tests/workflow/workflow-proposal-compiler.test.ts` | **PASS** | 25/25 tests | Verification pass |
| 2026-10-23 | 37.4 | Production-path gate on materialization — cyclic `dependsOn` refused as `PROJECTION_FAILED` (409) with **no `Workflow` row** and lifecycle left `APPROVED`; structured `CYCLE` issue (code, path `steps`, sequence in message) asserted at the gate; acyclic control materializes | Local — `npx jest --config jest.realdb.config.ts src/tests/agent/proposal-compiler-materialization.realdb.test.ts --runInBand` | **PASS** | 3/3 tests (real PostgreSQL, real `materializeProposal` → `projectProposalToUIGraph` → `compileWorkflowProposal` → `collectWorkflowDefinitionIssues`; session lock passed through) | Verification pass |
| 2026-10-23 | 37.4 | Workflow regression suite | Local — `npx jest src/tests/workflow` | **PASS** | 21 suites, 369 tests | Verification pass |
| 2026-10-23 | 37.4 | Full repository suite | Local — `npx jest` | **PASS** | 78 suites, 1265 tests | Verification pass |
| 2026-10-23 | 37.4 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | Verification pass |
| 2026-10-23 | 37.4 | Lint of the new acceptance suite | Local — `npx eslint src/tests/agent/proposal-compiler-materialization.realdb.test.ts` | **PASS** | 0 errors, 0 warnings | Verification pass |
| 2026-10-23 | 37.4 | Product-surface integrity — verification changed no production source | Local — `git status --short` + `git diff --check` | **PASS** | only the new test file added; no `src/lib`, `src/app`, `prisma/` or prompt path touched by this verification; diff-check clean (CRLF advisories only) | Verification pass |
| 2026-10-23 | 37.4 | Live / deployed behaviour | — | **NOT CLAIMED** | Evidence is unit-level plus real-PostgreSQL execution of the materialization path; no live Gemini, QStash, Redis or deployed behaviour. 37.16 owns the live gate | Verification pass |
| 2026-10-23 | 37.4 | Real-PostgreSQL production-path acceptance re-run as the 37.5 prerequisite audit | Local — `npx jest --config jest.realdb.config.ts src/tests/agent/proposal-compiler-materialization.realdb.test.ts --runInBand` | **PASS** | 3/3 tests (real PostgreSQL; `PROJECTION_FAILED`, no `Workflow` row, lifecycle unchanged; acyclic control materializes) | Verification pass |
| 2026-10-23 | 37.5 | `generateWorkflow` focused suite — registration/policy/fail-closed, proposal preservation, exact issue mapping, no forbidden side effects, describer, durable tool-result path | Local — `npx jest src/tests/agent/generate-workflow.test.ts --runInBand` | **PASS** | 35/35 tests | Verification pass |
| 2026-10-23 | 37.5 | Carried 37.2 real-model-path clause — live Gemini turn through the production `agentModel`, system prompt, registered tool definition and registered executor; emitted proposal validated, compiled and executed with byte-identical input (no fix-up, no repair) | Local — `npx jest --config jest.live.config.ts src/tests/agent/generate-workflow.live.test.ts --runInBand` | **PASS** | 1/1 test; `gemini-3.6-flash`; 2 steps / 2 `task.create` actions; validate/compile/executor success; `mutated in transit: false` | Live-model verification pass |
| 2026-10-23 | 37.5 | Agent regression suite | Local — `npx jest src/tests/agent --runInBand` | **PASS** | 43 suites / 814 tests | Verification pass |
| 2026-10-23 | 37.5 | Workflow regression suite | Local — `npx jest src/tests/workflow --runInBand` | **PASS** | 21 suites / 369 tests | Verification pass |
| 2026-10-23 | 37.5 | Full repository suite | Local — `npx jest --runInBand` | **PASS** | 78 suites / 1265 tests (default project excludes `*.live` and `*.realdb`) | Verification pass |
| 2026-10-23 | 37.5 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | Verification pass |
| 2026-10-23 | 37.5 | Lint | Local — `npm run lint` | **PASS** | exit 0 — 0 errors, 31 pre-existing warnings in untouched files | Verification pass |
| 2026-10-23 | 37.5 | Whitespace integrity | Local — `git diff --check` | **PASS** | exit 0; CRLF advisories only | Verification pass |
| 2026-10-23 | 37.5 | Harness defect and product-surface integrity — the live suite could not import the registry because it constructs a real `PrismaClient`; added the same `prisma/extended` + `prisma/db` double mocks used by the focused suite. No `src/lib`, `src/app`, `prisma/` or prompt file changed | Local — `npx jest --config jest.live.config.ts ...` before/after + `git status --short` | **PASS** (harness fix only) | before: suite failed to run at import; after: 1/1 passing. Only the untracked live test file changed | Verification pass |
| 2026-10-23 | 37.5 | Live / deployed behaviour | — | **NOT CLAIMED** | A live Gemini parse path is exercised and claimed. No live PostgreSQL, QStash, Redis, Pusher, real action execution or deployed capstone is claimed; 37.16 owns that gate | Verification pass |
| 2026-10-23 | 37.7 | Criticality contract suite — validateCriticalityDecisions (exact/complete, omissions, unknowns, non-boolean, non-object), applyCriticalityDecisions (overlay isCritical only, non-mutation, cross-proposal refusal, determinism), proposal revision binding (mutations across name, description, action, inputs, dependencies) | Local — `npx jest src/tests/agent/workflow-criticality.test.ts` | **PASS** | 15/15 tests | Verification pass |
| 2026-10-23 | 37.7 | Criticality route suite — auth refusal (401), request forwarding, strict body schema (userId/isCritical/correlationId injection refused 400), malformed payload | Local — `npx jest src/tests/agent/criticality-route.test.ts` | **PASS** | 19/19 tests | Verification pass |
| 2026-10-23 | 37.7 | Criticality service suite — auth/liveness, proposal recovery from persisted tool result, supersession, decision-set validation, recording, CAS, idempotency/conflict, clarification separation, exact-revision record reconstruction | Local — `npx jest src/tests/agent/criticality-service.test.ts` | **PASS** | 24/24 tests | Verification pass |
| 2026-10-23 | 37.7 | Criticality integration acceptance suite — model cannot set/smuggle `isCritical` in schema/tool input/executor, valid proposal parks `AWAITING_CRITICALITY`, human decision (`kickoff: false, follow: true`) persists, later model turn cannot override confirmed decision, stored execution definition and UI graph on materialization strictly match human decision, proving the human decision won | Local — `npx jest src/tests/agent/criticality-integration.test.ts` | **PASS** | 2/2 tests | Verification pass |
| 2026-10-23 | 37.7 | Combined criticality regression pass (contract + route + service + integration) | Local — `npx jest src/tests/agent/criticality-integration.test.ts src/tests/agent/criticality-service.test.ts src/tests/agent/criticality-route.test.ts src/tests/agent/workflow-criticality.test.ts --runInBand` | **PASS** | 4 suites / 60 tests | Verification pass |
| 2026-10-23 | 37.7 | Type check | Local — `npx tsc --noEmit` | **PASS** | exit 0 | Verification pass |
| 2026-10-23 | 37.7 | Lint of new acceptance suite | Local — `npx eslint src/tests/agent/criticality-integration.test.ts` | **PASS** | 0 errors, 0 warnings | Verification pass |
| 2026-10-23 | 37.7 | Product-surface integrity | Local — `git status --short` | **PASS** | only the new test file and tracker doc touched; no existing product source modified | Verification pass |
| 2026-10-23 | 37.7 | Live / deployed behaviour | — | **NOT CLAIMED** | Mocked integration + unit only; real-PostgreSQL persistence verified under 37.11 (`proposal-materialization.realdb.test.ts`). Live Gemini, QStash, Redis and capstone belong to 37.16 | Verification pass |

### Coverage summary

| Category | Events recorded |
|---|---|
| unit | 27 |
| integration | 0 |
| database | 0 |
| Redis | 0 |
| QStash | 0 |
| live Gemini | 0 |
| live workflow execution | 0 |
| security | 0 |
| tenant isolation | 2 |
| validation / persistence boundary | 2 |
| contract / consistency | 5 |
| documentation / inspection | 3 |

> **This tally is a 37.4-era snapshot and is stale.** It was last recomputed
> when the ledger ended at 37.4; it has not been recounted since, and the
> "integration 0" / "database 0" rows were already wrong before 37.15 (the I6
> real-PostgreSQL acceptance run passed on 2026-10-20). 37.15 adds 13 ledger
> rows: 6 unit / mocked-integration suites, 1 database acceptance run, 2
> whole-repository runs, 2 static checks, 1 whitespace check, 1
> product-surface check, 1 harness-defect record, and 1 explicit
> not-claimed row. A full recount of the ledger by evidence class is owed to
> 37.17's register reconciliation; 37.15 did not silently rewrite the
> historical tally above.

**Live verification remains outstanding.** The 37.0A tenant-isolation and 37.0B
node-validation evidence is Jest-level against the in-memory prisma double in
`src/tests/workflow/helpers/prisma-double.ts`; 37.1's evidence is Jest-level and
compiler-level; 37.2's evidence is Jest-level and `tsc`-level. None is a live
database check, and Phase 37.16 remains the phase that owes one. No database,
queue, Gemini, or real workflow execution has been exercised in this assignment.

> **Correction, 2026-10-21 (37.15).** The paragraph above was accurate when
> written but is no longer true as a statement about the whole assignment.
> Two real-PostgreSQL runs now exist: the I6 cross-tenant acceptance run
> (2026-10-20, 10/10) and the 37.15 re-run of both real-database suites
> (2026-10-21, 2 suites / 15 tests). Neither exercises the *workflow engine*
> end to end — I6 is a tenant-isolation check and `execution-handoff.realdb`
> is 37.12's handoff boundary — so **live workflow execution, live transport,
> live Redis/QStash, and live Gemini remain outstanding and are 37.16's.**
> 37.15's own new evidence is mocked-integration and says so.

> **Update, 2026-10-23 (verification pass).** The 37.11/37.12/37.13 gates add
> three real-PostgreSQL runs — materialization 11/11, handoff 5/5, I6 re-run
> 10/10 — plus mocked-integration runs (diamond 9/9, handoff 29/29, materialization
> 60/60) and prompt/version 29/29. These prove the materialize→load→recompile
> round trip, provenance survival, rollback, tenant-scoped run creation and prompt
> contract fidelity. They still do **not** prove live dispatch: the real-DB
> handoff mocks `advanceWorkflow`, and the diamond mocks persistence/transport.
> **Live Redis/QStash, live Gemini, real engine execution against a real database,
> and deployed behaviour remain outstanding; 37.15 must earn them before 37.16.**
> The historical coverage tally above was not silently recomputed.

> **Correction, 2026-10-23 (37.5 `VERIFIED`).** The ledger now contains one
> live-Gemini row: 37.5's carried real-model-path clause ran against
> `gemini-3.6-flash` (1/1) and proved the emitted proposal validates, compiles and
> executes unchanged. This is a live model *parse* check, not a capstone: no live
> database, transport, Redis/QStash, action execution or deployed behaviour is
> claimed, and the coverage tally above is still not recounted. 37.15 remains
> `IMPLEMENTED`; 37.16 still owns the live capstone.

37.3's evidence is Jest-level and `tsc`-level (static validator, no runtime).
37.4's evidence was Jest-level and `tsc`-level (static compiler, no runtime);
the compiler had no production caller until 37.5, so its production-path
verification was deferred at that time.
**Corrected 2026-10-23 (37.4 `VERIFIED`):** the production caller (37.5's
`executeGenerateWorkflow`) and the materialization path (37.11's
`materializeProposal`) both exist now, and a real-PostgreSQL acceptance run
(`proposal-compiler-materialization.realdb.test.ts`, 3/3) exercises the gate on
that path — so 37.4's evidence class is now **unit + real-PostgreSQL**. It still
claims no live Gemini, QStash, Redis or deployed behaviour.
**37.2's former model-path clause** (a real `generateWorkflow` proposal parsing
without a compiler fix-up) is **reassigned to 37.5**, which owns the model path;
it was **discharged live on 2026-10-23** (1/1, `gemini-3.6-flash`).

---

# Database / Migration State

### Required for Assignment 37

| Migration | Required by | Created | Applied | Verified | Status |
|---|---|---|---|---|---|
| None currently required | — | No | No | No | **None** |

### Explicit deferrals

| Item | Deferral reason | Revisit at |
|---|---|---|
| `WorkflowProposal` model | **F4 is an open fork.** The plan states: do not create this migration merely because `AgentToolExecution` may eventually be insufficient. | 37.8 |
| Any `AgentToolExecution` column or enum change | F4 fork, same reason. | 37.6 / 37.7 |
| I1 migration | I1 is a **predicate fix**, not a schema change. No migration required. | 37.0A |
| I2 migration | I2 is a **Zod validation fix**, not a schema change. No migration required. | 37.0B |

**F4 must not cause a migration to be created before the persistence decision is
made at 37.6/37.7/37.8.**

### Related history (not Assignment 37 work)

`docs/architecture/agent/assignments-35-36-audit.md` records five agent migrations
as applied, plus `prisma/migrations/20260930120000_workflow_run_progress/`, which
added `contextVersion` and `lastAdvancedAt`. Phase 0 did not verify applied status
of any migration — that is a 37.17 item.

---

# Implementation Ledger

**Historical trail of implementation changes.**

| Date | Phase | File | Change | Reason | Test | Verified |
|---|---|---|---|---|---|---|
| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-phase-0-audit.md` | Created | Phase 0 deliverable | N/A | Phase 0 gate |
| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-issue-register.md` | Created | Preserve Phase 0 findings | N/A | Reviewed |
| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-plan.md` | Created | Revised plan post-Phase 0 | N/A | Reviewed |
| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-tracker.md` | Created | Master operational tracker | N/A | This document |
| 2026-09-30 | 37.0A | `src/app/actions/workflows/workflow.ts` | `updateWorkflowState`: unscoped `update({ where: { id } })` replaced with a tenant-scoped `findFirst` refusal plus a tenant-scoped `updateMany` write | I1 — close cross-tenant workflow update | `workflow-update-scope.test.ts` 5/5 | VERIFIED 2026-09-30 |
| 2026-09-30 | 37.0A | `src/tests/workflow/workflow-update-scope.test.ts` | Created | I1 regression coverage | — | 5/5 |
| 2026-09-30 | 37.0A | `src/tests/workflow/helpers/prisma-double.ts` | Added a `workflow` delegate (`findFirst`, `updateMany`) sharing one `matchesWorkflowWhere` tenant filter | I1 — the double must enforce `orgId` or the negative tests prove nothing | workflow suite 109/109 | VERIFIED 2026-09-30 |
| 2026-09-30 | 37.0B | `src/app/actions/workflows/workflow.ts` | `IncomingNodeSchema` became a real `z.discriminatedUnion` over node shapes keyed on `node.type`, with `data` validated directly; the `.or(z.any())` tail removed; both save actions share one `IncomingNodesSchema` and persist the parsed nodes | I2 — make node validation at the persistence boundary actually validate | `workflow-node-validation.test.ts` 23/23 | VERIFIED 2026-09-30 |
| 2026-09-30 | 37.0B | `src/tests/workflow/workflow-node-validation.test.ts` | Created | I2 regression coverage, both save paths | — | 23/23 |
| 2026-09-30 | 37.0B | `src/tests/workflow/helpers/prisma-double.ts` | Added `workflow.create` so a create-path test can observe the persisted row | I2 — rejection tests assert nothing reached the database | workflow suite green | VERIFIED 2026-09-30 |
| 2026-10-20 | I6 | `src/lib/workflow/execution/trigger.ts` | `startWorkflow` gained a REQUIRED `orgId` first parameter; lookup changed from `findUnique({ where: { id } })` to `findFirst({ where: { id, orgId } })` | I6 — the run-creating lookup must be tenant-scoped | `trigger-tenant-scope.test.ts` 4/4 | VERIFIED 2026-10-20 |
| 2026-10-20 | I6 | `src/app/actions/workflows/workflow-run.ts` | `triggerWorkflowRun` calls `getOrgAccess(orgslug)` and refuses with `Unauthorized` on `null`; passes the verified `organization.id` to `startWorkflow` | I6 — public server action must authenticate and authorize | `workflow-run-boundary-scope.test.ts` 6/6 | VERIFIED 2026-10-20 |
| 2026-10-20 | I6 | `src/app/api/workflow/test/[workflowId]/test-run/route.ts` | `POST` calls `auth()` (401 without a session); resolves the workflow via a membership-constrained predicate; passes the resolved `orgId` | I6 — second reachable path; must be protected independently | `workflow-run-boundary-scope.test.ts` 6/6 | VERIFIED 2026-10-20 |
| 2026-10-20 | I6 | `src/tests/workflow/trigger-tenant-scope.test.ts` | Created | I6 regression: tenant-scoped lookup + no side effects on refusal | — | 4/4 |
| 2026-10-20 | I6 | `src/tests/workflow/workflow-run-boundary-scope.test.ts` | Created | I6 regression: both public entrypoints authenticate/authorize | — | 6/6 |
| 2026-10-20 | I6 | `docs/dev-log/2026-10-20-i6-cross-tenant-execution.md` | Created | I6 ticket record | N/A | Reviewed |
| 2026-09-30 | 37.0B | `src/tests/workflow/workflow-update-scope.test.ts` | Fixture node given a `label` so it is a valid node | I1 suite must exercise tenant scope, not node shape — real validation would otherwise reject it before the tenant check | 5/5 | VERIFIED 2026-09-30 |
| 2026-10-01 | 37.1 | `src/lib/workflow-types/action-capabilities.ts` | Created — client-safe capability catalog (input/output schemas, compensation, failure notes) plus derivation helpers | F3 — one authoritative planner-facing capability source without exposing server-only deps | `action-capabilities.test.ts` 32/32 | VERIFIED 2026-10-01 |
| 2026-10-01 | 37.1 | `src/lib/workflow-types/action-registry.ts` | `ActionRegistry` now `satisfies Record<string, WorkflowAction>`; exports `RegisteredActionId = keyof typeof ActionRegistry` | Couple the catalog to the runtime registry's literal key set (compile-time totality) | `tsc --noEmit` exit 0; TS2353/TS1360 guards | VERIFIED 2026-10-01 |
| 2026-10-01 | 37.1 | `src/lib/workflow-types/registry.ts` | `AVAILABLE_ACTIONS` projected from `ActionCapabilities`; `ACTION_FIELD_PRESENTATION` typed `Partial<Record<RegisteredActionId, …>>` with no `required` key | I4 — remove the hand-maintained second list that drifted (`comment.add`); derive requiredness/outputs | `action-capabilities.test.ts`; Mutation B fails 3/30 | VERIFIED 2026-10-01 |
| 2026-10-01 | 37.1 | `src/tests/workflow/action-capabilities.test.ts` | Created | F3/I4 regression: totality, required/optional inputs, output fields, trusted-identity rejection, `comment.add` absence | — | 32/32 |
| 2026-10-01 | 37.1 | `docs/architecture/workflows/assignments-37-phase-37.1-capability-catalog.md` | Created | 37.1 phase record, three boundaries, AD-P1, I7 | N/A | Reviewed |
| 2026-10-21 | 37.15 | `src/tests/workflow/workflow-integration-diamond.test.ts` | Created — 9 cases driving the assembled engine: `startWorkflow` → `advanceWorkflow` → `POST /api/workflow` → `resolveInputs` → `wrapStepOperation` → real action registry → real `task.create` action → real context merge | 37.15 — the engine had unit coverage of every component and none of the assembly; a fan-in that fires early or an output that never propagates reads as a success | `workflow-integration-diamond.test.ts` 9/9 | 37.15 |
| 2026-10-21 | 37.15 | `src/tests/workflow/dag-validation.test.ts` | Added "accepts a fan-in, where a join depends on two independent roots" | 37.15 — the graph gate listed fan-in as its own item, but the file that owns graph-shape validation only implied it inside the diamond | `dag-validation.test.ts` 26/26 | 37.15 |
| 2026-10-21 | 37.15 | `src/tests/workflow/helpers/prisma-double.ts` | `attachRun` now accepts `{ run: true }`, `{ run: { workflow: true } }` and `{ run: { include: { workflow: true } } }`; added `workflowRun.create` and `workflow.findUnique` delegates with schema-aligned run defaults (`contextVersion: 0`) | 37.15 — the double did not model the include shape the worker route actually requests, so the route answered 500 and the harness failure looked like a broken engine | workflow tree 21 suites / 368 tests | 37.15 |

**No Prisma schema, migration, prompt, or agent tool has been changed.** The
execution path (`workflow-run.ts`, `execution/trigger.ts`, `execution/resolver.ts`)
is untouched by 37.1 — that is I6, which was closed earlier by its own ticket
(2026-10-20; the 37.1 diff itself did not scope it). Conditional routing
(`actions/logic/conditions.ts`, the evaluator gate) is untouched — that is I7,
recorded but not implemented.

---

# Current Blockers

| Blocker | Severity | Reason | Blocks Phase | Owner/Action | Status |
|---|---|---|---|---|---|
| **I1** — cross-tenant workflow update | **P0** | `db.workflow.update` predicate was `{ id: workflowId }` with no `orgId`, while `getOrgAccess` established membership in an org the update then ignored. Any authenticated member of any org could overwrite any workflow. | 37.5 and all agent workflow writes; 37.8, 37.11 | Tenant-scoped predicate + regression test | **CLOSED 2026-09-30 — VERIFIED** |
| **I2** — node validation boundary | **P0** | `IncomingNodeSchema.data` was `.optional().or(z.any())`, making the discriminated union unreachable; `updateWorkflowState` validated `z.array(z.any())`. Generated `uiNodes` would cross the persistence boundary unvalidated. | 37.10, 37.11 | Tenant-scoped node-data validation on **both** paths | **CLOSED 2026-09-30 — VERIFIED** |
| **I6** — cross-tenant workflow execution | **P0** | `triggerWorkflowRun` (`workflow-run.ts:5`) performed no authentication and no organization check; `startWorkflow` (`trigger.ts:8`) loaded the workflow with `findUnique({ where: { id: workflowId } })` and no `orgId`. Any authenticated user could start any tenant's workflow, seeding an attacker-chosen `triggerPayload` into the run context under `{{trigger.outputs.*}}`. | **37.12** (Gate G) and every phase that hands a generated workflow to the engine | Separate security ticket: tenant-scoped execution entrypoint + regression test (cross-org run refused and no `WorkflowRun` created, same-org run succeeds). Covered all reachable callers, incl. `api/workflow/test/[workflowId]/test-run`. **Not** satisfied by closing I1. | **CLOSED 2026-10-20 — VERIFIED** |

### Not active blockers

| Item | Why it is not a blocker |
|---|---|
| **I5** — maintenance schedule | **RESOLVED 2026-10-23.** `scd_6Q8msEqiSPejMBjkvLrW6Fqw2xE5` exists and has fired successfully. The dev-tunnel destination still needs a stable production replacement. |
| F1, F2, F4, F5 | P2 / design forks. Each has a named phase. |
| **I7** — conditional routing not executable/authorable | P2 scope decision, recorded during 37.1. Non-blocking; no phase claims generated conditional branches until it is decided. |
| I3 | P2/P3; resolved with later state-machine cleanup. |

**No fictional blockers are recorded.**

---

# Explicit Non-Goals

Architectural guardrail. If a change below appears in a diff, it is a defect
regardless of intent.

- [ ] **No second DAG executor.** The existing evaluator is the only executor.
- [ ] **No second QStash node runner.**
- [ ] **No second Redis lock system.** `src/lib/locking/redis-lock.ts` is the single primitive.
- [ ] **No second reference language.** `{{…}}` with `<stepId>.outputs.*` and `trigger.outputs.*`.
- [ ] **No AI-owned execution authority.** Gemini proposes; the backend compiles and dispatches.
- [ ] **No AI-owned tenant identity.** `orgId` from persisted context, always.
- [ ] **No AI-owned final criticality.** The human decides.
- [ ] **No direct action execution from `generateWorkflow`.**
- [ ] **No `Task` row per generated graph node.**
- [ ] **No arbitrary preemptive `WorkflowProposal` migration.**
- [ ] **No UI coordinates generated by Gemini.**
- [ ] **No new rollback controller.** Existing saga pivot and compensation stand.
- [ ] **No second retry system.** Self-correction re-enters the agent loop, not a step retry.
- [ ] **No I6 fix folded into I1.** Cross-tenant UPDATE and cross-tenant EXECUTION
      are separate defects on separate paths, gated at 37.5 and 37.12. Neither
      closed ticket may stand in for the other.
- [ ] **No execution-path change under 37.0A.** `triggerWorkflowRun`,
      `startWorkflow` and the maintenance/test-run routes are untouched by the
      I1 fix. I6 is a separate ticket.
- [ ] **No conditional-routing implementation under 37.1.** `executeConditionNode`
      is not registered, no routing field is added to the canvas, and the
      evaluator's branch gate is not changed. I7 is a scope decision, not a task.

---

# Assignment 37 Completion Checklist

### Phase completion

- [x] Phase 37.0 complete — **VERIFIED 2026-09-30** — evidence: `assignments-37-phase-0-audit.md`
- [x] I1 closed and verified (37.0A) — **VERIFIED 2026-09-30** — evidence: `src/tests/workflow/workflow-update-scope.test.ts`
- [x] I2 closed and verified (37.0B) — **VERIFIED 2026-09-30** — evidence: `src/tests/workflow/workflow-node-validation.test.ts`
- [x] 37.1 complete — **VERIFIED 2026-10-01** — evidence: `src/tests/workflow/action-capabilities.test.ts`
- [x] **I6 closed and verified (separate ticket, before 37.12)** — real-PostgreSQL cross-tenant acceptance run passed 2026-10-20 (10/10); no `WorkflowRun` created on any refusal; fixtures removed with zero leftovers — evidence: `src/tests/security/i6-cross-tenant.realdb.test.ts`, `docs/dev-log/2026-10-20-i6-real-db-acceptance.md`
- [x] 37.2 complete — **VERIFIED 2026-10-12** — schema + validator + 45 cases green; bounds hardened; real-model-path parse reassigned to 37.5 — evidence: `src/tests/workflow/workflow-proposal.test.ts`
- [x] 37.3 complete — **VERIFIED 2026-10-12** — reference validator over the existing `{{…}}` grammar; 44 cases green; `MISSING_DATA_DEPENDENCY` enforced; resolver unmodified; F6 closed — evidence: `src/tests/workflow/proposal-references.test.ts`
- [x] 37.4 complete - **VERIFIED 2026-10-23** - real-PostgreSQL production-path acceptance 3/3 (cyclic proposal refused as `PROJECTION_FAILED`, no `Workflow` row, lifecycle unchanged); focused 25/25; workflow 21/369; full 78/1265; tsc 0; eslint 0 - evidence: `src/tests/agent/proposal-compiler-materialization.realdb.test.ts`
- [x] 37.5 complete - **VERIFIED 2026-10-23** - live Gemini `gemini-3.6-flash` emitted a proposal that validated, compiled and executed unchanged (1/1, no fix-up); focused 35/35; agent 43/814; workflow 21/369; full 78/1265; tsc 0; eslint 0 - evidence: `src/tests/agent/generate-workflow.live.test.ts`, `src/tests/agent/generate-workflow.test.ts`
- [ ] 37.6 complete — **IMPLEMENTED 2026-10-14 (remediated)** — missing-input protocol + clarification lifecycle; worker halt + `CLARIFICATION_REQUESTED`; `POST .../clarification` ingress; `interactionId`+`correlationId` binding; reaper `skippedWaiting`; 28 cases green; F4 open; durability deferred to 37.8 — evidence: `src/tests/agent/missing-input-protocol.test.ts`, `src/tests/agent/durability.test.ts`
- [x] 37.7 complete — **VERIFIED 2026-10-23** — evidence: `src/tests/agent/criticality-integration.test.ts` (2/2), `criticality-service.test.ts` (24/24), `criticality-route.test.ts` (19/19), `workflow-criticality.test.ts` (15/15)
- [ ] 37.8 complete
- [ ] 37.9 complete
- [ ] 37.10 complete — **IMPLEMENTED 2026-10-19 (not VERIFIED)** — deterministic projection + hand-rolled layered layout + read-only preview; server-side revision binding; 33/7/19/19 focused tests; full 53/1005; tsc/eslint/prisma clean; F1 still open (AD-11 ordering) — evidence: `src/tests/workflow/proposal-ui-projection.test.ts`, `assignments-37-phase-37.10-ui-graph-projection.md`
- [ ] 37.11 complete
- [ ] 37.12 complete
- [ ] 37.13 complete — **IMPLEMENTED 2026-10-21 (not VERIFIED)** — `AGENT_PROMPT_VERSION` v5 → v6; DAG-planning/local-id/capability-contract/reference-grammar/clarification/criticality/propose-only/validation-observation guidance added to `<WORKFLOW_GENERATION>`; v5 text preserved; `tool.ts` unchanged; new `prompt-dag-planning.test.ts` 29/29; full 69/1197; tsc/eslint/diff-check clean; manual prompt-vs-registry review done; model obedience unverified — evidence: `src/tests/agent/prompt-dag-planning.test.ts`, `docs/dev-log/2026-10-21-phase-37.13-prompt-dag-planning.md`
- [x] 37.14 complete — **VERIFIED 2026-10-23** — three distinct loops separated and bounded without a second retry controller; real-PostgreSQL wait-state CAS and proposal-review expiry isolation verified — evidence: `src/tests/agent/wait-state-cas.realdb.test.ts` (9/9), `three-loop-separation.test.ts` (6/6), `no-second-retry-controller.test.ts` (8/8), `proposal-review-expiry.test.ts` (35/35)
- [x] 37.15 complete — **VERIFIED 2026-10-23** — complete 43-check Test Gate matrix verified across all 8 categories; full default Jest suite 79 suites / 1267 tests pass; assembled-engine integration 9/9; tsc 0; eslint 0; diff-check clean; all predecessor phases 37.0–37.14 VERIFIED; formal prerequisite for 37.16 satisfied — evidence: 11 focused matrix suites (254 tests), full Jest suite (1267 tests)
- [ ] 37.16 complete
- [ ] 37.17 complete

### Issue closure

- [x] All P0 issues verified (I1 ✓, I2 ✓, **I6 ✓**) — three separate tickets; none
      substitutes for another. No P0 remains open (I6 closed by a real-PostgreSQL
      cross-tenant acceptance run, 2026-10-20).
- [ ] All P1 issues resolved or explicitly deferred (F3 ✓, I4 ✓, F6 ✓; F4, F5 open)
- [x] I5 verified (workflow-maintenance schedule exists and has fired successfully)
- [ ] All P2/P3 issues resolved or explicitly deferred (F1, F2, I3, I7)

### Decision closure

- [ ] All pending architectural decisions resolved (AD-P2 … AD-P7; AD-P1 ✓ 2026-10-01)

### Evidence closure

- [ ] Migration status verified
- [x] Full test suite passes — **2026-10-21 (37.15)** — `npm test` 72 suites / 1232 tests; realdb 2 suites / 15 tests; `npx tsc --noEmit` exit 0; `npm run lint` exit 0; `git diff --check` clean — evidence: Verification Ledger rows for 37.15
- [ ] Live capstone passes with per-check evidence
- [ ] Final documentation complete

---

## Tracker Rules

1. Update the tracker after every phase.
2. Never mark VERIFIED without evidence.
3. Never mark an issue RESOLVED without a test or verification reference.
4. Never silently delete historical status.
5. Preserve status history.
6. Record architecture decisions when they are actually made.
7. Record unresolved forks as PENDING DECISION.
8. Keep implementation notes separate from architectural decisions.
9. Do not claim deployed/live behavior from local tests.
10. Do not change the assignment architecture through tracker edits alone.
11. If implementation reveals that the plan is wrong, update the plan explicitly and record why in the decision log.
12. The tracker is the operational source for "where are we now?", while the plan remains the architectural source for "what are we building?"

---

*Tracker created 2026-09-30 alongside the Phase 0 audit, issue register, and plan.
Updated 2026-10-01 after Phase 37.1 verification: F3 and I4 are closed with
evidence, AD-P1 is decided, and I7 is recorded. No deployed/live behavior is
claimed; all 37.1 evidence is local Jest- and compiler-level.*
