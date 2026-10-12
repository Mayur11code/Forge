# Assignment 37 — Phase 37.2: WorkflowProposal Schema

```text
Phase:            37.2 — WorkflowProposal schema
Status:           VERIFIED
Classification:   P1
Depends on:       37.1 VERIFIED (action capability catalog)
Blocks:           37.3 (reference grammar + validator), 37.4 (graph validation)
Enforces:         I4 (action must be a registered workflow action) at the
                  generation boundary
Writes workflows: No
```

Companion documents: `assignments-37-phase-0-audit.md` (evidence, unmodified),
`assignments-37-phase-37.1-capability-catalog.md`,
`assignments-37-issue-register.md`, `assignments-37-plan.md`,
`assignments-37-tracker.md`.

This phase adds a schema and a validator. It writes no workflows and changes no
runtime, which is why it may proceed while I6 is still open (Gate G applies to
37.12, not here). The existing execution runtime remains the only execution
authority and was not modified.

**Status — `VERIFIED` (2026-10-12).** Unit tests are green (§13) and the
validator's resource bounds were hardened so an adversarial payload cannot force
unbounded recursion or a thrown error (§13.1). The earlier `PARTIALLY_VERIFIED`
note cited a second Verification Gate clause — a proposal produced by the *real
model path* parsing without a compiler fix-up. That clause is not a 37.2
responsibility: no `generateWorkflow` model path exists at 37.2 (it is 37.5), so
the clause has been **reassigned to 37.5/37.13**, where the model path exists and
can be exercised. It is relocated, not waived, and 37.5's Verification Gate now
carries it explicitly.

---

## 1. Purpose and scope

Phase 37.1 gave the model an authoritative, machine-readable description of every
action. Phase 37.2 gives the model a contract to author *against*: a typed
`WorkflowProposal` that is distinct from the persisted `WorkflowDefinition`, and
a validator that resolves each proposed action against the capability catalog and
checks each step's inputs against that action's real input schema.

In scope:

- A strict, client-safe `WorkflowProposal` Zod schema.
- A structured validator (`validateWorkflowProposal`) with machine-readable
  issue codes and dotted paths.
- Capability-backed action membership and per-action input validation, reusing
  37.1's catalog rather than duplicating the `task.create` contract.
- Reference-template tolerance: `{{...}}` values are deferred, not rejected.
- Documented, tested resource bounds.
- Focused tests, architecture documentation, tracker/plan updates.

Out of scope, and not done: reference resolution, dependency existence, cycle
detection, execution readiness (`37.3`, `37.4`); `generateWorkflow` or any prompt;
the proposal compiler; materialization into `Workflow`/`Node`/`Edge`
(`37.10`/`37.11`); UI derivation; persistence; Prisma changes; I6; I7.

---

## 2. Relationship to the persisted `WorkflowDefinition`

The proposal is deliberately **not** the persisted definition. The two differ
because they answer different questions: the definition records what the backend
owns and executes; the proposal records what a model is allowed to author.

| Concern | `WorkflowProposal` (this phase) | `WorkflowDefinition` (`workflow.ts`) |
|---|---|---|
| Steps | `steps: Record<localRef, step>` | `nodes: AppNode[]` + `edges: AppEdge[]` |
| Step action | registered action id, membership-checked | `action: z.string()`, unchecked |
| Step inputs | strict, per capability | `config: z.record(z.any())` |
| Dependencies | local refs only, grammar-checked | `dependsOn: string[]` |
| Identity | the record key (`localRef`) | backend-generated node/step id |
| Ownership fields | absent by construction | `id`, `kind`, `isCritical`, `routingConditions` |

Reuse decision, field by field:

- `action` reuses the shape of `WorkflowStep.action`, now checked against the
  capability catalog. This is where **I4** becomes enforceable.
- `inputs` replaces `WorkflowStep.config`. The rename is deliberate: a proposal
  input is validated against an action's real schema, not accepted as opaque
  `z.any()`.
- `dependsOn` reuses `WorkflowStep.dependsOn` unchanged in shape and meaning, and
  adds the local-id grammar.
- `name`/`description` are proposal-level fields. `name` is destined for
  `Workflow.name`, not `definition.name` (F2, surfaced at 37.11).
- No `id`, `kind`, `isCritical`, `routingConditions`, coordinates, run identity,
  QStash data, or tenant/user identity. A proposal must not be able to name what
  the backend owns (AD-10).

The step schemas were **not** collapsed into `WorkflowStepSchema`. That schema
validates a persisted step (with `kind`, `isCritical`, an unchecked `action`),
and reusing it here would either drag backend-owned fields into the proposal or
require weakening the proposal's strictness. The aligned subset was copied by
shape and re-validated, not re-exported.

---

## 3. The proposal shape

```ts
{
  name: string,
  description?: string,
  steps: {
    [localRef: string]: {
      action: string,
      inputs: Record<string, unknown>,
      dependsOn: string[]
    }
  }
}
```

Implemented as `WorkflowProposalSchema` (`z.object(...).strict().superRefine(...)`)
and `WorkflowProposalStepSchema` (strict). Both are strict so a typo, or an
attempt to smuggle a backend-owned field, fails while the model is still
generating rather than after the workflow is persisted.

`inputs` and `dependsOn` are required on every step. `dependsOn: []` is the
explicit "no prerequisite", matching the existing `WorkflowStepSchema`, where
`dependsOn` has no default.

---

## 4. Step identity and the `localRef` grammar

`steps` is a **record keyed by `localRef`**, not an array. This is AD-08: a
backend-generated id is forbidden in a proposal, and the model's logical id is
the step's identity for the whole proposal.

The record-key design has two consequences that were requirements, not
side-effects:

- **A duplicate `localRef` is unrepresentable.** A JSON object cannot hold the
  same key twice, so two steps cannot share an id. Duplicate detection is not a
  runtime rule that can be forgotten; it is a property of the representation.
- **There is no redundant `id` field** that could drift from the key.

`PROPOSAL_LOCAL_REF_PATTERN` is `/^[A-Za-z_][A-Za-z0-9_-]*$/`. It is compatible
with, but stricter than, the resolver's reference grammar `[\w.-]+`
(`src/lib/workflow/execution/resolver.ts:51`). Dots are excluded because the dot
is the path separator: a `localRef` containing one could not be referenced
unambiguously (`{{a.b.outputs.x}}`). Braces and whitespace are excluded for the
same reason. The result is an id that is always safe to place in front of
`.outputs.<field>` in a 37.3 reference.

Dependency entries are validated against the same grammar, so a dependency is
always usable as a reference target.

---

## 5. Structural validation vs full graph validation

`validateWorkflowProposal` performs **structural** validation only:

- proposal shape, strictness, and bounds;
- `localRef` grammar and dependency-entry grammar;
- action membership against the capability catalog;
- per-action input validity.

It does **not** check:

- whether a dependency names a step that exists (37.3/37.4);
- whether the dependency graph is acyclic (37.4);
- whether an output reference resolves or is ordered correctly (37.3);
- whether the workflow is executable.

This boundary is asserted by tests: a grammar-valid dependency on
`missing_step`, and a self-dependency, both pass. Rejecting them here would move
a 37.3/37.4 rule to the wrong phase and contradict the phase boundary.

---

## 6. Action resolution and capability reuse

For every step, the validator calls `getActionCapability(step.action)`. An action
that is not in the catalog is rejected with `UNKNOWN_ACTION` at
`steps.<ref>.action`. Because `ActionCapabilities` is `satisfies
Record<RegisteredActionId, ActionCapability>`, "in the catalog" is exactly "in
the runtime registry". This is the first place **I4** is actually enforced.

Input validation reuses the capability's own `input` schema as the source of
truth. The validator does not restate required fields, bounds, or enums:

- `requiredInputFields(capability.input)` derives requiredness;
- `capability.input.safeParse(inputs)` produces the real messages, e.g. "Task
  title must be at least 3 characters";
- `unrecognized_keys` from the capability's `.strict()` schema becomes
  `UNKNOWN_INPUT_FIELD`.

The one added rule is reference tolerance (§7). It is applied per offending
field, so a step with a valid reference in one field and a malformed literal in
another reports only the malformed literal.

### Why the capability schema is the validator

An alternative was tested during implementation: rebuild each capability input
schema as a `z.union([field, referenceTemplate])`. It was rejected. Zod reports a
union failure as a generic `INVALID_INPUT` ("Invalid input") and loses the
action's specific message, which would make 37.9's review surface and the
self-healing loop (37.14) worse. Validating against the original capability
schema and forgiving reference fields recovers the precise message ("Task title
must be at least 3 characters") while keeping identical accept/reject behaviour.

---

## 7. Reference-template handling

`inputs` may contain `{{...}}` references to previous steps' outputs, using the
**existing** resolver grammar (`REFERENCE_TEMPLATE_PATTERN`, the same
`{{[\w.-]+}}` as `resolver.ts:51`). No second reference syntax is introduced.

A `{{...}}` value is *deferred*, not *wrong*: its eventual resolved value is
unknown at proposal time. The validator therefore forgives an input issue whose
offending value is a reference template. `{{create_project.outputs.projectId}}`
is accepted where a literal `projectId` must be a cuid, and
`{{triage.outputs.priority}}` is accepted where a literal must be one of
`LOW`/`MEDIUM`/`HIGH`.

Forgiving is scoped to declared fields. An unknown key that happens to contain a
reference is rejected as `UNKNOWN_INPUT_FIELD`, so a reference cannot be used to
smuggle an undeclared field (e.g. `orgId: "{{session.outputs.orgId}}"`).

The schema validates that references are *well-formed strings*; it does not check
that they resolve. Resolving them is 37.3 (`MISSING_DATA_DEPENDENCY`), which will
consume this contract.

---

## 8. Resource bounds

No adequate pre-existing proposal bound was found, so this phase establishes
explicit, documented, tested limits:

| Constant | Value | Rationale |
|---|---|---|
| `MAX_PROPOSAL_STEPS` | 50 | Above any realistic generated graph, small enough to serialize, review and persist as one JSONB value. **Not** the evaluator's pass count. |
| `MAX_PROPOSAL_NAME_LENGTH` | 200 | Bounded, human-facing `Workflow.name`. |
| `MAX_PROPOSAL_DESCRIPTION_LENGTH` | 2000 | Optional, bounded. |
| `MAX_PROPOSAL_SERIALIZED_LENGTH` | 262144 | A capability bounds most fields, but some inputs are unbounded strings; this caps the whole payload well under the QStash payload ceiling. |
| `MAX_INPUT_DEPTH` | 8 | Current action inputs are flat; this bounds a pathological nested payload without constraining any real one. |

`MAX_PROPOSAL_STEPS` is explicitly **not** the evaluator's evaluation-pass count
(`MAX_EVALUATION_PASSES` in `evaluator.ts`). That is an execution bound and must
not silently cap what may be proposed. It is also not `MAX_AGENT_STEPS` (the
model-turn bound).

---

## 9. Structured issue contract

`validateWorkflowProposal` returns a discriminated result and never throws:

```ts
{ success: true; data: WorkflowProposal }
| { success: false; issues: { code: ProposalIssueCode; path: string; message: string }[] }
```

| Code | Meaning |
|---|---|
| `EMPTY_PROPOSAL` | `steps` has no entries |
| `TOO_MANY_STEPS` | step count exceeds `MAX_PROPOSAL_STEPS` |
| `INVALID_LOCAL_REF` | a `localRef` key is not a valid step id |
| `INVALID_DEPENDENCY` | a `dependsOn` entry is not a valid step id |
| `UNKNOWN_PROPOSAL_FIELD` | an unexpected top-level property |
| `UNKNOWN_STEP_FIELD` | an unexpected step property |
| `INVALID_PROPOSAL_STRUCTURE` | any other shape failure (wrong type, missing `name`) |
| `UNKNOWN_ACTION` | `action` is not a registered workflow action |
| `MISSING_REQUIRED_INPUT` | a required input is absent |
| `UNKNOWN_INPUT_FIELD` | an input the action does not declare |
| `INVALID_INPUT` | an input value failed, or a value that cannot be serialized |
| `INPUT_TOO_DEEP` | inputs exceed `MAX_INPUT_DEPTH` |
| `PROPOSAL_TOO_LARGE` | serialized size exceeds the limit |

`path` is dotted and points at the offending node, e.g.
`steps.create.inputs.title` or `steps.a.dependsOn.0`. Codes are surfaced through
Zod via `params.proposalCode` on custom issues, so a consumer switches on a code
rather than a message.

`validateWorkflowProposal` returns the *parsed* proposal on success, so callers
never re-parse and never cast raw model output into a `WorkflowProposal` by hand.

---

### No unchecked cast at the boundary

The only supported way to obtain a `WorkflowProposal` from model output is
`validateWorkflowProposal`, which returns `z.infer`-typed data. There is no
`as WorkflowProposal` in this phase and none is needed. A future
proposal → definition step (37.4) must likewise be a deterministic function over
validated data, not a cast.

---

## 10. Conversion boundary to `WorkflowDefinition` (documented, not implemented)

The proposal is not yet compilable into a definition, and this phase does not
attempt it. The intended mapping, recorded for 37.4 and 37.11:

```text
WorkflowProposal                      WorkflowDefinition / Workflow
----------------------------------    ----------------------------------------
name                                  Workflow.name  (NOT definition.name; F2)
description                           Workflow.description
steps[localRef].action          ->    node.data.actionType   (validated)
steps[localRef].inputs          ->    node.data.config
steps[localRef].dependsOn       ->    edges / WorkflowStep.dependsOn
localRef                        ->    backend-generated node / step id
(all steps are actions)               kind: "ACTION"; isCritical set later
```

Two things are intentionally unresolved here and belong to later phases:

- **Criticality.** A proposal carries no `isCritical`; the model does not choose
  it (37.4/37.11 decide how it is derived).
- **The definition already exists as a producer.** The canvas authors `uiNodes` +
  `uiEdges` and `compileWorkflow` produces a definition. The proposal path is a
  *second* producer to the same shape, and 37.4 owns reconciling them.

---

## 11. Canvas-first persistence constraint (deferred to 37.10/37.11)

Persistence today is canvas-first: `saveWorkflow`/`updateWorkflow`
(`src/app/actions/workflows/workflow.ts`) take `uiNodes` and `uiEdges` and call
`compileWorkflow`. Node **positions are required** for that path, and there is no
definition → React Flow reverse projection in the codebase.

Therefore producing a valid `WorkflowProposal`, even a valid
`WorkflowDefinition`, is **not** sufficient to persist anything. Materialization
needs either:

- **Option A** — proposal → `compileWorkflow` → a derived UI graph → the existing
  canvas-first persistence (positions synthesized), or
- **Option B** — a definition-first persistence boundary that does not require
  UI coordinates.

This decision is explicitly deferred to 37.10/37.11. This phase neither
implements nor pre-empts it; it only records that the proposal is not, by itself,
persistable.

---

## 12. Explicit non-goals preserved

- No `WorkflowProposal` Prisma model or migration.
- No reference resolution, dependency existence, or cycle detection.
- No `generateWorkflow` tool, prompt, or model wiring.
- No persistence, materialization, or UI derivation.
- No `isCritical`, coordinates, run/tenant identity, or QStash data.
- No change to the runtime registry, the executor, the resolver, or the capability
  catalog.

---

## 13. Test coverage and verification evidence

`src/tests/workflow/workflow-proposal.test.ts` — 45 tests:

- **Shape:** step schema exposes exactly `action`/`inputs`/`dependsOn`; no
  backend-owned field (`id`, `kind`, `isCritical`, `routingConditions`,
  coordinates, tenant/run ids); strict at proposal and step level; malformed
  types rejected.
- **Accepted graphs:** single `A`; linear `B→A`; fan-in `C→A,B`; fan-out
  `A→B,C`; diamond `A→B,C→D`; returns parsed data.
- **Structural rejection:** empty proposal, oversized step count, invalid
  `localRef`, `localRef` containing `.`, invalid dependency, unknown proposal vs
  step field, and the unrepresentable-duplicate demonstration.
- **Action resolution:** `UNKNOWN_ACTION` for `comment.add` and
  `utils.generate_report`, with exact path.
- **Inputs:** missing required input with path; malformed literal with the
  capability's own message; unknown input field; a reference accepted where a
  literal is rejected (cuid and enum); a reference in an undeclared field
  rejected; a mixed valid-reference/malformed-literal step reports only the
  malformed field.
- **Bounds:** `TOO_MANY_STEPS` (and acceptance at exactly the maximum),
  `PROPOSAL_TOO_LARGE`, `INPUT_TOO_DEEP`; plus adversarial cases (§13.1) —
  50 000-deep nesting without a stack overflow, a cyclic input, a non-serializable
  `BigInt` input, depth checked before serialization, and an oversized proposal
  short-circuiting before action validation.
- **Boundary:** dangling dependency and self-dependency accepted structurally.
- **Grammar:** reference template parity with the resolver; `localRef` grammar.
- **Client safety:** the module imports only `zod` and the capability catalog.

### 13.1 Resource-bound hardening

The initial bounds implementation had two weaknesses, both fixed here without
weakening `MAX_INPUT_DEPTH` or `MAX_PROPOSAL_SERIALIZED_LENGTH` and without adding
a new issue code:

- **Depth was computed by a recursive walk that visited every node before
  comparing.** It could overflow on a pathologically deep payload and kept
  working after the limit was already exceeded. It is now a **bounded, iterative
  traversal** (`exceedsMaxInputDepth`) that stops as soon as a value passes the
  limit; a cycle is stopped by the same bound. Depth accounting is unchanged.
- **Serialization was not the first resource check and could throw.**
  `serializedLength` ran before the depth check and `JSON.stringify` throws a
  `TypeError` on a non-serializable value (e.g. a `BigInt`). The order is now
  depth → safe serialize → size short-circuit → action validation. A
  non-serializable input is located per step and returned as `INVALID_INPUT` with
  a dotted path; an oversized proposal returns only `PROPOSAL_TOO_LARGE`, before
  any per-action validation runs. `validateWorkflowProposal` never throws.

The adversarial cases are pinned by tests so a future change cannot reintroduce
an unbounded walk or a thrown serialization error.

### 13.2 Evidence

```text
Focused:   npx jest src/tests/workflow/workflow-proposal.test.ts       45/45
Regression npx jest action-capabilities + dag-validation              2 suites / 56 tests
Full:      npx jest                                                    32 suites / 535 tests
Type check npx tsc --noEmit                                            exit 0
Lint       npx eslint on the 2 touched files                           0 errors / 0 warnings
```

The full-suite count rose from 31 suites / 490 tests (37.1) to 32 suites / 535
tests, the delta being this phase's one new suite plus the five adversarial
bounds cases added during hardening.

---

## 14. Compile-time and client-safety guards

- The module imports `zod` and `./action-capabilities` at runtime and nothing
  else. A test reads the source and asserts the import list, rejecting Prisma,
  server-only action modules, the registry runtime edge, and the UI registry.
  This keeps the contract usable from both the server-side generation path and a
  future client-side review UI (37.9).
- `WorkflowProposal`/`WorkflowProposalStep` are derived with `z.infer`; there is
  no hand-maintained parallel type.
- Action membership is total by construction through 37.1's `satisfies
  Record<RegisteredActionId, ActionCapability>`, so this phase inherits
  compile-time completeness rather than re-listing action ids.

---

## 15. Known limitations and deferred decisions

- **Dependency existence / cycles are unchecked** by design — 37.3/37.4.
- **References are string-validated, not resolved** — 37.3.
- **`isCritical` derivation** — 37.4/37.11.
- **Materialization path (Option A vs B)** — 37.10/37.11.
- **`name` destination** — `Workflow.name`, not `definition.name` (F2, 37.11).
- **I7 (conditional routing)** is unaffected and remains an open scope decision;
  proposals carry no `routingConditions`.
- **`localRef` forbids a leading digit** (stricter than the resolver). This is
  intentional and documented; if a later phase needs numeric-leading ids the
  grammar can be relaxed without breaking references.
- **Bounds are defaults, not physics.** They are recorded and tested, and may be
  revisited if real generated workflows approach them.
- **The real-model-path parse check** is reassigned to 37.5/37.13, where
  `generateWorkflow` and the prompt actually exist. 37.2 cannot exercise a model
  path that has not been built; the clause is relocated, not waived.

---

## 16. Next phase

**37.3 — Reference grammar + validator.** It consumes `WorkflowProposal` and
37.1's output contracts to reject an output reference that cannot resolve, adding
`MISSING_DATA_DEPENDENCY`. It reuses the resolver grammar this phase stayed
compatible with; it does not introduce new syntax. 37.2 must not start it.

The real-model-path parse obligation (a proposal from `generateWorkflow` parsing
without a compiler fix-up) is carried by 37.5, which owns the model path.
