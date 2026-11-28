# M4 — Real Event Triggers & Automation Implementation Report (FC-017, FC-018, FC-019)

- **Date:** 2026-11-28
- **Milestone:** M4 — Real Event Triggers & Automation (`FC-017`, `FC-018`, `FC-019`)
- **Methodology:** Universal Prompt Patterns Registry (UPPR) Rev 4.1
- **Status:** Automated Implementation & Verification Complete — **Awaiting Owner Manual Acceptance**

---

## 1. Executive Summary & Delivered Scope

Milestone M4 establishes real, durable, tenant-isolated domain event automation in Forge. It connects domain mutations across tasks and projects to published workflows through a transactional outbox, idempotent ignition ledger, deterministic payload filtering, and strict storm protection.

| Assignment | Capability | Status | Delivered Files |
|---|---|---|---|
| **FC-017** | Real Domain Event-to-Workflow Dispatch Engine | `DONE (Verified; Owner Acceptance PENDING)` | `src/lib/workflow/execution/event-dispatcher.ts`<br>`src/lib/events/domain-outbox.ts`<br>`src/lib/workflow/execution/trigger.ts`<br>`src/app/api/worker/route.ts`<br>`prisma/schema.prisma` |
| **FC-018** | Transactional Task & Project Domain Event Producers | `DONE (Verified; Owner Acceptance PENDING)` | `src/lib/tasks/create-task.ts`<br>`src/lib/tasks/update-task.ts`<br>`src/lib/projects/create-project.ts`<br>`src/lib/workflow/actions/core/create-task.ts`<br>`src/lib/prisma/extended.ts`<br>`src/lib/events/domain-event-mapping.ts` |
| **FC-019** | Trigger Filtering, Variable Propagation & Storm Protection | `DONE (Verified; Owner Acceptance PENDING)` | `src/lib/workflow-types/trigger-filter.ts`<br>`src/features/organizations/components/workflow/TriggerFilterEditor.tsx`<br>`src/features/organizations/components/workflow/PropertiesPanel.tsx`<br>`src/features/organizations/components/workflow/nodes/TriggerNode.tsx`<br>`src/lib/workflow/validation/diagnostics.ts` |

---

## 2. Core Invariants & Architecture Guarantees

### 2.1 The Critical Product Invariant: User Task vs. Workflow Task

A critical requirement of Forge's workflow automation is preventing recursive execution storms without breaking normal step execution:

1. **User-Originated Task Creation:**
   - When a human user creates a task through the UI or API (`createTaskInOrg`), the mutation writes the `Task` and `DomainEventOutbox` row inside a single atomic PostgreSQL `$transaction`.
   - The outbox record is marked with `originType: "USER"`, `workflowEligible: true`, `suppressionReason: null`, and `status: "PENDING"`.
   - The global event dispatcher picks up this event, queries active published workflows in that tenant matching `task.created`, and ignites them.

2. **Workflow-Originated Task Creation:**
   - When a running workflow executes a `task.create` step (`src/lib/workflow/actions/core/create-task.ts`), trusted execution provenance is passed: `{ originType: "WORKFLOW", workflowId: ctx.workflowId, workflowRunId: ctx.runId }`.
   - The task row is created with scalar fields `originType: "WORKFLOW"`, `originWorkflowId`, and `originWorkflowRunId` set atomically.
   - The associated `DomainEventOutbox` record is written with `originType: "WORKFLOW"`, `workflowEligible: false`, `suppressionReason: "WORKFLOW_ORIGINATED"`, and `status: "SUPPRESSED"`.
   - **Crucially, the task creation succeeds and returns `{ success: true, data: { taskId } }` to the action handler.** The current workflow receives the created task outputs and proceeds normally to subsequent steps. Vector synchronization proceeds normally.
   - The global domain event dispatcher evaluates `event.workflowEligible === false` and terminates dispatch immediately with 0 matched workflows, stopping any recursive cascade at depth 1.

3. **Subsequent Human Edit of Workflow-Created Task:**
   - If a human user later edits a workflow-created task via the task drawer or UI, `updateTaskInOrg` receives `origin: { originType: "USER" }`.
   - Eligibility is strictly based on the actor for the current mutation. The resulting `task.updated` outbox event has `originType: "USER"` and `workflowEligible: true`, allowing user-driven automations to execute legitimately.

### 2.2 Genuine State Transition Detection (`task.completed`)

- `updateTaskInOrg` pre-selects the prior status of the task under an ownership-scoped query.
- `task.completed` is emitted **if and only if** `existing.status !== "DONE" && updated.status === "DONE"`.
- Modifying the title, priority, or description of an already `DONE` task emits `task.updated` but **never** emits `task.completed`.

### 2.3 Elimination of Duplicate CDC Hooks

- Previously, both canonical task operations (`createTaskInOrg`, `updateTaskInOrg`) and the Prisma client extension (`src/lib/prisma/extended.ts`) independently emitted events, causing duplicate dispatches.
- The redundant best-effort `dispatchEvent` hooks for tasks were removed from `extended.ts`. All domain events are now transactionally persisted in `DomainEventOutbox`.

### 2.4 Idempotent Ignition via `WorkflowTriggerDispatch` Ledger

- Every potential ignition is recorded in `WorkflowTriggerDispatch` backed by a compound unique constraint: `@@unique([eventId, workflowId])`.
- If an event is redelivered (e.g. QStash retry or parallel sweeper ticks), the ledger record already exists with `status: "STARTED"` and `runId`. The dispatcher records `SKIPPED_ALREADY_STARTED` and skips creating duplicate `WorkflowRun` instances.

### 2.5 Strict Tenant Boundaries & Publication Race Protection

- `dispatchDomainEvent` queries candidate workflows filtering strictly by `orgId == event.orgId`. Cross-tenant events cannot be dispatched.
- `startWorkflow` executes an atomic row read under `FOR SHARE` locking, asserting that `publishedVersionId === expectedVersionId`. If a workflow is concurrently republished, ignition safely fails closed without creating runs against stale versions.

### 2.6 Deterministic Trigger Filter Engine

- Built with Zod schemas in `src/lib/workflow-types/trigger-filter.ts`.
- Supports operators: `equals`, `not_equals`, `in` (array or comma-delimited strings), and `contains` (case-insensitive substring or array containment).
- Supports compound `AND` and `OR` conjunctions.
- Fail-closed property path resolution with zero `eval` and prototype pollution guards.

---

## 3. Database Schema Changes & Migration

Generated migration: `prisma/migrations/20261127180000_m4_domain_event_outbox/migration.sql`

- Added `Task` columns: `originType`, `originWorkflowId`, `originWorkflowVersionId`, `originWorkflowRunId`, and `@@index([originType])`.
- Created `DomainEventOutbox` table:
  - `eventId` (`@unique`), `orgId`, `eventType`, `entityType`, `entityId`, `payload`, `originType`, `originWorkflowId`, `originWorkflowVersionId`, `originWorkflowRunId`, `workflowEligible`, `suppressionReason`, `leaseToken`, `leaseExpiresAt`, `status`, `attempts`, `maxAttempts`, `nextAttemptAt`, `processedAt`.
  - Indexes: `@@index([orgId, status, nextAttemptAt])`, `@@index([workflowEligible, status])`.
- Created `WorkflowTriggerDispatch` table:
  - `eventId`, `orgId`, `workflowId`, `workflowVersionId`, `runId` (`@unique`), `triggerType`, `status`, `filterEvaluated`, `filterPassed`, `filterReason`.
  - Compound unique constraint: `@@unique([eventId, workflowId])`.
  - Foreign keys to `Workflow`, `WorkflowVersion`, and optional one-to-one to `WorkflowRun`.

---

## 4. Automated Verification Results

### 4.1 Dedicated M4 Test Suites

- **FC-017 Dispatch Engine:** `src/tests/workflow/fc017-event-dispatcher.test.ts`
  - 6/6 tests passing: Tenant isolation, draft exclusion, publication race protection, idempotent ledger deduplication, partial fan-out isolation, sweeper batch processing.
- **FC-018 Task & Project Producers:** `src/tests/workflow/fc018-task-event-producers.test.ts`
  - 7/7 tests passing: User task creation, workflow task suppression, human update re-evaluation, state transition detection, already-done task update, transactional project creation.
- **FC-019 Trigger Filters & Storm Protection:** `src/tests/workflow/fc019-trigger-filters-and-storm.test.ts`
  - 8/8 tests passing: Deterministic filter operators (`equals`, `not_equals`, `in`, `contains`), compound AND/OR logic, fail-closed property resolution, variable propagation (`trigger.outputs`), storm suppression at depth 1.

### 4.2 Full Engine Regression Suite

- **Workflow Test Suites:** 36 passed / 36 total.
- **Workflow Tests:** 518 passed / 518 total (0 failures, 0 regressions).
- **TypeScript:** `npx tsc --noEmit` / `next build` passed with 0 errors.
- **ESLint:** `npm run lint` passed with 0 errors (clean exit code 0).
- **Next.js Production Build:** `npm run build` compiled with Turbopack, static page generation (21/21), exit code 0.

---

## 5. Post-Audit Remediation (M4-REM-1, M4-REM-2, M4-REM-3)

Following the independent post-implementation audit (`forge/docs/audits/2026-11-28-m4-independent-verification.md`), three targeted remediations were authorized and implemented:

### 5.1 M4-REM-1: Atomic Task Completion Transition (P0)
- **Problem:** Concurrent completion requests could both observe task status as non-DONE before writing, leading to duplicate `task.completed` domain events.
- **Solution:** In `src/lib/tasks/update-task.ts`, relocated row query inside `prisma.$transaction` with `SELECT FOR UPDATE` and implemented an atomic compare-and-swap update via `tx.task.updateMany({ where: { id: taskId, status: { not: "DONE" } }, data: { status: "DONE", completedAt: ... } })`. `task.completed` is emitted if and only if `transition.count > 0`.
- **Verification:** Dedicated adversarial test added in `src/tests/workflow/fc018-task-event-producers.test.ts` asserting exactly 1 `task.completed` event is emitted under concurrent completion attempts.

### 5.2 M4-REM-2: Atomic Lease Claiming on WorkflowTriggerDispatch (P0)
- **Problem:** Concurrent dispatch workers executing `startWorkflow()` could both create a `WorkflowRun` before updating dispatch status.
- **Solution:** In `src/lib/workflow/execution/trigger.ts`, introduced an atomic compare-and-swap ignition claim Step 0.2 (`updateMany({ where: { id: dispatchId, status: "PENDING", runId: null }, data: { status: "PROCESSING" } })`) *before* `tx.workflowRun.create`. If count is 0, the runner checks for an existing started run and throws `DISPATCH_ALREADY_CLAIMED_OR_STARTED`. In `src/lib/workflow/execution/event-dispatcher.ts`, catches conflict and records `SKIPPED_ALREADY_STARTED` without failing.
- **Verification:** Dedicated adversarial concurrent ignition test in `src/tests/workflow/fc017-event-dispatcher.test.ts` confirming zero duplicate `WorkflowRun` instances and graceful recovery.

### 5.3 M4-REM-3: Standing Production Outbox Sweeper (P1)
- **Problem:** If the post-commit QStash wakeup failed or timed out, pending outbox events remained unpolled without a standing cron mechanism.
- **Solution:** 
  1. Implemented `getDomainOutboxTelemetry()` in `src/lib/events/domain-outbox.ts` reporting backlog age, pending eligible count, and processing counts.
  2. Created `src/app/api/cron/domain-outbox/route.ts` supporting `GET` and `POST` authenticated via constant-time `crypto.timingSafeEqual` with `process.env.CRON_SECRET`.
  3. Configured recurring 60-second cron schedule in `forge/vercel.json` (`* * * * *`).
- **Verification:** Dedicated test suite `src/tests/workflow/cron-domain-outbox.test.ts` (8/8 tests passing) verifying authentication, batch processing, telemetry reporting, and error handling.

---

## 6. Final Remediation Quality Gates & Test Results

### 6.1 Dedicated M4 Test Suites (4/4 Suites, 32/32 Tests Passed)
- `src/tests/workflow/fc017-event-dispatcher.test.ts`: 8/8 passed
- `src/tests/workflow/fc018-task-event-producers.test.ts`: 8/8 passed
- `src/tests/workflow/fc019-trigger-filters-and-storm.test.ts`: 8/8 passed
- `src/tests/workflow/cron-domain-outbox.test.ts`: 8/8 passed

### 6.2 Full Engine Regression Suite
- **Workflow Engine Suites:** 37 passed / 37 total (100%).
- **Workflow Engine Tests:** 529 passed / 529 total (100%).

### 6.3 Code Quality & Build Gates
- **TypeScript:** `npx tsc --noEmit` clean exit code 0 (0 errors).
- **ESLint:** `npm run lint` clean exit code 0 (0 errors).
- **Turbopack Build:** `npm run build` clean exit code 0 (21 static pages + all dynamic API routes compiled).

---

## 7. Next Steps

- Request Owner Manual Acceptance for Milestone M4.
- Following acceptance, proceed to **Milestone M5: Actions and Integrations** (`FC-020` through `FC-023`).
