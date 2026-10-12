# Assignment 37 — Phase 37.4: Proposal Compiler / Semantic Validation Adapter

```text
Phase:            37.4 — Proposal compiler / semantic validation adapter
Status:           IMPLEMENTED (not yet VERIFIED — no production caller until 37.5)
Classification:   P1
Depends on:       37.2 VERIFIED (WorkflowProposal), 37.3 VERIFIED (reference validator)
Blocks:           37.5 (generateWorkflow)
Resolves:         F5 (which graph-semantic gate is canonical) — AD-P4
Writes workflows: No
Runtime changed:  No
Resolver changed: No
```

Companion documents: `assignments-37-phase-0-audit.md` (evidence, unmodified),
`assignments-37-issue-register.md` (F5), `assignments-37-plan.md`,
`assignments-37-tracker.md`,
`assignments-37-phase-37.2-workflow-proposal-schema.md`.

This phase adds one deterministic compilation boundary. It writes no workflows,
changes no runtime, and **does not modify `src/lib/workflow/execution/resolver.ts`
or `src/lib/workflow-types/workflow.ts`**.

**Status — `IMPLEMENTED` (2026-10-12).** The compiler is implemented and covered by
25 focused tests (§10). It is deliberately **not** marked `VERIFIED`: the
verification gate requires a production-path check that the chosen gate runs on
materialization, and the compiler has no production caller until 37.5. The
unit-tested half of the gate is satisfied; the production-path half is deferred.

---

## 1. Purpose and scope

Provide the single deterministic boundary that turns an untrusted model artifact
into either a candidate `WorkflowDefinition` or a structured list of
`ProposalIssue`s. It composes existing layers and re-implements nothing:

```text
input (unknown)
      |
      v
1. validateWorkflowProposal        structure, bounds, action membership, inputs   (37.2)
      |
      v
2. validateProposalReferences      reference + data-dependency integrity          (37.3)
      |
      v
3. mapProposalToDefinition         pure, total proposal -> definition mapping     (37.4, new)
      |
      v
4. collectWorkflowDefinitionIssues existing graph-semantic rules (authority)      (existing)
      |
      v
5. toProposalIssues                normalize collector issues -> ProposalIssue    (37.4, new)
```

The pipeline short-circuits: a failure at stage 1, 2 or 4 returns immediately, so a
caller is never shown a downstream symptom of an upstream error.

### Out of scope (honoured)

- No second DAG validator — stage 4 is the existing collector.
- No executor, no runtime behaviour change, no persistence, no queue.
- No modification to the canvas `compileWorkflow` or the save/update actions.
- No trigger design, routing conditions, migrations or materialization.

---

## 2. API

Module: `src/lib/workflow-types/workflow-proposal-compiler.ts`.

```ts
export const PROPOSAL_DEFINITION_ID = "proposal";
export const PROPOSAL_DEFINITION_NAME = "Compiled Execution Graph";

export type WorkflowCompilationResult =
  | { success: true; proposal: WorkflowProposal; definition: WorkflowDefinition }
  | { success: false; issues: ProposalIssue[] };

export function compileWorkflowProposal(input: unknown): WorkflowCompilationResult;
export function mapProposalToDefinition(proposal: WorkflowProposal): WorkflowDefinition;
export function toProposalIssues(issues: WorkflowDefinitionIssue[]): ProposalIssue[];
```

- The success arm keeps the validated proposal (name/description metadata) as well
  as the candidate definition, so no validated metadata is discarded.
- The result mirrors the existing `ProposalValidationResult` discriminated-union
  convention rather than introducing a parallel one.
- Expected validation failures are returned, never thrown. Unexpected programming
  errors remain unexpected.

### Issue codes added to `ProposalIssueCode`

`workflow-proposal.ts` (the existing union) is extended with the seven members of
`WorkflowDefinitionIssueCode`: `EMPTY_GRAPH`, `ID_MISMATCH`, `DUPLICATE_STEP_ID`,
`UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY`, `UNKNOWN_ROUTING_CONDITION`, `CYCLE`. This
makes `WorkflowDefinitionIssueCode` a subset of `ProposalIssueCode`, so the
normalization adapter is total and cannot silently drop a collector code.

---

## 3. Why the four "unreachable" codes exist in the adapter

Only **three** of the collector's seven codes are reachable through proposal
compilation — `UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY`, `CYCLE`. The other four are
unreachable by construction:

| Collector code | Why unreachable from a proposal |
|---|---|
| `EMPTY_GRAPH` | An empty proposal is rejected at stage 1 as `EMPTY_PROPOSAL` (`workflow-proposal.ts:177-187`). Stage 4 never sees an empty graph. |
| `ID_MISMATCH` | The mapping sets each step's `id` to its record key; key and id are identical by construction. |
| `DUPLICATE_STEP_ID` | Steps are a record (`Record<localRef, step>`), so duplicate step ids are unrepresentable (AD-08). |
| `UNKNOWN_ROUTING_CONDITION` | A proposal cannot express `routingConditions`; the mapping never synthesizes it. |

The adapter is nonetheless asserted **total over all seven codes** (§10), because its
contract must not depend on which codes happen to be reachable today. Adding a
collector code becomes a compile error in `locationForGraphIssue`'s exhaustive
`switch`, not a silent omission.

---

## 4. Mapping contract

`mapProposalToDefinition` is pure and total:

- `id` ← `localRef` (the record key); `dependsOn` ← a copy of the step's array;
  `config` ← a shallow copy of `inputs`.
- Every step is `kind: "ACTION"`. A proposal has no trigger node: the trigger is a
  runtime namespace, not a step. The mapping never synthesizes a `TRIGGER`.
- `isCritical: false` provisionally. Criticality is a human decision (AD-04);
  37.4 does not guess it.
- `routingConditions` is not emitted — a proposal cannot express it.
- The definition `id`/`name` are documented constants, not clock- or
  proposal-derived values (AD-10 / F2 / AD-P6).

---

## 5. F5 / AD-P4 — which gate is canonical

Two entry points to graph-semantic validation exist: the
`WorkflowDefinitionSchema.superRefine` and `collectWorkflowDefinitionIssues`.

**F5's premise was inaccurate and is corrected.** The schema *is* invoked in
production: `evaluator.ts:223` re-parses the persisted definition with
`WorkflowDefinitionSchema.safeParse(run.workflow.definition)` (added in the
2026-10-01 lint pass). It is not, however, a suitable structured gate: its
`superRefine` re-emits every issue as `z.ZodIssueCode.custom` and discards the
cycle `path` (`workflow.ts:243-250`) — exactly the structure the compiler must
preserve.

**Decision (AD-P4).** `collectWorkflowDefinitionIssues` is the canonical
graph-semantic gate. The compiler calls it directly. `WorkflowDefinitionSchema` is
unchanged and remains the runtime read-boundary validator. No production file was
modified to close F5.

---

## 6. Determinism

No clock, randomness, database, queue, model call, or runtime execution. The same
input always yields the same output. The definition `id` is the constant
`"proposal"` and is never `compiled_<timestamp>` (the canvas compiler's
per-save placeholder). A test asserts the id is constant across compilations and
reads the module source from disk to assert it contains no `Date.now`.

---

## 7. Structured output and `path`

`ProposalIssue.path` always denotes a location in the proposal **input**; it is
never repurposed as a graph path. Mapping from collector issue → input path:

| Collector code | `ProposalIssue.path` |
|---|---|
| `EMPTY_GRAPH` | `steps` |
| `ID_MISMATCH` | `steps.<stepId>` |
| `DUPLICATE_STEP_ID` | `steps.<stepId>` |
| `UNKNOWN_DEPENDENCY` | `steps.<stepId>.dependsOn` |
| `SELF_DEPENDENCY` | `steps.<stepId>.dependsOn` |
| `UNKNOWN_ROUTING_CONDITION` | `steps.<stepId>.routingConditions` |
| `CYCLE` | `steps` (the cycle sequence stays in `message`) |

`code` and `message` are copied verbatim; nothing is dropped or rewritten.

---

## 8. Security boundary

- No workflow write, no execution, no tenant/runtime identity, no authority.
- The compiler consumes already-validated data; stage 1 bounds are the 37.2 limits.
- `ProposalIssue.path` is a fixed, dotted, string-only shape — graph arrays never
  cross the boundary.
- No `@ts-ignore`, no `@ts-expect-error`, no unchecked `as` casts, no suppression.

### 8.1 Files changed

- `src/lib/workflow-types/workflow-proposal-compiler.ts` — **new**.
- `src/lib/workflow-types/workflow-proposal.ts` — `ProposalIssueCode` extended with
  seven graph codes (additive; no behaviour change).
- `src/tests/workflow/workflow-proposal-compiler.test.ts` — **new**, 25 cases.
- Documentation: this record; `assignments-37-tracker.md`;
  `assignments-37-issue-register.md`; `assignments-37-plan.md`.

`src/lib/workflow-types/workflow.ts`, the canvas compiler, the save actions, and
the entire execution runtime are **unmodified**.

---

## 9. Known limitations and deferred decisions

1. **Not integrated.** The compiler has no production caller until 37.5. This is
   the reason the phase is `IMPLEMENTED`, not `VERIFIED`.
2. **`TYPE_MISMATCH` is not implemented.** Carried over from 37.3: every catalogued
   output is `z.string()` and no machine-declared field-type relationship exists,
   so a sound cross-field type check is impossible without a type-inference layer.
   Recorded, not faked. It is not part of this phase's acceptance gate.
3. **Placeholder identity.** `definition.id`/`name` are constants. Real identity is
   materialization's responsibility (37.11 / F2 / AD-P6); provenance is AD-P6.
3. **Four collector codes are unreachable via a proposal.** Documented above and in
   the tracker; the adapter stays total regardless.

---

## 10. Test coverage and verification evidence

`src/tests/workflow/workflow-proposal-compiler.test.ts` — 25 focused tests:

- Pipeline order and short-circuit (structural → reference → graph); a proposal
  with both a reference error and a cycle returns only the reference issue.
- Empty proposal → `EMPTY_PROPOSAL`, never `EMPTY_GRAPH`.
- Success arm carries proposal metadata and the candidate definition.
- Mapping: key/id identity, `inputs` → `config`, `dependsOn` preserved, all
  `ACTION`, `isCritical: false`, no trigger, no `routingConditions`.
- No input mutation (deep-frozen input), determinism, no clock in behaviour or
  source.
- Reachable graph checks: `UNKNOWN_DEPENDENCY` path, `CYCLE` path/message,
  `SELF_DEPENDENCY` + `CYCLE` duality.
- Adapter total over all seven collector codes; `code`/`message` preserved; every
  `path` is a string.

### 10.1 Evidence

```text
npx jest workflow-proposal-compiler                          -> 25/25
npx jest src/tests/workflow                                  -> 13 suites / 287 tests
npx jest                                                     -> 34 suites / 604 tests
npx tsc --noEmit                                             -> exit 0
npx eslint (3 touched files)                                 -> exit 0
git diff --check                                             -> clean
git diff -- src/lib/workflow/execution/resolver.ts           -> empty
git diff -- src/lib/workflow-types/workflow.ts               -> empty
```

---

## 11. Next phase

37.5 (`generateWorkflow`) becomes the compiler's first production caller. Its
model-path clause (a real generated proposal parsing without a compiler fix-up,
reassigned from 37.2) is where the deferred production-path verification for 37.4
lands.

---

## 12. Status history

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-12 | IMPLEMENTED | Compiler module + 25 tests; `ProposalIssueCode` extended; F5 + AD-P4 resolved | 25/25 focused; workflow 13/287; tsc exit 0; eslint 0; `git diff --check` clean; resolver + workflow.ts diffs empty |
