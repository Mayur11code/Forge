# 2026-10-01 — Lint and type cleanup, and a CI gate

The working tree carried 85 lint errors and 34 warnings. This entry records what
most of them were actually hiding, because the ratio of "type error" to "real
defect" was worse than the count suggested: roughly a third of the fixes changed
what the code does.

## The rule for the pass

No blanket suppressions, no `@ts-expected-error`, no rule downgrades, no build
step added to hide a type error. Every error was either narrowed at a real
boundary or deleted because the code it guarded was unreachable. Where a
narrowing required a cast, the cast had to be at the parse boundary and the
comment had to say why.

That rule is what surfaced the bugs below. An `any` is not a type error in a
codebase that is already full of them; it is a place where nobody checked.

## Four defects the lint pass found

**Conditional routing never took the TRUE branch.** `evaluateCondition`
(`execution/actions/logic/conditions.ts`) returned
`{ success, data: { branch, details } }`, and the evaluator read the branch out of
`outputs`. The property did not exist, so the value was always `undefined`,
`undefined === "TRUE"` was always false, and every conditional action resolved
down the FALSE edge. Both tests and the code agreed on the wrong shape, so nothing
failed — this is what the check was for. Nine cases added in
`src/tests/workflow/condition-branch.test.ts`.

**The AI token budget counted nothing.** `token-manager.ts` measured
`JSON.stringify(msg.content).length / 4`. The AI SDK v5 passes `content` as an
**array of typed parts** for every real turn, so the estimate was
`JSON.stringify([{...}]).length / 4` over a fixed wrapper — the content itself
contributed almost nothing to the count, and the budget could not trip. When it
did trip, the negative slice it used to truncate (`slice(-n)` with `n < 0`
removing from the front) removed the system prompt first, which is the one message
a tool call needs to survive. Both paths are covered in
`src/tests/vector/token-budget.test.ts`.

**The rate limiter blocked the first submit after each window.** `CreateTaskForm`
called `setLocalCount(0)` and then tested the `localCount` captured in the same
closure, which still held the pre-reset value. A user who hit the limit stayed
blocked past the window. The count is now computed before the reset. Its
`useState(Date.now())` seed was also an impure render — server and client would
disagree on hydration — so the window now opens on the first submit.

**Task filters threw on a stale bookmark.** `?status=…` and `?filter=…` were cast
with `as any` straight into the Prisma `where`. An unrecognised value compiles and
then fails inside Prisma, so a hand-edited URL 500s the org's task page. Both
params also wrote `status`, and because `filter` is always defined (defaulting to
`ALL`) the `status` param was silently ignored whenever present. `src/lib/tasks/filters.ts`
validates against the real enums and resolves the precedence once, in a named
place, instead of leaving it to object-literal key order.

## Two boundary validations that had no schema

**Edges.** `IncomingNodeSchema` had been hardened by 37.0B while `uiEdges` was
still `z.array(z.any())`, on the reasoning that edges carry no data and the
compiler reads only `source`/`target`. `IncomingEdgeSchema` now validates them on
the same terms as nodes and the parsed edges are what get persisted.

**The Pusher payload.** `useWorkflowLiveStream` took `setNodes: any` and typed
the incoming event as `{ stepId: string, status: string }`, then assigned that
straight into node data whose field is a `StepExecutionStatus`. The annotation
was false and nothing checked it. The status is now validated at the wire
boundary. Both enum lookups here and in `filters.ts` use `hasOwnProperty` rather
than a bare index — the generated enum objects inherit from `Object.prototype`, so
`?status=constructor` resolves to something real and passes an undefined check.

`AppNode` is a union discriminated on `type`, so the status could not just be
spread into `node.data`: TypeScript widens the spread to a union of both shapes
and cannot prove the result is still an `AppNode`. Switching on the discriminant
narrows one member at a time, and both members carry `executionStatus`, so each
case is provably well-typed without a cast.

## React effects that were doing work the event already did

Three components set state inside an effect in response to something the user
had just done, which costs a render and flashes a stale frame:

- `TaskAttachmentModalClient` opened a modal and then fetched on mount. The fetch
  moved into the click handler, with `try/finally` so a failure clears the
  spinner instead of leaving it spinning forever.
- `ModalPortal` set its own mounted flag in an effect, which is
  `useSyncExternalStore` with extra steps.
- `PropertiesPanel` and `getNodeDefinition` returned `null` for a missing node;
  `getNodeDefinition` is now overloaded and returns `undefined`, matching what its
  callers actually compared against.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean, 0 errors |
| Lint | `npx eslint` | **0 errors**, 29 warnings |
| Full suite | `npm test` | **30 suites, 458 tests**, passing (was 28 / 440) |
| Prisma client | `npx prisma generate` | generated, 566ms |
| CI workflow | parsed with `js-yaml` | valid; 7 steps, `working-directory: forge` |

29 warnings remain, all pre-existing and none of them errors: unused imports and
locals in 20 files, `@next/next/no-img-element` in 4, and two
`react-hooks/exhaustive-deps` in `WorkflowCanvas.tsx` where `getNodes` is
declared on one `useCallback` but read on another. Warnings do not fail
`eslint` by default and CI uses that default, so they are not blocking.

## The CI gate

`.github/workflows/ci.yml`, Node 22, `npm ci` → `npx prisma generate` →
`npx tsc --noEmit` → `npm test` → `npm run lint`. Triggers on push and pull
request against `main`, with `concurrency` cancelling superseded runs on the
same ref so a pushed fix does not queue behind the run it replaces.

Two deliberate choices:

**No build step.** `npm run build` is `prisma generate && next build`, and a
Next build fails the whole gate on an unrelated type or prerender error. That
would mean the lint work could not land until every prerender error in the app
was also fixed, which is a much larger change than the one being made. Typecheck
and test are the real gates here; the build is left to deploy.

**No database service.** The suite runs against the in-memory Prisma double, so
there is no migration ordering to get right on a fresh runner.

## Still not verified

Same limit as the previous entry, and worth restating because CI widens the
surface of what looks checked: **no live database, queue, Gemini, or real
workflow execution has been exercised.** CI will prove the suite stays green; it
will not prove a Pusher event ever arrives, that a conditional branch routes
correctly against a real run, or that the token budget behaves on live traffic.
The conditional-routing and token-budget tests are unit-level against their
extracted logic.

**I6 is still open.** `workflow-run.ts` and `execution/trigger.ts` received type
annotations and `unknown`-typed catches in this pass. No tenant check was added
and no execution logic changed — the annotations are not a fix, and the entry
above no longer claims these files have an empty diff.

## Known defects left in place

**`SEND_EMAIL` sends to a hardcoded personal address.** `api/worker/email-worker/ew.ts`
delivers to `mayurnanda45@gmail.com`. The schema carries `userId` but no
recipient, and the channel name is `org-${userId}` — `userId` is not an org id,
so the Pusher channel is wrong independently of the address. This was typed but
not fixed: choosing the real recipient is a product decision (user email table?
org billing contact?) and the schema change belongs with it.

**`TASK_UPDATED` and `TASK_DELETED` are published with no route.** The typed
event-bus table (`a5d6f66`, `f547ee4`) makes this visible — the payload map has
both events and the routing table has neither. Real-time subscribers never
receive them.

**`SEND_WELCOME_EMAIL` publishes a wider payload than its schema accepts.** The
authored payload type includes subject and body; the schema does not, so Zod
strips both at publication and the worker receives an empty message.

## Commit state

Committed on `main`, pushed through `b99f7cf`, plus three commits from the final
UI pass (`51df6a3`, `207362c`, `b632fe8`) and this entry. The CI workflow is at
the repository root, outside the `forge` working directory, because GitHub reads
workflows from `.github/workflows` at the root regardless of any
`defaults.run.working-directory`.