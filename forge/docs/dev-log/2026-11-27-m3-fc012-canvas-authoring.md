# 2026-11-27 — Milestone M3 Unit 1: FC-012 Canvas Authoring UX, Workflow Naming & Notifications

**Baseline Branch:** `feat/m1-identity-and-latenight-landing`  
**Baseline HEAD SHA:** `5d533a8b3de93cf34dd4879cb84000a54f02f9d3` (audit report untracked in `forge/docs/audits/`)  
**Scope:** `FC-012` only (Canvas Authoring UX, Workflow Naming & Toast Notifications)  
**Owner Acceptance Status:** **PENDING** (Awaiting manual browser walkthrough)

---

## 1. Files Changed

| File | Change Type | Purpose |
|---|---|---|
| `src/app/actions/workflows/workflow.ts` | Modified | Added `WorkflowNameSchema` (1–100 chars) & `WorkflowDescriptionSchema` (max 500 chars, empty normalized to `null`). Extended `saveWorkflowState` with optional `description` and `updateWorkflowState` with optional `metadata?: { name?: string; description?: string | null }` written atomically in the single `updateMany` predicate. |
| `src/features/organizations/components/workflow/WorkflowEditorHeader.tsx` | Created | Dedicated header bar supporting inline workflow `name` (default `"Untitled workflow"`) and optional `description` editing with `Enter` confirm, `Escape` cancel, focus/select, pending-state lock, `RunWorkflowButton`, and Save action. |
| `src/features/organizations/components/workflow/WorkflowCanvas.tsx` | Modified | Replaced hardcoded `"My First Automation"`, wired `WorkflowEditorHeader`, replaced all 6 `alert()` calls with `sonner` `toast.success`/`toast.error`, added duplicate-submit `isPending` guard, and mounted dark-themed `<MiniMap />`. |
| `src/features/organizations/components/workflow/RunWorkflowButton.tsx` | Modified | Replaced `alert()` calls with `toast.success("Workflow execution started.")` and `toast.error(...)`. |
| `src/app/org/[orgId]/workflows/[workflowId]/page.tsx` | Modified | Passed `initialName={workflow.name}` and `initialDescription={workflow.description}` to `WorkflowBuilder`. |
| `src/app/org/[orgId]/workflows/page.tsx` | Modified | Rendered `wf.description` preview on workflow cards when present. |
| `src/tests/workflow/workflow-metadata.test.ts` | Created | Server action tests for metadata creation/update, validation, omission preservation, compile failure atomicity, and cross-tenant isolation. |
| `src/tests/workflow/workflow-canvas-fc012.test.tsx` | Created | jsdom UI tests for default/persisted title & description, Enter/Escape keyboard editing, Sonner toasts, duplicate-save guard, and `<MiniMap />` / `<Controls />`. |
| `src/tests/workflow/run-workflow-button.test.tsx` | Modified | Updated assertions from `window.alert` to `sonner` `toast.success`/`toast.error`. |

---

## 2. Architecture Reused & Invariants Preserved

- **Schema & Migrations:** Zero database changes; reused existing `Workflow.name` and `Workflow.description` (`prisma/schema.prisma:563-564`).
- **Notifications:** Reused installed `sonner` (`^2.0.7`) and root `<Toaster />` (`src/app/layout.tsx:34`).
- **Tenant Isolation:** `saveWorkflowState` and `updateWorkflowState` continue deriving `orgId` solely from `getOrgAccess(orgslug)` and scoping `findFirst` + `updateMany` by `{ id: workflowId, orgId: access.organization.id }`.
- **Persistence Atomicity:** Metadata and compiled graph are validated before any DB write and persisted in a single `updateMany` call; omitted metadata never overwrites existing `name`/`description`.
- **Runtime Isolation:** `WorkflowRun.definitionSnapshot`, action version pinning, and execution semantics remain completely untouched.

---

## 3. Verification & Evidence

- **Static Checks (E1):**
  - `npx tsc --noEmit` &rarr; **0 errors**
  - `npx eslint` on all 9 changed/added files &rarr; **0 errors, 0 warnings**
- **Targeted Unit & UI Suites (E2, Jest with `jest.setup-db-guard.ts`):**
  - `workflow-metadata.test.ts`, `workflow-canvas-fc012.test.tsx`, `workflow-node-validation.test.ts`, `workflow-update-scope.test.ts`, `run-workflow-button.test.tsx`, `dag-validation.test.ts` &rarr; **6/6 suites PASSED (76/76 tests)**.
- **Known Limitations:**
  - `*.realdb.test.ts` (E3) and live browser E2E walkthrough were not executed in this unit; real PostgreSQL persistence and visual MiniMap/toast UX await owner manual acceptance.
  - Pre-existing `RunWorkflowButton` still triggers `startWorkflow()` (sandbox simulation is scoped to `FC-016`).
