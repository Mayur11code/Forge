# Assignment 37 — Phase 37.1: Action Capability Catalog

```text
Phase:            37.1 — Action capability registry
Status:           VERIFIED
Classification:   P1
Resolves:         F3 (no authoritative planner-facing capability contract)
                  I4 (runtime / UI action registry mismatch)
                  AD-P1 (where planner-facing action metadata lives)
Depends on:       37.0A VERIFIED, 37.0B VERIFIED (Gate A, isolation sufficient)
Blocks:           37.2, 37.3, 37.4
Records:          I7 (conditional routing not executable/authorable end-to-end)
Writes workflows: No
```

Companion documents: `assignments-37-phase-0-audit.md` (evidence, unmodified),
`assignments-37-issue-register.md`, `assignments-37-plan.md`,
`assignments-37-tracker.md`.

This phase writes no workflows, which is why it may proceed while I6 is still
open (Gate G applies to 37.12, not here). The existing execution runtime remains
the only execution authority and was not modified.

---

## 1. Purpose and scope

Phase 0 established that the model had no authoritative, machine-readable
description of a workflow action (F3), and that the two descriptions that did
exist — the runtime registry and the canvas list — contradicted each other and
were both wrong about `task.create` (I4).

Phase 37.1 establishes **one** planner-facing action capability source, derived
from the runtime registry rather than maintained beside it, and reconciles the UI
against it.

In scope:

- A client-safe capability catalog describing every registered action.
- Compile-time and runtime enforcement that the capability catalog, the runtime
  registry, and the UI picker cover exactly the same action set.
- Corrected `task.create` input and output metadata, verified against the
  canonical operation.
- Removal of `comment.add` from the executable picker.
- Focused tests, architecture documentation, register/tracker/plan updates.

Out of scope, and not done: `WorkflowProposal`, `generateWorkflow`, proposal
persistence, Prisma changes, reference preflight, `MISSING_DATA_DEPENDENCY`, the
proposal compiler, materialization, prompt changes, conditional-routing
implementation, new runtime actions, executor changes, I6, and I1/I2.

---

## 2. The three boundaries

Phase 37.1 separates three concerns that were previously entangled in two files:

```text
                    ACTION CAPABILITY
                 canonical semantic contract
                src/lib/workflow-types/action-capabilities.ts
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   RUNTIME REGISTRY              UI PRESENTATION
   which functions run           how actions are shown
   action-registry.ts            registry.ts
            │
            ▼
   action.execute()
```

| Surface | File | Owns | Environment |
|---|---|---|---|
| Runtime registry | `src/lib/workflow-types/action-registry.ts` | Which executable functions exist. Execution authority. | Server |
| Capability catalog | `src/lib/workflow-types/action-capabilities.ts` | What each action means: inputs, outputs, compensation, failure behaviour. | Shared / client-safe |
| UI presentation | `src/lib/workflow-types/registry.ts` | Widget type, label wording, dropdown option labels, field order. | Client |

The split exists because the two requirements genuinely conflict: the catalog
must be importable from client code, while the executable actions under
`src/lib/workflow/actions/**` import the extended Prisma client and must never
reach a browser bundle. Putting widget metadata on `WorkflowAction` would force
one of those to break. Three surfaces with one job each satisfies both.

**A capability descriptor is schema information only, never execution authority.**
The runtime registry decides what runs. A descriptor cannot dispatch anything.

---

## 3. AD-P1 and rationale

**AD-P1 — where does planner-facing action metadata live?**

Options considered: on `WorkflowAction` itself, or in a separate descriptor keyed
by action id.

**Decision: a separate, client-safe capability catalog keyed by action id, with
the runtime registry as the source of truth for membership.**

Rationale:

- `ActionDef` (the old UI shape) already carries presentation concerns — form
  widget types, select options, label wording — that an execution module has no
  business owning. Merging them onto `WorkflowAction` would put UI metadata into
  a module the worker bundle imports.
- A separate catalog is the only shape that keeps the executable implementations
  out of the client bundle while still describing them.
- The drift risk that "two maps" normally introduces is closed by construction
  rather than by discipline: the catalog is typed against the registry's literal
  key set (section 5), so the two cannot diverge without a compile error.

The plan's original constraint — "the registry remains the source of truth" —
is preserved. The capability catalog describes; the registry dispatches.

---

## 4. Selected source-of-truth relationship

```text
action-registry.ts
  export const ActionRegistry = { ... } satisfies Record<string, WorkflowAction>
  export type RegisteredActionId = keyof typeof ActionRegistry
        │
        │  (type-only import — erased by isolatedModules, no runtime edge)
        ▼
action-capabilities.ts
  export const ActionCapabilities = { ... } satisfies Record<RegisteredActionId, ActionCapability>
        │
        │  (derived projection)
        ▼
registry.ts
  export const AVAILABLE_ACTIONS: ActionDef[] = Object.values(ActionCapabilities).map(buildActionDef)
```

The runtime registry owns **membership**. The catalog owns **meaning**. The UI
owns **presentation**. The UI's `requires` and `outputs` are computed from the
capability schemas, never restated.

The `satisfies` on `ActionRegistry` is what makes the key union available. It
changes no runtime behaviour: `ActionRegistry` is still a plain object of
`id -> WorkflowAction`, still read through `getAction`.

---

## 5. Registry consistency enforcement

Five properties are required; all five are enforced.

| # | Property | Enforced by |
|---|---|---|
| 1 | Every planner-exposed action has an executable implementation | Compile time — `satisfies Record<RegisteredActionId, ActionCapability>` plus excess-property checking rejects an unregistered catalog entry |
| 2 | Every registered executable action has capability metadata | Compile time — the same `satisfies` fails when a registry key has no catalog entry |
| 3 | The UI never offers an action the runtime cannot dispatch | Derived projection; `AVAILABLE_ACTIONS` is built from the catalog, and the presentation overlay is typed `Partial<Record<RegisteredActionId, ...>>` |
| 4 | Adding an executable action without metadata fails a check | Compile time, verified (section 12, negative case 2) |
| 5 | Adding a capability without registration fails a check | Compile time, verified (section 12, negative case 1) |

The coupling is **type-only**: `action-capabilities.ts` imports `RegisteredActionId`
with `import type`, which `isolatedModules` erases. So there is no runtime import
edge from the client-safe catalog to the server-side runtime registry, and the
compile-time guarantee is not paid for with a bundle dependency.

**Why this holds without circular imports.** The dependency direction is one way:
registry → catalog → UI. The catalog imports a *type* from the registry, so at
runtime the catalog has no dependencies beyond `zod`. Nothing imports the catalog
from the registry, so there is no cycle.

**Documented limitation.** The mutual exclusion (`satisfies`) catches a
catalog/registry mismatch *at the time the edit is made*. It cannot catch someone
later widening `ActionRegistry` back to an explicit `Record<string, WorkflowAction>`
annotation, which would erase the literal key union. Test
`capability registry correspondence` in
`src/tests/workflow/action-capabilities.test.ts` is the runtime backstop for that:
it asserts the catalog id set, the registry key set, and the UI picker id set are
equal. That test was confirmed to fail when `comment.add` is re-advertised
(section 12, mutation B).

---

## 6. The `task.create` contract

Confirmed against source, not against the Phase 0 prose.

### Inputs — from `createTaskSchema` (`src/core/domain.ts:14-39`)

| Field | Type | Required | Constraint |
|---|---|---|---|
| `title` | string | **yes** | min 3, max 100 |
| `projectId` | string | **yes** | cuid |
| `description` | string | no | — |
| `assigneeId` | string | no | cuid |
| `priority` | enum | no | `LOW` \| `MEDIUM` \| `HIGH`, default `MEDIUM` |

The action reads `title`, `projectId`, `description`, `priority`, `assigneeId`
from `ctx.inputs` and rejects a call missing `title` or `projectId`
(`src/lib/workflow/actions/core/create-task.ts:25-33`). Phase 0's observation is
confirmed exactly.

### Output — the business `data` payload

`createTaskAction` returns `{ success: true, data: { taskId, title } }`
(`create-task.ts:68-71`). The wrapper copies `ActionResult.data` into
`StepRun.outputs`, and `{{<stepId>.outputs.*}}` resolves against that column. So
the catalog's **output schema describes the business payload, not the
`ActionResult` envelope**:

```ts
z.object({
  taskId: z.string(),
  title: z.string(),
})
```

Both fields are referenceable. `referenceableOutputFields` derives them from the
schema, so a later edit to the output shape cannot leave `outputs` stale — which
is the half of I4 that was most dangerous, because a reference to
`{{create_task.outputs.title}}` is real and the old list declared only `taskId`.

### Strictness

The catalog input schema is `.strict()`. `createTaskSchema` is **not** strict: it
strips unknown keys. This is a deliberate divergence, not an inconsistency.

The capability catalog is the **generation boundary** — the point a model's
proposal is first validated. An unknown key there is either a typo or an attempt
to supply a field the model controls; both must fail loudly at generation rather
than be silently dropped and discovered at execution. The runtime boundary is
unchanged and still uses `createTaskSchema`.

The equivalence test asserts the two schemas agree on accept/reject for every
well-formed payload, and asserts the strictness difference explicitly.

### Trusted identity boundary

`orgId`, `userId`, `workflowId` and `runId` are absent from the input schema and
rejected by it. Organization identity continues to come from the persisted
`Workflow` row (`create-task.ts:36-39`); project and assignee ownership are
re-validated by the canonical operation. `createTaskInOrg` was not modified and
its validation was not weakened.

---

## 7. Why `comment.add` was removed

`comment.add` was listed in `AVAILABLE_ACTIONS` (`registry.ts`, before this
phase) and registered nowhere. The compiler performs no registry membership check
and `WorkflowStep.action` is `z.string()`, so a workflow using it saved cleanly
and then failed at execution as a non-retriable step failure.

Phase 37.1 removes it by construction: `AVAILABLE_ACTIONS` is projected from the
capability catalog, and the catalog is total over the runtime registry, so an
action with no executor cannot appear.

Deliberately **not** done:

- `comment.add` was not registered. No comment executor exists or was written.
- `communication.send_email` and `utils.generate_report` were not exposed. Those
  files exist on disk and are exported, but nothing registers them, and a
  function existing in the repository does not make it an available capability.
- No unregistered implementation was deleted from disk.

`getActionCapability("comment.add")` returns `undefined`;
`ActionRegistry` has no such key; the picker does not list it.

---

## 8. How output paths support Phase 37.3

`referenceableOutputFields(capability.output)` derives the referenceable output
set from the output schema. It feeds two consumers today:

- `getAvailableUpstreamOutputs` (`src/lib/workflow/graph-ui/utils.ts:135`), which
  offers wireable values to the canvas auto-mapper.
- The corrected `ActionDef.outputs`, which is what the canvas shows a user when
  wiring a downstream step.

For `task.create` this now yields `['taskId', 'title']` instead of `['taskId']`.

37.3 will validate `{{<stepId>.outputs.<field>}}` paths against each action's
declared output contract. That validator can call the same derivation, so the
contract it checks against is the same one the UI offers — no second list, and no
divergence between "what the canvas lets you wire" and "what validation accepts".

37.3 is **not** implemented here. No validator, no `MISSING_DATA_DEPENDENCY`, no
compiler change.

---

## 9. How the design supports 37.2 and 37.4

**37.2 (WorkflowProposal schema).** The catalog provides the action id set and
per-action input schemas a proposal must be checked against. A proposal step's
`action` can be validated against `CAPABILITY_ACTION_IDS` rather than an
unconstrained `z.string()`.

**37.4 (compiler / semantic validation).** The catalog is static, deterministic
data with no runtime side effects, so a validation adapter can consume it without
touching the execution engine. Output contracts (section 8) are the input to
reference validation.

Neither 37.2 nor 37.4 is implemented here.

---

## 10. Confirmed conditional-routing limitation — I7

The reconnaissance finding was re-inspected against source and **confirmed**. It
is recorded as **I7 — Conditional routing is not executable/authorable
end-to-end** in the issue register and tracker.

### What exists

- `executeConditionNode` (`src/lib/workflow/actions/logic/conditions.ts:40`)
  computes a `TRUE`/`FALSE` branch and returns `{ success, data: { branch, ... } }`.
- The evaluator reads a parent's branch via `readBranch`
  (`src/lib/workflow/execution/evaluator.ts:62-69`) and gates a dependant on it:
  `requiredBranch = node.routingConditions?.[depId]`,
  `actualBranch = readBranch(stepRunMap.get(depId)?.outputs)` (`:424-431`).
- `I7 does not contradict the 2026-10-01 output-contract fix` — the helper now
  returns its payload under `data` (correct) rather than `outputs` (wrong). See
  `src/tests/workflow/condition-branch.test.ts`.

### What is unreachable or missing

1. `executeConditionNode` is **not registered** in `ActionRegistry`, and its
   signature is not an `ExecuteFunction` — it takes `Record<string, JsonValue>`,
   not `ActionContext`. Nothing in the engine imports it; its only importer is
   its own test.
2. The wrapper's single dispatch path is `getAction(actionId)`
   (`wrapper.ts:180`). An unregistered action fails with "Action not found in
   registry". So a condition step cannot execute, and never writes a branch into
   `StepRun.outputs`.
3. `readBranch` therefore always reads `undefined`, and
   `requiredBranch && actualBranch !== requiredBranch` is true for every
   conditional dependant, so every conditional branch is skipped.

### What the canvas can author

Nothing that produces `routingConditions`. `ActionNodeDataSchema`
(`workflow-types/workflow.ts`) has no routing field, and `compileWorkflow`
(`src/lib/workflow/graph-ui/compiler.ts`) builds `WorkflowStep` records without
ever setting `routingConditions`. The field exists in the schema and is read by
the evaluator, but no authoring path populates it.

### Why merely registering `executeConditionNode` would not complete the feature

Registration would make the step run and publish a `branch`, but:

- Nothing sets a dependant's `routingConditions[depId]`, so the evaluator would
  still have no required branch to compare against.
- The action's input shape (`value1`, `operator`, `value2`) does not come from any
  canvas field or capability descriptor, so a generated proposal could not supply
  it through the normal config path.
- The node kind has no representation in the capability catalog, and it is not an
  `ActionDef` consumer.

A working feature needs a node/authoring path, a way for a dependant to declare
which branch it requires, and a capability contract for the condition inputs —
three pieces, none of which is the capability catalog's job.

### Scope decision required before Assignment 37 claims generated conditional branches

Assignment 37 must decide whether generated conditional branching is:

- (a) in scope, requiring a condition node kind, an authoring path, branch
  declaration on dependants, and a capability contract; or
- (b) out of scope, in which case generated proposals must be forbidden from
  emitting conditional steps and the capability surface must not imply otherwise.

**Not decided in 37.1.** No evaluator logic, routing semantics, node kind, or
registry entry was changed to enable conditional execution. Conditional routing is
**not** claimed to work end-to-end.

---

## 11. Explicit non-goals preserved

- No second DAG executor, reference language, retry controller, or lock system.
- No change to `WorkflowAction`, `ActionContext`, `ActionResult`, or the wrapper.
- No new runtime action registered.
- No conditional-routing implementation.
- `getAction` still returns the same values for the same inputs; the runtime
  registry remained the execution authority throughout.

---

## 12. Test coverage and verification evidence

### Automated

`src/tests/workflow/action-capabilities.test.ts` — 32 tests.

| Group | Covers |
|---|---|
| Registry correspondence | catalog ids == registry keys == picker ids; no duplicates; every capability has required metadata; unreadable schema throws |
| Client safety | no server-only import in the two client-facing modules; the registry coupling is `import type`; no import of the executable actions |
| `task.create` input | required/optional sets; equivalence with `createTaskSchema`; strict rejection of unknown keys; malformed rejection; `MEDIUM` default; no trusted identity field |
| `task.create` output | exactly `taskId`/`title`; describes the payload not the envelope; validates the real payload |
| UI projection | derived `requires`/`outputs`/fields/requiredness/options; UI-only presentation retained; `comment.add` and the other unregistered impls absent; triggers unchanged; `getNodeDefinition` resolves both kinds |
| Derivation | counts come from the schemas; a mutated schema changes the derived lists |

### Commands run and results

```text
npx jest src/tests/workflow/action-capabilities.test.ts   -> 32 passed, 32 total
npx jest                                                  -> 31 suites, 490 tests passed
npx tsc --noEmit                                          -> exit 0
npx eslint (4 touched files)                              -> 0 errors, 0 warnings
```

### Compile-time guards, demonstrated

```text
Negative case 1 — catalog entry with no registration:
  TS2353: Object literal may only specify known properties, and '"phantom.action"'
  does not exist in type 'Record<"task.create", ActionCapability>'.

Negative case 2 — registration with no catalog entry:
  TS1360: Type '{ "task.create": ... }' does not satisfy the expected type
  'Record<"unregistered.new" | "task.create", ActionCapability>'.
```

### Mutation checks

Both were applied to the working tree, observed to fail, then reverted:

```text
Mutation A — remove `title` from the capability output schema:
  3 failed, 29 passed. The tests detect a silently omitted output.

Mutation B — re-advertise `comment.add` in the picker:
  3 failed, 29 passed. The tests detect an unregistered action reaching the UI.
```

### Verification gate

37.1's gate is unit-level by its own definition ("unit tests plus an inspection
confirming `comment.add` is no longer advertised"). That gate is satisfied.

**Not exercised:** no live database, no queue, no execution engine, no component
render. The picker's *data* is verified (`getNodeDefinition`, projection
assertions); no React component test exists in this repository, so
`PropertiesPanel` / `ActionNode` rendering is covered by type-check only, as it
was before this phase.

---

## 13. Known limitations and deferred decisions

- **The mutual-exclusion guarantee depends on `satisfies`.** Widening
  `ActionRegistry` to an explicit `Record<string, WorkflowAction>` would erase the
  literal key union. The correspondence test is the runtime backstop.
- **`task.create` now advertises `title` as required in the canvas.** This is a
  UI behaviour change, and it is the correct one: `autoMapNodeVariables` and the
  missing-upstream alert previously did not require `title`, though the action
  rejects a call without it. Not a regression, but visible to a user.
- **The two `createTaskSchema` definitions were not unified.**
  `src/core/domain.ts` (canonical runtime) and
  `src/lib/ai/agent/tools/create-task/schema.ts` (agent tool, uses `projectName`
  instead of `projectId`) are separate and were left alone. The catalog mirrors
  the canonical one, and an equivalence test pins the agreement. Note for 37.13:
  the agent tool's `projectName`-based shape will not match a proposal that
  carries `projectId`.
- **`src/core/domain.ts` carries a stray `import { version } from "typescript"`.**
  It is dead, and it is why the catalog does not import `createTaskSchema`
  directly at runtime — doing so would drag the TypeScript compiler into a
  client-safe module. Out of scope here (unrelated cleanup); the catalog mirrors
  the schema and an equivalence test enforces agreement instead.
- **I7 is recorded, not resolved.** Its scope decision is carried forward.
- **No capability entry describes a condition node**, because none is registered.

## 14. Next phase

**37.2 — WorkflowProposal schema.** The proposal's static shape, with local
logical step ids (AD-08), validated against this phase's `CAPABILITY_ACTION_IDS`
and per-action input schemas. Not begun.
