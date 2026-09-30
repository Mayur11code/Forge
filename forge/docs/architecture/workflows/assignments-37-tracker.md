# Assignment 37 — Master Phase Tracker

```text
Last Updated:     2026-09-30
Current Phase:    37.0A  (37.0 is VERIFIED)
Overall Status:   BLOCKED
Next Action:      Close P0 prerequisites (37.0A I1, 37.0B I2), then begin 37.1
```

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
| `assignments-37-issue-register.md` | Findings. F1–F6, I1–I5, priorities, dependency map. |
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

Overall:                     BLOCKED
Current Phase:               37.0A  (Security prerequisite — I1)
Previous Completed Phase:    37.0   (Contract reconnaissance — VERIFIED)
Next Phase:                  37.0B  (Persistence-boundary prerequisite — I2)
Blocking Issue:              I1, I2  (both P0)
Security Prerequisites:      I1 NOT_STARTED, I2 NOT_STARTED
Architecture Decision Pending: F1, F2, F4, F5
Last Verification:           NONE — no test or live verification has been performed
Last Updated:                2026-09-30

Progress:
[█░░░░░░░░░░░░░░░░░░░] 5%   (1 of 20 tracked phases VERIFIED)
```

### Why `BLOCKED` and not `IN_PROGRESS`

Two P0 findings gate any workflow-writing capability. Phases 37.1–37.4 write no
workflows and can proceed once Gate A is satisfied by isolation. Phase 37.5 and
beyond cannot: the agent must not become a workflow writer while
`updateWorkflowState` updates by primary key alone.

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
| 37.0A | Security prerequisite — I1 tenant-scoped workflow update | **NOT_STARTED** | **P0** | 37.0 | 37.5, 37.8, 37.11, all agent writes | Tenant-scoped update predicate + regression test | Cross-org write rejected; same-org write succeeds | — | Separate ticket. Not to be bundled into a feature phase. |
| 37.0B | Persistence-boundary prerequisite — I2 node validation | **NOT_STARTED** | **P0** | 37.0 | 37.10, 37.11 | Real node-data validation on create **and** update paths | Valid node accepted; malformed node rejected | — | Separate ticket. |
| 37.1 | Action capability registry | **NOT_STARTED** | **P1** | 37.0A, 37.0B (isolation sufficient) | 37.2, 37.3, 37.4 | One authoritative planner-facing capability source | Planner obtains authoritative metadata for every generatable action | — | Resolves F3, absorbs I4. |
| 37.2 | WorkflowProposal schema | **NOT_STARTED** | P1 | 37.1 | 37.3, 37.4 | `WorkflowProposal` Zod schema | Static A / B→A / C→A,B parses; malformed fails structurally | — | localRef IDs; no DB IDs, no coordinates, no criticality. |
| 37.3 | Reference grammar + validator | **NOT_STARTED** | P1 | 37.2 | 37.4, 37.5 | Reference validator over existing `{{…}}` grammar | Unordered data reference cannot pass validation | — | Resolves F6. Adds `MISSING_DATA_DEPENDENCY`. **No new syntax.** |
| 37.4 | Proposal compiler / semantic validation adapter | **NOT_STARTED** | P1 | 37.3 | 37.5, 37.11 | Single deterministic compiler boundary | Proposal + DAG validation form one boundary; issue codes preserved | — | Resolves F5. Reuses `collectWorkflowDefinitionIssues`. |
| 37.5 | `generateWorkflow` agent tool | **NOT_STARTED** | P1 | 37.4, **37.0A VERIFIED** | 37.6, 37.7, 37.8 | Macro agent tool, proposal-only | Tool registered, proposes only, executes nothing | — | **Gate E: I1 must be VERIFIED.** |
| 37.6 | Missing-input state | **NOT_STARTED** | P1 | 37.5 | 37.7, 37.8 | Durable `NEEDS_USER_INPUT` state | Model error and missing user info are distinguishable in the protocol | — | F4 part 1. No preemptive migration. |
| 37.7 | Human criticality state | **NOT_STARTED** | P1 | 37.6 | 37.8, 37.9 | Durable human criticality decision | Model cannot set or override final `isCritical` | — | F4 part 2. |
| 37.8 | Durable proposal persistence | **NOT_STARTED** | P1 | 37.7 | 37.9, 37.11 | Chosen proposal persistence lifecycle | Full lifecycle survives process restart | — | **PENDING DECISION** — reuse vs new model. |
| 37.9 | Existing confirmation integration | **NOT_STARTED** | P1 | 37.8 | 37.11 | Review surface over existing 35/36 gate | Approval binds exact proposal; changed proposal cannot reuse it | — | Mechanism already exists. Surface is the work. |
| 37.10 | UI graph projection / deterministic layout | **NOT_STARTED** | P2 | 37.9, 37.0B VERIFIED | 37.11 | Deterministic `uiNodes`/`uiEdges` + layout | Projection is deterministic and Gemini-free | — | **F1.** Moved ahead of materialization. |
| 37.11 | Workflow materialization | **NOT_STARTED** | P2 | 37.10 | 37.12 | `Workflow` row with compiled definition | Persisted workflow is executable and name/provenance correct | — | F1 + F2. Canvas-first path. |
| 37.12 | Execution handoff | **NOT_STARTED** | P1 | 37.11 | 37.16 | Handoff to existing evaluator | Generated workflow runs in the existing engine | — | No new executor, lock, or queue runner. |
| 37.13 | Prompt / DAG planning instructions | **NOT_STARTED** | P1 | 37.12 | 37.16 | Prompt update + version bump | Prompt references real contracts only | — | Only after 37.1. Version explicitly tracked. |
| 37.14 | Self-healing observations | **NOT_STARTED** | P1 | 37.13 | 37.16 | Three distinct loops in the state machine | Self-correction, clarification and approval are distinguishable | — | No second retry controller. |
| 37.15 | Full test matrix | **NOT_STARTED** | P1 | 37.14 | 37.16 | All test classes passing | Full suite green | — | Includes I1 regression test. |
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

**NOT_STARTED** · Classification: **P0** · separate prerequisite ticket

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
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**I1.** Affected path: `updateWorkflowState`
(`src/app/actions/workflows/workflow.ts:95-137`). The authorization check and the
database predicate disagree in scope. Impact is read-write on execution
blueprints for every tenant, by primary key, with no requirement that the target
belong to the caller's organization.

### Decisions

Made: none. The fix form is the ticket's decision.

Pending: none specific to I1.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.0B — Persistence-boundary prerequisite: I2 node validation

### Status

**NOT_STARTED** · Classification: **P0** · separate prerequisite ticket

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
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**I2.** `IncomingNodeSchema.data` is `.optional().or(z.any())`;
`updateWorkflowState` validates `z.array(z.any())`. Also **F1** — the reason
generated content passes through the canvas at all.

### Decisions

Made: none.

Pending: none specific to I2.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.1 — Action capability registry

### Status

**NOT_STARTED** · Classification: **P1**

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

- Capability surface — file/type location **UNKNOWN** until designed
- Reconciliation of `ActionDef` against `ActionRegistry` — location UNKNOWN
- Tests asserting registry/capability agreement
- Updated `assignments-37-tracker.md` Decision Log entry

### Acceptance Gate

The planner can obtain authoritative metadata for every action it is allowed to
generate, and no advertised action is unregistered.

### Test Gate

- Every capability entry corresponds to a registered action
- No registered action is missing from the capability surface
- `task.create` declared inputs match its implementation
  (implementation requires `title` **and** `projectId`; the UI `ActionDef`
  declares only `projectId`)
- `task.create` declared outputs match its implementation
  (implementation returns `{ taskId, title }`; `ActionDef` declares `['taskId']`)
- Capability surface contains no trusted identity field

### Verification Gate

Unit tests plus an inspection confirming `comment.add` is no longer advertised as
generatable without being registered — or has been registered deliberately.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F3.** `WorkflowAction` carries no description, input or output contract.
Two candidate sources exist and already contradict each other.

**I4.** `comment.add` is in `AVAILABLE_ACTIONS`
(`registry.ts:76-85`) but not in `ActionRegistry`. A workflow using it saves and
then fails at execution, because the compiler performs no registry membership
check.

Risk: creating a *third* surface instead of reconciling the two existing ones.

### Decisions

Made: none.

Pending: where capability metadata lives (on `WorkflowAction` vs a descriptor
keyed by action id). **This is the phase's primary design decision.**

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.2 — WorkflowProposal schema

### Status

**NOT_STARTED** · Priority: P1

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

- `WorkflowProposal` schema — path **UNKNOWN**, expected under
  `src/lib/workflow-types/` or a proposal-specific module
- Structural validation tests
- Type exports

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

Unit tests green, plus inspection that a proposal produced by the real model path
parses without a compiler fix-up step.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**I4** (from 37.1) — "action must be a registered workflow action" is currently
unenforceable, because `WorkflowStep.action` is `z.string()` and the compiler does
no membership check. 37.1 makes it enforceable.

**F2** (surfaced later, at 37.11) — the proposal's `name` belongs in
`Workflow.name`, not `definition.name`.

### Decisions

Made: none.

Pending: none specific beyond 37.1's carried decision.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.3 — Reference grammar + validator

### Status

**NOT_STARTED** · Priority: P1 · Resolves **F6**

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

- Reference validator — path **UNKNOWN**
- New issue code(s), including `MISSING_DATA_DEPENDENCY`
- Unit tests
- Zero changes to `src/lib/workflow/execution/resolver.ts`

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

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F6.** No preflight validation; silent failure on missing reference
(`resolver.ts:58`, `:65-67`, with `:66` noting strict failure as a known
unimplemented option); no input-reference/`dependsOn` cross-check.

Note recorded in Phase 0 and *unrated*: the path character class `\w` permits
`__proto__` as a segment, and `getValueByPath` traverses any object it is handed.
No exploit was constructed and severity was not assessed. It is in scope for
37.3 because the grammar is.

### Decisions

Made: **reuse the existing `{{…}}` grammar.** Established in the plan; do not
revisit.

Pending: none.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.4 — Proposal compiler / semantic validation adapter

### Status

**NOT_STARTED** · Priority: P1 · Resolves **F5**

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

- Proposal compiler — path **UNKNOWN**
- Structured error type
- Reuse tests over all seven existing DAG codes
- F5 resolution note in the plan and Decision Log

### Acceptance Gate

Proposal validation and existing DAG semantic validation form one deterministic
compiler boundary. Issue `code` and `path` survive to the caller.

### Test Gate

- All seven existing DAG checks reachable from a proposal
- `code` and `path` present in structured output
- No duplicate DAG implementation
- F5 decision implemented — the chosen gate is actually invoked in production

### Verification Gate

Unit tests green, plus a production-path check that the chosen gate runs on
materialization, not only in tests.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F5.** `WorkflowDefinitionSchema` appears only at its definition, its inferred
type, and `src/tests/workflow/dag-validation.test.ts`. A proposal compiler is a
*second* producer of `WorkflowDefinition`, so the gate must be explicit.

### Decisions

Pending: **F5 — which gate is canonical**, `WorkflowDefinitionSchema` or the
compiler's issue collector.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.5 — `generateWorkflow` agent tool

### Status

**NOT_STARTED** · Priority: P1

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

- `generateWorkflow` tool module — path **UNKNOWN**, expected under
  `src/lib/ai/agent/tools/`
- Registry entry with policy
- Proposal describer for the review surface
- Tests

### Acceptance Gate

The tool is registered, proposes only, and executes nothing.

### Test Gate

- Tool appears in the model-visible tool set
- Executor returns structured issues on invalid input
- No action `execute` is reachable from this tool
- No `Workflow` row is created by this tool
- Policy is resolved server-side from the tool name
- Unregistered-input paths fail closed

### Verification Gate

Integration test proving a `generateWorkflow` turn produces a proposal artifact
and zero side effects.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**I1** — blocking per Gate E. **I2** — not yet closed; this phase writes no
workflow, so it is not blocking here, but it becomes blocking at 37.10/37.11.

### Decisions

Pending: the tool's access classification and therefore whether it requires
confirmation. `WRITE` is the likely candidate but is a design decision.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.6 — Missing-input state

### Status

**NOT_STARTED** · Priority: P1 · F4 part 1

### Objective

Make "the user never supplied this" a first-class, durable, distinguishable
outcome — distinct from "the model made a mistake".

### Architectural Role

One of the three loops the plan requires to be explicitly distinct. Without it,
the model either guesses or produces prose that nothing can act on.

### Inputs / Dependencies

- 37.5
- **F4 part 1** — `AgentToolExecution` has no `result` column and no
  `NEEDS_INPUT` status (`prisma/schema.prisma`)
- Existing self-correction path via `AGENT_LOOP_REQUESTED`

### Required semantic distinction

| Condition | Who resolves it |
|---|---|
| `UNKNOWN_DEPENDENCY` | Model self-corrects |
| `INVALID_INPUT` | Model self-corrects |
| `CYCLE` | Model self-corrects |
| `MISSING_USER_INPUT` | **Human is asked** |

### Scope

- Durable representation of the missing-input state
- `field`, `reason`, `question`, optional `candidateValues?`
- Continuation after the user answers
- Distinguishing the two failure classes in the protocol

### Out of Scope

**Do not invent the final persistence model.** Do not create a migration here.

- No `WorkflowProposal` table
- No schema change until the 37.6/37.7 design decision is made
- No criticality state (37.7)

### Expected Implementation

A structured `NEEDS_USER_INPUT` result that the agent can render as a
user-facing question, and that survives the process boundary. The question text
is presentation; the state must be machine-readable.

### Deliverables

- Missing-input state representation — location **UNKNOWN**
- Continuation path after user answer
- Tests
- F4 part-1 design decision recorded

### Acceptance Gate

Model error and missing user information are distinguishable in the protocol, and
the missing-input state is durable.

### Test Gate

- One missing required input → `NEEDS_USER_INPUT`
- Multiple missing inputs → all reported
- Model error → self-correction, **not** a user question
- State survives process restart
- Continuation after user answer
- Regenerated proposal remains valid

### Verification Gate

Integration test: a real missing-input case produces a human question rather than
a hallucinated value.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F4.** `AgentToolExecution` columns: `id`, `sessionId`, `toolCallId`,
`toolName`, `input`, `error`, `status`, `confirmedAt`, `cancelledAt`, `expiresAt`,
`expiredAt`. No `result`. Status enum has no `NEEDS_INPUT`.

**I3.** A session awaiting input would remain `RUNNING` — the session-level pause
state is unwired (see Decision Log).

### Decisions

Pending: **F4 — how the missing-input state is persisted.** Three options
identified in the register: encode in `input` and carry through confirmation; grow
the execution state machine; dedicated model. **Not decided here.**

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.7 — Human criticality state

### Status

**NOT_STARTED** · Priority: P1 · F4 part 2

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

- Criticality state representation — location **UNKNOWN**
- Application at materialization
- Tests proving model output cannot set or override

### Acceptance Gate

The stored execution policy comes from the human decision. Model output cannot
set or override `isCritical`.

### Test Gate

- Model cannot set final criticality
- Human criticality persists
- Confirmed value cannot be overridden by a later model turn
- Criticality changes affect only the intended materialized policy
- Human-approved criticality survives materialization unchanged

### Verification Gate

Integration test where the model proposes criticality and the stored value differs,
proving the human decision won.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F4 part 2.** Human criticality answers have no column anywhere today.

Recorded semantics that must not be misremembered: `isCritical` gates rollback,
**not** final run status. A non-critical failure still ends the run `FAILED`.

### Decisions

Made: Gemini does not own final criticality. (Established in the plan.)

Pending: persistence representation — shares the F4 fork with 37.6.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.8 — Durable proposal persistence

### Status

**NOT_STARTED** · Priority: P1 · **F4**

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
- **F4** — the open fork
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

Two options remain open:

1. **Reuse / extend `AgentToolExecution`** — it already holds `input` (Json),
   `status`, and approval timestamps, but has no `result` column and no lifecycle
   states.
2. **Dedicated `WorkflowProposal` model** — clean lifecycle, at the cost of a
   migration and a second state machine.

Phase 0 recorded that the existing `AgentOutboxEvent` pattern
(`src/lib/ai/agent/outbox.ts:143`, `:221`, `:289`) is the established precedent
for durable agent state, and should inform whichever option is chosen.

### Deliverables

- Chosen persistence implementation — location **UNKNOWN**
- Lifecycle tests
- Migration **only if** a new model is chosen
- F4 decision recorded in plan + Decision Log

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
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F4.** No `result` column; no `NEEDS_INPUT` / `AWAITING_CRITICALITY` /
`VALIDATING` statuses.

**F2.** `definition.id` is `compiled_${Date.now()}` and cannot serve as proposal
identity.

### Decisions

Pending: **F4 — reuse `AgentToolExecution` or introduce `WorkflowProposal`.**
Explicit instruction from the plan: do not create the migration preemptively.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.9 — Existing confirmation integration

### Status

**NOT_STARTED** · Priority: P1

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

### Expected Implementation

Render the persisted proposal. Nothing about the approval mechanism changes.

### Deliverables

- Review surface — component paths **UNKNOWN**
- Surface tests
- Documentation that approval binds the exact proposal

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

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F2** — the review surface's "workflow name" must read `Workflow.name`, not
`definition.name` (a hardcoded placeholder).

### Decisions

Made: reuse the 35/36 confirmation system. No special architecture.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.10 — UI graph projection / deterministic layout

### Status

**NOT_STARTED** · Priority: P2 · **F1**

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

- Projection implementation — path **UNKNOWN**
- Determinism tests
- Layout decision recorded

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

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F1** — canvas-first persistence is the reason for this phase's ordering.
**I2** — must be VERIFIED first, or generated nodes cross the boundary
unvalidated.

### Decisions

Pending: **F1 — synthesize layout before persistence, or introduce a
definition-first write path.** Not chosen in the plan; belongs to 37.10/37.11.
Note: option two creates a second write path that must independently replicate the
validation and authorization properties of the first — precisely what I1 shows
can be got wrong.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.11 — Workflow materialization

### Status

**NOT_STARTED** · Priority: P2 · **F1 + F2**

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
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**F1** — canvas-first persistence.
**F2** — `definition.id` is a per-save placeholder and can collide; `definition.name`
is a constant. There is no stable provenance key in the `definition` contract
today.
**I1**, **I2** — both P0, both must be VERIFIED first.

### Decisions

Pending: **F1** (carried from 37.10) and **F2** (where provenance lives).

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.12 — Execution handoff

### Status

**NOT_STARTED** · Priority: P1

### Objective

Hand a materialized `Workflow` to the existing execution engine.

### Architectural Role

Proves the core boundary: the existing runtime is the execution authority.

### Inputs / Dependencies

- 37.11 (materialized workflow)

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

### Expected Implementation

No new machinery. The existing path is the path.

### Deliverables

- Handoff integration — path **UNKNOWN**
- Integration test

### Acceptance Gate

A generated workflow successfully enters and runs in the existing execution
engine.

### Test Gate

- `WorkflowRun` created
- Evaluator dispatches ready steps
- Actions dispatch through `getAction`
- No new executor, lock, or queue runner added to the codebase
- Existing workflow tests still pass unchanged

### Verification Gate

Integration test proving end-to-step dispatch through the existing engine only.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

None outstanding. The engine is the hardened surface 37 depends on and must not be
rebuilt.

### Decisions

Made: the existing engine is the executor. No second runtime.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.13 — Prompt / DAG planning instructions

### Status

**NOT_STARTED** · Priority: P1

### Objective

Teach the model DAG planning, local references, and the boundaries.

### Architectural Role

The prompt can only describe contracts that exist. This phase is last among the
early ones for that reason.

### Inputs / Dependencies

- 37.1 minimum; 37.12 nominal
- `AGENT_PROMPT_VERSION` in `src/lib/ai/agent/constants.ts`
- `AgentSession.promptVersion`, defaulting to the legacy `"v1"`
- `src/lib/ai/agent/prompts/system-prompt.ts`
- Model: `gemini-2.5-flash` (`src/lib/ai/agent/model.ts`)

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
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

None. Sequencing risk only: writing the prompt before 37.1 would describe
contracts that do not exist.

### Decisions

Pending: prompt version identifier for this increment.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.14 — Self-healing observations

### Status

**NOT_STARTED** · Priority: P1

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

- Observation wiring — path **UNKNOWN**
- Loop distinction tests
- Bounded-loop tests

### Acceptance Gate

The three loops are explicitly distinct in the state machine and none is
implemented as a retry controller.

### Test Gate

- Self-correction: model corrects and re-proposes
- Clarification: human is asked, model does not invent
- Approval: human confirms exact proposal
- Loop bounded by `MAX_AGENT_STEPS`
- No second retry controller exists
- Correction consumes budget; it does not loop forever

### Verification Gate

Integration test exercising each of the three loops separately.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

**I3.** `WAITING_CONFIRMATION` is read in two places and written nowhere
(`src/lib/ai/agent/session-service.ts:201`, `:249`); `cancelAgentSession` filters
on an unreachable state. Loop 2 has no session-level representation. Does not
block 37.1; relevant here.

### Decisions

Pending: whether a durable pause uses the unused session-status enum slot.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

---

## Phase 37.15 — Full test matrix

### Status

**NOT_STARTED** · Priority: P1

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

- [ ] valid proposal
- [ ] duplicate `localRef`
- [ ] unknown action
- [ ] malformed input
- [ ] malformed dependency
- [ ] oversized proposal
- [ ] strict-schema rejection

### Test Gate — graph tests

- [ ] linear chain
- [ ] fan-out
- [ ] fan-in
- [ ] diamond
- [ ] disconnected graph
- [ ] self dependency
- [ ] cycle
- [ ] unknown dependency

### Test Gate — reference tests

- [ ] valid output reference
- [ ] unknown source step
- [ ] unknown output
- [ ] missing execution dependency
- [ ] nested reference
- [ ] malformed reference
- [ ] unavailable runtime state

### Test Gate — human-input tests

- [ ] one missing input
- [ ] multiple missing inputs
- [ ] user answer
- [ ] regenerated proposal remains valid

### Test Gate — criticality tests

- [ ] model cannot set final criticality
- [ ] human criticality persists
- [ ] changed criticality affects only the intended materialized policy
- [ ] confirmed value cannot be overridden

### Test Gate — confirmation tests

- [ ] exact proposal approval
- [ ] changed proposal cannot reuse old approval
- [ ] cancel
- [ ] expiry
- [ ] duplicate confirmation is idempotent

### Test Gate — execution integration

- [ ] independent A and B execute
- [ ] fan-in C waits for both
- [ ] output propagation A → input B
- [ ] real action execution
- [ ] resolver behaviour
- [ ] parallel execution

### Test Gate — I1 regression (added in Phase 0)

- [ ] cross-tenant workflow update rejected
- [ ] same-tenant legitimate update succeeds

### Verification Gate

Full suite green via `npm test` (Jest, `jest.config.ts`), plus
`npx tsc --noEmit` and `npm run lint`. Note: `package.json` defines no `typecheck`
script, so type-checking is invoked directly.

### Evidence

```text
Implementation: —
Tests:          —
Verification:   —
Commit/PR:      —
Relevant files: —
```

### Known Risks / Findings

None. This phase aggregates.

### Decisions

Made: none.

Pending: none.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

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

- [ ] workflow maintenance schedule **actually exists**, **or**
- [ ] deployed schedule documented as unverifiable from the repository

Phase 0 established: the handler exists
(`src/app/api/worker/workflow-maintenance/wm.ts`);
`scripts/qstash-maintenance-schedule.mjs` registers only
`AGENT_MAINTENANCE_REQUESTED`. Whether a workflow schedule exists on the deployed
QStash instance is **not observable from the repository**. A run that wedges during
capstone would be unrecoverable without this path, so it must be known beforehand.

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

**I5** — P1-CHECK. Not an active blocker until verification confirms absence.

### Decisions

Pending: none.

### Status History

| Date | Status | Change | Evidence |
|---|---|---|---|

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

**Nothing is resolved.** No fix has been implemented.

| ID | Description | Priority | Current State | Blocking? | Assigned Phase | Resolved? | Verification Evidence |
|---|---|---|---|---|---|---|---|
| **F1** | Canvas-first persistence; no definition → UI reverse projection | P2 | Open — recorded | No (gates 37.10/37.11 ordering) | 37.10 / 37.11 | **No** | — |
| **F2** | `definition.id` is a per-save placeholder; `definition.name` is a constant | P2 | Open — recorded | No | 37.11 | **No** | — |
| **F3** | No authoritative planner-facing action capability contract | P1 | Open — recorded | No (gates 37.2+) | 37.1 | **No** | — |
| **F4** | `AgentToolExecution` cannot represent the proposal lifecycle | P1 | Open — recorded, fork undecided | No | 37.6 / 37.7 / 37.8 | **No** | — |
| **F5** | `WorkflowDefinitionSchema` never called in production | P1 | Open — recorded | No | 37.4 | **No** | — |
| **F6** | No reference / data-dependency validation; silent failure | P1 | Open — recorded | No (gates 37.4+) | 37.3 | **No** | — |
| **I1** | Cross-tenant workflow update | **P0** | Open | **YES** | 37.0A | **No** | — |
| **I2** | Node validation bypass at persistence boundary | **P0** | Open | **YES** | 37.0B | **No** | — |
| **I3** | `WAITING_CONFIRMATION` session state unreachable | P2/P3 | Open | No | later cleanup / 37.14 | **No** | — |
| **I4** | Runtime / UI action registry mismatch | P1 | Open | No | 37.1 | **No** | — |
| **I5** | Workflow maintenance schedule unknown | **P1-CHECK** | **Unverified** | No — not an active blocker | 37.16 | **No** | — |

### Count

- Resolved: **0 of 11**
- P0 open: **2** (I1, I2)
- P1 open: **5** (F3, F4, F5, F6, I4)
- P1-CHECK unverified: **1** (I5)
- P2/P3 open: **3** (F1, F2, I3)

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

### Pending decisions — PENDING DECISION

| Ref | Question | Blocks | Where decided |
|---|---|---|---|
| **AD-P1** | Where does planner-facing action metadata live? | 37.2, 37.3, 37.4 | 37.1 |
| **AD-P2** | How is the missing-input state persisted? | 37.7, 37.8 | 37.6 / 37.7 |
| **AD-P3** | Reuse `AgentToolExecution` or add a `WorkflowProposal` model? | 37.9, 37.11 | 37.8 |
| **AD-P4** | Which validation gate is canonical — `WorkflowDefinitionSchema` or the issue collector? | 37.5, 37.11 | 37.4 |
| **AD-P5** | Synthesize layout before persistence, or add a definition-first write path? | 37.11 | 37.10 |
| **AD-P6** | Where does proposal provenance live, given `definition.id` is a placeholder? | 37.11 | 37.11 |
| **AD-P7** | Does a durable pause use the unused session-status enum slot? | 37.14 | 37.6 / 37.7 |

---

# Verification Ledger

**Every meaningful verification event.** No rows are invented.

| Date | Phase | Test/Check | Environment | Result | Evidence | Verified By |
|---|---|---|---|---|---|---|
| 2026-09-30 | 37.0 | Contract reconnaissance across workflow, persistence, agent and confirmation surfaces | Local — read-only source inspection | **PASS** | `assignments-37-phase-0-audit.md` (535 lines, `file:line` cited) | Phase 0 |
| 2026-09-30 | 37.0 | Phase 0 gate answered | Local — inspection | **PASS** | Audit, *Phase 0 gate* section | Phase 0 |
| 2026-09-30 | 37.0 | No source modified by Phase 0 work | Local — `git status --short` | **PASS** | Single untracked path: `forge/docs/architecture/workflows/` | Phase 0 |

### Coverage summary

| Category | Events recorded |
|---|---|
| unit | 0 |
| integration | 0 |
| database | 0 |
| Redis | 0 |
| QStash | 0 |
| live Gemini | 0 |
| live workflow execution | 0 |
| security | 0 |
| tenant isolation | 0 |
| documentation / inspection | 3 |

**No test, database, queue, or live verification has been performed.** Every
implementation phase below 37.0 is untested and unverified.

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

**Historical trail of implementation changes.** No entries exist because no
implementation has been performed. Phase 0 was documentation only.

| Date | Phase | File | Change | Reason | Test | Verified |
|---|---|---|---|---|---|---|

| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-phase-0-audit.md` | Created | Phase 0 deliverable | N/A | Phase 0 gate |
| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-issue-register.md` | Created | Preserve Phase 0 findings | N/A | Reviewed |
| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-plan.md` | Created | Revised plan post-Phase 0 | N/A | Reviewed |
| 2026-09-30 | 37.0 | `docs/architecture/workflows/assignments-37-tracker.md` | Created | Master operational tracker | N/A | This document |

**No source file, Prisma schema, migration, or prompt has been changed.**

---

# Current Blockers

| Blocker | Severity | Reason | Blocks Phase | Owner/Action | Status |
|---|---|---|---|---|---|
| **I1** — cross-tenant workflow update | **P0** | `db.workflow.update` predicate is `{ id: workflowId }` with no `orgId`, while `getOrgAccess` establishes membership in an org the update then ignores. Any authenticated member of any org can overwrite any workflow. | 37.5 and all agent workflow writes; 37.8, 37.11 | Separate security ticket: tenant-scoped predicate + regression test (cross-org rejected, same-org succeeds) | **OPEN — NOT_STARTED** |
| **I2** — node validation boundary | **P0** | `IncomingNodeSchema.data` is `.optional().or(z.any())`, making the discriminated union unreachable; `updateWorkflowState` validates `z.array(z.any())`. Generated `uiNodes` would cross the persistence boundary unvalidated. | 37.10, 37.11 | Separate ticket: real node-data validation on **both** create and update paths + regression tests | **OPEN — NOT_STARTED** |

### Not active blockers

| Item | Why it is not a blocker |
|---|---|
| **I5** — maintenance schedule unknown | P1-CHECK. Repository evidence supports "not wired in source" and does not support "does not exist." Verify at 37.16. |
| F1, F2, F4, F5 | P2 / design forks. Each has a named phase. |
| I3, I4 | P2/P3 and P1 respectively; I4 gates 37.2 onward but is assigned to 37.1. |

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

---

# Assignment 37 Completion Checklist

### Phase completion

- [x] Phase 37.0 complete — **VERIFIED 2026-09-30** — evidence: `assignments-37-phase-0-audit.md`
- [ ] I1 closed and verified (37.0A)
- [ ] I2 closed and verified (37.0B)
- [ ] 37.1 complete
- [ ] 37.2 complete
- [ ] 37.3 complete
- [ ] 37.4 complete
- [ ] 37.5 complete
- [ ] 37.6 complete
- [ ] 37.7 complete
- [ ] 37.8 complete
- [ ] 37.9 complete
- [ ] 37.10 complete
- [ ] 37.11 complete
- [ ] 37.12 complete
- [ ] 37.13 complete
- [ ] 37.14 complete
- [ ] 37.15 complete
- [ ] 37.16 complete
- [ ] 37.17 complete

### Issue closure

- [ ] All P0 issues verified (I1, I2)
- [ ] All P1 issues resolved or explicitly deferred (F3, F4, F5, F6, I4)
- [ ] I5 verified or documented as unverifiable
- [ ] All P2/P3 issues resolved or explicitly deferred (F1, F2, I3)

### Decision closure

- [ ] All pending architectural decisions resolved (AD-P1 … AD-P7)

### Evidence closure

- [ ] Migration status verified
- [ ] Full test suite passes
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
No finding in this document is claimed to be fixed. No test or live verification
has been performed.*
