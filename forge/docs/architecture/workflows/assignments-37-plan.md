# Assignment 37 — AI Workflow Generation (Implementation Plan)

> **Revision note.** This plan is the original Assignment 37 design, retained in
> full, with revisions applied after Phase 0 reconnaissance. It is superseded in
> ordering, gating, and architecture by the sections marked **[REVISED]**.
> Findings are tracked in
> `docs/architecture/workflows/assignments-37-issue-register.md`; the evidence
> behind them is in
> `docs/architecture/workflows/assignments-37-phase-0-audit.md`.
>
> Provenance: no pre-existing plan document was present in
> `docs/architecture/workflows/` at the time of this revision. This file was
> created from the accepted plan text and revised against the Phase 0 report. No
> architectural intent was removed; the original phase-by-phase design is
> preserved below.

## Central boundary

> **Gemini generates a declarative workflow proposal. The deterministic backend
> compiles, validates, gets missing human decisions, and only then materializes it
> into the existing workflow engine.**

The design uses the `localRef`/step-ID approach: the model creates string
references inside the graph, while the persisted workflow uses those references to
determine topology and dispatch actions.

The execution side stays untouched as much as possible. The hardening pass has
already established the workflow definition as the executable blueprint and moved
semantic graph validation to the persistence boundary.

---

# Phase 0 — Contract reconnaissance

**COMPLETE.** Deliverable: `assignments-37-phase-0-audit.md`.

Reconnaissance covered the actual current implementation of: `WorkflowAction` /
`ActionContext` types, the action registry, every registered workflow action,
existing input/result conventions, `WorkflowDefinitionSchema`,
`WorkflowStepSchema`, the compiler/materializer, the pointer resolver, the
workflow persistence path, the 35/36 confirmation machinery, the agent registry /
tool policy, prompt versioning, `AgentToolExecution` proposal fields, and
`Workflow` / `WorkflowRun` persistence.

The contract maps requested were produced and filled in with exact observed
shapes and `file:line` citations:

```text
Action
├── id
├── description?          — DOES NOT EXIST (F3)
├── input contract?       — DOES NOT EXIST (F3)
├── output contract?      — DOES NOT EXIST (F3)
├── compensation capability? — type-level only; unimplemented for the sole action
└── current execution semantics — documented

WorkflowStep
├── id
├── action                — unconstrained z.string(); no registry check (I4)
├── dependsOn
├── config/inputs         — z.record(z.string(), z.any())
├── kind
└── current criticality representation — z.boolean(), default false; gates rollback only

WorkflowDefinition
├── name                  — hardcoded placeholder by the compiler (F2)
├── steps
└── existing metadata     — id only, a per-save placeholder (F2); no version field
```

**Gate answer:** the agent currently has no machine-readable action contract to
generate a valid step from. The action execution path dispatches through
`getAction(actionId)` (`src/lib/workflow/execution/wrapper.ts:153`), and that
registry boundary remains the natural anchor for 37 — but the registry carries no
planner-facing metadata.

### Phase 0 outcome carried into the plan

Six findings (F1–F6) and five pre-existing issues (I1–I5) were recorded. Two are
P0 and now gate the first implementation phase. The original plan's phase order
is inverted at one point (F1) and must be revised.

---

# Phase 1 — Establish the canonical generated-workflow contract

Create the **agent-facing proposal schema**, called `WorkflowProposal`, rather
than exposing the full persisted `WorkflowDefinition`.

```ts
{
  name,
  description,
  steps: {
    localRef: {
      action,
      inputs,
      dependsOn
    }
  }
}
```

The exact fields reuse the existing definition where possible.

### Rules

`localRef` / `id`: unique within the proposal; stable; backend-generated IDs are
forbidden; workflow-local references only.

`action`: must correspond to a registered workflow action.

> **[REVISED — F3, 37.1]** "Must correspond to a registered workflow action" is
> currently unenforceable from a schema: `WorkflowStep.action` is `z.string()`
> and the compiler performs no registry membership check, so an unregistered
> action saves cleanly and fails at execution. The capability surface that makes
> this checkable is 37.1's work and lands before this schema is written.

`dependsOn`: references local step IDs only; an empty array means no prerequisite.

`inputs`: action-specific; strict; may contain references to previous step
outputs.

No `isCritical` yet. No PostgreSQL ID. No `WorkflowRun`. No QStash data. No UI
coordinates.

The scan's proposed local-reference pattern is conceptually right, but it is
persisted as the workflow's logical step identity rather than treated as an
ephemeral foreign-key substitute.

### Gate

A static proposal of `A`; `B -> A`; `C -> A,B` must parse cleanly. Malformed
actions, duplicate IDs, bad references, and malformed inputs must fail
structurally.

---

# Phase 2 — Build the Action Capability Catalog

The most important foundation after the schema. Rather than maintaining
`z.enum(["task.create", "foo", "bar"])` in multiple locations, derive generation
capabilities from the **actual workflow action registry**.

The model needs, per action: action ID, human description, required inputs,
optional inputs, input semantics, output shape / output fields, and whether an
output is referenceable.

The uploaded material correctly argues the model needs action-specific contracts
rather than a loose `config: z.any()` structure. Its discriminated-union example
should not be copied blindly — in Forge the registry remains the source of truth.

```text
Action Registry
      ↓
Capability Descriptor
      ↓
generateWorkflow tool schema / prompt context
      ↓
Gemini
```

### Constraint

The descriptor contains **schema information** but never trusted execution
authority. The model can learn that `task.create` requires `projectId`. It cannot
obtain `orgId`, `userId` or `workflowId` from the generation payload; those
continue to come from trusted persisted context.

### Phase 2 gate

There is one authoritative planner-facing action capability source, and it is
derived from the runtime registry rather than hand-maintained beside it.

---

# Phase 3 — Input/output reference system

Where 37 becomes much more than a DAG generator:

```text
A.outputs.projectId
        ↓
B.inputs.projectId
```

The existing resolver already supports nested workflow-context pointers, so
**reuse its reference semantics rather than inventing a second
`{{steps.x.output}}` language**. The canonical grammar is whatever the current
resolver guarantees:

```text
{{stepRef.outputs.field}}
```

### Reference validation must check

1. The referenced step exists.
2. The referenced output path exists in the action's output contract.
3. The referencing step explicitly depends on the referenced step.
4. The value is legal for the target action's input.
5. Nested references are supported where the resolver supports them.
6. References cannot point forward to unrelated runtime state.
7. No reference can escape workflow scope.

### Example

Valid — data flow and execution order agree:

```json
{
  "create_project": { "action": "project.create", "dependsOn": [], "inputs": {} },
  "create_task": {
    "action": "task.create",
    "dependsOn": ["create_project"],
    "inputs": { "projectId": "{{create_project.outputs.projectId}}" }
  }
}
```

Invalid — the second graph must be rejected because its **data dependency** and
**execution dependency** disagree:

```json
{
  "create_task": {
    "action": "task.create",
    "dependsOn": [],
    "inputs": { "projectId": "{{create_project.outputs.projectId}}" }
  }
}
```

> **[REVISED — F6]** Checks 1, 2 and 3 have no existing implementation. The
> resolver has no preflight pass, resolves only at dispatch time, and fails
> silently on a missing path — substituting `""` inside a larger string and
> returning the literal `{{...}}` text when the reference is the whole value.
> `collectWorkflowDefinitionIssues` cross-checks `routingConditions` against
> `dependsOn` but never inspects inputs. This phase adds validation, **not**
> vocabulary.

### Gate

A deterministic reference-validation module and tests.

---

# Phase 4 — Separate structural validation from semantic compilation

Semantic DAG validation already exists in the hardened workflow layer and is
kept.

```text
LLM output
   ↓
ProposalSchema
   ↓
action contract validation
   ↓
reference validation
   ↓
existing DAG semantic validator
   ↓
compiled executable definition
```

Gemini is never asked to produce something the backend merely trusts.

### Structured compiler errors

```ts
{
  errorType: "WORKFLOW_VALIDATION_ERROR",
  issues: [
    {
      code: "UNKNOWN_DEPENDENCY",
      path: ["steps", "generate_report", "dependsOn"],
      message: "Step 'generate_report' depends on unknown step 'foo'."
    }
  ]
}
```

Issue codes: `UNKNOWN_ACTION`, `MISSING_INPUT`, `UNKNOWN_OUTPUT`,
`MISSING_DATA_DEPENDENCY`, `TYPE_MISMATCH`, `CYCLE`. This feeds the self-healing
behavior already hardened in 35/36.

> **[REVISED — F5]** `WorkflowDefinitionSchema` exists with a full
> `superRefine`, but it is **never called in production** — only in
> `src/tests/workflow/dag-validation.test.ts`. Production goes through
> `compileWorkflow`, which calls `collectWorkflowDefinitionIssues` directly. A
> proposal compiler is a *second* producer of `WorkflowDefinition`, so this phase
> must settle which of the schema or the collector is the real gate, and make the
> comment at `src/lib/workflow-types/workflow.ts:42-44` true of production code.

---

# Phase 5 — Make "missing information" first-class

Built into the agent protocol rather than handled as random prose. Two
fundamentally different cases.

**Case A — the LLM made a mistake.** `UNKNOWN_DEPENDENCY`, `INVALID_INPUT`,
`CYCLE`. The model should self-correct.

**Case B — the user never supplied necessary information.** `MISSING_USER_INPUT`.
The model should ask the human.

> "Create an onboarding workflow for Acme."

`task.create` requires a project and none is known. The agent should ask: "Which
project should the onboarding tasks belong to?" It must **not** invent a project
ID.

### Design

The generation tool returns a structured state:

```text
NEEDS_USER_INPUT
```

```ts
{
  field,
  reason,
  question,
  candidateValues?
}
```

> **[REVISED — F4]** There is nowhere to put this state durably. `AgentToolExecution`
> has no `result` column and no `NEEDS_INPUT` status, and the only wired gate is
> `PENDING_CONFIRMATION`. The fork is taken at 37.6, with the consumer known.
> **No preemptive migration.**

---

# Phase 6 — Human criticality assignment

**Gemini does not own criticality.** Criticality influences saga behavior; the
execution engine uses it to decide whether a failure pivots into rollback.

```text
AI generates
    ↓
Step A / Step B / Step C
    ↓
backend identifies criticality fields needing human decision
    ↓
user chooses
    ↓
WorkflowDefinition receives final isCritical
```

The UI or conversation presents:

```text
Create project      [Critical]
Create welcome task [Non-critical]
Generate report     [Critical]
```

The model may recommend a default **only as presentation**; the stored execution
policy comes from the human decision.

> **[REVISED — F4, continued]** Human criticality answers have no column
> anywhere. This is the second half of the F4 fork.

---

# Phase 7 — Build `generateWorkflow` as a macro agent tool

`generateWorkflow` is preferred over `executeWorkflowManifest` because the first
creates a proposal while the second implies execution. The "micro-tool calling"
versus "macro-tool calling" distinction maps onto the architecture: one durable
agent turn generates the whole declarative blueprint instead of requiring a
separate reasoning round per future workflow node.

### Tool behavior

```text
generateWorkflow(...)
        ↓
validate proposal
        ↓
compile
        ↓
if missing user input:  return NEEDS_USER_INPUT
if invalid:            return structured validation observation
if valid:              create durable proposal, return proposal awaiting human review
```

The tool **does not execute workflow actions**.

> **[REVISED — Gate E, I1]** This is the phase at which the agent becomes a
> workflow writer. I1 must be closed first.

---

# Phase 8 — Persist the proposal before execution

Generation is asynchronous, so it needs durable state. The plan prefers reusing
`AgentToolExecution`:

```text
AgentToolExecution
 ├── proposal arguments
 ├── validation state
 ├── missing-input state
 ├── approval state
 └── compiled definition
```

over immediately creating `Workflow` rows. Only after confirmation:

```text
proposal ↓ Workflow
```

If the current model cannot represent this cleanly, introduce a dedicated
`WorkflowProposal` model.

**Don't create that migration preemptively.** The decision lands at 37.6/37.7.

---

# Phase 9 — Human review / confirmation

Reuse the **existing 35/36 confirmation system**. No special confirmation
architecture. The confirmation payload binds to the **exact proposal**, not
regenerated arguments.

> Already satisfied by the existing machinery. The confirm endpoint takes no
> request body by design, so the executed arguments are exactly those persisted
> in `AgentToolExecution.input`; a modified proposal cannot reuse an approval.
> The work here is the review *surface*, not the mechanism.

### Review surface

Workflow name · number of steps · dependency structure · actions ·
missing-input resolutions · criticality decisions. Parallel groups and critical
path are presentation concerns.

> **[REVISED — F2]** "Workflow name" must read `Workflow.name`, not
> `definition.name` — the compiler hardcodes that field to
> `"Compiled Execution Graph"`.

---

# Phase 10 — Materialize the proposal into `Workflow`

```text
WorkflowProposal
      ↓
canonical WorkflowDefinition
      ↓
existing Workflow persistence
```

At this point: local step IDs become persisted workflow step IDs; action IDs
remain registry identifiers; inputs remain declarative templates; dependencies
remain local logical references; criticality is the human-approved value;
provenance is attached if the `definition` JSON contract allows it.

Do **not** create `Task` rows for every generated node. The scan's `dependsOnRaw`
model explains the local-reference idea, but Forge already stores the compiled DAG
as structured JSON and uses `StepRun` for runtime state.

> **[REVISED — F1, F2]** Two corrections:
>
> 1. **Ordering.** This phase moves to **37.11**. The only persistence path in
>    Forge is canvas-first: `saveWorkflowState` and `updateWorkflowState` both
>    accept `uiNodes`/`uiEdges` and call `compileWorkflow`, and
>    `IncomingNodeSchema` makes `position` mandatory. No definition → UI reverse
>    projection exists anywhere in the codebase. UI projection is therefore a
>    *precondition* of persistence, not a consequence of it.
> 2. **Provenance.** `definition.id` is `compiled_${Date.now()}` and is
>    regenerated on every save. It can collide and cannot identify a proposal.
>    There is no stable provenance key in the `definition` contract today.

---

# Phase 11 — Derive UI representation

Do not ask Gemini for React Flow coordinates.

```text
WorkflowDefinition
       ↓
UI compiler
       ↓
uiNodes
uiEdges
```

The execution graph remains the source of truth:

```text
definition    = WHAT executes
uiNodes/uiEdges = HOW it is visualized
```

For the first implementation this may reuse existing `compiler.ts` / graph
utilities rather than creating another UI compiler.

> **[REVISED — F1]** This phase moves to **37.10**, ahead of materialization, and
> the required decision is: **synthesize deterministic layout before persistence**,
> **or** introduce a definition-first write path. Neither is chosen in the plan.
> The first keeps a single write path and inherits its guarantees; the second keeps
> generation free of UI concerns but creates a second path that must independently
> replicate the validation and authorization properties of the first — precisely
> the property I1 shows can be got wrong.

---

# Phase 12 — Start the existing execution engine

```text
Workflow → WorkflowRun → existing evaluator
```

No new DAG executor. No separate QStash node runner. No new Redis lock. No new
fork/join engine. The hardened engine is the executor. Action dispatch remains
`step.action → getAction(actionId) → action.execute(...)`, already how the wrapper
operates.

---

# Phase 13 — Runtime result propagation

```text
Action A
 ↓
outputs persisted
 ↓
global workflow context updated
 ↓
Step B becomes ready
 ↓
resolver resolves {{A.outputs.foo}}
 ↓
Action B
```

Concurrent context writes are already handled by optimistic CAS
(`contextVersion`, `src/lib/workflow/execution/state.ts:38-88`). 37 should **not**
modify this context system unless implementation reveals a concrete contract
mismatch.

---

# Phase 14 — Runtime failure behavior

Do not let 37 invent a second fault controller.

```text
Step fails → wrapper → StepRun status → evaluator
          → existing rollback / retry / intervention behavior
```

Cascading cancellation, AI-driven triage and resume are possibly valuable future
work, but the hardened engine already has retry/rollback/recovery semantics. 37's
job is graph generation, not a second workflow runtime.

---

# Phase 15 — Self-healing generation loop

```text
Gemini → generateWorkflow → validator → UNKNOWN_DEPENDENCY
       → structured observation → AGENT_LOOP_REQUESTED → Gemini → corrected proposal
```

```text
Gemini → generateWorkflow → missing projectId → NEEDS_USER_INPUT
       → human answers → Gemini continues
```

```text
Gemini → valid workflow → human criticality → confirmation
```

Three qualitatively different loops:

```text
1. self-correction
2. human clarification
3. human approval
```

That distinction exists explicitly in the state machine.

> **[REVISED — I3]** Loops 1 and 3 are distinguishable today. Loop 2 has no
> durable representation at any level: `AgentSessionStatus.WAITING_CONFIRMATION`
> is read in two places and written nowhere, and a session awaiting approval
> remains `RUNNING`. The real gate is `AgentToolExecution.status`. This does not
> block 37.1, but it is the level at which a new pause state would have to be
> wired, and it is relevant to keeping the three loops genuinely distinct.

---

# Phase 16 — Prompt architecture

Only after the contract exists. The prompt teaches:

**DAG planning** — "Do not serialize independent work. Create dependencies only
where required by business ordering or data flow."

**Local references** — "Use unique logical step IDs. Never invent database IDs."

**Output references** — "Use the existing `{{step.outputs.field}}` reference
grammar."

**Action contracts** — "Use only registered actions and obey their input/output
contracts."

**Missing information** — "Ask the user rather than guessing."

**Criticality** — "Do not decide final criticality."

**Validation failures** — "Treat compiler observations as internal correction
signals."

**Execution** — "`generateWorkflow` proposes; it does not directly execute."

The scan's `<DAG_THINKING_RULES>` concept is useful as **planning guidance**, not
as a substitute for deterministic graph validation.

---

# Phase 17 — Tests

The value is not "Gemini returned JSON."

**Contract tests** — valid proposal, duplicate localRef, unknown action, malformed
inputs, malformed dependency, oversized proposal, strict schema rejection.

**Graph tests** — linear chain, full fan-out, full fan-in, diamond, disconnected,
self-dependency, cycle, unknown dependency.

**Reference tests** — valid output reference, unknown step reference, unknown
output field, missing dependency for a referenced output, nested reference, wrong
reference shape, reference into unavailable runtime state.

**Human-input tests** — missing required action input, multiple missing inputs,
user supplies answer, regenerated proposal remains valid.

**Criticality tests** — no criticality supplied by model, human criticality
persisted, criticality changes affect the materialized definition only, model
cannot override a confirmed value.

**Confirmation tests** — exact proposal bound to approval, modified proposal
cannot reuse approval, cancel works, duplicate confirm remains idempotent.

**Execution integration** — a small real diamond:

```text
A ──┐
    ├── C
B ──┘
```

where A and B are independent, C consumes outputs from both, C starts only after
both succeed, actual action output enters workflow context, the resolver converts
references, and the existing evaluator executes C.

> Add an I1 regression test to this matrix: a member of organization A must not be
> able to update a workflow belonging to organization B. The positive case must be
> asserted alongside it so the fix cannot degenerate into blanket denial.

---

# Phase 18 — Verification and closure

```text
Jest · tsc --noEmit · scoped ESLint · Prisma validation/generate · migration status
```

Then live verification: generation (real Gemini produces a workflow); validation
(a real invalid proposal is rejected as a structured observation); clarification
(real missing input produces a human question, not a hallucination); approval
(real criticality + confirmation path); execution (real `WorkflowRun` created and
the existing evaluator executes it); dataflow (real output from node A becomes
input to node B); parallelism (two independent nodes execute concurrently);
fan-in (the final node waits for all prerequisites); recovery (the existing
hardened retry/rollback path continues to work).

> **[REVISED — I5]** Add: **verify workflow-maintenance scheduling** before
> capstone. `src/app/api/worker/workflow-maintenance/wm.ts` exists;
> `scripts/qstash-maintenance-schedule.mjs` registers only
> `AGENT_MAINTENANCE_REQUESTED`. Phase 0 did not establish whether a workflow
> schedule exists on the deployed QStash instance, because that is not observable
> from the repository. A run that wedges during capstone would be unrecoverable
> without this path, so it must be known beforehand.

---

# [REVISED] Updated implementation sequence

The ordering below supersedes the per-phase numbering above wherever they
conflict. It is the authoritative sequence.

```text
37.0    Contract reconnaissance                          COMPLETE
37.0A   Security prerequisite — I1 tenant-scoped update
37.0B   Persistence-boundary prerequisite — I2 node validation
37.1    Action capability registry                      (F3, absorbs I4)
37.2    WorkflowProposal schema
37.3    Reference grammar + validator                   (F6, MISSING_DATA_DEPENDENCY)
37.4    Proposal compiler / semantic validation adapter (F5)
37.5    generateWorkflow agent tool
37.6    Missing-input state                              (first part of F4)
37.7    Human criticality state                          (continues F4)
37.8    Durable proposal persistence
37.9    Existing confirmation integration
37.10   UI graph projection / deterministic layout       (F1)
37.11   Workflow materialization                        (canvas-first, F2)
37.12   Execution handoff
37.13   Prompt / DAG planning instructions
37.14   Self-healing observations
37.15   Full test matrix
37.16   Live capstone verification                      (I5, and the full live matrix)
37.17   Documentation / closure
```

Three structural changes from the original ordering:

1. **37.0A and 37.0B inserted before 37.1**, so P0 work is not bundled into a
   feature phase.
2. **37.10 and 37.11 swap places** — UI projection before materialization — as a
   direct consequence of F1.
3. **I5 verification attaches explicitly to 37.16** rather than being left
   implicit.

37.1–37.17 are still **not** implemented in one shot. The first implementation
prompt covers 37.0–37.3: understand the existing action registry, define the
canonical proposal contract, define how action metadata is exposed, and build the
reference model.

---

# [REVISED] Explicit "Do Not Fix Yet" boundary

Recorded so a well-meaning reader does not "tidy up" a finding ahead of its phase
and invalidate the design it was meant to inform.

**DO NOT** preemptively fix **F1**, **F2**, **F4**, or **F5** before their
designated phase. Each is a fork whose consumer does not exist yet; resolving it
early means guessing at a requirement rather than responding to it.

**DO NOT** create a `WorkflowProposal` migration merely because
`AgentToolExecution` may eventually be insufficient.

**DO NOT** rebuild the workflow executor. The existing evaluator, wrapper,
bounded retry, saga pivot, lock heartbeat, durable re-entry on contention and
stale-run maintenance are the hardened surface 37 depends on.

**DO NOT** create a second reference syntax. The resolver's `{{path}}` grammar
with `<stepId>.outputs.*` and `trigger.outputs.*` namespaces is already the shape
the plan specifies; 37.3 adds validation, not vocabulary.

**DO NOT** create a second DAG engine. Reuse `collectWorkflowDefinitionIssues` and
the `WorkflowValidationError` shape.

**DO NOT** implement self-healing as a second retry controller. It re-enters the
existing agent loop; it does not retry workflow steps.

**DO NOT** make Gemini responsible for final criticality. The stored value is the
human decision; the model may suggest a presentation default only.

**DO NOT** make Gemini responsible for trusted tenant or runtime identity. `orgId`
comes from persisted context — `AgentSession` for tools, the `Workflow` row for
actions. A capability descriptor may carry schema information and must never
carry authority.

---

# [REVISED] Updated architectural gates

**Gate A — before 37.1.** P0 prerequisites (I1, I2) are closed, or explicitly
isolated from the contract work with a named owner and a date. Isolation is
acceptable for 37.1–37.4, which write no workflows. It is not acceptable for 37.5
onward (Gate E) or for materialization (Gate F).

**Gate B — after 37.1.** Exactly one authoritative planner-facing action
capability source, derived from the runtime registry rather than hand-maintained
beside it. I4 reconciled: every action advertised to the model is registered, and
every registered action's declared inputs and outputs match its implementation.

**Gate C — after 37.3.** Every output reference in a proposal has an existing
source step, a valid output path per that action's declared output contract, and
an explicit execution dependency in `dependsOn`. A reference that resolves but is
unordered is rejected.

**Gate D — after 37.4.** Proposal validation and existing DAG semantic validation
form one deterministic compiler boundary. F5 resolved: it is settled which of
`WorkflowDefinitionSchema` or the compiler's issue collector is the gate.

**Gate E — before 37.5 becomes workflow-writing.** I1 is closed. The predicate on
any workflow write is tenant-scoped, and a regression test proves cross-tenant
writes are rejected.

**Gate F — before materialization.** F1's decision is resolved — synthesized
layout versus a definition-first write path — and I2's persistence-boundary
integrity is closed, so generated `uiNodes` crossing the canvas boundary is
genuinely validated.

---

# [REVISED] Updated conceptual architecture

The revised diagram differs from the original in one respect, and the difference
is a direct consequence of F1: the definition is not written first and projected
afterwards. The only persistence path in Forge is canvas-first, so UI projection
is a *precondition* of persistence rather than a consequence of it.

```text
                    HUMAN INTENT
                         │
                         ▼
                      GEMINI
                         │
                         ▼
                  WorkflowProposal
                         │
                         ▼
            Action capability validation          37.1
                         │
                         ▼
                Reference validation               37.3
                         │
                         ▼
               DAG semantic validation             37.4
                         │
              ┌──────────┴──────────┐
              │                     │
      NEEDS USER INPUT             VALID              37.6
              │                     │
              ▼                     ▼
           HUMAN              HUMAN REVIEW
                                      │
                                 CRITICALITY            37.7
                                      │
                                 CONFIRMATION           37.9
                                      │
                                      ▼
                             UI GRAPH / LAYOUT         37.10   ← F1
                                      │
                         CANVAS-FIRST PERSISTENCE      37.11   ← I2
                                      │
                                      ▼
                            WorkflowDefinition
                                      │
                                      ▼
                               WorkflowRun
                                      │
                                      ▼
                          EXISTING ENGINE              37.12
```

Everything from `WorkflowProposal` through `CONFIRMATION` is unchanged from the
original diagram. The tail is not: `UI GRAPH / LAYOUT` and
`CANVAS-FIRST PERSISTENCE` sit **before** `WorkflowDefinition`, whereas the
original placed UI derivation as a side concern after materialization.

---

## Status

Phase 0: **COMPLETE** — see `assignments-37-phase-0-audit.md`.
Current blockers: **I1**, **I2**.
Current implementation target: **37.1 — Action capability registry**.
Later architectural decisions: **F1**, **F2**, **F4**, **F5**.

No issue in the register has been fixed by this planning revision.
