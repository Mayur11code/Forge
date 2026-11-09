# 2026-11-10 — F-02 Compensation Contract & Safe Task Rollback

**Scope.** Remediate the P0 defect where missing compensators were falsely reported as successful rollbacks (F-02), implement truthful workflow convergence to `REQUIRES_INTERVENTION`, and deliver real, safe task reversal in `createTaskAction.compensate()` with PostgreSQL row locking, foreign-key cascade protection, vector tombstoning, and durable crash-recovery receipts.

---

## 1. Root Cause Analysis

### F-02: False Rollback Success on Missing Compensators
In `forge/src/lib/workflow/execution/wrapper.ts`, missing compensator functions were previously treated as successful no-ops:
```typescript
// Previous buggy fallback:
if (operation === "COMPENSATE" && !action.compensate) {
  return { success: true };
}
```
If a workflow created a task or made external side-effects and subsequently failed at a downstream step, the uncompensated steps reported `{ success: true }`, causing the engine evaluator to falsely report the workflow run status as `ROLLED_BACK`. In reality, zero rollback had occurred and created artifacts were silently abandoned.

---

## 2. Architecture & Implementation

### 2.1 Fail-Safe Compensation Contract
`wrapStepOperation()` in `wrapper.ts` was redesigned with strict fail-safe rules:
1. **Explicit No-Op Exemption:** Only actions explicitly declaring `genuineNoOp: true` in their definition are permitted to skip compensation with `{ success: true }`.
2. **Truthful Compensation Failure:** Any action without an explicit `compensate()` implementation and without `genuineNoOp: true` fails truthfully, marking the step run `COMPENSATION_FAILED`.
3. **Truthful Convergence:** The DAG evaluator in `wf.ts` / `evaluator.ts` detects `COMPENSATION_FAILED` and converges the workflow run to `REQUIRES_INTERVENTION`.

### 2.2 Real Task Compensation (`createTaskAction.compensate`)
`createTaskAction.compensate()` was implemented in `forge/src/lib/workflow/actions/core/create-task.ts` with strict transactional safety:

1. **Pre-Transaction Idempotency Fence:**
   Checks `ExecutionAuditLog` for an existing `COMPENSATION_TASK_DELETED` receipt. If present, returns `{ success: true, alreadyCompensated: true }` immediately.
2. **PostgreSQL Row Locking (`FOR UPDATE OF t`):**
   ```sql
   SELECT t.id, t."orgId", t."projectId", t.title, t.description, t.status, t.priority,
          t."assignedToId", t."createdAt", p."orgId" AS "projectOrgId"
   FROM "Task" t
   JOIN "Project" p ON t."projectId" = p.id
   WHERE t.id = ${taskId}
   FOR UPDATE OF t;
   ```
   Acquires an exclusive lock on the task row, serializing concurrent user updates and blocking concurrent comment/attachment insertions via foreign key `FOR KEY SHARE` conflicts.
3. **Tenant & Project Isolation:**
   Resolves trusted `orgId` from the DB using `ctx.runId` and verifies `task.orgId === orgId` and `project.orgId === orgId`.
4. **Precondition & Mutation Checks:**
   - Precondition: `task.status === "TODO"`. If modified (e.g. `IN_PROGRESS`), deletion is refused.
   - Field diffs: Compares `title`, `description`, `priority`, and `assignee` against `taskSnapshot` / inputs. Refuses deletion if modified.
5. **Cascade & User Data Protection:**
   Queries `tx.comment.count({ where: { taskId } })` and `tx.attachment.count({ where: { taskId } })`. If any comments or attachments exist, refuses cascading deletion to prevent user data loss.
6. **Vector State Machine Tombstoning:**
   - Marks pending `VectorOutbox` jobs as `FAILED`.
   - Calls `tombstoneEntityHead(tx, ...)` to set `isTombstone = true`, reset `activeGenId = NULL`, and fail in-flight `VectorGeneration` records. PostgreSQL check constraint `chk_head_tombstone_no_active_gen` and embedding worker locks prevent vector resurrection.
7. **Atomic Task Deletion & Durable Receipt:**
   Deletes the task row and inserts a `COMPENSATION_TASK_DELETED` receipt into `ExecutionAuditLog` within the same transaction.
8. **Best-Effort CDC Dispatch:**
   Dispatches `TASK_DELETED` event post-commit for legacy vector worker cleanup.

---

## 3. Verification & Evidence

### Unit Tests (`src/tests/workflow/compensation-contract.test.ts`)
- **10/10 PASS**:
  - Scenario 1: Unmodified task deleted and workflow converges to `ROLLED_BACK`.
  - Scenario 2 & 3: User-modified task or status change refuses deletion and converges to `REQUIRES_INTERVENTION`.
  - Scenario 4 & 5: Tasks with comments or attachments refuse cascading deletion to protect user data.
  - Scenario 6: Cross-tenant compensation attempts are rejected.
  - Scenario 8: Duplicate compensation deliveries are skipped safely.
  - Scenario 9: Crash-after-delete retry detects durable receipt and completes idempotently.
  - Scenario 10: Multi-step Saga rollback (A $\to$ B $\to$ C).
  - Scenario 11: Missing compensator fails truthfully and converges to `REQUIRES_INTERVENTION`.

### Real-Database Acceptance (`src/tests/workflow/compensation-contract.realdb.test.ts`)
- **4/4 PASS**: Real PostgreSQL executions against Neon DB confirming physical deletion, comment cascade abort, field mutation abort, and receipt-driven idempotency.

### Independent Review (F-02.3)
- Formal audit report generated in `F02_3_REAL_TASK_COMPENSATION_AUDIT_REPORT.md` with final disposition: **`ACCEPTED WITH DOCUMENTED FOLLOW-UPS`**.

---

## 4. Modified & Created Files
- `forge/src/lib/workflow/actions/core/create-task.ts` (task compensation logic)
- `forge/src/lib/workflow/execution/wrapper.ts` (fail-safe contract enforcement)
- `forge/src/lib/workflow-types/type.ts` (contract interfaces)
- `forge/src/app/api/workflow/wf.ts` (evaluator intervention convergence)
- `forge/src/tests/workflow/compensation-contract.test.ts` (unit suite)
- `forge/src/tests/workflow/compensation-contract.realdb.test.ts` (real-DB suite)
- `forge/docs/dev-log/2026-11-10-f02-compensation-contract-and-task-rollback.md` (this dev-log)
