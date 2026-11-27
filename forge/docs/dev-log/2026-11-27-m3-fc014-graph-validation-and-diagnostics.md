# M3 — FC-014: Graph Validation & Actionable Error Diagnostics

- **Date:** 2026-11-27
- **Assignment:** FC-014 — Graph Validation & Actionable Error Diagnostics
- **Methodology:** UPPR Rev 4.1 (P1, P2, P3, P5, P9, P14, P24, P26, P28)
- **Status:** Implemented & Verified by Automated Test Suite (Owner Manual Acceptance Pending)

## Summary of Changes

1. **Unified Graph Diagnostics Engine (`forge/src/lib/workflow/validation/diagnostics.ts`)**
   - Implemented `evaluateWorkflowDiagnostics` extending `collectWorkflowDefinitionIssues` and `validateActionNodeConfig`.
   - Attaches `severity: "ERROR" | "WARNING"`, `blocksPublish`, node/edge attribution, trigger cardinality checks, and non-blocking `INDEPENDENT_COMPONENT` warnings while preserving independent-root DAG support.

2. **Trigger vs. Action Manifest Fix (`forge/src/lib/workflow/execution/trigger.ts`)**
   - Fixed manifest validation during `startWorkflow` so `step.kind === "TRIGGER"` validates against `AVAILABLE_TRIGGERS` and is excluded from `actionManifest`, while only `ACTION` steps require `ActionRegistry` entries.

3. **Canvas Node & Header Diagnostics UI**
   - `forge/src/features/organizations/components/workflow/nodes/TriggerNode.tsx` and `ActionNode.tsx`: Added live diagnostic error/warning badges and inline issue summaries.
   - `forge/src/features/organizations/components/workflow/WorkflowEditorHeader.tsx` & `WorkflowCanvas.tsx`: Added live diagnostics pill and popover with click-to-focus (`fitView`) on problematic nodes.

## Verification

- `src/tests/workflow/fc014-diagnostics-and-trigger-manifest.test.ts`, `src/tests/workflow/dag-validation.test.ts`, `src/tests/workflow/immutable-definition.test.ts`: passed (also included in full `npm test` run: 139/139 suites, 2120/2120 tests passed).
- `npx tsc --noEmit`: 0 errors.
