# M3.1 — Workspace UI Revamp, Simulation Engine & CI Hardening

- **Date:** 2026-11-27
- **Milestone:** M3 / M3.1 — Complete Workflow Builder & Workspace Polish
- **Methodology:** UPPR Rev 4.1
- **Status:** Complete, Verified by Automated Test Suite & Pushed to Remote

## 1. Summary of Changes

### 1.1 Landing Page Performance & Interactive DAG Workflow
- **Mouse Pointer & Rendering Optimization:** Diagnosed and resolved low-FPS pointer jitter on `/` caused by high-frequency mouse event handlers and heavyweight 3D cassette meshes. Replaced 3D cassettes with an interactive, responsive workflow DAG canvas.
- **Interactive Workflow DAG Simulation:** Added interactive simulation controls (Play, Pause, Step-by-Step, Reset, Speed toggle, and Step Rollback) illustrating real-time node state transitions (IDLE, PROCESSING, COMPLETED, ROLLED_BACK).
- **Typography & Aerospace Aesthetic:** Replaced default sans fonts with crisp monospace typography (`font-mono`, `text-[10px]`, `tracking-wider`) and warm amber/cyan aerospace design tokens matching Kind 50 / Bizarro aerospace specifications.
- **Entryway Flow:** Rewired the "Enter Forge" CTA button directly to `/dashboard`. Unauthenticated visitors are cleanly redirected to `/login`, and sign-in button copy was updated to "Sign Up" where requested for initial onboarding.

### 1.2 Workflow Canvas Authoring & Node Diagnostics
- **Node Input Completeness Resolution:** Resolved an issue where Action nodes displayed "Missing Data" even after titles were entered. Updated `missingVariables` in `ActionNode.tsx` to recognize node title input from both `data.config.title` and `data.label`.
- **Publish vs. Save Draft Clarity:** Reconciled grayed-out publish states with clear visual indicators informing operators when drafts must be saved before immutable version publication.

### 1.3 Simulation Engine Enhancements & White Glow State
- **Sequential Multi-Node Downstream Flow:** Resolved simulation engine stall where execution failed to propagate past the initial node to downstream nodes. State now sequentially advances with real-time output storage across the topological graph.
- **White Glow Processing State:** Upgraded the visual processing indicator across `ActionNode.tsx`, `ExecutionEdge.tsx`, and `WorkflowLiveViewer.tsx` from yellow to a high-contrast white glow aesthetic (`ring-white/80`, `shadow-[0_0_25px_rgba(255,255,255,0.4)]`, `border-white`).

### 1.4 CI Test Suite Hardening
- **`src/tests/agent/proposal-graph-preview.test.tsx`:** Handled `useReactFlow()` defensively inside `ActionNode.tsx` and `TriggerNode.tsx` using safe execution fallbacks and optional chaining on `deleteElements?.(...)`. Added a `useReactFlow` double in `proposal-graph-preview.test.tsx` so read-only proposal previews render deterministically in isolated jsdom environments.
- **`src/tests/workflow/fc015-version-lifecycle.test.ts`:** Mocked `@/lib/workflow/execution/evaluator`'s `advanceWorkflow` in `fc015-version-lifecycle.test.ts` (matching the pattern used in `fc014`, `fc016`, and `trigger-tenant-scope.test.ts`). This isolates version lifecycle tests from external Upstash Redis roundtrips in CI environments lacking network access, resolving `TypeError: fetch failed: bad port`.

## 2. Verification Summary

- **Unit & Integration Tests:** 139/139 test suites passing (2,120/2,120 tests green across Jest).
- **TypeScript:** `npx tsc --noEmit` passed with 0 errors.
- **Affected Test Suites:**
  - `src/tests/agent/proposal-graph-preview.test.tsx`: 7/7 passed.
  - `src/tests/workflow/fc015-version-lifecycle.test.ts`: 5/5 passed.
  - `src/tests/workflow/fc014-diagnostics-and-trigger-manifest.test.ts`: passed.
  - `src/tests/workflow/fc016-safe-simulation.test.ts`: passed.
  - `src/tests/workflow/fc013-properties-and-variables.test.tsx`: passed.
  - `src/tests/agent/workflow-proposal-panel.test.tsx`: passed.
  - `src/tests/workflow/workflow-canvas-fc012.test.tsx`: passed.
- **Git Delivery:** Committed (`d432abd`) and pushed to branch `feat/m1-identity-and-latenight-landing`.
