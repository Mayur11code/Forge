# 2026-10-20 — I6 real-database acceptance run (Gate G)

**Scope.** Provide the acceptance evidence Gate G requires for I6 (cross-tenant
workflow execution): a **real-PostgreSQL** demonstration that a caller
authenticated for one organization cannot start another organization's workflow,
and that **no `WorkflowRun` row is created** when they try — plus the same-org
positive control, so the fix cannot degenerate into a blanket denial.

The source fix and its mocked suites were already complete (see
`2026-10-20-i6-cross-tenant-execution.md`). What was missing was execution against
a real database; the mocked suites only assert the tenant predicate is *passed* to
`findFirst` and never run SQL.

## Result

**PASSED — I6 is `VERIFIED`.** New suite
`src/tests/security/i6-cross-tenant.realdb.test.ts`: **10/10** against the
configured PostgreSQL database; fixtures created and removed with zero rows left
behind (verified by a post-run count). `tsc --noEmit` exit 0; ESLint exit 0.

## How a real-DB acceptance run is wired

The default Jest project refuses a real connection on purpose
(`jest.setup-db-guard.ts` throws the moment `PrismaClient` is constructed). Rather
than weaken that guard, a second, separate project was added:

| File | Role |
|---|---|
| `jest.setup-realdb.ts` (new) | Neutralises `server-only` only; **omits** the `PrismaClient` refusal. |
| `jest.realdb.config.ts` (new) | Same resolution/`.env` loading as the default config, but `setupFilesAfterEnv` points at `jest.setup-realdb.ts`; `forceExit` since `pg.Pool` is not closed by `$disconnect()`. |
| `jest.config.ts` (edit) | `testPathIgnorePatterns: ['\\.realdb\\.test\\.ts$']` — the guard-protected run must never discover these suites. |

**Convention:** real-DB suites are named `*.realdb.test.ts` and run with

```
npx jest --config jest.realdb.config.ts src/tests/security/i6-cross-tenant.realdb.test.ts
```

## What the acceptance suite keeps real vs mocked

- **Real:** Prisma/Postgres (`@/lib/prisma/db`), `getOrgAccess` (its real
  membership `findUnique`), `startWorkflow` (its real tenant-scoped lookup),
  `triggerWorkflowRun`, and the test-run route.
- **Mocked:** `auth()` — NextAuth needs a request/cookie scope a Jest process does
  not have, and identity is not what Gate G disputes; and `advanceWorkflow` — the
  engine's first domino, which would otherwise acquire a real Redis lock and
  publish real QStash messages that dispatch real actions.

Side-effect budget: with `advanceWorkflow` mocked, the run touches only Postgres.
No QStash, Redis, Gemini, Pusher or email call is reachable.

## Fixtures and hygiene

Two tenants (`orgA` slug-prefixed, `orgB`), a user + ADMIN membership each, and one
workflow owned by each. Crucially, **user A is not a member of org B** and vice
versa. Rows use a unique run-scoped `i6acc_…` prefix; `afterAll` deletes them in
FK-safe order (runs → workflows → memberships → users → orgs) and asserts the
post-cleanup counts are all zero. Cleanup is idempotent and prefix-driven so a
partially-completed `beforeAll` cannot leak rows.

## Properties asserted (the Gate G evidence)

1. `startWorkflow(orgA.id, workflowB.id)` rejects with the not-found error and a
   real `workflowRun.count({ workflowId: workflowB.id }) === 0` — the real-SQL
   analogue of `expect(create).not.toHaveBeenCalled()`.
2. A nonexistent workflow is refused indistinguishably (no existence oracle).
3. Positive control: `startWorkflow(orgA.id, workflowA.id)` creates exactly one
   `RUNNING` run with the expected `context.trigger.outputs`, and `advanceWorkflow`
   is reached with that run id.
4. `triggerWorkflowRun(workflowB.id, SLUG_B)` for a member of A returns
   `{ success:false, error:"Unauthorized" }` via **real** `getOrgAccess`, with no
   run created.
5. A payload-smuggled org id cannot redirect the tenant; no B run is created.
6. `POST` test-run for B's workflow returns **404** via a real membership-scoped
   query, body identical to a genuinely missing id, no `orgId` leaked, no run.
7. 401 for an unauthenticated test-run request, no side effects.

## Migration-state correction

`npx prisma migrate status` reports **"Database schema is up to date!"** — all 26
migrations, **including `20261017120000_agent_proposal_lifecycle` (the 37.8
migration)**, are applied to the configured database. Several docs still describe
that migration as "unapplied"; those statements are stale and were corrected.

## Constraints honored

No workflow was executed end-to-end; no `WorkflowRun` was created on any
refusal path; no QStash message was enqueued and no Redis lock taken
(`advanceWorkflow` mocked); the evaluator, resolver, registry, locking, queueing,
retry and compensation were not changed. Fixture rows were written to and removed
from the configured database (authorised for this run) with a verified
zero-leftover check. Nothing was committed by the acceptance run itself.

## Files

- `jest.realdb.config.ts` (new)
- `jest.setup-realdb.ts` (new)
- `jest.config.ts` (edit: ignore `*.realdb.test.ts`)
- `src/tests/security/i6-cross-tenant.realdb.test.ts` (new)
