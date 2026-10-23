# Assignment 37 — Phase 37.5: `generateWorkflow` Agent Tool

```text
Phase:            37.5 — generateWorkflow agent tool
Status:           VERIFIED (2026-10-23 — real-model-path clause discharged live)
Classification:   P1
Depends on:       37.4 VERIFIED (compiler boundary); 37.0A VERIFIED (Gate E, I1)
Blocks:           37.6, 37.7, 37.8
Resolves:         Tool access classification — AD-17 (READ_ONLY)
Writes workflows: No
Writes anything:  No (tool-domain only: nothing persisted by this tool)
Runtime changed:  No
Resolver changed: No
Prompt changed:   No (deferred to 37.13)
```

Companion documents: `assignments-37-phase-0-audit.md` (evidence, unmodified),
`assignments-37-issue-register.md`, `assignments-37-plan.md`,
`assignments-37-tracker.md`,
`assignments-37-phase-37.4-proposal-compiler.md` (the compiler this tool calls).

This phase registers one additional agent tool. It does not write a workflow, does
not execute an action, does not touch the runtime, and **does not modify
`src/lib/workflow-types/*` or `src/lib/workflow/execution/resolver.ts`**.

**Status — `VERIFIED` (2026-10-23).** The tool is registered and covered by
focused tests (§8; 35 now). The verification gate carries a clause reassigned from
37.2 requiring that a proposal produced by the **real model path** parses without
a compiler fix-up. That clause was discharged live on 2026-10-23 against
`gemini-3.6-flash`: the emitted proposal validated, compiled and executed with
byte-identical input at every stage (no fix-up, no repair). The mocked/scripted
path remains the regression baseline; the live check claims a model parse path
only, not a database, transport or capstone run.

---

## 1. Purpose and scope

Register `generateWorkflow`, a macro agent tool that turns a single model-authored
proposal into either a validated proposal or structured validation feedback. It is
the first production caller of the 37.4 compiler.

```text
model arguments (untrusted)
      |
      v
inputSchema: WorkflowProposalSchema           structure/bounds rejected here      (37.2)
      |
      v
executor: executeGenerateWorkflow
      |
      v
compileWorkflowProposal                        structure -> reference -> graph   (37.4)
      |
      +-- success: { ok: true,  proposal }      candidate definition NOT returned
      +-- failure: { ok: false, code: "INVALID_INPUT", error, issues[] }
```

### Out of scope (honoured)

- Tool is **proposal-only**: no action executor, no `startWorkflow`, no `Workflow`,
  `WorkflowRun` or `StepRun`, no proposal persistence, no workflow event, no lock.
- No prompt change and no `AGENT_PROMPT_VERSION` bump — deferred to 37.13.
- No modification to the 37.2 `WorkflowProposalSchema` or any other contract.
- No change to the confirmation behaviour of the existing `createTask` / `updateTask`
  tools.

---

## 2. Registration contract

One entry in `src/lib/ai/agent/tools/registry.ts` binds all four parts, so none can
drift from the others:

| Facet | Value |
|---|---|
| `tool` | `generateWorkflowTool` (`tool({ description, inputSchema })`) |
| `executor` | `executeGenerateWorkflow` |
| `policy` | `READ_ONLY_POLICY` (AD-17) |
| `describeProposal` | `describeGenerateWorkflowProposal` (presentation only) |

`agentTools` is derived from the registry, so the tool is in the model-visible set
without a second list. Policy is resolved server-side from the tool name; tool input
cannot select or relax it.

The executor is declared `(input: Prisma.JsonValue)` with no `ToolExecutionContext`
parameter. It is assignable to `ToolExecutor` (which takes `ctx`) because the executor
never reads identity: a proposal carries no organization, user or database id, and
compilation never touches the database. A `ctx` parameter would be a lie — it would
imply the tool depends on trusted identity it does not use.

---

## 3. API

Module: `src/lib/ai/agent/tools/generate-workflow/`.

```ts
export const generateWorkflowSchema = WorkflowProposalSchema;           // schema.ts
export const generateWorkflowTool;                                       // tool.ts
export type GenerateWorkflowSuccess  = { ok: true;  proposal: GeneratedProposal };
export type GenerateWorkflowFailure  = { ok: false; code: "INVALID_INPUT"; error: string; issues: ToolValidationIssue[] };
export type GenerateWorkflowOutput   = GenerateWorkflowSuccess | GenerateWorkflowFailure;
export function executeGenerateWorkflow(input: Prisma.JsonValue): Promise<ToolResultPart["output"]>;
export function describeGenerateWorkflowProposal(input: unknown): ToolProposalSummary | null;
```

- `schema.ts` re-exports the 37.2 `WorkflowProposalSchema` by **reference**, not a
  copy: the schema the model is told is well-formed and the schema the compiler
  validates are the same object, so they cannot drift (a test asserts the identity).
- `GeneratedProposal`/`GeneratedProposalStep` are structurally the 37.2 shapes with
  `inputs` bounded to `JsonValue` so the serialisable bound is explicit to the type
  system. Compilation has already proven serialisability, so nothing is lost.
- The success arm returns only the proposal. The compiler's candidate
  `WorkflowDefinition` is **never** returned: it is backend-owned (identity is
  assigned at materialization) and a model must not mistake a candidate for a
  persisted workflow.

### Failure envelope

`{ ok: false, code: "INVALID_INPUT", error, issues }` — the same envelope every other
tool uses, produced by the shared `buildStructuredValidationFailure` in
`src/lib/ai/agent/tools/shared-output.ts` (new, additive; the existing
`buildValidationFailure` is refactored to share the same tail). One prompt rule
therefore covers self-correction regardless of which tool failed. Each
`ToolValidationIssue` is `{ path, code, message }`, copied one-for-one from the
compiler's `ProposalIssue`.

---

## 3.1 Schema rejection vs compiler rejection

Two distinct failure paths, deliberately kept distinct (asserted in the tests):

- **Structural** violations the schema encodes (missing `name`, malformed step key,
  empty `steps`, oversize payload) are rejected by `inputSchema` **before** the
  executor runs. The provider/worker surfaces these through the existing schema
  path.
- **Semantic** violations the schema does not encode (unknown action, dangling or
  self dependency, cycle, invalid `{{…}}` reference, missing required input) reach
  the executor and are returned as `INVALID_INPUT` issues with exact `path`/`code`/
  `message`.

Unexpected programming errors (e.g. a `null` payload, which the object schema cannot
produce) are **thrown**, never coerced into `INVALID_INPUT`.

---

## 4. Determinism and security boundary

- No clock, randomness, database, queue, model call, action executor or runtime
  execution. The same input always yields the same output.
- No trusted identity is taken or used, and no workflow-domain write is reachable:
  there is no import path from this module to an action executor, the workflow
  trigger, the queue publisher, or a Prisma workflow model.
- Normal agent infrastructure is unchanged and expected (a `ToolExecution` row, the
  durable tool result, agent events, queue dispatch, worker lifecycle). Only
  workflow-domain effects are prohibited, and none is reachable.
- `ProposalIssue.path` is a fixed dotted string; graph arrays never cross the
  boundary. No `@ts-ignore` / `@ts-expect-error`, no unchecked `as` casts, no
  suppressions.

### 4.1 Files changed

- `src/lib/ai/agent/tools/generate-workflow/{schema,tool,execute,describe,types,index}.ts` — **new**.
- `src/lib/ai/agent/tools/registry.ts` — one `generateWorkflow` entry + imports.
- `src/lib/ai/agent/tools/shared-output.ts` — `buildStructuredValidationFailure`
  added; `buildValidationFailure` refactored to share `failureFromIssues` (output
  unchanged; existing tests untouched and green).
- `src/tests/agent/generate-workflow.test.ts` — **new**, 24 cases (35 now).
- `src/tests/agent/generate-workflow.live.test.ts` — live-model clause test
  (untracked working tree; 2026-10-23 harness mocks added).
- Documentation: this record; `assignments-37-tracker.md`;
  `assignments-37-issue-register.md` (sequence line).

`src/lib/workflow-types/workflow-proposal.ts`, `workflow-proposal-compiler.ts`, the
execution runtime, the canvas resolver and the save actions are **unmodified**.

---

## 5. AD-17 — access classification is `READ_ONLY`

`WRITE` was the tracker's "likely candidate". It is wrong here, and the reason is the
point of the phase:

- `WRITE` gates an approval **before** the executor runs. `generateWorkflow` writes
  nothing, so a pre-execution confirmation would suppress the compilation and the
  structured `INVALID_INPUT` feedback the model needs to self-correct — the tool's
  entire output would be withheld behind a prompt that asks the user to approve an
  artifact they have not seen.
- The human approval boundary for a generated workflow belongs downstream, where a
  proposal is persisted and materialized (37.8/37.9), not at proposal time.
- Consequently the proposal describer is **presentation only** and is not on the
  confirmation path today (`requiresConfirmation(READ_ONLY)` is false). It exists
  because every registered tool exposes the same optional contract through
  `describeToolProposal`; that generic resolver is its only current caller.

---

## 6. Deferred prompt change (37.13)

The current system prompt still enumerates "exactly three tools". Registering a
fourth makes that sentence stale. The change is **not** made here: the tracker marks
"no prompt changes (37.13)" as 37.5 out-of-scope, and Phase 37.13 owns the system
prompt text and the version constant. The tool is nevertheless present in
`agentTools`, so the model can call it; only the human-readable enumeration lags.

---

## 7. Known limitations and deferred decisions

1. **`VERIFIED` (2026-10-23).** The 37.2 real-model-path clause is discharged for
   the mocked/scripted path and on a live Gemini turn (§8.2, §10). The live check
   proves the model's emitted proposal needs no compiler fix-up; it does not claim
   a live database, transport or capstone.
2. **Describer is unused.** `READ_ONLY` never enters the confirmation path; see §5.
3. **`TYPE_MISMATCH`** remains unimplemented, inherited from 37.3/37.4. Not part of
   this phase's gate.
4. **Prompt enumeration** is stale by design; see §6.

---

## 8. Test coverage and verification evidence

`src/tests/agent/generate-workflow.test.ts` — 35 focused tests (the original record counted 24) across six groups:

- **Registration / policy.** Present in `agentTools`; `agentTools` and
  `resolveToolPolicy` exercised; `requiresToolConfirmation("generateWorkflow")` is
  false; an unregistered name fails closed; the schema is the same object as the
  37.2 `WorkflowProposalSchema`; trusted-identity rejection.
- **Success path.** A valid proposal is preserved whole (name, description, step
  keys, actions, inputs, dependencies); an absent description is omitted; the
  candidate `WorkflowDefinition` is never present in the output; nothing is
  persisted.
- **Failure path.** Compiler issues map exactly with `path`/`code`/`message`
  (`UNKNOWN_ACTION`, `UNKNOWN_DEPENDENCY`, `CYCLE`, `UNKNOWN_REFERENCE_SOURCE`,
  `MISSING_REQUIRED_INPUT`); a schema-valid-but-semantically-invalid proposal is
  distinguished from a schema rejection; a `null` payload throws rather than being
  coerced to `INVALID_INPUT`.
- **Side effects.** Spies on `createTaskAction.execute`, `startWorkflow`,
  `publishEvent` and `prisma.task.*` are never called by a valid run.
- **Describer.** Renders name/step-count/actions; returns null on unparseable input;
  is reachable through `describeToolProposal` with a generic fallback; the
  model-facing description states propose-only behaviour.
- **Durable tool-result path.** Through `handleToolExecution`, a failed proposal is
  persisted under the exact `toolCallId`, `AGENT_LOOP_REQUESTED` is recorded, and
  `completeToolExecution` is called — a failed proposal can be corrected on the next
  turn.

### 8.1 Evidence

```text
npx jest src/tests/agent/generate-workflow.test.ts              -> 1 suite / 35 tests PASS
npx jest src/tests/agent                                       -> 43 suites / 814 tests PASS
npx jest src/tests/workflow                                    -> 21 suites / 369 tests PASS
npx jest                                                       -> 78 suites / 1265 tests PASS
npx tsc --noEmit                                               -> exit 0
npm run lint                                                   -> exit 0 (0 errors, 31 pre-existing warnings)
git diff --check                                               -> exit 0 (CRLF advisories only)
git diff -- src/lib/workflow/execution/resolver.ts             -> empty
git diff -- src/lib/workflow-types/workflow.ts                 -> empty
```

Verification pass 2026-10-23:

```text
Live model:   npx jest --config jest.live.config.ts
                src/tests/agent/generate-workflow.live.test.ts --runInBand
              -> 1 suite / 1 test PASS (gemini-3.6-flash; 2 steps; task.create)
              -> input byte-identical through validate/compile/execute (no fix-up)
Harness fix:  added prisma/extended + prisma/db double mocks to the live test
              (registry imports projects.ts/Prisma); db guard retained; no
              production source changed
Evidence:     live-model parse path + unit/mocked integration. No live DB,
              QStash, Redis, Pusher, action execution or capstone claimed; 37.16
              owns that gate.
```

### 8.2 The 37.2 real-model-path clause

The clause asks for inspection confirming that a proposal produced by the **real
model path** parses without a compiler fix-up step. What is evidenced here: the tool
invokes `compileWorkflowProposal` once, directly, with no repair, retry, or
pre-normalisation between the model arguments and the compiler — the test asserts the
executor's first and only substantive call. This is proven on the **mocked/scripted**
model path. **Discharged live 2026-10-23:** the `generate-workflow.live.test.ts`
suite ran through the production `agentModel` (`gemini-3.6-flash`), the registered
system prompt, registered tool definition and registered executor. The model
emitted a two-step `task.create` proposal; `validateWorkflowProposal`,
`compileWorkflowProposal` and `executeGenerateWorkflow` all succeeded with the
input bytes unchanged through each stage and no field repaired or defaulted. The
suite mocks only the Prisma boundary required for import (and keeps the database
guard installed); it does not exercise a live database, transport, action or
workflow write. No overclaim is made that a live model always produces valid
proposals — the gate is satisfied for this real turn. 37.5 is `VERIFIED`.

---

## 9. Next phase

37.6 (missing-input state) builds on the failure envelope this tool returns, making
"the user never supplied this" a first-class durable outcome distinct from "the model
made a mistake".

---

## 10. Status history

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-12 | IMPLEMENTED | Module + registry entry + shared failure helper + describer; `READ_ONLY` (AD-17) | 24/24 focused; full 35/628; tsc exit 0; eslint 0; `git diff --check` clean; resolver/canvas/runtime diffs empty |
| 2026-10-23 | **VERIFIED** | Carried 37.2 real-model-path clause discharged live against `gemini-3.6-flash` through production model/prompt/registered tool/executor; input validated, compiled and executed unchanged (no fix-up). Focused, agent, workflow and full regressions green; harness fix test-only | Live 1/1; focused 35/35; agent 43/814; workflow 21/369; full 78/1265; `tsc` 0; `npm run lint` 0 errors; `git diff --check` clean |
