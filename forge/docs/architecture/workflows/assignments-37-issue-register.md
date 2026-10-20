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
  - **Amendment, I6 only.** One exception exists. **I6 — Cross-tenant workflow
    execution** was recorded after Phase 0 closed, from a separate inspection of the
    execution entrypoint (`triggerWorkflowRun` / `startWorkflow`). It is filed here
    because it is a P0 tenant-isolation finding on a path Assignment 37 consumes,
    and leaving it outside the register would mean the P0 set was incomplete. The
    Phase 0 audit is **not** amended and still describes exactly what Phase 0
    observed; I6 is additional, not a correction. Every other finding, including
    I1–I5 and F1–F6, remains exactly as Phase 0 recorded it.
- **This document does not change runtime behavior.** It is documentation. No
  finding here has been fixed by its existence.
- The findings are not homogeneous. They include:
  - **Bugs** — behavior that is already wrong (I1, I2, I3, I4, I6).
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
| **P0** | Must be resolved before Assignment 37 relies on the affected path — before the agent can safely become a workflow writer (I1), or before a generated workflow is handed to the execution engine (I6) |
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

### I6 — Cross-tenant workflow execution

**Classification:** P0 · security / tenant-isolation · separate issue / separate
ticket · **must be closed before 37.12**, i.e. before Assignment 37 hands any
generated workflow to the existing execution engine.

**Status:** IMPLEMENTED — **VERIFIED (2026-10-20)** by a real-PostgreSQL
cross-tenant acceptance run. The fix landed on
`feat/37.1-action-capability-catalog`; see §I6 Resolution below. Originally
recorded after Phase 0 closed, from a separate inspection of the execution
entrypoint. Phase 0 findings are not amended by this entry; I6 is an additional
finding in its own right.

**Gate status (2026-10-20).** The source fix and its mocked tests are complete,
**and** the acceptance evidence Gate G requires — a **real-database** cross-tenant
run proving a caller authenticated for one organization cannot start another
organization's workflow (and that no `WorkflowRun` row is created) — has now been
performed and passed. I6 is therefore `VERIFIED`, and **37.12 is unblocked**.
Evidence: `src/tests/security/i6-cross-tenant.realdb.test.ts` (10/10) and
`docs/dev-log/2026-10-20-i6-real-db-acceptance.md`. The mocked suites are retained
but are not, by themselves, the Gate G evidence.

**Affected files / functions.**

| File | Function | Role in the gap |
|---|---|---|
| `src/app/actions/workflows/workflow-run.ts` | `triggerWorkflowRun` (`:5-25`) | Server action. Performs no authentication and no organization check. |
| `src/lib/workflow/execution/trigger.ts` | `startWorkflow` (`:7-43`) | Loads the workflow and creates the run. Loads by id with no `orgId` filter. |

**Observed authorization gap.** `triggerWorkflowRun` accepts `workflowId`,
`orgId` and `triggerPayload` and calls `startWorkflow` directly. There is no
`getOrgAccess` call, no `auth()` call, and no membership check anywhere on the
path:

```ts
export async function triggerWorkflowRun(
  workflowId: string,
  orgId: string,
  triggerPayload: Record<string, any> = {}
) {
  try {
    const run = await startWorkflow(workflowId, triggerPayload);
    return {
      success: true,
      runId: run.id,
      redirectTo: `/org/${orgId}/runs/${run.id}`,   // :17 — orgId is used only to build a link
    };
```

The `orgId` argument is used exclusively to construct a redirect string. It never
participates in an authorization decision, so the value is caller-supplied and
unverified; supplying any string produces a successful return.

**Observed database predicate.** The lookup inside `startWorkflow` is keyed on
primary key alone:

```ts
export async function startWorkflow(workflowId: string, triggerData: Record<string, any> = {}) {
  const workflow = await db.workflow.findUnique({
    where: { id: workflowId },                    // :8-9 — no orgId component
  });

  if (!workflow) {
    throw new Error(`Cannot start workflow: ${workflowId} not found.`);
  }
```

There is no `orgId` in the predicate, so the row is located regardless of owning
organization. The only check present is existence.

**Observed trigger / run behavior, established by repository inspection.**

1. `triggerPayload` becomes the run's global context. `startWorkflow` builds
   `initialContext = { trigger: { outputs: triggerData } }` (`:20-24`) and writes it
   to the new `WorkflowRun` row as `context` (`:27-33`).
2. That payload is referenceable from step inputs through the existing pointer
   grammar. `resolveInputs` → `resolveValue` → `getValueByPath(globalContext, path)`
   in `src/lib/workflow/execution/resolver.ts:7-14, 20-32, 50-59` walks
   `context.trigger.outputs.<field>` for a pointer such as
   `{{trigger.outputs.userId}}`. The source comment at `trigger.ts:19` states this
   intent directly. No new syntax is required for the payload to be consumed.
3. The run is created with `status: "RUNNING"` (`:30`) and immediately advanced by
   `advanceWorkflow(run.id)` (`:40`), which dispatches real actions through the
   existing engine.
4. `startWorkflow` returns the run, so the caller receives a run id and a redirect
   into a run viewer.

**Security / tenant-isolation impact.** An authenticated member of any
organization can start a workflow belonging to a different tenant if they know its
id, supplying an arbitrary `triggerPayload` that is seeded into that workflow's
run context. The attacker does not need the workflow to appear in any list they can
load, and does not need write access to it. The consequences are read of execution
behavior, invocation of another tenant's real actions, and attacker-controlled
values flowing into those actions through the `{{trigger.outputs.*}}` namespace.

**Distinction from I1 — the two must not be merged.**

| | **I1** | **I6** |
|---|---|---|
| Operation | cross-tenant **UPDATE** | cross-tenant **EXECUTION** |
| Target | an existing workflow's stored content | an existing workflow's runtime behavior |
| Entry point | `updateWorkflowState` (`workflow.ts:95`) | `triggerWorkflowRun` (`workflow-run.ts:5`) |
| Predicate | `update({ where: { id } })` | `findUnique({ where: { id } })` |
| Attacker needs | a workflow id | a workflow id |
| Consequence | overwrites blueprint, `eventId`, `isActive` | starts a real run with attacker-chosen trigger data |
| Gate | before **37.5** (agent becomes a writer) | before **37.12** (execution handoff) |

I1 lets an attacker change what a workflow *is*. I6 lets an attacker cause a
workflow to *run*. Closing I1 does not reduce I6: the read-side gate at
`workflows/[workflowId]/page.tsx:18-23` and the write-side gate at `workflow.ts:115`
are the same `workflow` row, and neither is on the execution path. They are
separate defects with separate owners, separate regression tests, and separate
definitions of done, and they are gated at different phases. Merging them would let
one closed ticket stand in for the other.

**Why this becomes especially relevant at 37.12.** 37.12 is the phase that hands a
generated workflow to the existing execution engine — the point at which
Assignment 37 stops producing proposals and starts producing effects. The
`startWorkflow` entrypoint is exactly what 37.12 makes reachable from
machine-generated material. Before that, the exposure is a human clicking "Test
Workflow" on a workflow in their own editor. After it, a proposal that has passed
every validation gate in 37.2–37.9 can reach the same unscoped entrypoint, and the
authorization surface becomes a proposal rather than a UI. The correct reading is
that I6 is a latent bug today and a serious one at 37.12.

**Why P0.** It crosses a tenant boundary on an execution path, it is reachable by
any authenticated user with no membership check at all, and it is consumed directly
by a phase of this assignment. Per axis 4 of the priority model, agent-reachable
exposure raises severity; here the assignment does not even have to make the agent
a caller for the boundary to be crossed, because the existing client button is
already sufficient.

**Required regression test.** A test asserting that a caller authenticated for
organization A cannot start a workflow whose `orgId` is B, and that the
`WorkflowRun` is not created. The positive case — a caller starting a workflow in
their own organization — must be asserted alongside it, so the fix cannot
degenerate into a blanket denial.

**Do not implement the fix in this document.** I6 is documentation and gating only
at this point. No fix is proposed here, and the execution path is not modified by
this entry.

**Additional observed caller, recorded for the ticket and not expanded here.**
`src/app/api/workflow/test/[workflowId]/test-run/route.ts:10-29` is a `POST` route
that calls the same `startWorkflow` with the `workflowId` taken from the URL, and
carries no authentication of its own. It is a second reachable path to the same
unscoped primitive. It is noted because the fix must not stop at
`triggerWorkflowRun` — a ticket that fixes only the server action would leave this
route open. No behavior at this route is analyzed or changed here.

---

#### I6 Resolution (source fix + mocked tests + real-DB acceptance — VERIFIED)

**Contract.** `startWorkflow` no longer accepts an id in isolation. Its signature
is now `startWorkflow(orgId, workflowId, triggerData = {})`, and the lookup is
tenant-scoped:

```ts
const workflow = await db.workflow.findFirst({
  where: { id: workflowId, orgId },   // orgId is REQUIRED and rides in the predicate
});
```

The `orgId` parameter is required (not optional), so no unscoped call shape
remains for a future caller to reach for; adding one would not compile. The
`orgId` passed in must be a **server-derived, verified** organization id — never a
value lifted from the request body.

**Entry points secured (all verified).**

| Entry point | Protection added |
|---|---|
| `src/app/actions/workflows/workflow-run.ts` → `triggerWorkflowRun` | Calls `getOrgAccess(orgslug)` first (the second argument is the `[orgId]` URL segment, which the router fills with the org **slug**). On `null`, returns `{ success: false, error: "Unauthorized" }` before any execution. Passes `access.organization.id` — the verified id — to `startWorkflow`. |
| `src/app/api/workflow/test/[workflowId]/test-run/route.ts` → `POST` | Independently calls `auth()`; returns `401` without a session. Resolves the workflow through a **membership-constrained** predicate (`organization: { memberships: { some: { userId } } }`), so a foreign workflow matches nothing — the same `404` as a nonexistent one, with no existence oracle — and passes the resolved `orgId` to `startWorkflow`. |

The trusted internal QStash worker (`src/app/api/workflow/route.ts`) is unchanged:
it is signature-verified and calls `advanceWorkflow`, not `startWorkflow`.

**Regression tests (mutation-sensitive).**

| File | Properties asserted |
|---|---|
| `src/tests/workflow/trigger-tenant-scope.test.ts` | lookup predicate carries `orgId`; foreign workflow refused **and** `workflowRun.create` / `advanceWorkflow` not called; missing and foreign yield the same error; same-org positive path still creates the run and advances. |
| `src/tests/workflow/workflow-run-boundary-scope.test.ts` | server action: unauthorized ⇒ refused with no `startWorkflow` call; verified org id (not the slug) is passed; action refusal propagates. route: unauthenticated ⇒ `401` with no lookup; lookup is membership-scoped and starts with the resolved org; foreign and missing both `404` with the same response shape and no `startWorkflow` call. |

**Verification performed.** Focused mocked suites pass; full default Jest suite
**64 suites / 1142 tests** pass; `tsc --noEmit` clean; ESLint clean
on all changed files; `git diff --check` clean. Verification level:
**unit / route-level with mocked boundaries (auth, `getOrgAccess`, Prisma,
`startWorkflow`, `advanceWorkflow`)— plus a real-database acceptance run.**

**Real-database acceptance (Gate G evidence, 2026-10-20).** A separate suite,
`src/tests/security/i6-cross-tenant.realdb.test.ts` (**10/10**), runs the **real**
Prisma client, the **real** `getOrgAccess`, `startWorkflow`, `triggerWorkflowRun`
and the test-run route against the configured PostgreSQL database (`auth()` and
`advanceWorkflow` are mocked so identity is deterministic and no QStash/Redis/
action side effects fire). It proves: an org-A caller cannot start org B's
workflow and `workflowRun.count({ workflowId: B }) === 0`; a nonexistent workflow
is refused indistinguishably; the same-org positive path creates exactly one
`RUNNING` run with the expected `context.trigger.outputs` and reaches
`advanceWorkflow`; a payload-smuggled org id cannot redirect the tenant; and the
test-run route returns an identical `404` for foreign vs missing with no run.
Fixtures are created under a unique prefix and removed with a verified
zero-leftover check. It is wired via `jest.realdb.config.ts` +
`jest.setup-realdb.ts` (which omit the default PrismaClient refusal); the default
config ignores `*.realdb.test.ts`. See
`docs/dev-log/2026-10-20-i6-real-db-acceptance.md`.

**Gate G status (2026-10-20).** Met. I6 is `VERIFIED`; **37.12 is unblocked.** The
mocked suites are necessary but not sufficient; the real-DB run above is the
evidence Gate G defines.

**Residual / follow-ups.** Every production caller of
`startWorkflow` is one of the two entry points above, and both derive `orgId`
server-side; adding an unscoped call shape would not compile — now asserted both
at the mocked boundary and against the real database.
A plain-string sentinel in a clarified
proposal still fails `isReferenceTemplate` and can re-arm the loop
(`workflow-proposal.ts:293,427`) — an unrelated defect, tracked separately, not
part of I6.

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

**Resolution — CLOSED 2026-10-01 (Phase 37.1).** AD-P1 is decided: a separate,
client-safe capability catalog keyed by action id, in
`src/lib/workflow-types/action-capabilities.ts`, with the runtime registry as the
source of truth for membership. Each capability carries label, description, a
strict input schema, an output schema for the business `data` payload, a
compensation flag and failure characteristics. `task.create` is described from
source, not from the Phase 0 prose.

The contract is now checkable at compile time and at test time, not just present:
`ActionCapabilities satisfies Record<RegisteredActionId, ActionCapability>` makes
catalog/registry agreement a type error in both directions, and
`src/tests/workflow/action-capabilities.test.ts` (32 tests) is the runtime
backstop. Evidence: `assignments-37-phase-37.1-capability-catalog.md` §6, §12.

**Trust boundary preserved.** No capability input schema admits `orgId`,
`userId`, `workflowId` or `runId`; a test asserts their rejection. Organization
identity still comes from the persisted `Workflow` row.

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

**Resolution — CLOSED 2026-10-01 (Phase 37.1).** The two lists are reconciled by
removing the second list, not by editing it into agreement.
`AVAILABLE_ACTIONS` is now a projection of the capability catalog
(`src/lib/workflow-types/registry.ts`), and the catalog is total over the runtime
registry, so `comment.add` — present in the UI list and absent from the runtime —
cannot appear. It was **not** registered and no comment executor was written;
`communication.send_email` and `utils.generate_report` were likewise not exposed
despite their implementation files existing on disk. The rule recorded here now
holds structurally: **a function existing in the repository does not make it an
available workflow capability.**

Both halves of the `task.create` disagreement are corrected, and both are
derived rather than restated:

| aspect | before | now |
|---|---|---|
| required inputs | `['projectId']` | `['title', 'projectId']` |
| outputs | `['taskId']` | `['taskId', 'title']` |

`requires` and `outputs` are computed from the capability input and output
schemas, so they cannot drift from the action again. Evidence:
`assignments-37-phase-37.1-capability-catalog.md` §6–§7, §12; mutation B in §12
re-advertises `comment.add` and the suite fails 3 tests.

The output half is the more consequential fix: `outputs` feeds
`getAvailableUpstreamOutputs`, so before this phase a reference to the real
`{{create_task.outputs.title}}` could not be wired on the canvas. It can now, and
37.3's reference validator will check paths against the same derivation.

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

**Resolution — CLOSED 2026-10-12 (Phase 37.3).** A read-only preflight validator
over `WorkflowProposal` now performs the checks F6 recorded as absent, without
modifying the resolver:

- `src/lib/workflow-types/workflow-proposal-references.ts` (new) —
  `validateProposalReferences(proposal): ProposalIssue[]`, walking every string
  leaf under every step's `inputs`.
- Reuses the resolver's own grammar (`/\{\{([\w.-]+)\}\}/g`) rather than extending
  it; a parity test drives the real `resolveInputs` against the same strings.
- The plan's invalid example is rejected with `MISSING_DATA_DEPENDENCY`: a valid
  step-output reference requires the source step in the consumer's own
  `dependsOn`, and that array is never inferred or mutated.
- Also rejects unknown sources (`UNKNOWN_REFERENCE_SOURCE`), undeclared outputs
  (`UNKNOWN_OUTPUT`), malformed tokens/namespaces (`MALFORMED_REFERENCE`),
  out-of-scope runtime namespaces (`UNAVAILABLE_REFERENCE_SCOPE`), and
  prototype-path segments (`UNSAFE_REFERENCE_PATH`). Self-references are reported
  as `SELF_REFERENCE`.

The resolver's runtime behaviour — including its silent missing-path handling and
its `current[part]` traversal — is **unchanged**; the phase is a preflight for
generated proposals, not a runtime rewrite. `git diff --
src/lib/workflow/execution/resolver.ts` is empty, and two tests read the file
from disk to assert it is untouched.

Evidence: `src/tests/workflow/proposal-references.test.ts` — 44/44 (full run 33
suites / 579 tests); `assignments-37-phase-37.3-reference-validator.md` §10–§11.

**Recorded limitations (not silent omissions).** Trigger output fields fail
closed with `UNKNOWN_OUTPUT` because no authoritative trigger-output contract
exists (`triggerData` is an unconstrained `Record<string, JsonValue>`). A sound
`TYPE_MISMATCH` check is not implemented because every catalogued output is
`z.string()` and no machine-declared field-type relationship exists without a
type-inference layer. Dependency existence and cycle detection remain 37.4.

---

### F5 — `WorkflowDefinitionSchema` is not the production validation gate

**Classification:** P1 · resolve at **37.4**. Do not refactor yet.

**Status:** **CLOSED 2026-10-12 (Phase 37.4).** See the resolution note at the end
of this entry.

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

**Resolution — CLOSED 2026-10-12 (Phase 37.4).**

*Premise correction.* The F5 premise — "`WorkflowDefinitionSchema` is never called
in production" — is inaccurate as of the 2026-10-01 lint pass. `evaluator.ts:223`
re-parses the persisted definition with
`WorkflowDefinitionSchema.safeParse(run.workflow.definition)`. The schema is a
runtime read-boundary validator. It is not, and cannot be, the graph-semantic
gate: its `superRefine` re-emits every issue as `z.ZodIssueCode.custom` and drops
the cycle `path` (`workflow.ts:243-250`), discarding exactly the structure
(AD-P4) that the compiler must return to the caller.

*Decision (AD-P4).* `collectWorkflowDefinitionIssues` is the canonical
graph-semantic gate. The new compiler
(`src/lib/workflow-types/workflow-proposal-compiler.ts`) runs it directly and
normalizes its issues into `ProposalIssue[]` with `code`, `path` and `message`
intact. `WorkflowDefinitionSchema` is unchanged and remains the runtime
read-boundary validator. No production file was modified to close F5.

*Scope of the guarantee.* The compiler is a static boundary with no production
caller until 37.5, so this is a design resolution plus a tested boundary, not yet
a production-path verification. Evidence: `workflow-proposal-compiler.test.ts` —
25/25; tracker §37.4 Test Gate (three graph checks reachable, adapter total over
all seven collector codes).

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

**Phase 37.6 resolution note (2026-10-14, AD-18):**
The protocol-level distinction between model error (`INVALID_INPUT`) and missing user information
(`NEEDS_USER_INPUT`) is implemented schema-free in `src/lib/ai/agent/tools/generate-workflow/`
along with clarification-intent validation and safe same-session answer continuation logic.
**37.6 honored the no-preemptive-migration boundary: no Prisma model or migration was created.**
Final proposal-lifecycle persistence, storage model decision (AgentToolExecution reuse vs dedicated
WorkflowProposal table), and restart-survival verification are deferred to 37.8 (relocated, not waived).
**F4 remains OPEN** until the 37.8 persistence decision and acceptance criteria are satisfied.

**Remediation note (2026-10-14):** The continuation lifecycle is now genuinely wired rather than inert.
The tool worker halts on a `NEEDS_USER_INPUT` result instead of recording `AGENT_LOOP_REQUESTED`
(which previously sent the model straight back to the same missing input), persists the backend
`interactionId`, and publishes a `CLARIFICATION_REQUESTED` event. A real ingress route
(`POST /api/agent/session/[sessionId]/clarification`) and the session GET `clarification` exposure
give the pending ask a production consumer. Answers are authorised under the session lock, bound to the
pending `interactionId` + proposal-revision `correlationId`, idempotent on identical repeats and
`CLARIFICATION_CONFLICT` on changed repeats, and re-enter the bounded loop transactionally.
`redriveStalledSessions` skips waiting sessions (`skippedWaiting`) so the reaper no longer kills a
deliberate wait. Surviving a process restart still requires the 37.8 persistence decision.

**Acceptance note (2026-10-17).** 37.6's protocol scope is now `VERIFIED`: the backend `NEEDS_USER_INPUT`
protocol and same-session clarification continuation are accepted (real ingress + session GET exposure,
`interactionId`/`correlationId` binding, idempotent/conflicting continuation, reaper `skippedWaiting`). The
accepted scope is backend-only; no external UI is claimed. **F4 remains open** - the durable
proposal-lifecycle persistence and restart-survival criteria that keep it open are owned by 37.8.

**Documented limitation (distinct from F4).** Independent verification cannot establish whether a value the
human had already supplied was actually present in the prior conversation: the continuation path proves an
answer corresponds to a genuinely missing required input, but no durable record proves the model omitted a
value the human had already provided. This is a limitation of the current evidence, not the F4 persistence
fork, and 37.8's schema decision does not by itself resolve it.

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

> **[RESOLVED — 37.11, 2026-10-20]** **F1 and F2 are CLOSED** by
> `assignments-37-phase-37.11-workflow-materialization.md`. F1: Option 1 was taken
> — the materializer synthesizes the deterministic layout via the verbatim 37.10
> projection and persists it through the SAME shared save boundary
> (`IncomingNodesSchema`/`IncomingEdgesSchema`), so there is one write path and its
> I1/I2 guarantees are inherited. No schema change was needed: `compileWorkflow`
> accepts action-only graphs and stores `eventId: null` / `isActive: false`. F2: no
> new migration — `Workflow.sourceProposalId` already existed; provenance is the
> durable `AgentToolExecution.id`, and `Workflow.name` is `proposal.name`. The
> `/api/agent/session/[sessionId]/route.ts` session read and the review card now
> surface the outcome. The historical text below is retained unchanged.

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

### I7 — Conditional routing is not executable / authorable end-to-end

**Classification:** P2 scope / architecture finding · **non-blocking for 37.1** ·
requires a scope decision before Assignment 37 claims generated conditional
branches.

**Recorded after Phase 0, from Phase 37.1 reconnaissance.** Like I6, this is not
a Phase 0 finding and the Phase 0 audit is not amended. It was reported during
37.1 reconnaissance, re-inspected against source, and confirmed. A related
output-contract defect in the condition helper was already fixed on 2026-10-01
(see `src/tests/workflow/condition-branch.test.ts`); that fix was necessary but
not sufficient, and this finding records the remainder.

**What exists.**

- `executeConditionNode` (`src/lib/workflow/actions/logic/conditions.ts:40`)
  evaluates `value1 <operator> value2` and returns
  `{ success, data: { branch: "TRUE" | "FALSE", details } }`.
- The evaluator gates a dependant on its parent's branch:
  `requiredBranch = node.routingConditions?.[depId]`,
  `actualBranch = readBranch(stepRunMap.get(depId)?.outputs)`
  (`src/lib/workflow/execution/evaluator.ts:424-431`).

**What is unreachable or missing.**

1. `executeConditionNode` is **not registered** in `ActionRegistry`, and its
   signature is not an `ExecuteFunction` — it takes `Record<string, JsonValue>`,
   not `ActionContext`. Its only importer is its own test; no engine code calls
   it.
2. The wrapper dispatches only through `getAction(actionId)`
   (`src/lib/workflow/execution/wrapper.ts:180`), which fails an unregistered
   action with "Action not found in registry". A condition step therefore cannot
   execute, so no step ever writes `{ branch }` into `StepRun.outputs`.
3. `readBranch` consequently always reads `undefined`, and
   `requiredBranch && actualBranch !== requiredBranch` is true for every
   conditional dependant — so every conditional branch is skipped.

**What the canvas can author.** Nothing that yields `routingConditions`.
`ActionNodeDataSchema` (`src/lib/workflow-types/workflow.ts`) has no routing
field, and `compileWorkflow` (`src/lib/workflow/graph-ui/compiler.ts`) never sets
`WorkflowStep.routingConditions`. The field is declared in `WorkflowStepSchema`
and read by the evaluator, but no authoring path populates it.

**Why registering `executeConditionNode` would not complete the feature.** It
would let the step run and publish a branch, but (a) nothing sets a dependant's
`routingConditions[depId]`, so there is still no required branch to compare
against; (b) the action's inputs (`value1`, `operator`, `value2`) come from no
canvas field and no capability descriptor; and (c) a condition node has no
representation in the capability catalog.

**Scope decision required before Assignment 37 claims generated conditional
branches:**

1. **In scope** — add a condition node kind, a canvas authoring path, branch
   declaration on dependants, and a capability contract for the condition inputs;
   or
2. **Out of scope** — forbid generated proposals from emitting conditional steps,
   and ensure the capability surface does not imply otherwise.

**Not decided, and not implemented, in 37.1.** No evaluator logic, routing
semantics, node kind, or registry entry was changed to enable conditional
execution. Conditional routing is **not** claimed to work end-to-end. See
`assignments-37-phase-37.1-capability-catalog.md` §10.

---

## 6. Dependency Map

| Finding | Priority | Assignment phase | Blocks what? | Separate ticket? |
|---|---|---|---|---|
| **I1** cross-tenant workflow update | **P0** | Pre-37.5 prerequisite | All agent-originated workflow writes / materialization | **Yes** |
| **I6** cross-tenant workflow execution | **P0** | Pre-37.12 prerequisite | Handing any generated workflow to the existing execution engine | **Yes** |
| **I2** node validation bypass | **P0** | Pre-37.11 prerequisite | Trusting generated `uiNodes` at the persistence boundary | **Yes** |
| **F3** no authoritative capability contract | **P1** | **37.1** | Planner-facing action knowledge; the whole generation path | No — **CLOSED 2026-10-01** |
| **I4** runtime/UI registry mismatch | **P1** | **37.1** | Reliable output contracts; absence of phantom actions | No — **CLOSED 2026-10-01, with 37.1** |
| **F6** no reference / data-dependency validation | **P1** | **37.3** | Deterministic step generation; `MISSING_DATA_DEPENDENCY` | No — **CLOSED 2026-10-12** |
| **F5** schema is not the production semantic gate | **P1** | **37.4** | Deterministic, structured proposal compilation; AD-P4 | No — **CLOSED 2026-10-12** |
| **F4** `AgentToolExecution` cannot hold the lifecycle | **P1** | **37.6 / 37.7 / 37.8** | `NEEDS_USER_INPUT`, human criticality, durable proposal state | **Open** — protocol scope VERIFIED 37.6 (2026-10-17, AD-18); persistence deferred to 37.8 |
| **I5** maintenance schedule unknown | **P1-CHECK** | **37.16** | Capstone recovery verification; only if confirmed absent | Only if confirmed absent |
| **F1** canvas-first persistence | **P2** | **37.10 / 37.11** | Materialization ordering; layout strategy | No — **CLOSED 2026-10-20** (37.11, Option 1: synthesize layout before persistence through the shared boundary) |
| **F2** definition id/name are placeholders | **P2** | **37.11** | Provenance; correct human-facing name placement | No — **CLOSED 2026-10-20** (37.11: `Workflow.name` = proposal name; provenance = `AgentToolExecution.id`; no new migration) |
| **I3** `WAITING_CONFIRMATION` unreachable | **P2/P3** | Later state-machine cleanup | Nothing in 37.1–37.5 | No |
| **I7** conditional routing not executable/authorable | **P2** | Scope decision (recorded 37.1) | Any claim that generated conditional branches work | No — needs a scope decision, not a ticket yet |

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
37.0    Contract reconnaissance                          COMPLETE (VERIFIED)
37.0A   Security prerequisite — I1 tenant-scoped update   COMPLETE (VERIFIED)
37.0B   Persistence-boundary prerequisite — I2 node validation  COMPLETE (VERIFIED)
37.1    Action capability registry                      VERIFIED (F3, absorbed I4)
37.2    WorkflowProposal schema                         VERIFIED
37.3    Reference grammar + validator                   VERIFIED (F6, MISSING_DATA_DEPENDENCY)
37.4    Proposal compiler / semantic validation adapter IMPLEMENTED (F5)
37.5    generateWorkflow agent tool                     IMPLEMENTED
37.6    Missing-input state                              VERIFIED (first part of F4)
37.7    Human criticality state                          IMPLEMENTED (continues F4)
37.8    Durable proposal persistence                     IMPLEMENTED
37.9    Existing confirmation integration                IMPLEMENTED (incl. 37.9.1 UI)
37.10   UI graph projection / deterministic layout       IMPLEMENTED (ordering = AD-11; F1 open)
37.11   Workflow materialization                        (canvas-first, F2)
37.12   Execution handoff                               (GATED ON I6)
37.13   Prompt / DAG planning instructions
37.14   Self-healing observations
37.15   Full test matrix
37.16   Live capstone verification                      (I5, and the full live matrix)
37.17   Documentation / closure
```

The four structural changes from the original ordering:

1. **37.0A / 37.0B inserted before 37.1**, so the P0 work is not bundled into a
   feature phase.
2. **37.10 and 37.11 swap places** — UI projection before materialization — as a
   direct consequence of F1.
3. **I5 verification is attached to 37.16** rather than left implicit.
4. **37.12 is gated on I6.** Execution handoff cannot become `VERIFIED` until
   cross-tenant workflow execution is closed. I6 is a separate ticket from I1 and
   is not satisfied by closing I1.

**I7 adds a pending scope decision, not a phase.** Conditional routing is not
executable or authorable end-to-end (section 5 → I7). The decision — support
generated conditional branches, or forbid them — must be taken before Assignment
37 claims either way. It does not renumber the sequence and does not block 37.2.

---

## 8. Explicit "Do Not Fix Yet" Boundary

Recorded so that a well-meaning reader does not "tidy up" a finding ahead of its
phase and invalidate the design it was meant to inform.

**DO NOT** preemptively fix **F1**, **F2**, or **F4** before their designated
phase. Each is a fork with a consumer that does not exist yet, and resolving it
early means guessing at a requirement rather than responding to it.
(F5 has since been resolved at its assigned phase, 37.4; see its resolution note.
It was a gate-selection decision, not a rewrite.)

**DO NOT** fold **I6** into the I1 ticket. They are separate defects on separate
paths, gated at different phases, and one closed ticket must not be allowed to
stand in for the other. I6 is also **not** to be fixed as a side effect of 37.0A,
and 37.0A must not touch the execution path. I6 is fixed by its own ticket, before
37.12, covering every reachable caller of the unscoped entrypoint.

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
isolated from the contract work with a named owner and a date. Isolation is
acceptable for 37.1–37.5 because none of those phases writes a workflow (37.5's
`generateWorkflow` is `READ_ONLY`; see AD-17). It is not acceptable once a phase
writes workflows — materialization at 37.11 (Gate F).

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
compiler boundary, and issue `code`/`path` survive to the caller. **F5 is
resolved (AD-P4):** `collectWorkflowDefinitionIssues` is the canonical
graph-semantic gate and the compiler calls it directly.
`WorkflowDefinitionSchema` remains the runtime read-boundary validator (invoked at
`evaluator.ts:223`) and is unchanged. The guarantee in the comment at
`workflow.ts:42-44` is upheld in production by the compiler's collector call; no
production file was edited to close F5. The compiler has no production caller
until 37.5, so this gate is a tested boundary, not yet a production-path
verification.

**Gate E — before 37.5 becomes workflow-writing.**
I1 is closed. The predicate on any workflow write is tenant-scoped, and a
regression test proves cross-tenant writes are rejected. **Phase 37.5
(2026-10-12)** registered `generateWorkflow` as `READ_ONLY` (AD-17): it performs
no workflow write, so this gate is not yet exercised by it and remains the
precondition for the first phase that does write a workflow.

**Gate F — before materialization.**
F1's decision is resolved — synthesized layout versus a definition-first write
path — and I2's persistence-boundary integrity is closed, so that generated
`uiNodes` crossing the canvas boundary is genuinely validated.

**Gate G — before 37.12, Execution handoff.**
I6 is closed. The execution entrypoint enforces tenant scope, and a regression
test proves a caller authenticated for one organization cannot start another
organization's workflow, and that no `WorkflowRun` row is created when they try.
Gate E does **not** satisfy Gate G: I1 and I6 are different defects on different
paths, gated at different phases, and a closed I1 leaves the execution entrypoint
unscoped. Every reachable caller of the unscoped primitive must be covered by the
I6 ticket, not only the server action.

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
                             UI GRAPH / LAYOUT         37.10   ← F1 (IMPLEMENTED)
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

**Phases VERIFIED:** 37.0, 37.0A, 37.0B, **37.1 (2026-10-01)**,
**37.2 (2026-10-12)**, **37.3 (2026-10-12)**, **37.6 (2026-10-17)**

**Phases IMPLEMENTED (not VERIFIED):** 37.4, 37.5, 37.7, 37.8, **37.9 (incl. 37.9.1
human-input UI, 2026-10-19)**, **37.10 (2026-10-19, UI graph projection + read-only
preview)** — complete and tested at the mocked boundary; their
documented Verification Gates are not yet satisfied.

**Current blockers:**
- None at P0. **I6 is `VERIFIED` (2026-10-20)** by a real-PostgreSQL cross-tenant
  acceptance run, so **37.12 is unblocked**. Outstanding non-P0 gates: 37.8
  migration-applied verification, 37.11 real-DB materialization round-trip, and
  the usual per-phase verification debt.

**P0 set:** I1, I2, I6 — three separate tickets, of which **I1 and I2 are CLOSED
(2026-09-30)** under Phases 37.0A and 37.0B, and **I6 is now CLOSED
(2026-10-20)** by its real-DB acceptance run. **No P0 remains open.** None of the
three was ever satisfied by closing either of the others.

**Current implementation target:** 37.11 — workflow materialization (dependency
37.10 satisfied; F1/F2 persistence decision still open)

**Closed by Phase 37.1, with evidence:**
- **F3** — the capability contract exists and is tested
  (`src/lib/workflow-types/action-capabilities.ts`;
  `src/tests/workflow/action-capabilities.test.ts`).
- **I4** — the UI list is a derived projection of the catalog; `comment.add` is
  no longer advertised; the `task.create` required-input and output mismatches
  are corrected.

Both closures rest on a test that fails when the defect is reintroduced
(mutation checks in `assignments-37-phase-37.1-capability-catalog.md` §12), not
merely on the existence of a document.

**Closed by Phase 37.3, with evidence:**
- **F6** — a read-only preflight validator over `WorkflowProposal` rejects a data
  reference whose execution dependency is absent (`MISSING_DATA_DEPENDENCY`),
  along with unknown sources, undeclared outputs, malformed tokens, out-of-scope
  namespaces and prototype-path segments
  (`src/lib/workflow-types/workflow-proposal-references.ts`;
  `src/tests/workflow/proposal-references.test.ts` — 44/44). The resolver was not
  modified (`git diff -- src/lib/workflow/execution/resolver.ts` is empty).

**Recorded, not resolved, by Phase 37.1:**
- **I7** — conditional routing is not executable or authorable end-to-end. A
  scope decision is required before Assignment 37 claims generated conditional
  branches. Non-blocking.

**Later architectural decisions:**
- F1
- F2
- F4

(F5 was resolved at 37.4.)

**Scope note.** Phase 37.1 modified application source
(`src/lib/workflow-types/action-registry.ts`, `registry.ts`), added
`src/lib/workflow-types/action-capabilities.ts`, and added a test file. No Prisma
schema, migration, prompt, execution engine, or runtime behaviour was changed.
`createTaskInOrg` and the canonical `createTaskSchema` were not modified. The
Phase 0 audit remains unmodified.

**Phase 37.2/37.3 scope note.** Phase 37.2 added
`src/lib/workflow-types/workflow-proposal.ts` and its test. Phase 37.3 added
`src/lib/workflow-types/workflow-proposal-references.ts`, its 44-test suite, and
extended the `ProposalIssueCode` union in the 37.2 module. Neither phase changed
`src/lib/workflow/execution/resolver.ts` or any runtime, Prisma schema, migration,
prompt, or execution path. The Phase 0 audit remains unmodified.

**I5 remains unverified** and is not listed as a blocker. It becomes one only if
verification confirms no workflow-maintenance schedule exists.

### Deferred follow-ups (recorded 2026-10-20)

Tracked so that deferred cleanup is not mistaken for closed work. Items 1–3 are
ordinary deferrals. The I6 acceptance run was **completed and passed 2026-10-20**
(no longer a blocker); the 37.8 migration gate and the 37.11 real-DB
materialization gate remain **gates** (and note the 37.8 migration is now applied
— see item 6).

1. **`@modal/new` route correction (deferred; config-only workaround in place).**
   `next.config.ts` carries `deprecated: { looseRouteMatching: true }` to work
   around a strict parallel-route match failure in the `org/[orgId]/projects`
   layout + `@modal/new` slot. The permanent correction is to fix the route
   structure and **remove the flag**, then re-evaluate compatibility with a future
   `next` patch (16.4.2+). The flag is a compatibility shim, not a fix.
2. **Residual `resend` / `svix` advisory.** Moderate, transitive, no compatible
   upstream fix at this time. Monitor for a patched `svix` release; reassess on a
   new advisory, a reachability change, or a deployment change.
3. **Remaining dev / CLI / build-tooling advisories.** Lower priority (not in the
   production request path). Clear opportunistically with compatible upgrades.
   Reassessment triggers: a patched release, a reachability change, a deployment
   change, or a new advisory.
4. **Production Pinecone config prerequisite (BLOCKER for a clean production
   build).** The production build stops at page-data collection on missing
   `PINECONE_API_KEY_PROD` / `PINECONE_INDEX_PROD` (`src/lib/vector/client.ts:8,13`;
   `.env` has only `_DEV`). No fake creds were supplied and no config check was
   weakened. Recorded honestly as unresolved.
5. **Conditional credential rotation (owner action).** No confirmed exposure —
   `forge/.env` is untracked, ignored, and absent from all commits. Rotation is
   owner hygiene, not a confirmed leak remediation.
6. **Migration-state correction (2026-10-20).** `npx prisma migrate status`
   reports **"Database schema is up to date!"** — all 26 migrations, including the
   37.8 migration `20261017120000_agent_proposal_lifecycle`, are **applied** to the
   configured database. Docs that describe that migration as "unapplied" are
   stale. The 37.11 real-DB round-trip is therefore runnable now; its own
   verification remains outstanding.

---

*Provenance: findings F1–F6 and I1–I5 traced to
`docs/architecture/workflows/assignments-37-phase-0-audit.md`. **I6 was recorded
separately, after Phase 0 closed**, from inspection of `triggerWorkflowRun` and
`startWorkflow`; **I7 was recorded separately, during Phase 37.1 reconnaissance**,
from inspection of the evaluator, wrapper and compiler. The Phase 0 audit is
unmodified in both cases. Where Phase 0 recorded `UNKNOWN`, this register
preserves the uncertainty rather than resolving it by assumption.*
