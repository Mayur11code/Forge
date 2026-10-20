# 2026-10-20 — I6: Cross-tenant workflow execution (security ticket)

**Scope.** Close the P0 tenant-isolation defect on the workflow *execution*
entrypoint. This is a separate security ticket, **not** part of Assignment 37.12
(execution handoff) and **not** the I1 write-path defect. No engine code, no
Prisma schema, and no migration were touched.

## The defect

Two publicly reachable paths handed a workflow id straight to
`startWorkflow`, which loaded it by primary key alone:

```ts
const workflow = await db.workflow.findUnique({ where: { id: workflowId } });
```

Existence is not authorization. Any authenticated user who knew a workflow id
could start that workflow — any tenant's — and seed an attacker-chosen
`triggerPayload` into its run context under `{{trigger.outputs.*}}`.

Reachable paths:

| Path | Gap |
|---|---|
| `src/app/actions/workflows/workflow-run.ts` → `triggerWorkflowRun` | No `auth()`, no `getOrgAccess`, no membership check. `orgId` was used only to build a redirect string. |
| `src/app/api/workflow/test/[workflowId]/test-run/route.ts` → `POST` | Public, no auth of its own, hardcoded payload. A fix limited to the server action would have left this open. |

## The fix

**1. `startWorkflow` is tenant-scoped (`src/lib/workflow/execution/trigger.ts`).**

```ts
export async function startWorkflow(
  orgId: string,          // REQUIRED, server-derived
  workflowId: string,
  triggerData: Record<string, JsonValue> = {},
) {
  const workflow = await db.workflow.findFirst({
    where: { id: workflowId, orgId },
  });
  ...
}
```

`orgId` is a required parameter, so no unscoped call shape remains to be
reintroduced — adding one would not compile. The tenant constraint rides in the
same query that gates `WorkflowRun` creation.

**2. `triggerWorkflowRun` authenticates and authorizes.** The second argument is
the `[orgId]` URL segment, which the router fills with the organization **slug**
(`src/app/router/page.tsx:38`). The action calls `getOrgAccess(orgslug)` first;
on `null` it returns `{ success: false, error: "Unauthorized" }` before any
execution. It passes `access.organization.id` — the verified id, never the
client string — to `startWorkflow`.

**3. The test-run route authenticates independently.** It calls `auth()` and
returns `401` without a session. Because the route carries no organization in its
path, the tenant is derived server-side through a **membership-constrained**
predicate:

```ts
db.workflow.findFirst({
  where: { id: workflowId, organization: { memberships: { some: { userId } } } },
  select: { id: true, orgId: true },
});
```

A workflow owned by another tenant matches nothing — the same `404` as a
nonexistent workflow, so the route is not an existence oracle — and the resolved
`orgId` is what is passed to `startWorkflow`.

The trusted internal QStash worker (`src/app/api/workflow/route.ts`) is unchanged:
it is signature-verified and calls `advanceWorkflow`, not `startWorkflow`.

## Regression tests (mutation-sensitive)

| File | Properties |
|---|---|
| `src/tests/workflow/trigger-tenant-scope.test.ts` | lookup predicate carries `orgId`; foreign workflow refused **and** `workflowRun.create` / `advanceWorkflow` not called; missing and foreign yield the same error; same-org positive path creates the run and advances. |
| `src/tests/workflow/workflow-run-boundary-scope.test.ts` | action: unauthorized ⇒ refused, no `startWorkflow` call; verified org id (not the slug) passed; refusal propagates. route: unauthenticated ⇒ `401` with no lookup; lookup is membership-scoped and starts with the resolved org; foreign and missing both `404` with the same response shape and no `startWorkflow` call. |

## Verification

- Focused suites: **10/10** across the two new files.
- Full Jest: **58 suites / 1087 tests** pass (was 56 / 1077).
- `tsc --noEmit`: clean (exit 0).
- ESLint on changed files: clean.
- `git diff --check`: clean.
- Level: **unit / route-level with mocked boundaries** (auth, `getOrgAccess`,
  Prisma, `startWorkflow`, `advanceWorkflow`). A real-Postgres cross-tenant
  integration run was **not** performed in *this* pass; the mocked predicates
  mirror the production query text exactly.

**Gate status (superseded 2026-10-20).** The real-PostgreSQL acceptance run this
note deferred was subsequently performed and passed — **I6 is `VERIFIED` and 37.12
is unblocked.** See `docs/dev-log/2026-10-20-i6-real-db-acceptance.md`
(`src/tests/security/i6-cross-tenant.realdb.test.ts`, 10/10). The record above
stands as the source-fix pass; it is no longer the last word on Gate G.

## Constraints honored

No workflow was executed; no `WorkflowRun` was created; no QStash message was
enqueued; the evaluator, resolver, registry, locking, queueing, retry and
compensation were not changed; nothing was staged or committed by the agent.

## Files changed

- `src/lib/workflow/execution/trigger.ts`
- `src/app/actions/workflows/workflow-run.ts`
- `src/app/api/workflow/test/[workflowId]/test-run/route.ts`
- `src/tests/workflow/trigger-tenant-scope.test.ts` (new)
- `src/tests/workflow/workflow-run-boundary-scope.test.ts` (new)

## Follow-up (unrelated, not I6)

A plain-string sentinel in a clarified proposal still fails `isReferenceTemplate`
(`workflow-proposal.ts:293`) and can re-arm the loop (`:427`). Tracked
separately.
