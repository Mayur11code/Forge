# Change guide — lint and type pass, 2026-10-01

Every file this pass touched, and why. Written to be read in one sitting, in
plain language, without knowing the codebase in advance.

Start here if you want the short version:

- **5 of these changes fix bugs that were live.** They are listed under
  [Bugs that were hiding](#1-bugs-that-were-hiding). Read that section first;
  the rest is hygiene.
- **The rest are type-system changes.** They move a guarantee from a comment into
  the compiler. No behavior change intended in any of them.

One thing to be clear about at the top: this started as a lint cleanup and ended
up changing how workflows execute. That was not the plan. The plan was to remove
`any` without changing behavior. When a type error is in the path of a value that
gets compared, persisted, or branched on, removing it forces a decision about
what the code actually does — and several of those decisions were wrong already.

---

## Contents

1. [Bugs that were hiding](#1-bugs-that-were-hiding)
2. [The three contracts](#2-the-three-contracts)
3. [The DAG engine, file by file](#3-the-dag-engine-file-by-file)
4. [Actions](#4-actions)
5. [Events and workers](#5-events-and-workers)
6. [Server boundaries](#6-server-boundaries)
7. [The React UI](#7-the-react-ui)
8. [Tests](#8-tests)
9. [CI](#9-ci)
10. [Files touched but not described](#10-files-touched-but-not-described)

---

## 1. Bugs that were hiding

### 1.1 Conditional routing never took the TRUE branch

**File:** `src/lib/workflow/actions/logic/conditions.ts`

**What was wrong.** When you draw a condition node in the editor, the canvas
draws two outgoing edges, one labelled TRUE and one labelled FALSE. The engine
walks those edges to decide what runs next.

The condition action returns its verdict, and the evaluator reads that verdict to
pick the edge. The action was returning it under the key `outputs`. The evaluator
was reading it from `data`.

So the evaluator read a property that did not exist. It got `undefined`.
`undefined === "TRUE"` is `false`. Every single conditional workflow took the
FALSE edge, every time, regardless of the comparison.

**Why nobody caught it.** The tests and the code agreed on the same wrong shape.
A test that asserts "branch is FALSE" passes when the answer is always FALSE.
Both sides were consistent, so nothing was red.

**What changed.** The action returns `data`, which is what the wrapper actually
writes into `StepRun.outputs`. Fixed the side that had the typo, not both.

**Behavior change:** yes. Conditions now work. If you had workflows relying on
them always going FALSE — which is unlikely to be intentional — those change.

### 1.2 The AI token budget counted almost nothing

**File:** `src/lib/ai/token-manager.ts`

**What was wrong.** There is a budget that decides how much chat history to send
to Gemini. It measured the size of a message like this:

```ts
JSON.stringify(msg.content).length / 4
```

The AI SDK v5 does not put a string in `content`. It puts an **array of typed
parts**. So `msg.content` was `[{type:"text", text:"..."}]`, and
`JSON.stringify` of that measures the *wrapper* — about 40 characters of
`{"type":"text","text":""}` — plus the text. The estimate was not zero, but the
per-message overhead the formula assumes was nowhere in the number. The budget
could not trip on real conversations.

**The second bug.** When the budget *did* trip, it truncated with a negative
slice. In JavaScript, `slice(-100)` does not mean "the last 100 characters." It
means "stop 100 characters from the end," which removes characters from the
**front**. So the truncation removed the system prompt first — the one message a
tool call needs to survive — and left the recent conversation intact.

**What changed.** A helper flattens `content` to the text that will actually be
sent: strings pass through, arrays are joined from their text parts. Truncation
uses `Math.max(0, …)` so the slice end is never negative. Tool messages are
left as arrays rather than being rewritten to a string, because the AI SDK
rejects a string where a tool result belongs.

**Behavior change:** yes. The budget now counts what it claims to count, which
means it will start trimming conversations that were previously never trimmed.

### 1.3 The rate limiter blocked the first submit after each window

**File:** `src/features/organizations/components/CreateTaskForm.tsx`

**What was wrong.** A client-side rate limit: 5 submits per 10 seconds. When the
window expired, the code did this:

```ts
setLocalCount(0);        // queue the reset
if (localCount >= LIMIT) // ...but read the OLD value
```

`localCount` in the second line is the value captured when the handler was
created, not the one that was just queued. So the reset never took effect for
the current click. A user who hit the limit stayed blocked past the window —
indefinitely, in practice, because each blocked click re-ran the same reset.

**Also wrong:** `useState(Date.now())`. Reading the clock during render is an
impure render. The server and the browser produce different values, which React
reports as a hydration mismatch. The window now opens on the first submit.

**What changed.** The count is computed into a local variable *before* the reset,
and that computed value is what gets compared.

### 1.4 Task filters threw a 500 on a stale bookmark

**Files:** `src/lib/tasks/filters.ts` (new), `src/app/org/[orgId]/Tasks/page.tsx`,
`src/app/org/[orgId]/projects/[projectId]/page.tsx`

**What was wrong.** The task list filters by URL. `?status=TODO` should show
todo tasks. The value went into the database query via a cast that told the
compiler to stop checking:

```ts
...(status && { status: status as any })
```

If someone bookmarks `?status=TYPO`, that compiles fine and then fails inside
Prisma, which means a 500 error page instead of an empty task list.

**The second bug.** Two URL parameters both wrote the `status` filter: `status`
and `filter`. Because `filter` always has a value (defaulting to `"ALL"`), it
was always written last and always won. The `status` parameter was dead — it
appeared to work when you set it alone, and was silently ignored whenever
`filter` was also present. The precedence was decided by object-literal key
order, which is the kind of thing that breaks when someone reorders lines.

**What changed.** A new module validates both values against the actual Prisma
enums. Unknown values return nothing, so the filter is simply omitted and you see
the unfiltered list. The `status` vs `filter` precedence is resolved once, in a
function with a name, instead of by accident.

The enum lookup uses `hasOwnProperty` rather than a bare index, because Prisma's
generated enum objects inherit from `Object.prototype` — meaning `?status=constructor`
would otherwise resolve to something real and pass the "is this valid?" check.

**Behavior change:** yes, but only for inputs that previously crashed. Valid
filters behave identically.

### 1.5 Step error messages could be stored as `undefined`

**File:** `src/lib/workflow/execution/wrapper.ts`

**What was wrong.** When a step crashes, the error message is written to
`StepRun.error` and the audit log. That field is the only thing an operator has
when diagnosing a failed step.

The catch block read `uncaughtError.message`. If something threw a **string**
instead of an `Error` — which is legal JavaScript, and which some libraries do —
`.message` is `undefined`, and `undefined` got written to the one field you need.

**What changed.** A helper renders any thrown value as a string: an `Error` uses
its message, an object with a `message` string uses that (Prisma and several SDKs
throw this shape), anything else uses `String(value)`.

---

## 2. The three contracts

These are the foundation the rest builds on. No behavior change in any of them.

### 2.1 `JsonValue`

**File:** `src/lib/workflow-types/type.ts`

**Why.** The workflow engine stores everything in JSONB columns:
`WorkflowRun.context`, `StepRun.outputs`, `ActionResult.data`. A `Date` or a class
instance assigned to one of those gets silently mangled on write — the row comes
back and the value is a string or is missing.

`any` said nothing. `unknown` said the right thing but was unactionable — every
reader narrows from scratch, and nothing stops the bad assignment. So:

```ts
type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };
```

This is a real type, not a comment. It states what the column already enforced at
runtime, and now the compiler enforces it too.

### 2.2 The event routing table

**File:** `src/lib/events/event-bus.ts`

**Why.** The event bus has two halves that were never linked: a routing table
mapping "system event" → "jobs to enqueue", and a set of schemas describing each
job's payload. A rule could name an event and carry a payload the schema never
described, and the compiler was happy because both halves used `any`.

Three changes:

- **`TriggerPayloads`** now declares the payload each trigger is dispatched
  with, derived from the fields the routing rules actually read. A trigger is an
  *input* to the bus; an event is its *output*. The clearest case is
  `TASK_CREATED`: the dispatcher already builds a subject and body from the task
  title, so the bus never needed the title.
- **`EVENT_ROUTING`** is typed as `RoutingTable` with optional entries, so a
  handler parameter gets the right payload type for its own event.
- **`RoutedEvent`** keeps `type` correlated with payload shape, so a rule cannot
  emit a `SEND_EMAIL` carrying a `PROCESS_FILE` body.

One deliberate widening: the payload a rule may **author** is wider than the
payload the schema **validates**. `publishEvent` is the validating authority and
it strips unknown keys. This is how `SEND_WELCOME_EMAIL` currently loses its
subject and body — see [known issues](#known-issues-we-did-not-fix). Narrowing
the authored type would have hidden that instead of recording it.

### 2.3 `WorkerHandler` export

**File:** `src/lib/events/worker.ts`

**Why.** `createWorker` infers the event payload type and passes it to the
handler. But a handler written as `({ event }: { event: any })` — which every
worker in this repo was — **overrides that inference and opts out of the check
entirely**. The generic machinery was there, working, and being defeated at every
call site.

Exporting `WorkerEventEnvelope` and `WorkerHandler` lets each handler declare its
own type and get checked against it.

---

## 3. The DAG engine, file by file

The execution engine is five files. All five were touched.

### 3.1 `execution/evaluator.ts` — validate the definition where it is read

**Why.** The evaluator cast `run.workflow.definition` straight into the engine.

If that stored JSON did not match what the engine expected, the result was a run
that **silently never advanced**. No dispatch, no error, no terminal state,
nothing in the logs. From the outside it looks exactly like a workflow that is
just slow. The only symptom is a support ticket saying "it just stops."

Now parsed with `WorkflowDefinitionSchema` at the read boundary, and a failure
throws with the Zod issues joined into the message — naming the workflow and the
offending path, so the log says which field is wrong rather than just "invalid."

**Behavior change, and it is the intended direction:** definitions written under
the older, permissive schema will now **fail to execute with a clear error**
instead of hanging. If you have old malformed workflows, they will start erroring
loudly. That is better, but it is a visible change.

Also in this file: a Prisma unique-constraint check was narrowed from `any` to a
check for the one error code it actually cares about (`P2002`).

### 3.2 `execution/resolver.ts` — type the pointer resolution

**Why.** `getValueByPath` walks `a.b.c` into the run context to resolve
`{{trigger.outputs.taskId}}` style pointers. It was `(obj: any, path: string) =>
any`.

Rewritten as a loop over `JsonValue`. Two real improvements fell out:

- **Arrays are traversable by numeric segment** (`steps.0.id`), which they always
  were at runtime, because `arr["0"]` resolves fine in JavaScript. Now it is
  explicit, and a non-numeric segment into an array stops deterministically
  instead of depending on JS coercion.
- **Missing paths return `undefined` rather than throwing**, because a pointer
  into a partially-populated context is an ordinary thing that happens during
  execution, not an exception.

Also: the branch order in `resolveValue` changed. It used to check
`typeof value !== 'string' && typeof value !== 'object'` first, which meant
`null` fell through several checks before being handled. The string case is now
first and explicit.

### 3.3 `execution/wrapper.ts` — errors you can actually read

Covered as bug 1.5 above. Also: `handleFailure`'s first parameter was `any` and
is now a structural type naming the five fields the function actually reads.
That is worth a note on its own — a structural type keeps the helper honest about
what it depends on, so the caller's query can change without silently widening
the signature.

### 3.4 `execution/trigger.ts` — type-only, and what it is not

**Only change:** `Record<string, any>` → `Record<string, JsonValue>` on the
trigger payload, which becomes `WorkflowRun.context`.

This file is on the **I6** path. I6 is a cross-tenant execution defect: this
function loads a workflow by `id` with no `orgId` check, so any authenticated
user can start any tenant's workflow. **That is not fixed.** These annotations
are not a fix and do not narrow the gap. It remains a separate P0 gating
Assignment 37.12.

I touched it anyway because the payload flows into the same JSONB column as
everything else, and leaving `any` here would have been inconsistent. Flagging it
plainly rather than quietly skipping it.

### 3.5 `execution/state.ts` — a falsy context is still a context

**Why.** `appendStepOutputToContext` merges a step's output into the run context.
It read:

```ts
(run.context as Record<string, any>) || {}
```

`||` treats falsy as absent. So if a step returned `0`, `""`, or `false`, the
context would be treated as empty and the output written into a fresh object —
silently discarding whatever was already there. Changed to `??`, which only falls
back on `null` and `undefined`.

Same change applied in `src/app/api/workflow/route.ts`.

---

## 4. Actions

Four action implementations. Three were type-only; one was bug 1.1.

### 4.1 `logic/conditions.ts`

Bug 1.1 above. Also fixed the coercion helper:

```ts
Number(value) || value   // was
```

`Number(0)` and `Number("0")` are both `0`, which is falsy, so **a value of 0
fell through to the raw input** and compared as the string `"0"` against a real
number. Invisible on `===`, quietly wrong on every ordering operator (`<`, `>`).
Replaced with explicit branches.

`CONTAINS` is now documented as substring semantics over the rendered form, so a
numeric check like `"150"` contains `"15"` behaves the way the editor implies.

### 4.2 `core/send-email.ts`

**Why.** Inputs arrive from resolved pointers, so a `to` or `subject` could
resolve to a number or an object. Previously `if (!toEmail || !subject)` accepted
a number and handed it to the email client.

Now each field is narrowed to `string`, and a non-string fails as a
configuration error rather than being coerced into something plausible-looking.

Two smaller things worth knowing:

- `resendId` uses `?? null` because Resend types `id` as optional, and
  `undefined` is not representable in the JSONB column this gets written to.
  A missing id is genuinely "no id," not "absent key."
- The `validation_error` check is now read through a type guard instead of an
  `any` cast. **This preserves the existing behavior** — a malformed address is
  still marked non-retriable, because retrying it is pointless and burns the
  step's retry budget.

### 4.3 `core/generate-report.ts`

**Why.** `userName` is interpolated into a filename and slugified with
`.replace()`. The old guard was `if (!userName)` — which passes for a number,
and a number has no `.replace`. A non-string would have thrown a `TypeError`
deep inside the action and been reported as a retriable infrastructure failure,
when it is actually a workflow configuration error.

Now `typeof userName !== "string"`. Same for `outputs.fileKey` in the
compensation path — a compensated step whose outputs were truncated must skip
cleanly rather than deleting an unrelated file.

### 4.4 `core/create-task.ts`

`catch (error: any)` → `catch (error: unknown)`, and the message is read through
`instanceof Error`. Purely a type change.

---

## 5. Events and workers

### 5.1 `email-worker/ew.ts` — how the hardcoded email got found

**Why this file is in a lint commit.** The handler was typed
`({ event }: { event: any })` and destructured `orgId` from the payload.
`SEND_EMAIL`'s schema has `userId`, `subject`, `body` — **no `orgId`**. So the
destructuring produced `undefined`, and every email completion was broadcast to a
Pusher channel literally named `org-undefined`.

Typing the handler surfaced it immediately. That is the whole argument for this
pass: an `any` is not a type error, it is a place where nobody checked.

**What was not changed, and why.** The recipient is still hardcoded to
`mayurnanda45@gmail.com`. Fixing it means resolving `userId` to an address and
deciding whether an org's mail should go to a person at all — that is a product
decision plus a schema change, not a lint fix.

One honest caveat: the channel was changed from `org-undefined` (a
guaranteed-wrong name) to `org-${userId}` (a probably-wrong name). `userId` is
not an org id, so this is still incorrect. It is called out in the code comment
and in the dev log rather than presented as a fix.

### 5.2 `analytics-worker/aw.ts` — the one handler that runs before validation

**Why this file is different from the others.** `createWorker` calls the analytics
handler for **every** event, before validation — `worker.ts:96` invokes it, and the
`schema.safeParse` on the payload only happens at line 106. So the log records
what arrived even when the payload turns out to be malformed, and its `data` is
genuinely unknown-shaped rather than `EventPayloadMap[K]`.

So this handler declares its own event type rather than using `WorkerHandler`.
`orgId` is narrowed with `typeof === "string"` rather than `|| null`, because
`orgId` is a string column and a truthy non-string from an unvalidated payload
would otherwise be handed to Prisma as if it were already the right shape.

### 5.3 `ai-worker.ts`, `file-worker/fw.ts`

Typed as `WorkerHandler<"EMBEDDING_REQUESTED">` and
`WorkerHandler<"FILE_UPLOADED">`. The `if (event.type !== "X") return` guards
were removed because the handler type already pins the event type — the guard was
checking something the compiler now checks.

### 5.4 `embedding-worker/ew.ts`, `vector/retreiver.ts`

`catch (error: any)` → `catch (error: unknown)`. Nothing else.

---

## 6. Server boundaries

### 6.1 `app/actions/workflows/workflow.ts` — edges get a schema too

**Why.** `IncomingNodeSchema` had been hardened in an earlier assignment. Edges
were still `z.array(z.any())`, on the reasoning that they carry no data.

That reasoning is wrong. `compileWorkflow` is the **only** thing that turns drawn
edges into `dependsOn` — the edges *are* the DAG's instructions. An unvalidated
edge is an unchecked instruction to the execution engine.

`IncomingEdgeSchema` now validates them on the same terms as nodes, and the
**parsed** edges are what get persisted. Validating a copy while storing the raw
argument would leave unvalidated keys in the JSONB column and make the check
advisory rather than binding.

React Flow's presentation fields (`type`, `animated`, `label`, handles) pass
through rather than being stripped — meaningful to the editor, harmless to the
compiler, which reads only `source` and `target`.

Function signatures went from `any[]` to `unknown[]`, which means the schema is
the only thing allowed to make a claim about the shape.

### 6.2 `app/api/workflow/route.ts`

The context read switched from `|| {}` to `?? {}` (same falsy bug as 3.5), and
`resolvedInputs` is typed as `Record<string, JsonValue>`.

### 6.3 `app/api/webhooks/razerpay/route.ts`

**Why this one matters.** The webhook's idempotency check catches a Prisma
`P2002` to detect "this event was already processed" and return 200 so Razorpay
stops retrying. The catch read `error.code` on an `any`.

Narrowed to check that one specific code. Treating *every* throw as a duplicate
would silently swallow real database failures as if they were replays — which
means a genuine outage looks like a successful idempotent skip.

### 6.4 `lib/emails/core-service.ts`

`let emailAttachments = []` → `const emailAttachments: EmailAttachment[] = []`.

Worth a line because of the annotation: an unannotated `const x = []` infers
`never[]`, not "an array of the thing pushed below." That is how element types
get quietly lost.

---

## 7. The React UI

### 7.1 `CreateTaskForm.tsx`

Bugs 1.3 above. Also `let result` → `const result`.

### 7.2 `useWorkflowLiveStream.ts` — the payload was lying about itself

**Why.** The Pusher event handler typed its input as
`{ stepId: string, status: string }`, then assigned `status` straight into node
data whose field is a `StepExecutionStatus`. The annotation was **false**, and
nothing checked it because `setNodes` was `any`.

Now validated at the wire boundary: an unrecognized status is dropped and logged,
rather than pushing a status the UI has no branch for. Same `hasOwnProperty`
guard as the task filters, for the same prototype reason.

**The part that is worth reading.** `AppNode` is a union discriminated on `type`
(trigger vs action). You cannot just spread into `node.data`, because TypeScript
widens the spread to a union of both shapes and cannot prove the result is still
an `AppNode`. Switching on the discriminant narrows one member at a time, and
both members carry `executionStatus` — so each case is provably well-typed with
no cast at all. This is why the file is typed the way it is.

### 7.3 `TaskAttachmentModalClient.tsx` — fetch on click, not on mount

**Why.** The component opened a modal on click, then fetched in a `useEffect`
that ran because the modal opened. That is one extra render and a visible frame
of empty content before data arrives.

The fetch moved into the click handler, with `try/finally` so a failure clears
the spinner. The old code had no `finally`, so a failed fetch left the spinner
running forever.

### 7.4 `ModalPortal.tsx`

Set its own "am I mounted" flag in an effect. That is `useSyncExternalStore` with
extra steps, and it causes a hydration mismatch on the server render. Rewritten
with the hook.

### 7.5 `graph-ui/utils.ts` — `null` vs `undefined`

`getNodeDefinition` returned `null` for a missing node. Its callers were
comparing against `undefined`. Now overloaded so the return type states both
cases, and returns `undefined` — which is what the callers actually wanted. No
caller compared against `null`, verified before the change.

### 7.6 `PropertiesPanel.tsx`, `nodes/ActionNode.tsx`, `nodes/TriggerNode.tsx`

Casts from `any` to the real `AppNode` / `AppEdge` types. No behavior change.

### 7.7 `components/razerpay/upgrade.tsx`

`Window.Razorpay` was `any`, which meant the options object passed to the
constructor was never checked at all. Declared the slice of the checkout API the
component uses: options, the `open()` method, and the response shape.

### 7.8 Remaining UI files

`InviteMemberModal.tsx` (role narrowed instead of cast; error narrowed through
`instanceof`), `RunWorkflowButton.tsx` (payload typed as `JsonValue`), and three
unescaped-entity fixes in `workflows/page.tsx` and `org-settings-form.tsx`.

---

## 8. Tests

Two suites added, 18 tests.

### 8.1 `condition-branch.test.ts` — 9 tests

Covers TRUE and FALSE edges, missing pointers, string/number/boolean/null
coercion, `"0"` against `0`, and empty-string handling.

The last two are deliberate: the coercion helper has branches where `"0"` and
`0` must stay distinguishable (see 4.1) while `" 0 "` and `""` must not.

### 8.2 `token-budget.test.ts` — 9 tests

The important detail: **the fixtures are `TextPart` and `ToolResultPart`
messages, not strings.** The bug only exists because AI SDK v5 puts an array in
`content`. A string-only fixture would have passed against the broken
implementation — which is precisely the mistake that let the bug ship.

### 8.3 The prisma double

The workflow delegate's `findFirst`, `updateMany` and `findMany` share matchers
that actually apply `orgId` and status predicates. A permissive double would let
a tenant-scoping test pass because the test forced a result, rather than because
the query excludes the row.

---

## 9. CI

`.github/workflows/ci.yml`, at the repository root.

Node 22, then `npm ci` → `npx prisma generate` → `npx tsc --noEmit` →
`npm test` → `npm run lint`. Runs on push and pull request against `main`, with
`concurrency` cancelling superseded runs on the same ref — so pushing a fix does
not queue behind the run it replaces.

Two deliberate choices:

**No build step.** `npm run build` is `prisma generate && next build`, and a
Next build fails on unrelated type or prerender errors. Adding it would mean the
lint work could not land until every prerender error in the app was also fixed —
a much larger change than the one being made. Typecheck and test are the real
gates. The build belongs to deploy.

**No database service.** The suite runs against the in-memory Prisma double, so
there is no migration ordering to get right on a fresh runner.

`prisma generate` is explicit rather than left to `npm ci`'s postinstall, because
`package.json` has no `postinstall` script and the generated client is what
everything imports.

---

## 10. Files touched but not described

Small enough to list without a section of their own:

| File | Change |
| --- | --- |
| `app/org/[orgId]/Tasks/page.tsx` | task filters (1.4) |
| `app/org/[orgId]/projects/[projectId]/page.tsx` | task filters (1.4) |
| `app/org/[orgId]/workflows/page.tsx` | escaped quotes |
| `app/actions/workflows/workflow-run.ts` | `JsonValue` payload, `unknown` catch. On the I6 path — **not a fix**, see 3.4 |
| `features/organizations/components/invitation/InviteMemberModal.tsx` | role narrowing, `unknown` catch |
| `features/organizations/components/org-settings-form.tsx` | escaped apostrophe |
| `features/organizations/components/workflow/PropertiesPanel.tsx` | node/edge casts |
| `features/organizations/components/workflow/RunWorkflowButton.tsx` | `JsonValue` payload |
| `features/organizations/components/workflow/nodes/ActionNode.tsx` | casts |
| `features/organizations/components/workflow/nodes/TriggerNode.tsx` | cast removed |
| `features/attachments/TaskAttachmentModalClient.tsx` | fetch on click (7.3) |
| `lib/vector/retreiver.ts` | `unknown` catch |

---

## Known issues we did not fix

Recorded here rather than silently patched, because each needs a decision that is
not a lint fix.

**`SEND_EMAIL` delivers to one developer's personal inbox.** See 5.1. The typed
payload is what surfaced it. Fixing it means resolving `userId` to an address and
deciding whether an org's mail should go to a person at all.

**`TASK_UPDATED` and `TASK_DELETED` are published with no route.** The typed
routing table makes this visible — both events exist in `EventPayloadMap` and
neither has an entry in `EVENT_ROUTING`. So a task edit or delete produces no
event at all, and the vector index goes stale on every update.

**`SEND_WELCOME_EMAIL` publishes a wider payload than its schema accepts.** The
authored payload includes subject and body; the schema does not declare them, so
Zod strips both at publish time and the worker receives an empty message. This is
the documented consequence of the deliberate widening in 2.2.

**I6 — cross-tenant workflow execution.** See 3.4. Still open, still a P0, still
gates Assignment 37.12.

**29 lint warnings remain**, across 24 files. All pre-existing, none of them
errors: 24 unused imports or locals, 3 `no-img-element`, and 2
`exhaustive-deps` in `WorkflowCanvas.tsx` where `getNodes` is declared on one
`useCallback` and read on another — that last pair describes a real staleness
risk in the canvas, and is worth a pass of its own. Warnings do not fail
`eslint` under its default config, so CI will not catch regressions there.

---

## What is still unverified

All evidence is Jest-level against an in-memory Prisma double, plus local command
runs. **No live database, queue, Gemini, Pusher, or real workflow execution has
been exercised.** CI proves the suite stays green; it does not prove a Pusher
event ever arrives, that a conditional branch routes correctly against a real
run, or that the token budget behaves on live traffic.

CI itself has not yet run on a GitHub runner. The workflow was validated by
parsing it and by running every step's command locally on Windows, which is not
the same thing.