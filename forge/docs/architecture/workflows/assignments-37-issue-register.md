# Assignment 37 — Issue / Finding Register

## 1. Purpose

This document exists to prevent the findings produced by Phase 0 reconnaissance
from being lost while Assignment 37 is implemented incrementally. Assignment 37 is
deliberately split into eighteen small phases; without a durable register, the
reasoning behind a constraint recorded in Phase 0 evaporates by Phase 7, and the
same investigation gets repeated — or, worse, silently reversed.

Explicit statements of scope:

- **All findings in this document originated from Phase 0 reconnaissance**, as
  recorded in `docs/architecture/workflows/assignments-37-phase-0-audit.md`. This
  document does not introduce new investigation.
- **This document does not change runtime behavior.** It is documentation. No
  finding here has been fixed by its existence.
- The findings are not homogeneous. They include:
  - **Bugs** — behavior that is already wrong (I1, I2, I3, I4).
  - **Architectural gaps** — capability that Assignment 37 requires and does not
    yet exist (F3, F4, F6).
  - **Design decisions** — forks that are legitimate choices rather than defects,
    and that belong to a later phase (F1, F2).
  - **Verification items** — questions Phase 0 could not answer from repository
    evidence, and which are not findings until confirmed (I5).
- **Categories are not collapsed.** A P0 bug and a P2 design fork are tracked
  separately even when they touch the same file, because they have different
  owners, different urgency, and different definitions of "done".
- **No finding in this document is claimed to be fixed.**

---

## 2. Priority Model

| Priority | Meaning |
|---|---|
| **P0** | Must be resolved before the agent can safely become a workflow writer |
| **P1** | Direct prerequisite for Assignment 37 implementation |
| **P1-CHECK** | Must be verified; becomes a blocker only if verification confirms the condition |
| **P2** | Required later in Assignment 37 but should not block the current contract phases |
| **P3** | Pre-existing technical debt / non-gating cleanup |

Priority is assigned on five axes:

1. **Security impact** — can the finding be used to cross a tenant boundary or
   escalate authority?
2. **Integrity impact** — can the finding cause incorrect data to be persisted or
   silently lost?
3. **Dependency on 37** — does Assignment 37 consume the affected surface, and
   will it be materially harder to correct afterward?
4. **Whether it blocks agent-originated workflow writes** — Phase 0 flagged
   specifically that making the agent a workflow writer changes the severity of
   pre-existing write-path defects, because a human-driven canvas edit and a
   machine-driven materialization have different exposure profiles.
5. **Timing** — is the capability needed in the first contract slice
   (37.0–37.3), or only at a later phase?

A finding that scores high on security but is not consumed by 37 is still tracked
as a separate prerequisite ticket rather than folded into an implementation
phase. Security fixes that share a file with in-flight feature work are the case
where bundling is most tempting and most wrong: the review surface of the two
changes differs entirely.

---

## 3. P0 Findings

### I1 — Cross-tenant workflow update

**Classification:** P0 · separate prerequisite ticket · **must be closed before
37.5**, i.e. before any agent-originated workflow materialization or write path.

**Affected file / function:** `src/app/actions/workflows/workflow.ts`,
`updateWorkflowState` (`:95-137`).

**Observed authorization behavior.** The function authenticates the caller and
establishes membership in one organization:

```ts
export async function updateWorkflowState(
  orgslug: string, workflowId: string, uiNodes: any[], uiEdges: any[]
) {
  const access = await getOrgAccess(orgslug);   // :102
  if (!access) return { success: false, error: "Unauthorized" };
```

`getOrgAccess` validates an authenticated user and membership, and returns a
trusted organization id. That trusted value is then **not used** in the update.

**Observed database predicate.**

```ts
await db.workflow.update({
  where: { id: workflowId },                    // :115
  data: { uiNodes, uiEdges, definition: compiledDefinition,
          eventId, isActive: !!eventId },
});
```

The predicate is `{ id: workflowId }` alone. There is no `orgId` component, so
the row is located by primary key regardless of which organization owns it.

**Security impact.** Any authenticated member of *any* organization can
overwrite any workflow in the system by supplying its id. `workflowId` is a
client-supplied string from a server action call. The attacker does not need the
target workflow to belong to their organization, nor to appear in any list view
they can load. The write replaces `uiNodes`, `uiEdges` and `definition`
wholesale, so the capability is read-write on execution blueprints for every
tenant.

**Why agent-originated workflow writing raises the severity.** Today the reachable
path is a human opening a workflow they were shown in a list. After 37.5, a
machine constructs workflow material from a model proposal and persists it. A
model-reachable call site inherits the same missing predicate, and the
authorization surface becomes a prompt rather than a UI. The correct reading is
that I1 is a latent bug today and a serious one at 37.5; the fix is a one-line
predicate change and the reason to defer it is only that it deserves its own
review, not that it is low-risk.

**Required regression test.** A test asserting that a user with valid membership
in organization A cannot update a workflow whose `orgId` is B — expecting a
rejected update (or a not-found result), not a silent success. The positive case
— member of A updating a workflow in A succeeds — must be asserted alongside it,
so the fix cannot degenerate into a blanket denial.

**Do not implement the fix in this document.**

---

### I2 — Node validation bypass

**Classification:** P0 · persistence-boundary integrity prerequisite · must be
resolved before generated `uiNodes` are trusted by the materialization path.

**Affected file / function:** `src/app/actions/workflows/workflow.ts`,
`IncomingNodeSchema` (`:30-38`) and `updateWorkflowState` (`:105`).

**Observed — `IncomingNodeSchema`.**

```ts
const IncomingNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['trigger', 'action']),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.discriminatedUnion('type', [
    z.object({ type: z.literal('trigger') }).merge(TriggerNodeDataSchema),
    z.object({ type: z.literal('action' }).merge(ActionNodeDataSchema)
  ]).optional().or(z.any()),                        // :37
});
```

**Observed — `updateWorkflowState`.**

```ts
const areNodesValid = z.array(z.any()).safeParse(uiNodes);   // :105
```

**Why `z.any()` defeats the intended validation.** `z.any()` is the permissive
type in Zod — every value satisfies it, including `undefined`. A union of
`X.optional().or(z.any())` therefore *always* succeeds: the right-hand branch
accepts whatever the left-hand branch might have rejected. The discriminated
union over `TriggerNodeDataSchema` / `ActionNodeDataSchema` is constructed,
attached to the object shape, and then made unreachable. The result is that
`data` is unvalidated on the create path, and `updateWorkflowState` validates
nothing at all about any node field.

The surviving protections on the create path are `id`, `type`, and `position`.
`data` — which carries `eventId`, `actionType`, `config` and `isCritical`, i.e.
everything that determines what executes — carries none.

**Why this matters for a generated workflow crossing the canvas persistence
boundary.** The only persistence path in the system is canvas-first (see F1), so
a generated proposal must be expressed as `uiNodes` / `uiEdges` to be saved at
all. That makes the canvas schema the trust boundary for machine-generated
content. With the node-data union inert, a proposal that has passed contract
validation can still be serialized into node `data` in a shape the Zod schemas
were written to reject, and it will persist and compile without complaint. The
validation that ProposalSchema performs in 37.2 becomes advisory rather than
binding the moment the value crosses into `uiNodes`.

**Blocking point.** Before 37.11, where generated nodes are first persisted and
then treated as a canonical `WorkflowDefinition` source.

**Do not implement the fix in this document.**

---

## 4. P1 Assignment-37 Core Findings

### F3 — No authoritative planner-facing action capability contract

**Classification:** P1 · becomes **37.1**.

**Observed runtime shape.** `src/lib/workflow-types/type.ts:33-39`:

```ts
export interface WorkflowAction {
  id: string;
  execute: ExecuteFunction;
  compensate?: CompensateFunction;
}
```

No description, no declared input contract, no declared output contract, and no
way to express whether an output is referenceable.

**Observed UI shape.** `src/lib/workflow-types/registry.ts:19-26`:

```ts
export type ActionDef = {
  id: string; label: string; description: string;
  requires: string[]; outputs: string[]; fields: FieldDef[];
};
```

This carries everything the model needs, and is labelled `// FOR UI` on line 1. It
is imported by no engine code and no agent code path.

**Registry mismatch.** See I4 below. `src/lib/workflow-types/action-registry.ts`
is the runtime registry and is the only source consumed by `getAction`
(`:20-22`), whose sole call site is
`src/lib/workflow/execution/wrapper.ts:153`.

**Current registered runtime inventory.** Exactly one action:

| id | source | required inputs | outputs | compensation |
|---|---|---|---|---|
| `task.create` | `workflow/actions/core/create-task.ts:82-86` | `title`, `projectId` (`:27`) | `{ taskId, title }` (`:70`) | none (`:85`, commented) |

Unregistered implementations exist on disk and are **not** reachable through
`getAction`: `communication.send_email`
(`actions/core/send-email.ts:39-40`), `utils.generate_report`
(`actions/core/generate-report.ts:99-100`), and `executeConditionNode`
(`actions/logic/conditions.ts:3`), the last of which does not return an
`ActionResult` and would not satisfy the wrapper's `result.success` read.

**Why model generation cannot safely rely on either representation.**

- Relying on `WorkflowAction` yields no contract at all. A model asked to produce
  a valid step gets an action id and nothing else, and `WorkflowStep.action` is
  `z.string()` (`workflow-types/workflow.ts:14`) — unconstrained, so a bad id is
  only discovered at execution time, when the wrapper reports "Action not found
  in registry" as a non-retriable `FAILED` (`wrapper.ts:154-156`).
- Relying on `ActionDef` means trusting a hand-maintained UI list that is already
  out of step with the runtime registry in both directions (I4). Teaching a model
  `comment.add` produces a workflow that saves and then fails during execution.

**Relationship to 37.1.** 37.1 is the phase that establishes a single
authoritative, planner-facing capability source derived from the registry. The
question to settle there is *where capability metadata lives* — on
`WorkflowAction` itself, or in a descriptor keyed by action id — and the Phase 0
gate answer stands: **the agent currently has no machine-readable action contract
to generate a valid step from.**

---

### I4 — Runtime/UI action registry mismatch

**Classification:** P1 · resolve together with 37.1's canonical action capability
surface. Do not create a separate competing registry unless later design
explicitly requires it.

**Observed.** Two entries in `AVAILABLE_ACTIONS`
(`src/lib/workflow-types/registry.ts:52-86`); one entry in `ActionRegistry`
(`src/lib/workflow-types/action-registry.ts:12-16`).

| action | UI list | runtime registry | consequence |
|---|---|---|---|
| `task.create` | present | present | metadata disagrees (below) |
| `comment.add` | present (`:76-85`) | **absent** | saves, then fails at execution |

**`task.create` metadata disagreement.**

| aspect | UI `ActionDef` | `createTaskAction` |
|---|---|---|
| required inputs | `requires: ['projectId']` (`:57`) | `title` **and** `projectId` (`:27`) |
| declared fields | `title`, `priority` (`:60-73`) | also reads `description`, `assigneeId` (`:25`) |
| outputs | `['taskId']` (`:59`) | `{ taskId, title }` (`:70`) |

**Consequence.** A workflow authored from the canvas can persist `comment.add` as
a step action. `compileWorkflow` accepts it — the step schema types `action` as
`z.string()` and performs no registry membership check
(`src/lib/workflow/graph-ui/compiler.ts:44-57`, `:66-69`) — so the save succeeds
and validation reports no issue. The failure surfaces only at execution, in the
worker, as a non-retriable step failure.

The `task.create` disagreements are the more insidious half: the canvas's own
form does not collect `description` or `assigneeId`, marks `title` and
`projectId` differently from the action's own check, and declares one output
where the action publishes two. A reference written against
`{{create_task.outputs.title}}` would be rejected by any output validation built
from `ActionDef.outputs`.

**Resolution note.** Resolving I4 independently would mean either deleting
`comment.add` from the UI or registering an executor for it. Neither is
Assignment 37's decision to make, and doing either before 37.1 would fork the
source of truth a second time. The correct ordering is to settle 37.1's
capability surface first, then reconcile the two lists against it.

---

### F6 — Missing reference / data-dependency validation

**Classification:** P1 · becomes **37.3**.

**Current resolver grammar.** `src/lib/workflow/execution/resolver.ts`.
`{{path}}`, with the path character class restricted to `[\w.-]` (`:51`).
Resolution is whole-string first (`:54-58`), then interpolation (`:62-73`).
Values are namespaced `<stepId>.outputs` by
`src/lib/workflow/execution/state.ts:57-62`, with `trigger.outputs` primed by
`startWorkflow` (`execution/trigger.ts:20-24`).

**Current behavior on a missing reference.** Both paths fail silently.

| position of reference | missing path yields | line |
|---|---|---|
| whole string is the reference | the **literal `{{...}}` text** | `:58` |
| inside a larger string | `""` | `:65-67` |

`:66` carries the comment `// Or throw an error if you want strict failure on
missing variables`, confirming strict failure is a known, deliberately
unimplemented option.

**Absence of preflight validation.** `resolveInputs` performs no check that the
referenced step exists, that the path exists in any output contract, or that the
referencing step depends on the referenced step. It is called once, at dispatch
time, from `src/app/api/workflow/route.ts:175-177`, immediately before the action
executes. There is no validation pass earlier in the lifecycle.

**Absence of the input-reference / `dependsOn` cross-check.**
`collectWorkflowDefinitionIssues` validates `routingConditions` against
`dependsOn` (`src/lib/workflow-types/workflow.ts:190-198`) but never inspects
`config` — the only field inputs live in. So a step may read
`{{sibling.outputs.x}}` for a sibling it does not depend on. At runtime that
resolves to whatever the context happens to hold at dispatch time, which is
either stale from an earlier branch or absent, and in the absent case it is the
silent-empty-string path above.

**`MISSING_DATA_DEPENDENCY` requirement.** The plan's invalid example — a step
that references `create_project.outputs.projectId` while declaring
`dependsOn: []` — must be rejected because data dependency and execution
dependency disagree. Nothing in the current engine rejects it, and there is no
structural substitute. This is the single genuinely new validation in the
Assignment 37 sequence, and it is why 37.3 is a P1 rather than a convenience.

---

### F5 — `WorkflowDefinitionSchema` is not the production validation gate

**Classification:** P1 · resolve at **37.4**. Do not refactor yet.

**Observed.** The schema exists and is fully specified —
`src/lib/workflow-types/workflow.ts:237-251`:

```ts
export const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.record(z.string(), WorkflowStepSchema),
}).superRefine((definition, ctx) => { /* collectWorkflowDefinitionIssues */ });
```

The comment at `:42-44` asserts that the semantic checks "are part of the schema,
not a separate opt-in call, so that a definition cannot be written to the
database without them."

**What production actually does.** `compileWorkflow` calls
`collectWorkflowDefinitionIssues` directly and throws `WorkflowValidationError`
on any issue (`src/lib/workflow/graph-ui/compiler.ts:66-69`). Both save actions
invoke only the compiler (`app/actions/workflows/workflow.ts:59`, `:110`).
Repository-wide, `WorkflowDefinitionSchema` appears at its definition
(`workflow.ts:237`), its inferred type (`:254`), and in
`src/tests/workflow/dag-validation.test.ts`. It is never called in production.

**Consequence for future proposal compilation.** The `superRefine` is a second,
unwired entry point to logic the compiler already invokes. The comment's
guarantee currently rests on the compiler call, not on the schema. The
`definition` JSONB column has no read-time parse, so a definition written by any
path that bypasses `compileWorkflow` is trusted as-is at
`src/app/api/workflow/route.ts:163` (`as WorkflowDefinition`, a cast, not a
parse).

For 37.4 this matters concretely: a proposal compiler is a *new* producer of
`WorkflowDefinition` values. There are currently two plausible gates for it —
the schema, or the compiler's issue collector — and the hardening comment names
the first while production uses the second. 37.4 must pick one and make the
assertion in that comment true.

---

### F4 — `AgentToolExecution` cannot represent the complete workflow proposal lifecycle

**Classification:** P1 · design decision required at **37.6 / 37.7** ·
**no preemptive migration**.

**Current columns** (`prisma/schema.prisma`, `model AgentToolExecution`):
`id`, `sessionId`, `toolCallId` (`@unique`), `toolName`, `input` (Json),
`error` (Text?), `status`, `confirmedAt?`, `cancelledAt?`, `expiresAt?`,
`expiredAt?`, `createdAt`, `updatedAt`. Indexes: `[sessionId, createdAt]`,
`[sessionId, status]`, `[status, expiresAt]`.

**Current status enum** (`AgentToolExecutionStatus`): `PENDING`, `RUNNING`,
`COMPLETED`, `FAILED`, `PENDING_CONFIRMATION`, `CANCELLED`, `EXPIRED`.

**Absence of a result column.** There is no `result` field. Completed tool output
is written into `AgentMessage` rows, not onto the execution. The durable
per-execution record is what was proposed (`input`), an error string, and a
status.

**Absence of proposal-lifecycle states.** No `VALIDATING`, `NEEDS_INPUT`, or
`AWAITING_CRITICALITY`. The only wired gate is `PENDING_CONFIRMATION`, entered
when policy requires it and exited by confirm/cancel/expire.

**Current `PENDING_CONFIRMATION` mechanism, for contrast.** It is already a good
fit for a different problem: the confirm endpoint takes no request body by design
(`app/api/agent/session/[sessionId]/executions/[executionId]/confirm/route.ts:5-8`),
so the executed arguments are exactly those persisted in `input`;
`loadConfirmationTarget` + `decideConfirmation` enforce auth, ownership and
transition; `confirmToolExecution` commits the transition and the dispatch intent
together; and a repeat confirm returns 200 without re-dispatching. Approval binds
to the exact persisted proposal and cannot be re-pointed.

**Why this becomes relevant only at 37.6/37.7.** Phases 5 and 6 of the plan
require a generation tool to be able to return a *structured* `NEEDS_USER_INPUT`
with `{ field, reason, question, candidateValues? }`, and require the backend to
identify criticality fields needing a human decision. Both are durable states
that exist **before** confirmation. Today there is nowhere to put either: a
`NEEDS_INPUT` outcome would have to be smuggled through `error` as prose, and
human criticality answers have no column at all. The plan's Phase 5 requirement —
that the distinction between "the model made a mistake" (self-correct) and "the
user never supplied something" (ask the human) exist explicitly in the protocol —
is not expressible in the current state machine.

**Instruction carried forward.** Do not create a migration merely because this
model may eventually prove insufficient. The fork — encode proposal state inside
`input` and carry structured forms through the existing confirmation, versus grow
the state machine, versus a dedicated model — is taken at 37.6/37.7 with the
consumer already known.

---

### I5 — Workflow maintenance schedule uncertainty

**Classification:** P1-CHECK · verify during 37.16 live verification.
**Not labelled definitively broken.**

**Existing handler.** `src/app/api/worker/workflow-maintenance/wm.ts` exists and
handles `WORKFLOW_MAINTENANCE_REQUESTED`. The stale-run sweeper it drives
(`src/lib/workflow/maintenance.ts`) reads `WorkflowRun.lastAdvancedAt` and
distinguishes safe re-drive from unknown-outcome surfacing.

**Currently known schedule configuration.**
`scripts/qstash-maintenance-schedule.mjs` registers
`AGENT_MAINTENANCE_REQUESTED`. Workflow maintenance is not registered by that
script.

**What Phase 0 did NOT establish.** Whether a `WORKFLOW_MAINTENANCE_REQUESTED`
schedule exists by other means. Specifically, Phase 0 did not determine:

- whether the schedule is created out-of-band against the deployed QStash
  instance, which is not observable from the repository;
- whether it is registered by a second script or an undocumented manual
  `qstash schedule create` invocation;
- whether the handler is reachable at all, versus reachable-but-never-fired.

Repository evidence supports "no schedule is wired in source" and does not
support "there is no schedule." The distinction matters: the first is a gap in
automation, the second is a latent operational failure that only manifests on the
first genuinely stuck run.

**Exact verification required.** Before 37.16 closes, list the QStash schedules on
the target environment and confirm whether a workflow-maintenance schedule
exists. If it does not, that is a confirmed P1-CHECK failure and gets its own
ticket. If it does, record the schedule id in the closure notes so the next
person does not repeat the investigation.

**Why 37 cares.** 37.16's capstone runs a real `WorkflowRun` to completion, and
its recovery check depends on the sweeper. A run that wedges during capstone
would be unrecoverable without the maintenance path, so this must be known before
capstone rather than during it.

---

## 5. P2 Later Architectural Findings

### F1 — Canvas-first persistence

**Classification:** P2 · required decision around **37.10 / 37.11**.

**Observed.** Both save actions accept canvas state, not a definition:

```ts
export async function saveWorkflowState(
  orgslug: string, name: string, uiNodes: any[], uiEdges: any[]   // :43-47
)
export async function updateWorkflowState(
  orgslug: string, workflowId: string, uiNodes: any[], uiEdges: any[]  // :95-99
)
```

Both call `compileWorkflow(uiNodes, uiEdges)` (`:59`, `:110`) and persist
`uiNodes`, `uiEdges` and the compiled `definition` together (`:65-76`, `:115-125`).

**Compiler direction is canvas → definition only.**
`src/lib/workflow/graph-ui/compiler.ts` derives `dependsOn` from incoming edges
(`:32-34`) and builds steps from nodes. A repository search for a reverse
projection — `definitionToNodes`, `definitionToUI`, `toUiNodes`, `buildUiGraph`,
`layoutFromDefinition`, `definitionToGraph` — returns no matches. No code turns a
`WorkflowDefinition` into `uiNodes` / `uiEdges`.

**Node positions are mandatory.** `IncomingNodeSchema` requires
`position: z.object({ x: z.number(), y: z.number() })` (`app/actions/workflows/workflow.ts:33`).

**Why the original phase order is inverted.** The plan originally sequenced
37.10 materialization before 37.11 UI derivation, on the assumption that the UI
projection was a presentation concern layered on top of a completed `Workflow`
row. The code inverts that: the *only* way to create a `Workflow` is through a
canvas, and the canvas schema requires coordinates. Materialization cannot
precede projection, because projection is a prerequisite of persistence.

**Required decision — two options, neither chosen here:**

1. Synthesize deterministic UI layout **before** persistence, so materialization
   produces a definition and a layout together and hands both to the existing
   canvas-first path.
2. Introduce a **definition-first** persistence/materialization path, keeping the
   canvas path for human editing.

The tradeoffs are real and belong to 37.10/37.11. Option 1 keeps a single write
path and inherits its guarantees, at the cost of materialization carrying a
layout concern. Option 2 keeps generation clean of UI concerns, at the cost of a
second write path that must independently replicate the validation and
authorization properties of the first — which is exactly the property I1 shows
can be got wrong.

---

### F2 — `definition.id` / `definition.name` are compiler placeholders

**Classification:** P2 · resolve during materialization / provenance design
around **37.11**.

**Current compiler values.** `src/lib/workflow/graph-ui/compiler.ts:60-64`:

```ts
const definition: WorkflowDefinition = {
  id: `compiled_${Date.now()}`,
  name: "Compiled Execution Graph",
  steps,
};
```

**Regenerated on every save.** Both save actions recompile on every write
(`app/actions/workflows/workflow.ts:59`, `:110`), so both fields change on every
canvas edit. `compiled_${Date.now()}` is also not unique — two saves within the
same millisecond produce the same value. It is not a foreign key, so no integrity
violation results, but it carries no identity meaning.

**Why `definition.id` cannot be proposal provenance.** The plan's Phase 10 allows
"provenance can be attached if the existing `definition` JSON contract allows it."
There is no stable key today. A value that changes on every save and can collide
cannot identify which proposal produced a workflow, cannot be used to detect that
a definition was regenerated, and cannot anchor a one-to-one relationship
between a proposal record and the `Workflow` it materialized into. The `Workflow`
primary key is the only stable identity available.

**Where the workflow's actual human-facing name belongs.** `Workflow.name` — set
from the `name` argument at `app/actions/workflows/workflow.ts:67`. The plan's
`WorkflowProposal` carries a `name`, and that value belongs in the `Workflow`
row, not in `definition.name`, which is a constant. Phase 9's review surface is
required to show "Workflow name"; that must read the column, not the definition.

---

### I3 — `WAITING_CONFIRMATION` session state unreachable

**Classification:** P2/P3 · later state-machine cleanup · **does not block 37.1**.

**Status exists.** `AgentSessionStatus.WAITING_CONFIRMATION` is declared in
`prisma/schema.prisma`.

**No assignment path.** The value is read in exactly two places in the entire
source tree — `src/lib/ai/agent/session-service.ts:201` and `:249` — and
written nowhere.

**Actual gate.** Confirmation is gated by
`AgentToolExecution.status = PENDING_CONFIRMATION`, not by the session status. A
session awaiting approval therefore remains `RUNNING`.

**Why existing confirmation still works.** Because the real gate lives on the
execution row, where the state machine is complete and correct. The
session-status value is vestigial relative to it. Two consumers are consequently
unreachable: `cancelAgentSession` (`session-service.ts:239-255`) filters on
`WAITING_CONFIRMATION` and can never match a row, and the `WAITING_CONFIRMATION`
branch of `failAgentSession`'s predicate (`:198-203`) tolerates a state that
cannot occur.

**Why this is not an immediate Assignment 37 blocker.** The plan's human-approval
loop is satisfied by the execution-row gate, and the confirm/cancel endpoints
operate correctly against it. 37.6's `NEEDS_USER_INPUT` and 37.7's criticality
state, however, are a different question: they ask whether a *durable pause* has a
home, and the honest answer is that the session level has an unused enum slot
with no wired write path. Whether that slot is the right home for a new pause
state is part of the 37.6/37.7 design, not a prerequisite to it.

**Where it may become relevant.** 37.6 / 37.7, and again at 37.14, where the
plan requires the three loops — self-correction, human clarification, human
approval — to be *explicitly distinct* in the state machine. Today two of the
three are distinguishable and one has no representation at any level.

---

## 6. Dependency Map

| Finding | Priority | Assignment phase | Blocks what? | Separate ticket? |
|---|---|---|---|---|
| **I1** cross-tenant workflow update | **P0** | Pre-37.5 prerequisite | All agent-originated workflow writes / materialization | **Yes** |
| **I2** node validation bypass | **P0** | Pre-37.11 prerequisite | Trusting generated `uiNodes` at the persistence boundary | **Yes** |
| **F3** no authoritative capability contract | **P1** | **37.1** | Planner-facing action knowledge; the whole generation path | No |
| **I4** runtime/UI registry mismatch | **P1** | **37.1** | Reliable output contracts; absence of phantom actions | No — resolve with 37.1 |
| **F6** no reference / data-dependency validation | **P1** | **37.3** | Deterministic step generation; `MISSING_DATA_DEPENDENCY` | No |
| **F5** schema is not the production gate | **P1** | **37.4** | A trustworthy compiler boundary for a second definition producer | No |
| **F4** `AgentToolExecution` cannot hold the lifecycle | **P1** | **37.6 / 37.7** | `NEEDS_USER_INPUT`, human criticality, durable proposal state | Not yet — decision at 37.6/37.7 |
| **I5** maintenance schedule unknown | **P1-CHECK** | **37.16** | Capstone recovery verification; only if confirmed absent | Only if confirmed absent |
| **F1** canvas-first persistence | **P2** | **37.10 / 37.11** | Materialization ordering; layout strategy | No |
| **F2** definition id/name are placeholders | **P2** | **37.11** | Provenance; correct human-facing name placement | No |
| **I3** `WAITING_CONFIRMATION` unreachable | **P2/P3** | Later state-machine cleanup | Nothing in 37.1–37.5 | No |

Mapping applied as specified. No repository evidence conflicts with it; the one
point where evidence was thinner than the mapping assumed is **I5**, which is
recorded as P1-CHECK for exactly that reason rather than being promoted to P1 or
demoted to P2.

---

## 7. Updated Assignment 37 Sequence

The revised sequence is authoritative and supersedes the ordering in the original
plan. It is reproduced in full in
`docs/architecture/workflows/assignments-37-plan.md`; summarized here for
convenience.

```
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

The three structural changes from the original ordering:

1. **37.0A / 37.0B inserted before 37.1**, so the P0 work is not bundled into a
   feature phase.
2. **37.10 and 37.11 swap places** — UI projection before materialization — as a
   direct consequence of F1.
3. **I5 verification is attached to 37.16** rather than left implicit.

---

## 8. Explicit "Do Not Fix Yet" Boundary

Recorded so that a well-meaning reader does not "tidy up" a finding ahead of its
phase and invalidate the design it was meant to inform.

**DO NOT** preemptively fix **F1**, **F2**, **F4**, or **F5** before their
designated phase. Each is a fork with a consumer that does not exist yet, and
resolving it early means guessing at a requirement rather than responding to it.

**DO NOT** create a `WorkflowProposal` migration merely because
`AgentToolExecution` may eventually be insufficient. F4 is a design decision at
37.6/37.7 with the consumer known; a migration made now is a guess encoded in
DDL.

**DO NOT** rebuild the workflow executor. The existing evaluator, wrapper,
`MAX_RETRIES` bounded retry, saga pivot, lock heartbeat, durable re-entry on
contention, and stale-run maintenance are the hardened surface 37 depends on.

**DO NOT** create a second reference syntax. The resolver's `{{path}}` grammar
with `<stepId>.outputs.*` and `trigger.outputs.*` namespaces is already the shape
the plan specifies. 37.3 adds validation, not vocabulary.

**DO NOT** create a second DAG engine. Semantic validation reuses
`collectWorkflowDefinitionIssues` (`src/lib/workflow-types/workflow.ts:125-211`)
and the `WorkflowValidationError` shape.

**DO NOT** implement self-healing as a second retry controller. Self-correction
at 37.14 re-enters the existing agent loop via `AGENT_LOOP_REQUESTED`; it does
not retry workflow steps.

**DO NOT** make Gemini responsible for final criticality. `isCritical` is a
persisted step field read at `src/lib/workflow/execution/evaluator.ts:188-191`,
and the stored value is the human decision. The model may recommend a
presentation default only.

**DO NOT** make Gemini responsible for trusted tenant or runtime identity. `orgId`
comes from persisted context — `AgentSession` for tools, the `Workflow` row for
actions (`src/lib/workflow/actions/core/create-task.ts:36-39`). A capability
descriptor may contain schema information and must never contain authority.

---

## 9. Updated Architectural Gates

**Gate A — before 37.1.**
P0 security/integrity prerequisites (I1, I2) are either closed, or explicitly
isolated from the contract work with a named owner and a date. Isolation is
acceptable for 37.1–37.4 because none of those phases write workflows. It is not
acceptable for 37.5 onward (Gate E) or for materialization (Gate F).

**Gate B — after 37.1.**
There is exactly one authoritative planner-facing action capability source, and it
is derived from the runtime registry rather than hand-maintained alongside it. I4
is reconciled: every action advertised to the model is registered, and every
registered action's declared inputs and outputs match its implementation.

**Gate C — after 37.3.**
Every workflow output reference in a proposal has: an existing source step, a
valid output path per that action's declared output contract, and an explicit
execution dependency in `dependsOn`. A reference that resolves but is unordered is
rejected.

**Gate D — after 37.4.**
Proposal validation and existing DAG semantic validation form one deterministic
compiler boundary. F5 is resolved: it is settled which of
`WorkflowDefinitionSchema` or the compiler's issue collector is the gate, and the
comment at `src/lib/workflow-types/workflow.ts:42-44` is true of production code.

**Gate E — before 37.5 becomes workflow-writing.**
I1 is closed. The predicate on any workflow write is tenant-scoped, and a
regression test proves cross-tenant writes are rejected.

**Gate F — before materialization.**
F1's decision is resolved — synthesized layout versus a definition-first write
path — and I2's persistence-boundary integrity is closed, so that generated
`uiNodes` crossing the canvas boundary is genuinely validated.

---

## 10. Updated Conceptual Architecture

The revised diagram differs from the original in one respect, and the difference
is a direct consequence of F1: the definition is not written first and projected
afterwards. The only persistence path in Forge is canvas-first, so UI projection
is a *precondition* of persistence rather than a consequence of it, and F2's
provenance problem is likewise downstream of where the definition is actually
written.

```
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

`WorkflowProposal`, action capability validation, reference validation, DAG
semantic validation, criticality, and confirmation are unchanged from the
original diagram. The tail is not: `UI GRAPH / LAYOUT` and
`CANVAS-FIRST PERSISTENCE` are inserted **before** `WorkflowDefinition`, whereas
the original placed UI derivation as a side concern after materialization.

---

## 11. Final Status

### Current Assignment 37 Status

**Phase 0:** COMPLETE

**Current blockers:**
- I1
- I2

**Current implementation target:** 37.1 — Action capability registry

**Later architectural decisions:**
- F1
- F2
- F4
- F5

**Not fixed by this documentation task.** No issue, finding, or defect listed in
this register has been remediated. This document and the accompanying plan
revision are the only artifacts produced; no application source, Prisma schema,
migration, prompt, or runtime behavior was modified.

**I5 remains unverified** and is not listed as a blocker. It becomes one only if
verification confirms no workflow-maintenance schedule exists.

---

*Provenance: all findings traced to
`docs/architecture/workflows/assignments-37-phase-0-audit.md`. Where Phase 0
recorded `UNKNOWN`, this register preserves the uncertainty rather than
resolving it by assumption.*
