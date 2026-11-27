# M3 — FC-013: Capability-Driven Node Property Configuration & Variable Picker

- **Date:** 2026-11-27
- **Assignment:** FC-013 — Node Property Configuration Drawer & Variable Auto-Mapping
- **Methodology:** UPPR Rev 4.1 (P1, P2, P3, P5, P9, P14, P24, P26, P28)
- **Status:** Implemented & Verified by Automated Test Suite (Owner Manual Acceptance Pending)

## Summary of Changes

1. **Schema-Driven Action Field Introspection (`forge/src/lib/workflow-types/registry.ts`)**
   - Extended `FieldDef` to support `number`, `boolean`, `unsupported`, `description`, `defaultValue`, and `unsupportedReason`.
   - Added `getDefaultConfigForAction` to populate sensible defaults from Zod schemas when selecting an action.
   - Added `validateActionNodeConfig` to validate literal inputs against each registered action's Zod schema and verify `{{stepId.outputs.field}}` / `{{trigger.outputs.field}}` expressions against connected topological upstream outputs.
   - Fixed recursive Zod `.unwrap()` type annotation (`TS7022`).

2. **Canonical Upstream Variable Discovery & Safe Auto-Mapping (`forge/src/lib/workflow/graph-ui/utils.ts`)**
   - Extended `getAvailableUpstreamOutputs` with `sourceNodeType`, `sourceNodeLabel`, and canonical `expression` (`{{trigger.outputs.field}}` or `{{stepId.outputs.field}}`).
   - Added `formatVariableExpression` helper.
   - Hardened `autoMapNodeVariables` so ambiguous upstream providers (`matchingProviders.length !== 1`) are never auto-mapped silently.

3. **Property Configuration Drawer (`forge/src/features/organizations/components/workflow/PropertiesPanel.tsx`)**
   - Upgraded `PropertiesPanel.tsx` to render `string`, `textarea`, `number`, `boolean`, `select`, and explicit `unsupported` warnings from `getFieldsForAction`.
   - Added required/optional badges, Zod field descriptions, inline validation errors, and a manual `Var` upstream variable picker supporting cursor-position insertion or replacement.

## Verification

- `src/tests/workflow/fc013-properties-and-variables.test.tsx`, `src/tests/workflow/action-capabilities.test.ts`, `src/tests/workflow/proposal-references.test.ts`: **3/3 suites, 85/85 tests passed** (also included in full `npm test` run: 139/139 suites, 2120/2120 tests passed).
- `npx tsc --noEmit`: 0 errors.
