# Assignment 37 — Phase 0 Contract Reconnaissance

**Scope:** contract map only. No implementation, no schema changes, no new migrations,
no registry edits. Nothing in this document was acted on.

**Method:** read the current source. Every claim below is cited to `file:line`.
Where the code does not answer a question, the entry reads `UNKNOWN` rather than
guessing. Design forks are flagged for a later phase, not resolved here.

---

## 1. `WorkflowAction` / `ActionContext` types

**Observed** — `src/lib/workflow-types/type.ts`, 40 lines total:

```ts
export type ActionContext = {
  workflowId: string;                          // :3
  runId: string;                               // :4
  stepId: string;                              // :5
  inputs: Record<string, any>;                 // :9
};

export type ActionResult = {
  success: boolean;                            // :14
  data?: any;                                  // :17
  error?: string;                              // :20
  isRetriable?: boolean;                       // :23
};

export type ExecuteFunction    = (ctx: ActionContext) => Promise<ActionResult>;                        // :26
export type CompensateFunction = (ctx: ActionContext & { outputs: any }) => Promise<ActionResult>;    // :29-31

export interface WorkflowAction {
  id: string;                // :35
  execute: ExecuteFunction;  // :37
  compensate?: CompensateFunction;  // :38
}
```

The context is constructed by the wrapper, not the model —
`src/lib/workflow/execution/wrapper.ts:164-169` builds it from
`stepRun.run.workflowId`, the delivery's `runId`, and the step's `stepId`.
`inputs` arrives already resolved (§9).

**Inferred:** there is no place on `WorkflowAction` for a description, an input
schema, or an output schema. Those are the three things Phase 2 needs to expose to
the model, and none of them have a home in the current type.

---

## 2. Action registries — runtime vs UI

Two registries exist. They are separate files, separate types, and they disagree.

**Runtime** — `src/lib/workflow-types/action-registry.ts`:

```ts
export const ActionRegistry: Record<string, WorkflowAction> = {
  "task.create": createTaskAction,   // :12-16
};
export function getAction(actionId: string): WorkflowAction | undefined {  // :20
  return ActionRegistry[actionId];
}
```

`getAction` has exactly one call site in the codebase:
`src/lib/workflow/execution/wrapper.ts:153`.

**UI** — `src/lib/workflow-types/registry.ts`, whose first line is `// FOR UI`:

```ts
export type FieldDef = {                      // :4-10
  name: string; label: string;
  type: 'string' | 'select' | 'textarea' | 'number';
  options?: { label: string; value: string }[];
  required: boolean;
};
export type ActionDef = {                      // :19-26
  id: string; label: string; description: string;
  requires: string[]; outputs: string[]; fields: FieldDef[];
};
```

`AVAILABLE_ACTIONS` (`:52-86`) lists **two** entries: `task.create` and
`comment.add`. `AVAILABLE_TRIGGERS` (`:29-49`) lists `task.created`,
`project.created`, `user.joined`.

**Observed divergences:**

| | runtime registry | UI registry |
|---|---|---|
| `task.create` | present | present |
| `comment.add` | **absent** | present |
| `task.create` required inputs | `title`, `projectId` (`create-task.ts:27`) | `requires: ['projectId']` (`:57`) |
| `task.create` outputs | `{ taskId, title }` (`create-task.ts:70`) | `outputs: ['taskId']` (`:59`) |

A workflow can be saved from the canvas with `comment.add` as its action. It
will compile and validate, then fail at `wrapper.ts:154` with "Action not found
in registry" and a non-retriable `FAILED`.

**Decision required at 37.1:** whether action capability metadata is added to
`WorkflowAction` or held in a separate descriptor keyed by action id. Two
candidate sources exist today and they already contradict each other, so
"derive from the actual workflow action registry" is not a lookup — it is a
choice about which list becomes authoritative.

---

## 3. Registered action inventory

Exactly one action is registered: **`task.create`** →
`src/lib/workflow/actions/core/create-task.ts` (86 lines).

```ts
const { title, projectId, description, priority, assigneeId } = ctx.inputs;  // :25

if (!title || !projectId) {                                                  // :27
  return { success: false, error: "Missing required fields: title or projectId",
           isRetriable: false };
}

const workflow = await db.workflow.findUnique({                               // :36
  where: { id: ctx.workflowId }, select: { orgId: true },
});
if (!workflow) return { success: false, error: "Workflow not found", isRetriable: false };  // :41

const result = await createTaskInOrg(                                          // :54
  { title, projectId, description, priority, assigneeId },
  { orgId: workflow.orgId },
);

if (!result.success)                                                          // :59
  return { success: false, error: result.error, isRetriable: result.code === "CREATE_FAILED" };

return { success: true, data: { taskId: result.task.id, title: result.task.title } };  // :68-71
```

catch-all → `{ isRetriable: true }` (`:72-78`).
`compensate` is absent, commented `// For Phase 6` (`:85`).

**Trust model as implemented:** `orgId` is read from the persisted `Workflow` row
and never from `ctx.inputs` (`:8-11`, `:36`). `projectId` is treated as
untrusted and re-verified inside the org by `createTaskInOrg`. The write goes
through the canonical operation, so the extended Prisma client and the
`TASK_CREATED` CDC fire exactly as they do for UI and agent paths.

**Unregistered implementations present on disk** — implemented, reachable by
import, absent from `ActionRegistry`:

| file | id | compensate | result shape |
|---|---|---|---|
| `actions/core/send-email.ts:39-40` | `communication.send_email` | none | `data: { id, deliveredTo }` (via `emails/core-service.ts:37`) |
| `actions/core/generate-report.ts:99-100` | `utils.generate_report` | **yes** (deletes the upload) | `ActionResult` |
| `actions/logic/conditions.ts:3` | none — exports `executeConditionNode(inputs)` | n/a | returns `{ outputs }`, **not** `ActionResult` |

`executeConditionNode` is not a `WorkflowAction` and its return shape is
incompatible with the wrapper's `result.success` / `result.data` reads
(`wrapper.ts:192`, `:199`). Registering it unchanged would be a type error at
minimum.

**Inferred:** the effective action surface available to the model today is one
action with two required inputs. Phase 2 is almost entirely about establishing
the *shape* of the capability descriptor, not about populating it.

---

## 4. Input / result conventions

**Observed.** `ActionResult` (§1) is the only result shape. On success
(`wrapper.ts:197-204`) the same `result.data || {}` is written twice — once into
global context, once onto `StepRun.outputs`.

Context shape, from `src/lib/workflow/execution/state.ts:57-62`:

```ts
const nextContext = { ...currentContext, [stepId]: { outputs: outputData } };
```

So step outputs are namespaced `<stepId>.outputs`. The trigger namespace
`trigger.outputs` is primed by `startWorkflow` (`execution/trigger.ts:20-24`).

**Retry semantics.** `wrapper.ts:253`:
`shouldRetry = isRetriable && newAttempts < MAX_RETRIES`, with
`MAX_RETRIES = 3` (`wrapper.ts:22`). An uncaught throw is hardcoded
retriable (`wrapper.ts:236`). Attempt counters are per-operation:
`attempts` for forward, `compensationAttempts` for reverse (`wrapper.ts:271`).

**There is no runtime input schema.** `workflow/route.ts:175-177` takes
`nodeDefinition.config || {}` and passes it straight to `resolveInputs`. The step
schema types config as `z.record(z.string(), z.any())` (`workflow-types/workflow.ts:26`).
Validation of inputs is entirely per-action, ad hoc, and returns
`ActionResult` with `success: false` — not a validation structure the model can
read.

**Inferred:** Phase 4's "action contract validation" and the existing per-action
input checks are two different mechanisms. The former produces machine-readable
issues; the latter produces a failure string. They are not interchangeable.

---

## 5. Compensation capability

**Observed.** `CompensateFunction` receives `outputs` in addition to the normal
context (`type.ts:29-31`). The wrapper's reverse path
(`wrapper.ts:172-187`):

- no `compensate` defined → result is **synthesized** as
  `{ success: true, data: { status: "no_compensation_required" } }` (`:174-176`)
- otherwise `ctx` is rebuilt from the database: `inputs: stepRun.inputs`,
  `outputs: stepRun.outputs` (`:178-185`) — never from the in-memory delivery

Statuses: `COMPENSATING`, `COMPENSATED`, `COMPENSATION_FAILED`
(`prisma/schema.prisma`, `StepExecutionStatus`). A `COMPENSATION_FAILED` at
convergence sets the run to `REQUIRES_INTERVENTION` (`evaluator.ts:316-326`).

**Observed:** the only registered action defines no `compensate`. Rollback of any
currently-persisted workflow is therefore a sequence of no-ops that terminates
cleanly at `ROLLED_BACK`.

---

## 6. `WorkflowStepSchema`

`src/lib/workflow-types/workflow.ts:12-27`:

| field | type | default |
|---|---|---|
| `id` | `z.string()` | required |
| `action` | `z.string()` | required |
| `dependsOn` | `z.array(z.string())` | required |
| `routingConditions` | `z.record(z.string(), z.string())` | optional |
| `isCritical` | `z.boolean()` | `false` (`:18`) |
| `kind` | `z.enum(["TRIGGER","ACTION"])` | required (`:20-23`) |
| `config` | `z.record(z.string(), z.any())` | `{}` (`:26`) |

**Criticality, as actually read at runtime.** `evaluator.ts:188-191`:

```ts
const hasCriticalFailure = existingStepRuns.some(
  (stepRun) => stepRun.status === "FAILED" && steps[stepRun.stepId]?.isCritical,
);
```

`isCritical` gates **rollback only**. It does not gate the run's final status:
`evaluator.ts:489-501` marks the run `FAILED` if *any* step failed, regardless of
criticality, and `COMPLETED` only if none did.

**Trigger steps** are auto-completed by the wrapper and write no context
(`wrapper.ts:71-97`), so the only trigger-sourced data is whatever the caller of
`startWorkflow` supplied as `triggerData`.

---

## 7. `WorkflowDefinitionSchema`

`src/lib/workflow-types/workflow.ts:237-251`:

```ts
export const WorkflowDefinitionSchema = z.object({
  id: z.string(),                              // :239
  name: z.string(),                            // :240
  steps: z.record(z.string(), WorkflowStepSchema),  // :241
}).superRefine((definition, ctx) => {
  for (const issue of collectWorkflowDefinitionIssues(definition)) { /* :244-249 */ }
});
```

**No `version` field.** The top level is exactly `{ id, name, steps }`. There is
no description, no metadata block, and no discriminator. `description` lives on
the `Workflow` row, not in the definition.

**Semantic validation** — `collectWorkflowDefinitionIssues` (`:125-211`) produces
issues of type `WorkflowDefinitionIssue` (`:55-61`), codes enumerated at `:46-53`:

| code | check |
|---|---|
| `EMPTY_GRAPH` | zero steps (`:132-138`) |
| `ID_MISMATCH` | record key ≠ `step.id` (`:149-155`) |
| `DUPLICATE_STEP_ID` | same inner `id` under two keys (`:157-166`) |
| `SELF_DEPENDENCY` | `dependsOn` contains own key (`:169-176`) |
| `UNKNOWN_DEPENDENCY` | `dependsOn` names a step not in the record (`:178-184`) |
| `UNKNOWN_ROUTING_CONDITION` | `routingConditions` on a non-dependency (`:190-198`) |
| `CYCLE` | iterative DFS, full closing `path` (`:73-123`, `:201-208`) |

`WorkflowValidationError` (`:221-235`) is a distinct class so a bad graph is not
reported as a server fault.

**Observed:** `WorkflowDefinitionSchema` is **never called in production**.
Repository-wide, the symbol appears only at its definition (`workflow.ts:237`),
its inferred type (`:254`), and in `src/tests/workflow/dag-validation.test.ts`.
Production writes go through `compileWorkflow`, which calls
`collectWorkflowDefinitionIssues` directly (`compiler.ts:66-69`). The
`superRefine` is therefore a second, unwired entry point to the same logic.

**Inferred:** the file's comment at `:42-44` states the checks "are part of the
schema, not a separate opt-in call, so that a definition cannot be written to the
database without them." That guarantee currently rests on the compiler call, not
on the schema. The `definition` JSONB column has no read-time parse.

---

## 8. Compiler / materializer

`src/lib/workflow/graph-ui/compiler.ts`, 72 lines, the only materializer.

```ts
export function compileWorkflow(nodes: AppNode[], edges: AppEdge[]): WorkflowDefinition {
  const dependsOn = [...new Set(
    edges.filter(e => e.target === node.id).map(e => e.source))];   // :32-34

  if (node.type === "trigger") {
    action = node.data.eventId || "unknown_trigger"; kind = "TRIGGER";       // :41-43
  } else if (node.type === "action") {
    action = node.data.actionType || "unknown_action";
    config = node.data.config || {};
    isCritical = node.data.isCritical || false;                             // :44-48
  }

  steps[node.id] = { id: node.id, action, dependsOn, config, isCritical, kind };  // :50-57

  const definition = {
    id: `compiled_${Date.now()}`,                 // :61
    name: "Compiled Execution Graph",             // :62
    steps,
  };
  const issues = collectWorkflowDefinitionIssues(definition);
  if (issues.length > 0) throw new WorkflowValidationError(issues);   // :66-69
  return definition;
}
```

**Observed properties that matter for 37:**

1. **Direction is canvas → definition only.** A repository search for a reverse
   projection (`definitionToNodes`, `toUiNodes`, `buildUiGraph`, etc.) returns no
   matches. No code turns a `WorkflowDefinition` into `uiNodes`/`uiEdges`.
2. **`definition.id` and `definition.name` are placeholders**, regenerated on
   every save. `compiled_${Date.now()}` is also not unique — two saves in the same
   millisecond produce the same value. It is not a foreign key, so nothing
   breaks, but it cannot serve as a stable provenance key.
3. **A compile failure is flattened to prose.** `describeCompileFailure`
   (`app/actions/workflows/workflow.ts:22-28`) joins `issue.message` into one
   string, and the action returns `{ success: false, error }`. The issue `code` and
   `path` are discarded at the boundary, so a caller cannot branch on them.
4. **Trigger steps carry the event id in the `action` field**
   (`:42`), not in a separate field. The evaluator passes `kind` through to the
   wrapper, which short-circuits on `TRIGGER` before any registry lookup
   (`wrapper.ts:71-97`).

---

## 9. Pointer resolver

`src/lib/workflow/execution/resolver.ts`, 77 lines. Grammar is
`{{path}}` with path characters restricted to `[\w.-]` (`:51`).

| case | line | behaviour on missing path |
|---|---|---|
| whole string is one reference | `:54-58` | returns the **literal `{{...}}` text** |
| reference inside a larger string | `:62-73` | substitutes `""` |
| embedded object/array | `:70-72` | `JSON.stringify(...)` |
| nested objects / arrays | `:38-48` | recursed |

`getValueByPath` (`:7-14`) walks any dot path in the context blob.

**Observed:** the resolver performs **no** preflight validation. There is no
check that the referenced step exists, that the path exists in an output
contract, or that the referencing step actually depends on the referenced step.
`:66` carries the comment `// Or throw an error if you want strict failure on
missing variables` — strict failure is explicitly not implemented.

**Inferred, and load-bearing for Phase 3:** both missing-reference paths fail
*silently and successfully*. A typo'd reference in a whole-string position
propagates the literal `{{A.outputs.tsakId}}` into an action; in an interpolated
position it becomes an empty string. Neither raises, neither is retried, and
neither appears in `ExecutionAuditLog`. This is the strongest argument for
deterministic reference validation at generation time, and it is the check the
current engine does not have.

**Observed, severity unassessed:** `\w` permits `__proto__` as a path segment, and
`getValueByPath` traverses into any object it is handed. I did not build an
exploit and am not rating this; it is recorded because the path grammar is in
scope for 37.3.

**Dependency cross-check:** `collectWorkflowDefinitionIssues` validates
`routingConditions` against `dependsOn` (`workflow.ts:190-198`) but never
inspects `config` / inputs for references. The assignment's
`MISSING_DATA_DEPENDENCY` case — data dependency and execution dependency
disagreeing — is therefore genuinely new, and nothing in the current engine
rejects it.

---

## 10. Workflow persistence

**Models** — `prisma/schema.prisma`:

`Workflow` (`:432`): `id` cuid, `name`, `description?`, `isActive` default
`false`, `uiNodes` Json default `"[]"`, `uiEdges` Json default `"[]"`,
`definition` Json default `"{}"`, `orgId` → `Organization` cascade, `eventId?`,
`runs`, timestamps; indexes `[orgId]`, `[eventId]`. The `event` relation is
commented out (`:445`).

`WorkflowRun`: `status` default `PENDING`, `context` Json, `contextVersion` Int
default `0` (optimistic-concurrency token for parallel branch writes),
`lastAdvancedAt?`, `startedAt` default now, `completedAt?`; indexes
`[workflowId]`, `[status]`.

`StepRun`: `stepId` (canvas node id), `status` default `PENDING`, `attempts`,
`compensationAttempts`, `inputs` Json?, `outputs` Json?, `error` Text?,
`startedAt?`, `completedAt?`; **`@@unique([runId, stepId])`**.

`ExecutionAuditLog`: `runId`, `stepId`, `logLevel`, `eventType`, `message` Text,
`payload` Json?, `latencyMs?`, `createdAt`; four indexes.

`WorkflowExecutionStatus`: `PENDING, RUNNING, COMPLETED, FAILED, ROLLING_BACK,
ROLLED_BACK, REQUIRES_INTERVENTION`.
`StepExecutionStatus`: `PENDING, RUNNING, SUCCESS, FAILED, CANCELLED, RETRYING,
SKIPPED, COMPENSATING, COMPENSATED, COMPENSATION_FAILED`.

**Write path is canvas-first.** `src/app/actions/workflows/workflow.ts`:

- `saveWorkflowState(orgslug, name, uiNodes, uiEdges)` (`:43`)
- `updateWorkflowState(orgslug, workflowId, uiNodes, uiEdges)` (`:95`)

Both authenticate via `getOrgAccess(orgslug)`, validate nodes, call
`compileWorkflow(uiNodes, uiEdges)`, and persist `uiNodes`, `uiEdges` **and** the
compiled `definition` together. Both derive `eventId` from the trigger node
(`:62-63`, `:111-112`) and set `isActive: !!eventId`.

**There is no definition-first write path.** Materializing a generated proposal
through the existing action requires supplying React Flow nodes with
`position: {x, y}` — `IncomingNodeSchema` (`:30-38`) makes position mandatory.

**Observed validation weakness:** `IncomingNodeSchema` types `data` as
`.optional().or(z.any())` (`:37`), so the discriminated union of
`TriggerNodeDataSchema` / `ActionNodeDataSchema` is effectively bypassed — any
object satisfies `z.any()`. `updateWorkflowState` validates `z.array(z.any())`
(`:105`), i.e. nothing at all.

**`isActive` is cosmetic.** Written as `!!eventId` but read only at
`src/app/org/[orgId]/workflows/page.tsx:54` to pick a Draft/Active badge. Neither
`startWorkflow` nor the evaluator consults it.

**`startWorkflow`** (`src/lib/workflow/execution/trigger.ts:7`) takes a bare
`workflowId` plus optional `triggerData`, performs no ownership or `isActive`
check, creates the run, and calls `advanceWorkflow`.

**No event bridge.** Nothing wires `Workflow.eventId` to `startWorkflow`. Workflows
currently begin via the manual server action or the test route.

---

## 11. Confirmation machinery and agent tools

**Tool registry** — `src/lib/ai/agent/tools/registry.ts`. One object binds four
things per tool so they cannot drift: the AI SDK `tool`, the server `executor`,
the trusted `policy`, and an optional `describeProposal` (`:60-92`).

| tool | policy | confirm |
|---|---|---|
| `createTask` | `WRITE_POLICY` | yes |
| `listTasks` | `READ_ONLY_POLICY` | no |
| `updateTask` | `WRITE_POLICY` | yes |

`agentTools` is derived from the registry rather than re-declared (`:103-105`).
`requiresToolConfirmation` fails closed: an unregistered tool returns `true`
(`:145-149`).

**Policy** — `src/lib/ai/agent/tools/policy.ts`. `AgentToolPolicy` is a single
frozen `readonly access` field (`:31-33`); `requiresConfirmation` is *derived*
(`access !== "READ_ONLY"`, `:52-56`) so an inconsistent
`DESTRUCTIVE + requiresConfirmation: false` pair is unrepresentable. Policy is
resolved from the tool **name**, server-side, and there is no path by which tool
input can relax it.

**`AgentToolExecution` columns** — `prisma/schema.prisma`:

`id`, `sessionId`, `toolCallId` `@unique`, `toolName`, `input` Json, `error`
Text?, `status`, `confirmedAt?`, `cancelledAt?`, `expiresAt?`, `expiredAt?`,
timestamps. Indexes: `[sessionId, createdAt]`, `[sessionId, status]`,
`[status, expiresAt]`.

**There is no `result` column.** Completed tool output is written into
`AgentMessage` rows, not onto the execution. The durable per-execution record is
`input` (what was proposed), `error`, and `status`.

`AgentToolExecutionStatus`: `PENDING, RUNNING, COMPLETED, FAILED,
PENDING_CONFIRMATION, CANCELLED, EXPIRED`. There is no `VALIDATING`,
`NEEDS_INPUT`, or `AWAITING_CRITICALITY`.

**Confirm path** — `app/api/agent/session/[sessionId]/executions/[executionId]/confirm/route.ts`.
Takes **no request body** by design (`:5-8`): the executed arguments are whatever
is already persisted on the row, so the endpoint cannot substitute, augment, or
regenerate what the user was shown. `loadConfirmationTarget` + `decideConfirmation`
gate it; `confirmToolExecution` commits the transition and the dispatch intent
together (`:93-96`); a repeat confirm returns 200 without re-dispatching
(`:80-91`).

**Recovery** — `app/api/agent/session/[sessionId]/route.ts` re-derives the
proposal from persisted `execution.input` via `describeToolProposal`, and attaches
it **only** while status is `PENDING_CONFIRMATION` (`:95-99`).

**Observed gap — `WAITING_CONFIRMATION` is never written.** The value exists on
`AgentSessionStatus` and is read in exactly two places,
`session-service.ts:201` and `:249`. Nothing assigns it. Consequently:

- a session awaiting approval remains `RUNNING`;
- `cancelAgentSession` (`:239-255`) filters on a status no session can occupy;
- `failAgentSession` tolerates a state that cannot occur.

The actual gate is `AgentToolExecution.status = PENDING_CONFIRMATION`, not the
session status. A durable "waiting on a human" pause has no wired write path
today.

**The three loops.** The existing machinery supports two of the three the
assignment distinguishes: self-correction (structured validation observation
re-dispatches the loop) and human approval (35/36 confirmation). Human
clarification has no durable representation.

---

## 12. Prompt versioning and proposal fields

- `AGENT_PROMPT_VERSION` in `src/lib/ai/agent/constants.ts`; `startAgentSession`
  writes it explicitly, and `AgentSession.promptVersion` defaults to the legacy
  `"v1"` so pre-existing sessions are backfilled truthfully.
- `MAX_AGENT_STEPS = 5` (`src/lib/ai/agent/loop-policy.ts`); the loop also
  enforces one tool call per model turn.
- Tool outputs use `ToolResultPart["output"]`. Validation failures are built by
  `buildValidationFailure` as machine-readable `{ path, code, message }`.
- Model input schemas are strict Zod objects with per-field `.describe()` — e.g.
  `tools/update-task/index.ts:23-62` (`.strict()` plus a `.refine` requiring at
  least one mutable field). This is the existing convention for model-facing
  input contracts.
- `src/lib/ai/agent/model.ts` binds a single validated provider singleton
  (`gemini-2.5-flash`); there is deliberately no second credential path.
- Structural tool feedback already re-enters the loop via
  `AGENT_LOOP_REQUESTED` in the outbox.

**Proposal fields available today, exhaustively:** `AgentToolExecution.input`
(Json, model-authored, persisted verbatim), `error` (Text), `status` (enum),
`toolName`, `toolCallId`, `confirmedAt`, `cancelledAt`, `expiresAt`, `expiredAt`.
There is no field for a validation state, a missing-input state, a compiled
definition, or a result.

---

## Phase 0 gate

> **"What does the agent need to know about an action to generate a valid step?"**

**Answer: an action id string, and nothing else.**

`WorkflowAction` (§1) is `{ id, execute, compensate? }`. There is no description,
no declared input contract, no declared output contract, and no way to ask
whether a given output is referenceable. `WorkflowStep.action` is typed
`z.string()` (`workflow.ts:14`) — an unconstrained string that reaches
`getAction` unvalidated and fails at execution time (§2), not generation time.

The information the model would need does exist, but in the UI-only `ActionDef`
(§2), which is hand-maintained, disagrees with the runtime registry, and is not
imported by any engine or agent code path.

---

## Findings that affect the Assignment 37 plan

Recorded, not resolved. Each names the phase where it must be settled.

**F1 — Persistence is canvas-first, so the plan's phase order is inverted.**
§10. Both save actions take `uiNodes`/`uiEdges`; no definition-first write path
exists, and `IncomingNodeSchema` makes `position` mandatory. 37.10 (materialize)
therefore cannot precede 37.11 (UI projection) without either synthesizing layout
before saving or adding a second write path.
**Decide at:** 37.10 / 37.11.

**F2 — `definition.id` and `definition.name` are regenerated placeholders.**
§8, `compiler.ts:61-62`. A proposal's real name belongs in `Workflow.name`;
`definition.id` changes on every save and cannot anchor provenance. The plan's
"provenance can be attached if the `definition` JSON contract allows it" has no
stable key to attach to today.
**Decide at:** 37.10.

**F3 — No single source of truth for action capability metadata.**
§2, §3. The runtime registry holds one action and no metadata; the UI list holds
two actions and metadata that already contradict it. Phase 2's "derive from the
actual workflow action registry" is a decision about which list wins.
**Decide at:** 37.1.

**F4 — `AgentToolExecution` cannot represent the states Phases 5, 6, 8 and 9 need.**
§11. No `result` column; no `VALIDATING` / `NEEDS_INPUT` /
`AWAITING_CRITICALITY` status. Phases 5 and 6 require durable state that exists
*before* confirmation, and the only wired gate is `PENDING_CONFIRMATION`. The
plan's instruction not to create a migration preemptively is correct; the fork
still has to be taken at 37.6/37.7.
**Decide at:** 37.6 / 37.7.

**F5 — `WorkflowDefinitionSchema` is dead in production.**
§7. The `superRefine` is an unwired second entry point to logic the compiler
already calls. `definition` JSONB has no read-time parse. Relevant to any plan
step that treats the schema as the canonical gate.
**Decide at:** 37.4.

**F6 — Reference resolution fails silently, and dependency is never cross-checked.**
§9. Missing references substitute `""` or propagate the literal `{{...}}` with no
error, audit entry, or retry. `collectWorkflowDefinitionIssues` checks
`routingConditions` against `dependsOn` but never inspects inputs. The
`MISSING_DATA_DEPENDENCY` rejection in the plan is the one genuinely new
validation in the whole sequence, and the engine has no substitute for it today.
**Decide at:** 37.3.

### Items that need no decision

- **Reference grammar is reusable as-is.** `{{path}}` with `<stepId>.outputs.*`
  and `trigger.outputs.*` namespaces (§9) is already the shape the plan
  specifies. No second syntax is required.
- **Criticality is already a persisted step field** and already gates rollback
  (`evaluator.ts:188-191`). It does not gate final run status — that is
  `FAILED` whenever any step failed (`evaluator.ts:489-501`).
- **Confirmation already binds the exact persisted proposal** and takes no body
  (§11), so the plan's Phase 9 requirement is already met by the 35/36
  machinery.
- **Output propagation is already safe under parallelism** via
  `appendStepOutputToContext`'s `contextVersion` CAS (`state.ts:38-88`).
- **Retry, rollback, and recovery already exist** and need no second controller
  (evaluator `MAX_EVALUATION_PASSES` bounded loop, lock heartbeat, durable
  re-entry on contention, stale-run maintenance).

---

## Pre-existing issues found during reconnaissance

Not part of Assignment 37. Recorded so they are not lost; **no fix is proposed
here.**

**I1 — Cross-tenant workflow write.** `src/app/actions/workflows/workflow.ts:115`:

```ts
await db.workflow.update({ where: { id: workflowId }, data: { ... } });
```

`getOrgAccess(orgslug)` proves membership in `orgslug` but the update predicate
contains no `orgId`. Any authenticated member of any organization can overwrite
any workflow by id. The create path does not have this problem —
`db.workflow.create` is given the accessor's own `orgId` (`:57`, `:66`).

**I2 — Node validation is bypassed on write.** `IncomingNodeSchema.data` is
`.optional().or(z.any())` (`workflow.ts:37`), defeating the discriminated union;
`updateWorkflowState` validates `z.array(z.any())` (`:105`), validating nothing.

**I3 — `WAITING_CONFIRMATION` is unreachable.** §11.

**I4 — A saved workflow can reference an unregistered action.** §2. `comment.add`
is offered in the UI and absent from the runtime registry; such a workflow
compiles, saves, and fails at execution.

**I5 — Workflow maintenance has a handler but no schedule.**
`src/app/api/worker/workflow-maintenance/wm.ts` exists;
`scripts/qstash-maintenance-schedule.mjs` registers `AGENT_MAINTENANCE_REQUESTED`
only. `UNKNOWN` whether workflow maintenance is scheduled by other means.

---

## PHASE 0 STATUS

```
COMPLETE WITH BLOCKING PREREQUISITE
```

Reconnaissance is complete; the contract map above is the deliverable and no
implementation was performed. No source file was modified, no schema was added,
no migration was created.

Gate answer: **the agent currently has no machine-readable action contract to
generate a valid step from** (F3). Reference grammar, criticality, confirmation
binding, and output propagation are all reusable without change (see *Items that
need no decision*).

**Blocking prerequisite, tracked separately from Assignment 37:** I1, the
cross-tenant workflow write in `updateWorkflowState`. It is a pre-existing
vulnerability that Phase 0 did not introduce, and it is classified as blocking
because 37.5 makes the agent a workflow writer — a machine-driven writer turns a
tenant-isolation bug into an agent-reachable one. This should be closed before
37.5. I2, I3, I4 and I5 are recorded and are not gating.

## NEXT PHASE

```
37.1  Action capability registry
```

As designated in the implementation sequence, 37.0–37.3 proceed together:
establish where action capability metadata lives (F3), define
`WorkflowProposal`, and build the reference model against the existing resolver
grammar (F6). F1, F2, F4 and F5 are recorded above and are not resolved here.
