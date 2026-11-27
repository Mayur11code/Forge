# M3 — FC-015: Draft vs. Published State Management & Active Lifecycle

- **Date:** 2026-11-27
- **Assignment:** FC-015 — Draft vs. Published State Management & Active Lifecycle
- **Methodology:** UPPR Rev 4.1 (P1–P9, P14, P20, P21, P24, P26, P28)
- **Status:** Implemented & Verified by Automated Test Suite (Real-DB E3 Migration Application Deferred Pending Approved Disposable DB; Owner Manual Acceptance Pending)

## Summary of Changes

1. **Immutable `WorkflowVersion` Schema & Migration (`forge/prisma/schema.prisma`, `forge/prisma/migrations/20261127120000_workflow_version_lifecycle/migration.sql`)**
   - Added `WorkflowVersion` model with `@@unique([workflowId, versionNumber])` and `@@unique([id, workflowId, orgId])`.
   - Added `draftRevision Int @default(1)`, `publishedVersionId String? @unique`, and `publishedVersion` relation on `Workflow`, plus `workflowVersionId String?` on `WorkflowRun`.
   - Created SQL migration with composite ownership FK `Workflow_publishedVersion_ownership_fkey` and PostgreSQL `BEFORE UPDATE` immutability trigger `trg_workflow_version_immutable`. Verified with `npx prisma validate && npx prisma generate`.

2. **Server Lifecycle Actions & Engine Gating (`forge/src/app/actions/workflows/workflow.ts`, `forge/src/lib/workflow/execution/trigger.ts`)**
   - `saveWorkflowState`: creates unpublished inactive drafts (`isActive: false`, `draftRevision: 1`, `publishedVersionId: null`).
   - `updateWorkflowState`: supports `expectedDraftRevision` CAS check and increments `draftRevision` without altering `publishedVersionId` or `isActive`.
   - Added `publishWorkflowAction` (`FOR UPDATE` row lock, server-side `evaluateWorkflowDiagnostics` + `ActionRegistry` validation, `compileWorkflow`, `computeWorkflowDefinitionHash`, monotonic `versionNumber`, updates `publishedVersionId` and `isActive: true`).
   - Added `toggleWorkflowActiveAction` (rejects unpublished workflows, tenant-scoped `updateMany`).
   - Updated `startWorkflow` to reject `publishedVersionId === null` or `isActive === false`, load `WorkflowVersion` when `publishedVersionId` is set, and record `workflowVersionId` on `WorkflowRun`.

3. **Lifecycle UI (`WorkflowEditorHeader.tsx`, `WorkflowCanvas.tsx`, `workflows/[workflowId]/page.tsx`, `workflows/page.tsx`)**
   - Added Draft / `Published vN · Active` / `Published vN · Paused` badges, unsaved-edits / draft-differs indicators, `Publish` button, and `Activate`/`Pause` toggle.

## Verification

- `npx prisma validate && npx prisma generate`: passed.
- `src/tests/workflow/fc015-version-lifecycle.test.ts` (5 tests) + `workflow-update-scope.test.ts` + `workflow-metadata.test.ts` + `execution-handoff.test.ts` + `immutable-definition.test.ts`: passed (full `npm test`: 139/139 suites, 2120/2120 tests passed).
- `E3 Real-DB Migration`: **BLOCKED** — `.env` targets Neon DB; no approved disposable database was available for live migration execution.
