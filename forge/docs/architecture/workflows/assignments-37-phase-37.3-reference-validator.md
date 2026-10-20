# Assignment 37 — Phase 37.3: Reference Grammar + Validator

```text
Phase:            37.3 — Reference grammar + validator
Status:           VERIFIED
Classification:   P1
Depends on:       37.1 VERIFIED (action output contracts), 37.2 VERIFIED
                  (WorkflowProposal)
Blocks:           37.4 (compiler / graph validation), 37.5 (generateWorkflow)
Resolves:         F6 (missing reference / data-dependency validation)
Writes workflows: No
Resolver changed: No
```

Companion documents: `assignments-37-phase-0-audit.md` (evidence, unmodified),
`assignments-37-issue-register.md` (F6), `assignments-37-plan.md`,
`assignments-37-tracker.md`, `assignments-37-phase-37.2-workflow-proposal-schema.md`.

This phase adds a read-only validator. It writes no workflows, changes no runtime,
and **does not modify `src/lib/workflow/execution/resolver.ts`** — which is why it
may proceed while I6 is still open (Gate G applies to 37.12, not here). (I6 has
since been `VERIFIED`, 2026-10-20.) The
existing execution runtime remains the only execution authority.

**Status — `VERIFIED` (2026-10-12).** The reference validator is implemented,
client-safe, deterministic, and covered by 44 focused tests (§10). The
verification gate — "a deterministic reference-validation module and tests", with
zero changes to the resolver — is satisfied: the resolver diff is empty (§11).
F6's core requirement, that a data reference without its execution dependency
cannot pass validation, is enforced by `MISSING_DATA_DEPENDENCY`.

---

## 1. Purpose and scope

Phase 37.2 established a structurally-valid `WorkflowProposal` — shape, strictness,
local-id grammar, action membership and per-action input validity — and
deliberately deferred output-reference resolution to this phase. Phase 37.3 adds
the preflight pass that turns the runtime's silent reference failures into
structured issues *before* a workflow is materialised or dispatched.

The runtime resolver resolves only at dispatch time and fails silently: a missing
path becomes `""` inside a larger string and the literal `{{...}}` text when the
reference is the whole value (`resolver.ts:64-85`). Nothing checks that a
referenced step exists, that the path is a declared output, or that the consuming
step depends on the producer. 37.3 is that check.

In scope:

- A pure, read-only reference validator over `WorkflowProposal`.
- Reference extraction using the **existing** `{{...}}` grammar.
- Source-step existence, output-path validity, explicit data-dependency, namespace
  scope, prototype-path safety, and deterministic ordering.
- `MISSING_DATA_DEPENDENCY` as a new validation requirement.
- Focused tests, a resolver-parity test, and architecture documentation.

Out of scope, and not done: the resolver (unmodified); a second reference syntax;
DAG existence/cycle validation (37.4); the compiler; `generateWorkflow`; prompts;
materialization; persistence; Prisma; I6; I7.

---

## 2. The grammar being reused (reconnaissance finding)

`src/lib/workflow/execution/resolver.ts` recognizes exactly one grammar:

| Aspect | Implementation | Behaviour |
|---|---|---|
| Interpolation token | `/\{\{([\w.-]+)\}\}/g` (`:63`) | each match replaced in place |
| Whole-string token | `/^\{\{([\w.-]+)\}\}$/` (`:66`) | returns the actual value, not a string |
| Path character class | `[\w.-]` (`:63`, `:66`) | word chars, `.` and `-` |
| Missing path, whole-string | literal `{{...}}` (`:69-70`) | silent |
| Missing path, interpolation | `""` (`:76-79`) | silent |
| Traversal | `current[part]` after `path.split(".")` (`:18-39`) | walks objects/arrays; arrays require a numeric segment |

The parsing implementation is **not exported** — only `resolveInputs` is. Rather
than edit or refactor the resolver, 37.3 mirrors the grammar in a new module and
adds a parity test that drives the real `resolveInputs` against the same strings
(§10, *grammar parity*). The mirrored constants are:

```ts
const REFERENCE_TOKEN_PATTERN = /\{\{([\w.-]+)\}\}/g;
```

This is a second *reader* of the grammar, never a second grammar: a token this
module recognizes is a token the resolver acts on, and the parity test fails if
that stops being true.

---

## 3. Action output contracts (reconnaissance finding)

Output fields are declared per action in the 37.1 capability catalog, not inferred:

- `ActionCapability.output` is a `z.ZodType` (`action-capabilities.ts:57`).
- `referenceableOutputFields(output)` derives the declared field names from the
  output object schema (`action-capabilities.ts:141-143`).
- The catalog is total over the runtime registry, and `task.create` is the only
  catalogued action today, declaring `{ taskId, title }`.

The validator checks an output path against that schema directly, by walking it:
a field is accepted only where the schema establishes it, and a primitive has no
descendants (so `{{a.outputs.taskId.nested}}` is rejected). Fields are looked up
with an own-key test, never `in`, so an inherited member can never count as a
declared field. A test asserts the validator accepts exactly
`referenceableOutputFields(task.create.output)` and rejects an undeclared field.

Output fields are currently flat and all `z.string()`; the schema walk is written
to accept nested outputs if a future action declares them, without inferring
descent from a parent field name.

---

## 4. Trigger output contract (reconnaissance finding)

**There is no statically-verifiable trigger-output contract, so trigger field
references fail closed.**

- `startWorkflow` primes `trigger.outputs` from `triggerData:
  Record<string, JsonValue>` (`execution/trigger.ts:12,25-29`) — an unconstrained
  record, not a field list.
- `WorkflowProposal` carries no trigger identifier, so no event can be selected to
  pick a contract.
- `AVAILABLE_TRIGGERS.output` in `registry.ts` is UI presentation keyed by event
  id (`registry.ts:44-66`), not a proposal-addressable contract.

Therefore `STATIC_TRIGGER_OUTPUT_FIELDS` is an intentionally empty allow-list
(`workflow-proposal-references.ts`). A `{{trigger.outputs.<field>}}` reference is
rejected with `UNKNOWN_OUTPUT` rather than silently accepted. The trigger is still
handled specially — it is never treated as an unknown step and never requires a
`dependsOn` entry — but its fields are not invented. If a real contract is
declared later, populating that one constant enables the path without touching the
validator's logic. This limitation is recorded in §9.

---

## 5. Validator API

New module: `src/lib/workflow-types/workflow-proposal-references.ts`. Client-safe
(`zod` + the capability catalog only; no server-only import edge).

```ts
export function validateProposalReferences(
  proposal: WorkflowProposal,
): ProposalIssue[];
```

- **Pure and read-only.** The proposal is never mutated; a test validates a
  deep-frozen proposal and confirms no throw and no change.
- **Deterministic.** Steps are visited in their key order and each step's inputs
  depth-first in declaration order, so the same proposal and catalog always yield
  the same issues in the same order. A test asserts two calls are equal.
- **Reuses the existing issue system.** It returns `ProposalIssue[]`
  (`{ code, path, message }`) from `workflow-proposal.ts`; the reference codes were
  added to the existing `ProposalIssueCode` union rather than a parallel
  vocabulary. Paths use the established dotted form, e.g.
  `steps.c.inputs.payload.nested` and `steps.c.inputs.items.1`.
- **Boundary.** It expects a proposal that has passed `validateWorkflowProposal`
  and does not re-derive structural rules; it adds only reference and
  data-dependency checks. It is not wired into a compiler (that is 37.4).

The module also exports `extractReferences(value)` (used by the parity test) and
the two policy constants `UNSAFE_REFERENCE_SEGMENTS` and
`RESERVED_REFERENCE_SOURCES`.

### Issue codes added to `ProposalIssueCode`

| Code | Raised when |
|---|---|
| `MALFORMED_REFERENCE` | `{{`/`}}` appears without forming a complete token; an empty path segment; a missing/wrong namespace (`<step>.<not-outputs>.<field>`, missing `.outputs`, or missing field). |
| `UNKNOWN_REFERENCE_SOURCE` | The source names a step that is not in the proposal. |
| `UNKNOWN_OUTPUT` | The field is not in the source action's declared output contract (including any trigger field, per §4). |
| `MISSING_DATA_DEPENDENCY` | A valid step-output reference whose source is absent from the consumer's `dependsOn`. |
| `SELF_REFERENCE` | A step references its own output. |
| `UNAVAILABLE_REFERENCE_SCOPE` | The source names a runtime/out-of-scope namespace (tenant, user, session, database, process). |
| `UNSAFE_REFERENCE_PATH` | A path segment is `__proto__`, `prototype`, or `constructor`. |

---

## 6. Validation rules

1. **Nested scanning.** Every string leaf under every step's `inputs` is checked;
   objects and arrays are walked, and issue paths carry object keys and array
   indices.
2. **Source existence.** A step reference's source must be a proposal step;
   otherwise `UNKNOWN_REFERENCE_SOURCE`.
3. **Output validity.** The path must be `<step>.outputs.<field...>` and the field
   path must exist in the action's declared output schema; otherwise
   `UNKNOWN_OUTPUT` (or `MALFORMED_REFERENCE` for a broken namespace).
4. **Explicit data dependency.** A valid step-output reference requires the
   source step in the consumer's own `dependsOn`; otherwise
   `MISSING_DATA_DEPENDENCY`. Dependencies are never inferred or added.
5. **Trigger.** Handled as a separate namespace; never a data dependency; fields
   fail closed (§4).
6. **Scope.** Only `trigger` and proposal step ids are accepted sources; runtime
   namespaces raise `UNAVAILABLE_REFERENCE_SCOPE`.
7. **Prototype safety.** `__proto__`, `prototype` and `constructor` segments raise
   `UNSAFE_REFERENCE_PATH` before any other classification.
8. **Whole-string vs interpolation.** Both forms are extracted and validated
   identically; the validator does not change resolution semantics.
9. **Type compatibility — documented limitation.** The capability catalog exposes
   output field *names* and per-field Zod schemas, but no cross-field relationship
   metadata, and every catalogued output is `z.string()`. A definitive
   `TYPE_MISMATCH` would require a type-inference layer that 37.3 deliberately
   does not build (see §9). No `TYPE_MISMATCH` code was introduced and no
   speculative mismatch is ever reported.
10. **Determinism.** Stable order and stable paths (§5).

---

## 7. `MISSING_DATA_DEPENDENCY` — the phase's reason to exist

The plan's invalid example — a step that reads `create_project.outputs.projectId`
while declaring `dependsOn: []` — is exactly what this code rejects. The check is
deliberately *direct*, not transitive: if `C` reads `{{A.outputs.x}}`, then `C`
must itself list `A`, even if `C → B -> A` would happen to order them. A
self-reference (`{{C...}}` from `C`) is reported as `SELF_REFERENCE`, not mistaken
for a satisfied dependency. No dependency array is ever mutated and no dependency
is auto-inserted; a data dependency and an execution dependency that disagree is
a rejection, not a repair.

Dependency existence and cycles are **not** checked here — that remains 37.4,
which reuses `collectWorkflowDefinitionIssues`. This phase checks only the
reference→dependency direction.

---

## 8. Security boundary

- **Scope.** A proposal may reference workflow steps and `trigger` only. Sources
  naming tenant, identity, session, database, or process state raise
  `UNAVAILABLE_REFERENCE_SCOPE`. Trusted identity (`orgId`, `userId`, `workflowId`,
  `runId`) is never exposed to the model to make a reference valid.
- **Prototype traversal.** The resolver's `current[part]` walk (`resolver.ts:35`)
  can follow `__proto__`/`constructor`/`prototype`; the validator rejects those
  segments with `UNSAFE_REFERENCE_PATH`. This guards generated proposals only. It
  does not claim to fix the resolver for arbitrary pre-existing workflows, whose
  runtime security posture remains outside this phase.

---

### 8.1 Files changed

| File | Change |
|---|---|
| `src/lib/workflow-types/workflow-proposal-references.ts` | **New.** The reference validator and its helpers/constants. |
| `src/lib/workflow-types/workflow-proposal.ts` | Extended `ProposalIssueCode` with the seven reference codes (no behaviour change). |
| `src/tests/workflow/proposal-references.test.ts` | **New.** 44 focused tests, including resolver parity and resolver-integrity checks. |
| `docs/architecture/workflows/assignments-37-phase-37.3-reference-validator.md` | **New.** This record. |
| `docs/architecture/workflows/assignments-37-tracker.md`, `assignments-37-plan.md`, `assignments-37-issue-register.md` | Status/evidence updates. |

`src/lib/workflow/execution/resolver.ts` is **not** in this list and is unmodified
(§11).

---

## 9. Known limitations and deferred decisions

- **Trigger outputs cannot be validated statically.** No authoritative contract
  exists (§4); trigger field references fail closed with `UNKNOWN_OUTPUT`. A test
  records the fail-closed behaviour and asserts no `dependsOn` is required. This
  is the honest state rather than a guessed field list.
- **No definitive type checking.** All catalogued outputs are `z.string()` and
  input/reference type relationships are not machine-declared in a way that
  supports a sound check without a type engine. `TYPE_MISMATCH` is therefore not
  implemented (§6 rule 9). This is recorded, not silently omitted.
- **Resolver runtime posture unchanged.** Prototype-path and missing-path
  behaviour for existing (non-generated) workflows is untouched; the validator is
  a preflight for generated proposals.
- **No general DAG validation.** Dependency existence, self-dependency in
  `dependsOn`, and cycles remain 37.4.
- **Not integrated into a compiler.** The validator is exported for 37.4 to call;
  it is not yet wired into any pipeline.

No architectural fork was discovered; no new PENDING DECISION is opened.

---

## 10. Test coverage and verification evidence

44 focused tests in `src/tests/workflow/proposal-references.test.ts`.

| # | Required case | Test |
|---|---|---|
| 1 | valid reference on an existing step | *valid reference accepted* |
| 2 | valid reference with the source in `dependsOn` | *requires the referenced source in dependsOn* |
| 3 | multiple valid references in one step | *accepts multiple distinct valid references* |
| 4 | valid reference nested in an object | *nested inside an input object* |
| 5 | valid reference nested in an array | *nested inside an array* |
| 6 | valid reference interpolated into text | *interpolated into a larger string* |
| 7 | valid whole-string reference | *whole-string reference* |
| 8 | trigger reference | fail-closed: rejected with `UNKNOWN_OUTPUT` (no valid contract) |
| 9 | ordinary strings | *ordinary strings that do not attempt reference syntax* |
| 10 | unknown source step | `UNKNOWN_REFERENCE_SOURCE` |
| 11 | undeclared output field | `UNKNOWN_OUTPUT` |
| 12 | missing `dependsOn` | `MISSING_DATA_DEPENDENCY` |
| 13 | malformed / incomplete delimiters | `MALFORMED_REFERENCE` |
| 14 | invalid namespace after a valid step | `MALFORMED_REFERENCE` |
| 15 | out-of-scope namespace | `UNAVAILABLE_REFERENCE_SCOPE` |
| 16 | prototype-sensitive path (`__proto__`, `constructor`, `prototype`) | `UNSAFE_REFERENCE_PATH` |
| 17 | unknown trigger field | `UNKNOWN_OUTPUT` |
| 18 | invalid nested reference (object and array paths) | path assertions |
| 19 | self-reference | `SELF_REFERENCE` |
| 20 | type compatibility | documented limitation — no fabricated mismatch (§9) |
| 21 | multiple errors, deterministic order | *stable order and actionable paths* |

Additional tests: output contract parity with `referenceableOutputFields`,
read-only/no-mutation on a deep-frozen proposal, and grammar parity with the real
`resolveInputs` (token list, whole-string form, interpolation, and the
malformed-delimiter case the resolver silently passes through).

### 10.1 Evidence

```text
Focused:     npx jest src/tests/workflow/proposal-references.test.ts
             → 1 suite, 44 tests, PASS
Regression:  npx jest src/tests/workflow
             → 12 suites, 262 tests  (was 11 suites / 218)
Full suite:  npx jest
             -> 33 suites, 579 tests (was 32 / 535)
Type check:  npx tsc --noEmit                 -> exit 0
Lint:        npx eslint <3 touched files>     -> exit 0
Diff check:  git diff --check                 -> clean
Resolver:    git diff -- src/lib/workflow/execution/resolver.ts → empty
```

The suite fails to compile or passes are both meaningful here only because the
parity and completeness tests are attached to the real contracts; the count alone
is not the evidence.

---

## 11. Resolver integrity

`src/lib/workflow/execution/resolver.ts` was not edited, refactored, or
reformatted. Evidence:

- `git diff --stat -- forge/src/lib/workflow/execution/resolver.ts` is empty.
- `git status --short` does not list the file.
- Two tests read the file from disk and assert it neither imports nor mentions the
  validator and still carries the mirrored grammar
  (`/\{\{([\w.-]+)\}\}/g`, `/^\{\{([\w.-]+)\}\}$/`).
- The parity tests call the real exported `resolveInputs` and confirm the same
  tokens resolve.

---

## 12. Next phase

**37.4 — Proposal compiler / semantic validation adapter (F5).** 37.4 will compose
`validateWorkflowProposal`, this reference validator, and the existing
`collectWorkflowDefinitionIssues` into one deterministic boundary, preserving the
issue codes introduced here. 37.3 deliberately does not build that composition.

---

## 13. Status history

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-12 | IMPLEMENTED | Reference validator module + tests; resolver untouched | 44/44 focused tests locally green; `tsc`/eslint clean |
| 2026-10-12 | **VERIFIED** | Verification gate satisfied: deterministic module + tests, resolver diff empty; F6 resolved | 44/44 focused; workflow 12/262; full 33/579; `tsc` exit 0; scoped eslint 0; `git diff --check` clean |
