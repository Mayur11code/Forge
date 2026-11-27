# M3 — FC-016: Safe Manual Workflow Simulation & Trigger Output Preview

- **Date:** 2026-11-27
- **Assignment:** FC-016 — Manual Test-Run Drawer & Trigger Output Preview
- **Methodology:** UPPR Rev 4.1 (P1, P2, P3, P5, P9, P14, P24, P26, P28)
- **Status:** Implemented & Verified by Automated Test Suite (Owner Manual Acceptance Pending)

## Summary of Changes

1. **Zero-Side-Effect Simulation Engine (`forge/src/lib/workflow/execution/simulator.ts`)**
   - Implemented `simulateWorkflowRun` using topological Kahn execution over `WorkflowDefinition`, `resolveInputs`, and pure `executeConditionNode`.
   - Uses explicit sandbox adapters (`task.create` returns synthetic `sim_task_<stepId>`, `logic.condition` evaluates `TRUE`/`FALSE` branches and marks unmatched branches `SKIPPED`, `logic.delay` records simulated delay without sleeping, and unsupported actions fail safely without calling `ActionRegistry` or Prisma).
   - Enforces `MAX_SIMULATION_STEPS = 50`, recursive secret/token redaction (`redactSimulationValue`), and `MAX_SIMULATION_OUTPUT_CHARS = 4096` truncation.

2. **Server Simulation Boundary (`forge/src/app/actions/workflows/workflow-run.ts`)**
   - Added `simulateWorkflowRunAction` with `getOrgAccess`, `RATE_LIMIT_POLICIES.REQUEST_WORKFLOW_TEST_RUN`, JSON syntax validation, `validateTriggerContext`, tenant-scoped `db.workflow.findFirst` / `db.workflowVersion.findFirst`, `evaluateWorkflowDiagnostics` check on draft targets, and `draft` vs `published` target selection.

3. **Simulation Modal UI (`WorkflowTestRunModal.tsx`, `WorkflowEditorHeader.tsx`, `WorkflowCanvas.tsx`, `RunWorkflowButton.tsx`)**
   - Built `WorkflowTestRunModal.tsx` clearly badged **Dry Run · Zero Side Effects**, with `Saved Draft` vs `Published vN` target selector, pre-populated sample trigger JSON based on `AVAILABLE_TRIGGERS`, unsaved-edits warning, and step-by-step resolved inputs, redacted outputs, skipped branches, errors, and durations.
   - Separated **Simulate** (sandbox dry run) from **Run Live** (`RunWorkflowButton` with `label="Run Live"` shown only when published & active).

## Verification

- `src/tests/workflow/fc016-safe-simulation.test.ts` (6 tests): verified interpolation, conditional branching, unsupported action safety, redaction/truncation, auth/rate-limit/JSON/cross-tenant rejection, draft vs published simulation, and zero calls to `task.create`, `workflowRun.create`, `workflowOutbox.create`, `startWorkflow`, or `advanceWorkflow`.
- Full `npm test`: 139/139 suites, 2120/2120 tests passed.
