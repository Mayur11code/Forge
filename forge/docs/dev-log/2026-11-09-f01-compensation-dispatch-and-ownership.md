# 2026-11-09 — F-01 Compensation Dispatch & F-05A Ownership Foundation

**Scope.** Remediate the P0 defect where Saga compensation was completely bypassed by worker terminal-status guards (F-01), and establish exclusive atomic claim ownership and fencing for compensation executions (F-05A) to eliminate concurrent claim races.

---

## 1. Root Cause Analysis

### F-01: Terminal-Status Guard Early Return
In `forge/src/app/api/workflow/wf.ts`, `handleExecuteWorkflowNode()` inspected `TERMINAL_STATUSES` before determining the intended operation:
```typescript
// Previous buggy check:
if (TERMINAL_STATUSES.includes(stepRun.status)) {
  return { success: true, skipped: true };
}
```
Because `TERMINAL_STATUSES` contained `SUCCESS`, when a workflow failed at a downstream step and entered `phase: "ROLLING_BACK"`, upstream steps that had previously completed with `SUCCESS` were evaluated as terminal. The worker exited immediately, completely bypassing the mapped `COMPENSATE` operation and stranding workflows in perpetual or partial rollback states.

### F-05A: Concurrent Compensation Claiming
Previously, steps in `COMPENSATING` could be re-claimed by duplicate or concurrent QStash deliveries (`claimableFrom: ["SUCCESS", "COMPENSATING"]`) without fencing tokens, leading to split-brain dual executions of compensating actions.

---

## 2. Architecture & Implementation

### 2.1 F-01 Operation Resolution & Dispatch Fix
`handleExecuteWorkflowNode()` in `wf.ts` was refactored to resolve the intended operation before evaluating terminal guards:
1. If `run.phase === "ROLLING_BACK"`:
   - Steps in `SUCCESS`, `COMPENSATING`, or `COMPENSATION_RETRYING` map to `operation = "COMPENSATE"`.
   - Steps in `COMPENSATED` or `SKIPPED` are terminal for compensation and safely return `{ success: true, skipped: true }`.
2. Forward execution (`run.phase !== "ROLLING_BACK"`):
   - Steps in `PENDING` or `RETRYING` map to `operation = "EXECUTE"`.
   - Steps in `SUCCESS` return early as already completed.

### 2.2 F-05A Compensation Ownership Foundation
A new Prisma migration (`20261109180000_compensation_ownership_foundation`) introduced dedicated compensation tracking columns to `StepRun`:
- `compensationClaimToken`: CUID fencing token assigned atomically on claim acquisition.
- `compensationClaimExpiresAt`: Lease timestamp for crash detection and recovery.
- `compensationAttempts`: Separate attempt counter for compensation retries.
- `compensationStartedAt` & `compensationCompletedAt`: Timing and audit metadata.

The new module `forge/src/lib/workflow/execution/compensation-claim.ts` implements:
- `claimStepCompensation()`: Atomic CAS claim via `UPDATE "StepRun" ... WHERE id = :id AND (status IN ('SUCCESS', 'COMPENSATION_RETRYING') OR (status = 'COMPENSATING' AND "compensationClaimExpiresAt" < NOW()))`.
- `completeStepCompensation()`: Fenced state transition to `COMPENSATED` requiring the exact matching claim token.
- `failStepCompensation()`: Fenced transition to `COMPENSATION_RETRYING` (with backoff) or `COMPENSATION_FAILED` once retry limits are exhausted.

### 2.3 Evaluator Convergence
The DAG evaluator in `forge/src/lib/workflow/execution/evaluator.ts` was aligned to:
- Push compensating nodes in reverse topological order.
- Transition workflow runs to `ROLLED_BACK` once all compensable steps reach `COMPENSATED` or `SKIPPED`.
- Transition workflow runs to `REQUIRES_INTERVENTION` if any compensator fails.

---

## 3. Verification & Evidence

### Unit Tests
- `forge/src/tests/workflow/compensation-claim.test.ts` (**6/6 PASS**): Verified atomic claim acquisition, claim conflict rejection, lease expiry reclamation, and token fencing.
- `forge/src/tests/workflow/workflow-saga-rollback.test.ts` (**9/9 PASS**): Verified reverse topological compensation ordering, duplicate delivery suppression, and terminal status convergence.

### Real-Database Acceptance
- `forge/src/tests/workflow/compensation-concurrency.realdb.test.ts` (**4/4 PASS**): Real PostgreSQL concurrency testing against Neon DB verifying atomic claim races (only 1 winner among concurrent workers), lease-expiration recovery, and token fencing.

---

## 4. Modified & Created Files
- `forge/prisma/schema.prisma` (schema update for claim fields)
- `forge/prisma/migrations/20261109180000_compensation_ownership_foundation/migration.sql` (PostgreSQL migration)
- `forge/src/lib/workflow-types/type.ts` (compensation status enums and contracts)
- `forge/src/lib/workflow/execution/compensation-claim.ts` (claim engine)
- `forge/src/app/api/workflow/wf.ts` (worker dispatch & phase check)
- `forge/src/lib/workflow/execution/wrapper.ts` (operation wrapper)
- `forge/src/tests/workflow/compensation-claim.test.ts`
- `forge/src/tests/workflow/workflow-saga-rollback.test.ts`
- `forge/src/tests/workflow/compensation-concurrency.realdb.test.ts`
