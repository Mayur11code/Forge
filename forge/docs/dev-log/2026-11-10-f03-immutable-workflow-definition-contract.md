# 2026-11-10 — F-03 Immutable Workflow Execution Contract & Action Version Pinning

**Scope.** Remediate the P0 architectural defect where runtime execution paths dynamically read mutable `Workflow.definition` rows during execution and compensation (F-03), establish immutable execution snapshots captured atomically under transactional row lock at workflow ignition, enforce database-level immutability via hardened PostgreSQL triggers and CHECK constraints, implement deterministic canonical definition hashing (`sha256:...`), pin explicit semantic versions on all registered actions, and isolate all runtime execution paths from canvas edits.

---

## 1. Root Cause Analysis

### F-03: Mutable Definition Reads & Unversioned Action Execution
Prior to this remediation, Forge runtime components (`evaluator.ts`, `wf.ts`, `resolver.ts`, `wrapper.ts`) resolved workflow topology, node configurations, dependencies, and action implementations by querying mutable database state:
```typescript
// Previous vulnerable execution pattern:
const run = await db.workflowRun.findUnique({
  where: { id: runId },
  include: { workflow: true, stepRuns: true },
});
const steps = (run.workflow.definition as WorkflowDefinition).steps;
```
This design created severe production vulnerabilities:
1. **Mid-Flight Graph Mutation:** If a user modified, added, or deleted nodes on the workflow canvas while an execution was in flight, the running workflow executed the modified graph instead of the one triggered. Deleting a node caused subsequent steps to crash or hang.
2. **Rollback Graph Divergence:** During Saga compensation, the rollback path resolved predecessor steps from the *current* workflow definition. If nodes were edited between forward execution and rollback, compensators executed against mutated configurations or failed to find compensatory nodes.
3. **Unversioned Action Code Upgrades:** Actions registered in `ActionRegistry` had no version contract. Deploying a new action implementation immediately affected in-flight runs and caused rollback compensations to run different code than the forward pass.
4. **Race Conditions at Ignition:** Canvas edits occurring concurrently with `startWorkflow()` could read half-applied definition updates.

---

## 2. Architecture & Implementation

### 2.1 Immutable Snapshot Envelope & Database Trigger Hardening
Added `definitionSnapshot Json?` and `definitionHash String?` columns to `WorkflowRun` via migration `20261110180000_workflow_run_immutable_definition`.

Further hardened database-level physical immutability via migration `20261110190000_workflow_run_snapshot_immutability_hardening`:
1. **Table CHECK constraint `chk_workflow_run_snapshot_pair`:**
   ```sql
   ALTER TABLE "WorkflowRun" ADD CONSTRAINT chk_workflow_run_snapshot_pair
   CHECK (
     ("definitionSnapshot" IS NOT NULL AND "definitionHash" IS NOT NULL) OR
     ("definitionSnapshot" IS NULL AND "definitionHash" IS NULL)
   );
   ```
2. **BEFORE INSERT trigger `trg_workflow_run_snapshot_insert`:**
   Enforces that every new `WorkflowRun` row must be created with both `definitionSnapshot` and `definitionHash` populated.
3. **BEFORE UPDATE trigger `trg_workflow_run_snapshot_immutable`:**
   Enforces strict immutability using `IS DISTINCT FROM` on both fields:
   ```sql
   CREATE OR REPLACE FUNCTION prevent_workflow_run_snapshot_mutation()
   RETURNS TRIGGER AS $$
   BEGIN
     IF NEW."definitionSnapshot" IS DISTINCT FROM OLD."definitionSnapshot" THEN
       RAISE EXCEPTION 'WorkflowRun definitionSnapshot is immutable and cannot be populated, modified, or cleared after creation';
     END IF;

     IF NEW."definitionHash" IS DISTINCT FROM OLD."definitionHash" THEN
       RAISE EXCEPTION 'WorkflowRun definitionHash is immutable and cannot be populated, modified, or cleared after creation';
     END IF;

     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;
   ```
   Ordinary `UPDATE` statements cannot populate either field on legacy rows (where both are NULL), nor modify or clear either field once populated. Unrelated column updates (e.g. `status`, `completedAt`) remain completely unaffected.

The envelope structure (`src/lib/workflow-types/snapshot.ts`) captures:
- `snapshotSchemaVersion: 1`
- `workflowId: string`
- `workflowName: string`
- `definition: WorkflowDefinition`
- `actionManifest: WorkflowActionManifestEntry[]` (pinned `(stepId, actionId, actionVersion)`)
- `createdAt: string` (ISO timestamp)

### 2.2 Deterministic Canonical Hashing (`canonical-hash.ts`)
Implemented canonical hashing producing `sha256:<hex>` digests with strict determinism:
1. **Recursive Object Key Sorting:** Object keys are sorted lexicographically at all nesting levels via `canonicalizeJson()`.
2. **Semantic Step Normalization:** Normalizes `steps` while strictly discarding non-semantic UI layout fields (`position`, `width`, `height`, etc.).
3. **Action Manifest Normalization:** Action manifest entries are sorted deterministically by `stepId`.
4. **Secret-Safe Serialization:** Strips sensitive runtime secrets before hashing, while preserving credential references (`apiKeyRef`, `connectionId`) intact in the execution snapshot.
5. **Snapshot Verification:** `verifyWorkflowSnapshotIntegrity(snapshot, expectedHash)` validates the envelope schema against Zod, checks schema version compatibility, re-computes the canonical digest, and rejects tampered or corrupt payloads before execution.

### 2.3 Atomic Workflow Ignition (`trigger.ts`)
Workflow ignition in `startWorkflow()` captures the execution contract inside a PostgreSQL transaction with row-level locking:
1. **Transactional Row Lock:** `SELECT id, "orgId", name, definition FROM "Workflow" WHERE id = $1 AND "orgId" = $2 FOR SHARE`. Prevents concurrent canvas saves from mutating definition during snapshot capture.
2. **Schema Validation:** Validates definition against `WorkflowDefinitionSchema` (DAG acyclicity, connectivity, ID matching).
3. **Action Manifest Construction:** Pins explicit semantic version for every action from the registry. If any action is unregistered or manifest is invalid, throws before creating `WorkflowRun` or dispatching events.
4. **Hash & Run Creation:** Computes canonical hash and creates `WorkflowRun` atomically with `definitionSnapshot` and `definitionHash`.

### 2.4 Strict Action Versioning & Registry Safety (`action-registry.ts`)
- Added mandatory `version: string` to `WorkflowAction` interface.
- Registered core actions with explicit versions (`createTaskAction` @ `1.0.0`, `generateReportAction` @ `1.0.0`, `sendEmailAction` @ `1.0.0`).
- Upgraded `ActionRegistry` to index by `(actionId, actionVersion)` via `formatActionKey(actionId, version)`.
- **Delimiter Collision Safety:** Both `actionId` and `actionVersion` are forbidden from containing the `@` delimiter, preventing composite key ambiguity. Provided `parseActionKey(key)` utility.
- **Deterministic Registration:** Re-registering the same instance is idempotent; registering a conflicting implementation with identical `(actionId, version)` throws `Duplicate action registration rejected`.
- Runtime lookup `getAction(actionId, version)` requires both arguments. Zero unversioned or latest-version fallbacks. If the exact pinned version is unavailable, the step fails safely and truthfully with audited error `ACTION_NOT_IN_REGISTRY`.
- **Dynamic Plugin Extension Points:** Dynamic plugins or user-defined actions register into `versionedActionStore` using `registerAction({ id, version, execute, compensate })`. Pinned manifests lock the exact plugin version at ignition, ensuring dynamic actions cannot change semantics for in-flight runs.

### 2.5 Complete Runtime Isolation
Removed all runtime reads of mutable `Workflow.definition`:
- `evaluator.ts`: Reads execution graph strictly from `run.definitionSnapshot.definition.steps`. On snapshot integrity failure, transitions run to `REQUIRES_INTERVENTION`, sets `completedAt`, and writes `EXECUTION_HALTED` audit log.
- `wf.ts`: Worker resolves node definition, action name, and action version from `run.definitionSnapshot`. If snapshot verification fails, immediately returns HTTP 400 (preventing endless QStash retry loops) and marks step `FAILED`.
- `wrapper.ts`: Dispatches action execution and compensation using the pinned version from `actionManifest`.
- Zero occurrences of `workflow.definition` remain across runtime execution paths.

### 2.6 Legacy Run Migration Policy
Active legacy runs (`PENDING`, `RUNNING`, `ROLLING_BACK`) lacking `definitionSnapshot` fail closed on their next evaluation cycle to `REQUIRES_INTERVENTION` with an explicit audit log: `Run lacks immutable execution snapshot; failing closed to REQUIRES_INTERVENTION`. Completed and rolled-back legacy rows remain read-only in the database.

---

## 3. Verification & Evidence

### 3.1 Unit Acceptance Test Suite (`src/tests/workflow/immutable-definition.test.ts`)
- **22/22 PASS**:
  - `F03-09`: Canonically equivalent definitions with reordered keys produce identical SHA-256 hashes.
  - `F03-10`: UI layout and coordinate changes do not alter canonical hash.
  - `F03-11`: Semantic definition modifications produce distinct canonical hashes.
  - `F03-12`: Tampered or corrupt snapshots are rejected by integrity verification.
  - `F03-13 & F03-14`: Active runs without snapshots fail closed to `REQUIRES_INTERVENTION`.
  - `F03-01 & F03-02`: Run preserves original DAG when workflow definition is subsequently modified.
  - `F03-03`: Deleting a node from workflow definition does not affect in-flight step execution.
  - `F03-04`: Modifying node config in definition does not affect running execution inputs.
  - `F03-05`: Editing workflow definition during forward run preserves rollback graph and compensator.
  - `F03-06 & F03-07`: Action version pinning enforces v1 execution and v1 compensation when v2 is registered.
  - `F03-08`: Unavailable pinned action version fails safely without fallback to latest version.
  - `F03-16`: Cross-tenant workflow start is rejected.
  - `F03-17`: Step retry preserves original frozen snapshot and pinned action version.
  - Section 3: Rejection of unregistered action in manifest before run creation or dispatch.
  - Section 3: Atomic creation with non-null snapshot and hash.
  - Section 3: Credential references preserved in snapshot while raw secrets redacted in hash payload without leaking in logs.
  - Section 3: Worker terminates delivery loop (HTTP 400) and marks step FAILED on integrity failure.
  - Section 4: Rejection of `@` delimiter in `actionId` to prevent composite key collision.
  - Section 4: Rejection of `@` delimiter in `actionVersion`.
  - Section 4: Deterministic parsing of action keys via `parseActionKey`.
  - Section 4: Deterministic duplicate registration (idempotent for same instance, throws for conflicting implementation).
  - Section 4: `getAction` returns exact pinned version, never silently falls back to latest.

### 3.2 Real PostgreSQL Acceptance Suite (`src/tests/workflow/immutable-definition.realdb.test.ts`)
- **12/12 PASS** against real Neon PostgreSQL database using independent `pg.Pool` connection:
  - `F-03.2 Section 2 Case 1`: Valid new insert succeeds with populated snapshot and hash.
  - `F-03.2 Section 2 Case 2`: New insert with snapshot only fails (trigger and CHECK constraint `chk_workflow_run_snapshot_pair`).
  - `F-03.2 Section 2 Case 3`: New insert with hash only fails (trigger and CHECK constraint `chk_workflow_run_snapshot_pair`).
  - `F-03.2 Section 2 Case 4`: New insert with neither fails (trigger `trg_workflow_run_snapshot_insert`).
  - `F-03.2 Section 2 Case 5`: Existing legacy NULL/NULL row remains readable.
  - `F-03.2 Section 2 Case 6`: Legacy NULL/NULL row cannot be populated by ordinary UPDATE (`trg_workflow_run_snapshot_immutable`).
  - `F-03.2 Section 2 Case 7`: Populated snapshot/hash cannot be modified (`trg_workflow_run_snapshot_immutable`).
  - `F-03.2 Section 2 Case 8`: Populated snapshot/hash cannot be cleared (`trg_workflow_run_snapshot_immutable`).
  - `F-03.2 Section 2 Case 9`: Normal WorkflowRun updates unrelated to snapshot/hash still work on both populated and legacy rows.
  - `F03-18`: Database trigger rejects direct UPDATE to `definitionSnapshot` or `definitionHash` once set.
  - `F03-15`: Concurrent workflow edit and workflow start produces clean atomic snapshots under row locks.
  - `F03-01 to F03-04`: Running execution in real DB proceeds strictly from snapshot despite DB changes.

### 3.3 Full Quality Gates Matrix
- `npx prisma validate`: **100% Valid**.
- `npx prisma migrate status`: **35 migrations deployed, Database schema is up to date**.
- `npx tsc --noEmit`: **0 errors, 100% clean**.
- `npx eslint`: **0 errors, 0 warnings** across all workflow files.
- Complete workflow unit suite (`src/tests/workflow/`): **26 test suites, 428 tests total: 100% PASS**.
- Real PostgreSQL test suite: **4 test suites, 30 tests total: 100% PASS**:
  - `src/tests/workflow/compensation-contract.realdb.test.ts`: 8/8 PASS
  - `src/tests/workflow/immutable-definition.realdb.test.ts`: 12/12 PASS
  - `src/tests/workflow/execution-handoff.realdb.test.ts`: 6/6 PASS
  - `src/tests/workflow/compensation-concurrency.realdb.test.ts`: 4/4 PASS
- Production build (`npm run build`): **100% SUCCESS** (all 39 routes compiled and optimized cleanly).

---

## 4. Modified & Created Files
- `forge/prisma/schema.prisma` (added `definitionSnapshot` and `definitionHash` to `WorkflowRun`)
- `forge/prisma/migrations/20261110180000_workflow_run_immutable_definition/migration.sql` (schema migration + immutability trigger)
- `forge/prisma/migrations/20261110190000_workflow_run_snapshot_immutability_hardening/migration.sql` (CHECK constraint, insert trigger, enhanced update trigger)
- `forge/src/lib/workflow-types/snapshot.ts` (execution snapshot envelope & Zod validation)
- `forge/src/lib/workflow-types/type.ts` (mandatory `version: string` on `WorkflowAction`)
- `forge/src/lib/workflow-types/action-registry.ts` (versioned store, exact lookup, proxy synchronization, collision prevention, key parsing)
- `forge/src/lib/workflow/validation/canonical-hash.ts` (canonical JSON normalization & SHA-256 hashing)
- `forge/src/lib/workflow/execution/trigger.ts` (atomic ignition with `FOR SHARE` row lock)
- `forge/src/lib/workflow/execution/evaluator.ts` (snapshot-exclusive graph evaluation, fail-closed legacy policy, integrity audit logs)
- `forge/src/app/api/workflow/wf.ts` (worker node resolution from frozen snapshot, QStash loop termination with HTTP 400)
- `forge/src/lib/workflow/execution/wrapper.ts` (exact version lookup, fail-safe `ACTION_NOT_IN_REGISTRY`)
- `forge/src/lib/workflow/actions/core/create-task.ts` (pinned version `"1.0.0"`)
- `forge/src/lib/workflow/actions/core/generate-report.ts` (pinned version `"1.0.0"`)
- `forge/src/lib/workflow/actions/core/send-email.ts` (pinned version `"1.0.0"`)
- `forge/src/lib/prisma/extended.ts` (guarded `$extends` method typing)
- `forge/src/tests/workflow/helpers/prisma-double.ts` (double support for snapshot synthesis)
- `forge/src/tests/workflow/immutable-definition.test.ts` (22-scenario unit acceptance suite)
- `forge/src/tests/workflow/immutable-definition.realdb.test.ts` (12-scenario real Neon PostgreSQL acceptance suite with 9 direct SQL cases)
- `forge/src/tests/workflow/compensation-contract.realdb.test.ts` (updated test fixtures for immutable snapshots)
- `forge/src/tests/workflow/compensation-concurrency.realdb.test.ts` (updated test fixtures for immutable snapshots)
- `forge/docs/dev-log/2026-11-10-f03-immutable-workflow-definition-contract.md` (this dev-log)
