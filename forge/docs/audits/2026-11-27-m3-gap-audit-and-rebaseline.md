# FORGE — M3 Repository-Grounded Gap Audit & Scope Rebaseline
**Date:** 2026-11-27  
**Milestone Audited:** M3 — Complete Workflow Builder (`FC-012` through `FC-016`)  
**Methodology:** Universal Prompt Patterns Registry (UPPR) Rev 4.1 (Audit-Only, Non-Implementation)  
**Audit Disposition:** **PARTIAL (Rebaseline Required Before M3 Implementation)**  

---

## Top-Level Executive Brief

- **How much of M3 already exists?**  
  Substantial backend, schema, compiler, validation, capability, and immutable execution infrastructure already exists from Assignment 37 and F-03/F-04 hardening, whereas the **authoring UX, pre-publish graph diagnostics UI, draft-vs-published workflow versioning, and safe sandbox test-run simulation** are largely missing or only partially wired.
  *(Methodological note: No invented completion percentage is claimed; per-criterion status is classified below by observed implementation and evidence level.)*
- **Which work can be reused without modification?**
  - `WorkflowRun` immutable execution snapshots (`definitionSnapshot`, `definitionHash`, PostgreSQL triggers, `src/lib/workflow/execution/trigger.ts`, `src/lib/workflow-types/snapshot.ts`, `src/lib/workflow/validation/canonical-hash.ts`).
  - Transactional outbox dispatch (`WorkflowOutbox`, `src/lib/workflow/execution/outbox.ts`, `evaluator.ts`, `wf.ts`, `wrapper.ts`).
  - Client-safe capability-to-UI derivation (`src/lib/workflow-types/action-capabilities.ts` &rarr; `src/lib/workflow-types/registry.ts`).
  - Persistence-boundary graph validation (`IncomingNodesSchema`, `IncomingEdgesSchema`, `compileWorkflow`, `collectWorkflowDefinitionIssues`, `WorkflowDefinitionSchema`).
  - Trigger context trust boundary (`validateTriggerContext` in `src/lib/workflow/execution/trigger-context.ts`).
  - Installed `sonner` (`^2.0.7`) and `<Toaster />` already mounted in `src/app/layout.tsx:34`.
- **Which assignments need extension?**
  - **FC-012** (extend `WorkflowCanvas.tsx`, `workflow.ts` actions, and add header/metadata editing + Sonner toasts + `<MiniMap />`).
  - **FC-013** (extend `registry.ts` widget inference & `PropertiesPanel.tsx` with manual `{{stepId.outputs.field}}` picker, optional-field mapping, descriptions, and inline Zod error display; fix tracker's wrong `{{steps.step1.output}}` syntax).
  - **FC-014** (extend `collectWorkflowDefinitionIssues` / client preflight with severity levels `ERROR` vs `WARNING`, trigger/action/reference checks, and surface badges/banner on `ActionNode.tsx`, `TriggerNode.tsx`, and canvas header).
- **Which requirements are genuinely new?**
  - **FC-015** Draft vs. Published workflow separation (e.g. `WorkflowVersion` or bounded draft/published columns) and explicit Publish + Active/Inactive suspension semantics (distinct from `WorkflowRun.definitionSnapshot`).
  - **FC-016** Sandbox/Dry-Run simulation runner (`WorkflowTestRunModal.tsx` + simulation execution mode) so "Test Workflow" does not create real `Task` rows, send real emails, or enqueue production QStash jobs, plus step-output inspection UI.
- **Two or three highest-risk architectural decisions:**
  1. **FC-015 Data Model:** `WorkflowVersion` table vs. `draftData`/`publishedDefinition` columns on `Workflow` (and how `isActive` suspension interacts with M4 event dispatch without cancelling in-flight runs).
  2. **FC-014 Trigger & Disconnected-Node Policy:** Reconciling existing `dag-validation.test.ts` (which deliberately permits disconnected independent roots) with canvas UX (warning vs. blocking error for orphaned nodes and 0 vs. >1 triggers).
  3. **FC-016 Sandbox Side-Effect Policy:** Designing a dry-run/simulation execution mode for `startWorkflow` / `ActionRegistry` handlers so test runs never mutate production business tables or call external providers while still previewing realistic outputs.
- **What should the coding agent implement first after the audit is accepted?**
  1. **FC-012** (Header metadata editing, Sonner toasts replacing `alert()`, MiniMap) — zero schema risk, immediate authoring UX fix.
  2. **FC-013** (Schema-driven `PropertiesPanel` polish + manual `{{stepId.outputs.field}}` picker) — builds directly on `ActionCapabilities` + `registry.ts`.
  3. **FC-014** (Canonical validation diagnostics & canvas error/warning badges) — prerequisite gate for safe publishing.
  4. **FC-015** (Draft/Published versioning & lifecycle) — requires owner decision on schema model + migration.
  5. **FC-016** (Sandbox Test-Run Drawer & Output Preview) — depends on FC-014 validation and FC-015 draft-vs-published target selection.

---

## 1. Executive Summary

An exhaustive repository-grounded audit of Milestone M3 (`FC-012` through `FC-016`) was conducted prior to any M3 implementation. The audit inspected all workflow UI components, server actions, API routes, Zod schemas, compiler/validator modules, capability catalogs, execution engine modules, Prisma schema/migrations, and existing Jest suites.

**Key takeaway:** Several descriptions in `forge/docs/product/PRODUCT_COMPLETION_TRACKER.md` are **outdated or misleading** relative to the actual codebase:
1. The tracker claims `FC-013` lacks schema-driven derivation from `action-capabilities.ts` and cites variable syntax `{{steps.step1.output}}`. In reality, `src/lib/workflow-types/registry.ts` **already derives** `AVAILABLE_ACTIONS` from `ActionCapabilities`, and the actual runtime resolver (`src/lib/workflow/execution/resolver.ts`) uses `{{stepId.outputs.field}}` (and `{{trigger.outputs.field}}`).
2. The tracker prescribes new files (`WorkflowEditorHeader.tsx`, `NodePropertyDrawer.tsx`, `graphValidator.ts`, `workflowLifecycleActions.ts`, `WorkflowTestRunModal.tsx`, `testRunActions.ts`) without acknowledging existing equivalents (`PropertiesPanel.tsx`, `collectWorkflowDefinitionIssues`, `workflow.ts`, `RunWorkflowButton.tsx`, `POST /api/workflow/test/[workflowId]/test-run`).
3. Conversely, the tracker understates the gap in **FC-016**: a test-run endpoint and `RunWorkflowButton` already exist, **but they execute real production runs** (creating real `WorkflowRun` rows, real QStash dispatches, and real `Task` rows in PostgreSQL) with no sandbox isolation and no step-output preview UI.
4. For **FC-015**, the F-03 immutable execution contract protects **in-flight `WorkflowRun`s** via `definitionSnapshot` + `definitionHash` + PostgreSQL triggers, **not** published workflow definitions against subsequent canvas edits. Editing the canvas still overwrites `Workflow.definition` and `Workflow.uiNodes` for future runs.

---

## 2. Repository Identity and Baseline

- **Repository Root:** `C:\Users\Mayur\Desktop\Forge\Forge`
- **Application Root:** `C:\Users\Mayur\Desktop\Forge\Forge\forge`
- **Current Branch:** `feat/m1-identity-and-latenight-landing`
- **HEAD Commit SHA:** `5d533a8b3de93cf34dd4879cb84000a54f02f9d3`
- **Working-Tree Baseline (`git status --short`):** Clean (no uncommitted changes, no untracked files).
- **Package Scripts (`forge/package.json`):**
  - `dev`: `next dev`
  - `build`: `prisma generate && next build`
  - `lint`: `eslint`
  - `test`: `jest` (uses `jest.config.ts` with `jest.setup-db-guard.ts` blocking real `PrismaClient` instantiation and ignoring `*.realdb.test.ts`, `*.live.test.ts`, and `src/tests/e2e/`)
  - `test:rate-limit:live`: `jest --config jest.live.config.ts src/tests/security/rate-limit.live.test.ts`
- **Authoritative Docs Inspected:**
  - `forge/AGENTS.md`
  - `forge/docs/product/PRODUCT_COMPLETION_TRACKER.md`
  - `forge/docs/architecture/workflows/README.md`
  - `forge/docs/dev-log/2026-11-10-f03-immutable-workflow-definition-contract.md`
  - `forge/docs/dev-log/2026-11-10-f04-transactional-workflow-outbox.md`
  - *(Note: `forge/docs/pp.md` does not exist at that path in the working tree; UPPR Rev 4.1 rules supplied in the audit mandate were applied directly.)*

---

## 3. Complete Workflow Architecture Map

### 3.1 Workflow Authoring & Canvas Save/Update Path
- **Routes:**
  - List: `src/app/org/[orgId]/workflows/page.tsx` (queries `db.workflow.findMany({ where: { orgId: access.organization.id } })`; renders status badge `wf.isActive ? 'Active' : 'Draft'`).
  - Create: `src/app/org/[orgId]/workflows/new/page.tsx` &rarr; `<WorkflowBuilder />` (`WorkflowCanvas.tsx`) with no `workflowId`.
  - Edit: `src/app/org/[orgId]/workflows/[workflowId]/page.tsx` &rarr; `<WorkflowBuilder workflowId={workflow.id} initialNodes={nodes} initialEdges={edges} />`.
- **Save / Update Actions (`src/app/actions/workflows/workflow.ts`):**
  - `saveWorkflowState(orgslug, name, uiNodes, uiEdges)` &rarr; `getOrgAccess` &rarr; `IncomingNodesSchema.safeParse` &rarr; `IncomingEdgesSchema.safeParse` &rarr; `compileWorkflow(validNodes, validEdges)` &rarr; `db.workflow.create({ data: { name, orgId, uiNodes, uiEdges, definition, eventId, isActive: !!eventId } })`.
  - `updateWorkflowState(orgslug, workflowId, uiNodes, uiEdges)` &rarr; `getOrgAccess` &rarr; same validation &rarr; `compileWorkflow` &rarr; `db.workflow.updateMany({ where: { id: workflowId, orgId }, data: { uiNodes, uiEdges, definition, eventId, isActive: !!eventId } })`.
  - **Gap:** `WorkflowCanvas.tsx:187` hardcodes `"My First Automation"` on create; `updateWorkflowState` cannot update `name` or `description`.

### 3.2 Graph Compilation & Validation Path
- **Client Drag/Connect:** `WorkflowCanvas.tsx` checks `isValidConnection` (blocks self-loops and cycles using `getOutgoers` + `alert()`) and `onDrop` (blocks >1 trigger using `alert()`).
- **Compiler (`src/lib/workflow/graph-ui/compiler.ts`):** `compileWorkflow(nodes, edges)` builds `Record<string, WorkflowStep>` (`dependsOn` deduplicated from incoming edges) and runs `collectWorkflowDefinitionIssues(definition)`.
- **Schema (`src/lib/workflow-types/workflow.ts`):** `WorkflowDefinitionSchema` runs `collectWorkflowDefinitionIssues` inside `.superRefine(...)`, checking: `EMPTY_GRAPH`, `ID_MISMATCH`, `DUPLICATE_STEP_ID`, `SELF_DEPENDENCY`, `UNKNOWN_DEPENDENCY`, `UNKNOWN_ROUTING_CONDITION`, `CYCLE`.

### 3.3 Action Capability, Presentation & Execution Registry Relationship
Three strictly separated layers (verified by `src/tests/workflow/action-capabilities.test.ts`):
1. **Server Execution Authority (`src/lib/workflow-types/action-registry.ts`):** `ActionRegistry` + `versionedActionStore` keyed by `${actionId}@${actionVersion}`. Currently registers **only `"task.create"` (`createTaskAction` @ `"1.0.0"`)**. Unregistered actions on disk (`send-email.ts`, `generate-report.ts`, `conditions.ts`) are M5 (`FC-020`) scope.
2. **Client-Safe Semantic Catalog (`src/lib/workflow-types/action-capabilities.ts`):** `ActionCapabilities satisfies Record<RegisteredActionId, ActionCapability>` with strict Zod `input` and `output` schemas.
3. **Client Presentation Overlay (`src/lib/workflow-types/registry.ts`):** Derives `AVAILABLE_ACTIONS` from `ActionCapabilities` via `buildActionDef()`, computing `requires`, `outputs`, and `fields`. `AVAILABLE_TRIGGERS` is still a static array (`task.created`, `project.created`, `user.joined`).

### 3.4 Variable Resolution & Auto-Mapping Path
- **Upstream Discovery (`src/lib/workflow/graph-ui/utils.ts:69-162`):** `getAvailableUpstreamOutputs(targetNodeId, nodes, edges)` walks incoming edges recursively and collects `{ sourceNodeId, outputKey }` from `getNodeDefinition(parentNode)?.outputs`.
- **Auto-Mapper (`utils.ts:166-289`):** `autoMapNodeVariables(targetNodeId, edges, setNodes)` runs on edge connection (`onConnect`), action-type change, or trigger change. For each `requiredInput` in `targetDef.requires` that is currently empty, it finds the first matching `outputKey === requiredInput` and writes `{{${nodeId}.outputs.${requiredInput}}}` (using `"trigger"` when the source is a trigger node).
- **Runtime Resolver (`src/lib/workflow/execution/resolver.ts`):** `resolveInputs(configuredInputs, globalContext)` parses `/\{\{([\w.-]+)\}\}/g` and traverses `globalContext` (`{ trigger: { outputs }, [stepId]: { outputs } }`). Missing paths resolve to `""` (inside strings) or raw `{{...}}` (exact match).
- **Proposal Reference Validator (`src/lib/workflow-types/workflow-proposal-references.ts`):** Mirrors `/\{\{([\w.-]+)\}\}/g` for AI `WorkflowProposal`s only; not wired to the canvas editor.

### 3.5 Workflow Ignition, Immutable Snapshot, Dispatch & Monitoring Path
1. **Ignition (`src/lib/workflow/execution/trigger.ts`):** `startWorkflow(orgId, workflowId, triggerData)` locks `Workflow` with `FOR SHARE`, validates `WorkflowDefinitionSchema`, pins `actionManifest` versions via `getRegisteredActionForIgnition`, computes SHA-256 `definitionHash`, creates `WorkflowRun` with `definitionSnapshot` + `definitionHash` (enforced by PostgreSQL triggers `trg_workflow_run_snapshot_insert` and `trg_workflow_run_snapshot_immutable`), and calls `advanceWorkflow(run.id)`.
2. **Evaluator & Outbox (`evaluator.ts`, `outbox.ts`):** Atomically creates `StepRun` + `WorkflowOutbox` rows in `$transaction`, then drains outbox to QStash (`/api/worker` &rarr; `src/app/api/workflow/wf.ts`).
3. **Worker & Wrapper (`wf.ts`, `wrapper.ts`):** Verifies `definitionSnapshot` integrity, resolves `{{...}}` inputs via `resolveInputs`, executes pinned `getAction(actionId, actionVersion)`, persists `StepRun.outputs` + `ExecutionAuditLog`, broadcasts `STEP_STATE_CHANGE` over Pusher (`private-workflow-${runId}`), and re-enters `advanceWorkflow`.
4. **Manual Test-Run Entry Points:**
   - Canvas UI: `RunWorkflowButton.tsx` calls `triggerWorkflowRun(workflowId, orgId)` (`src/app/actions/workflows/workflow-run.ts`), which calls `startWorkflow` and redirects to `/org/${orgId}/runs/${runId}`.
   - HTTP API: `POST /api/workflow/test/[workflowId]/test-run` validates session, org membership, Upstash rate limit, `validateTriggerContext`, and `projectId` org ownership, then calls `startWorkflow`.
5. **Monitoring UI (`src/app/org/[orgId]/runs/[runId]/page.tsx`, `WorkflowRunDashboard.tsx`, `WorkflowLiveViewer.tsx`):** Displays node status pills and live Pusher `STEP_STATE_CHANGE` updates; **does not display `StepRun.outputs`, `StepRun.inputs`, `StepRun.error`, or audit logs**.

---

## 4. Evidence Methodology (UPPR Rev 4.1)

- **E1:** Static source inspection, TypeScript types, Prisma schema/migrations, ESLint.
- **E2:** Jest unit/integration tests with controlled doubles (`jest.setup-db-guard.ts` active).
- **E3:** Real Neon PostgreSQL constraint/transaction/concurrency tests (`*.realdb.test.ts`; **not executed in this audit** to preserve non-destructive baseline).
- **E4 / E5:** External provider / production operational validation (**not claimed**).

---

## 5. Assignment-by-Assignment Forensic Audit

### FC-012 — Canvas Authoring UX, Workflow Naming & Toast Notifications

| Criterion / Aspect | Existing Implementation | Evidence | Classification | Remaining Work |
|---|---|---|---|---|
| **Workflow title inline editing** | `edit` page (`workflows/[workflowId]/page.tsx:38`) displays static `{workflow.name}`; `new` page (`workflows/new/page.tsx:21`) displays static `"Automation Builder"`; `WorkflowCanvas.tsx:187` hardcodes `"My First Automation"`. `WorkflowEditorHeader.tsx` does not exist. | E1 (`WorkflowCanvas.tsx:187`, `workflows/[workflowId]/page.tsx:38`) | **NEW / EXTEND** | Add editable title & description header (inline or dedicated `WorkflowEditorHeader.tsx`) wired into `WorkflowCanvas` state and save/update actions. |
| **Persist name & description** | Prisma `Workflow` model already has `name String` and `description String?` (`schema.prisma:563-564`). `saveWorkflowState` accepts `name` (not `description`); `updateWorkflowState` accepts neither. | E1 (`prisma/schema.prisma:563-564`, `actions/workflows/workflow.ts:39-177`) | **EXTEND** | Extend `saveWorkflowState` and `updateWorkflowState` (or add `updateWorkflowMetadata`) with Zod-validated `name` (non-empty) and optional `description`, preserving tenant `orgId` write predicate. |
| **Toast notifications on save/error** | `sonner` (`^2.0.7`) is installed and `<Toaster />` is mounted in `src/app/layout.tsx:34`. `WorkflowCanvas.tsx` (lines 83, 130, 182, 183, 189, 194) and `RunWorkflowButton.tsx` (lines 59, 63) still call `window.alert()`. | E1 (`src/app/layout.tsx:34`, `WorkflowCanvas.tsx:83,130,182-194`) | **EXTEND** | Replace all `alert()` calls in `WorkflowCanvas.tsx` and `RunWorkflowButton.tsx` with `toast.success(...)` / `toast.error(...)` from `sonner`, surfacing `result.error` (e.g., compile validation messages) instead of generic `"Failed to update."`. |
| **Zoom, pan, mini-map** | `ReactFlow` in `WorkflowCanvas.tsx:227-242` renders `<Background>` and `<Controls />`, but omits `<MiniMap />`. | E1 (`WorkflowCanvas.tsx:227-242`) | **EXTEND** | Add `<MiniMap />` from `@xyflow/react` styled for dark mode; verify no layout shift inside `h-screen` container. |
| **Tenant isolation** | `workflows/[workflowId]/page.tsx:18-22` scopes lookup by `orgId: access.organization.id`; `updateWorkflowState` scopes `findFirst` and `updateMany` by `orgId`. Covered by `workflow-update-scope.test.ts`. | E2 (`workflow-update-scope.test.ts` PASS) | **REUSE** | Add tests verifying metadata (`name`, `description`) updates also enforce `orgId` scope. |

---

### FC-013 — Node Property Configuration Drawer & Variable Auto-Mapping

**Answers to Mandatory Audit Questions:**
1. **Catalog coverage:** Yes — `ActionCapabilities` (`action-capabilities.ts`) uses `satisfies Record<RegisteredActionId, ActionCapability>`, enforced by `action-capabilities.test.ts` (E2). Currently only `"task.create"` is registered in `ActionRegistry`.
2. **Schema-driven vs. manual fields:** `registry.ts` **already derives** `AVAILABLE_ACTIONS` fields from `ActionCapabilities` Zod schemas via `buildActionDef()`, using `ACTION_FIELD_PRESENTATION` only as an optional UI label/widget overlay. `PropertiesPanel.tsx:190` renders from `AVAILABLE_ACTIONS`.
3. **Required/optional consistency:** `requiredInputFields` / `optionalInputFields` in `action-capabilities.ts:115-130` derive optionality from `!field.isOptional()` (fields with `.default()` are treated as optional).
4. **Supported Zod field types:** `PropertiesPanel.tsx:196-230` only renders `'string'`, `'textarea'`, and `'select'`. `'number'` is in `FieldDef['type']` (`registry.ts:39`) but **not rendered** in `PropertiesPanel.tsx`; booleans, arrays, nested objects, and nullable schemas fall back to `'string'`.
5. **Defaults, enums, descriptions:** Enum options are derived automatically (`enumOptions` in `registry.ts:125-133`), but `field.description` from `.describe(...)` is **not** projected into `FieldDef` or rendered in `PropertiesPanel.tsx`, and `.default()` values are not pre-populated in UI state.
6. **Upstream discovery:** `getAvailableUpstreamOutputs` (`utils.ts:69-162`) traverses incoming edges recursively (with cycle guard) and returns `{ sourceNodeId, outputKey }[]`.
7. **Required vs. optional mapping:** `autoMapNodeVariables` (`utils.ts:217`) **only** maps `targetDef.requires` (required fields) when empty and when `outputKey === requiredInput`. Optional fields cannot be auto-mapped or picked via UI.
8. **Disambiguation across multiple upstream nodes:** `getAvailableUpstreamOutputs` keys its map by `${parentNode.id}.${outputKey}`, so it preserves distinct upstream sources, **but** `autoMapNodeVariables` picks `availableOutputs.find(...)` (first match) and `PropertiesPanel.tsx` has **no manual picker** to choose between multiple upstream nodes exposing the same field name (e.g., two `task.create` nodes both exposing `taskId`).
9. **Manual variable selection:** **Missing.** Users cannot click a variable button on a text/textarea field to insert `{{stepId.outputs.field}}` or `{{trigger.outputs.field}}`.
10. **Expression validation:** **Missing in UI/save.** `workflow-proposal-references.ts` validates `{{...}}` for AI proposals, but `compileWorkflow` and `PropertiesPanel` do not validate variable expressions or stale references on manually authored workflows.
11. **Canonical Variable Syntax:** **`{{stepId.outputs.field}}`** (and **`{{trigger.outputs.field}}`** for trigger outputs), proven by `utils.ts:250-260`, `resolver.ts:6-7,63-74`, and `workflow-proposal-references.ts:46-52`. The tracker's `{{steps.step1.output}}` is **incorrect/obsolete**.

| Criterion / Aspect | Existing Implementation | Evidence | Classification | Remaining Work |
|---|---|---|---|---|
| **Schema-driven form rendering** | `registry.ts` derives `FieldDef[]` from `ActionCapabilities`; `PropertiesPanel.tsx` renders `string`, `textarea`, `select`. | E1, E2 (`action-capabilities.test.ts` PASS) | **EXTEND / REVISE** | Add `number`, `boolean`, and JSON/array fallback widgets, surface Zod `.describe()` help text, and show inline Zod validation errors. Revise tracker reference from `NodePropertyDrawer.tsx` to extending `PropertiesPanel.tsx`. |
| **Upstream variable picker** | `getAvailableUpstreamOutputs` exists in `utils.ts:69-162`, but `PropertiesPanel.tsx` only displays missing-variable badges, not an insertion picker. | E1 (`PropertiesPanel.tsx:164-225`, `utils.ts:69-162`) | **NEW (UI) / REUSE (Util)** | Add variable-picker popover/dropdown on `PropertiesPanel` inputs listing all upstream `{ sourceNodeId, label, outputKey }` options and inserting `{{sourceNodeId.outputs.outputKey}}` (or `{{trigger.outputs.outputKey}}`). |
| **Variable syntax alignment** | `resolver.ts` and `utils.ts` use `{{stepId.outputs.field}}`. Tracker states `{{steps.step1.output}}`. | E1 (`resolver.ts:7,63`, `utils.ts:260`) | **REVISE** | Update tracker specification to canonical `{{stepId.outputs.field}}` / `{{trigger.outputs.field}}`. |
| **Stale/invalid reference check** | `workflow-proposal-references.ts` checks references for AI proposals only. | E1, E2 (`proposal-references.test.ts` PASS) | **EXTEND** | Reuse/adapt reference extraction to flag broken or non-upstream `{{...}}` tokens in `FC-014` validation. |

---

### FC-014 — Graph Validation & Actionable Error Diagnostics

**Validation Matrix (Observed Codebase Behaviour):**

| Case | Current Enforcement Location | Current Behaviour | Severity | Tested? | Surfaced in Authoring UI? | Blocked on Save / Execute? |
|---|---|---|---|---|---|---|
| Empty graph | `collectWorkflowDefinitionIssues` (`workflow.ts:132-138`) | Returns `EMPTY_GRAPH` | Error | Yes (`dag-validation.test.ts`) | Save disabled when `nodes.length === 0` (`WorkflowCanvas.tsx:220`) | Blocked on save & `startWorkflow` |
| No trigger | **Nowhere** | `WorkflowDefinitionSchema` accepts action-only graphs; `saveWorkflowState` sets `eventId: null, isActive: false` | None | `dag-validation.test.ts` tests root actions as valid | No badge/error | Allowed on save & `startWorkflow` |
| Multiple triggers | `WorkflowCanvas.tsx:125-133` (`onDrop` only) | `alert("Workflows can only have one Trigger event.")` on drop; **not** checked in `compileWorkflow` or `WorkflowDefinitionSchema` | UI alert only | No | `alert()` on drop only | Allowed if saved via API/paste |
| Duplicate node IDs / Key-ID mismatch | `collectWorkflowDefinitionIssues` (`workflow.ts:148-166`) | Returns `ID_MISMATCH` / `DUPLICATE_STEP_ID` | Error | Yes (`dag-validation.test.ts`) | Only via save failure `alert()` | Blocked on save & `startWorkflow` |
| Unknown / Self dependency | `collectWorkflowDefinitionIssues` (`workflow.ts:168-185`) | Returns `UNKNOWN_DEPENDENCY` / `SELF_DEPENDENCY`; `isValidConnection` blocks self-loop | Error | Yes (`dag-validation.test.ts`) | Self-loop blocked silently on connect | Blocked on save & `startWorkflow` |
| Cycle | `isValidConnection` + `collectWorkflowDefinitionIssues` (`workflow.ts:201-208`) | `alert()` on connect; `CYCLE` issue with `path` on compile | Error | Yes (`dag-validation.test.ts`) | `alert()` on connect; no node badge | Blocked on save & `startWorkflow` |
| Disconnected components / Orphaned nodes | **Deliberately permitted** in `WorkflowDefinitionSchema` (`dag-validation.test.ts:128-143`) | Treated as valid independent parallel roots | None | Yes (`dag-validation.test.ts:128`) | No warning badge | Allowed on save & `startWorkflow` |
| Invalid / `"unset"` action ID | `startWorkflow` (`trigger.ts:81-86`) only | `saveWorkflowState` allows `actionType: "unset"` (`workflow-node-validation.test.ts:57-68`); fails only at `startWorkflow`! | Runtime Error | Yes (`workflow-node-validation.test.ts`) | `ActionNode` shows `"Needs Setup"` when `!isConfigured` | **Allowed on save**, blocked at `startWorkflow` |
| Missing required action inputs | `ActionNode.tsx:63-87` & `PropertiesPanel.tsx:42-55` (upstream variable heuristic only) | Checks `actionDef.requires` against upstream `outputs` only — ignores literal values typed in `config`! Does not validate against `ActionCapabilities[id].input` Zod schema. | UI-only | No | `ActionNode` shows `"Missing Data"` | **Allowed on save & `startWorkflow`** (fails inside worker) |
| Invalid `{{...}}` variable references | **Nowhere on canvas/save** (only in `workflow-proposal-references.ts` for AI proposals) | Fails silently in `resolver.ts` (`""` or literal string) | None | Proposal only | No | Allowed on save & `startWorkflow` |
| Invalid routing conditions | `collectWorkflowDefinitionIssues` (`workflow.ts:190-198`) | Returns `UNKNOWN_ROUTING_CONDITION` | Error | Yes (`dag-validation.test.ts`) | Only via save failure | Blocked on save & `startWorkflow` |

**Critical Policy Reconciliation (Disconnected Nodes & Triggers):**
- `dag-validation.test.ts:128-143` explicitly establishes that **disconnected components are valid independent roots** in `WorkflowDefinitionSchema` (used by AI-generated parallel workflows). **Do not** make disconnectedness a hard `WorkflowDefinitionSchema` error; instead, surface unreachable-from-trigger nodes as a **non-blocking `WARNING`** in the canvas UI validator when a trigger is present, while blocking **publish** (`FC-015`) on errors (`CYCLE`, `EMPTY_GRAPH`, missing/invalid action, missing required inputs, invalid references, and trigger cardinality rules once owner confirms).
- **Ambiguity requiring owner decision:** Tracker body mentions "multiple trigger errors" while acceptance criteria say "lacks a trigger"; `WorkflowCanvas.tsx:129` enforces max 1 trigger on drop. Owner should confirm: **exactly 1 trigger required to publish** (drafts may have 0).

| Criterion / Aspect | Existing Implementation | Evidence | Classification | Remaining Work |
|---|---|---|---|---|
| **Canonical graph validator** | `collectWorkflowDefinitionIssues` (`workflow.ts:125`) + `compileWorkflow` (`compiler.ts:22`) | E1, E2 (`dag-validation.test.ts` PASS) | **EXTEND / REVISE** | Extend existing validator/issue model with `severity: 'ERROR' | 'WARNING'`, node/edge attribution, and a pre-publish validation pass (checking trigger presence, registered action IDs, Zod input completeness, `{{...}}` references, and orphaned-node warnings) without breaking `WorkflowDefinitionSchema` independent-root semantics. Do not create a separate parallel `graphValidator.ts`. |
| **Visual error/warning badges & header banner** | `ActionNode.tsx` only checks `missingVariables` (upstream outputs) and ignores literal `config` values; no canvas-level error banner or clickable jump-to-node. | E1 (`ActionNode.tsx:63-87`, `WorkflowCanvas.tsx`) | **NEW** | Pass validation issues into `ActionNode`, `TriggerNode`, and a header diagnostics banner with click-to-focus node. |

---

### FC-015 — Draft vs. Published State Management & Active Lifecycle

**Answers to Mandatory Audit Questions:**
1. **Does editing overwrite future runs?** **Yes.** `updateWorkflowState` (`workflow.ts:143-156`) overwrites `Workflow.uiNodes`, `Workflow.uiEdges`, `Workflow.definition`, `Workflow.eventId`, and `Workflow.isActive` in place.
2. **Can a published config be preserved while editing a draft?** **No.** There is only one `definition` / `uiNodes` / `uiEdges` pair on `Workflow`.
3. **Existing version model?** **None.** `prisma/schema.prisma:561-600` has no `WorkflowVersion` model and no `draft*` / `published*` columns.
4. **What does a new run read?** `startWorkflow` (`trigger.ts:44-49`) reads `Workflow.definition` under `FOR SHARE` and freezes it into `WorkflowRun.definitionSnapshot` + `WorkflowRun.definitionHash`.
5. **Are running executions isolated?** **Yes.** F-03 (`immutable-definition.test.ts` E2, `immutable-definition.realdb.test.ts` E3-documented) proves running and compensating `WorkflowRun`s read strictly from `WorkflowRun.definitionSnapshot`, enforced by PostgreSQL triggers.
6. **Can a previous published config be restored?** **No.** Overwritten on every `updateWorkflowState`.
7. **What does `isActive` currently mean?** `saveWorkflowState` and `updateWorkflowState` automatically set `isActive: !!eventId` (`workflow.ts:80,154`). There is no manual active/inactive toggle.
8. **Does disabling stop new runs / queued dispatch / in-flight runs?** Currently `startWorkflow` (`trigger.ts:44-65`) **does not even check `isActive`**! Disabling `isActive` would not stop `startWorkflow` or in-flight runs unless explicitly checked at ignition.
9. **Are those behaviours distinguishable?** Yes: `isActive` should gate **new event-driven / production ignition** (future M4 dispatcher + production triggers) while **never** cancelling already-running `WorkflowRun`s (which remain bound to their immutable `WorkflowRun.definitionSnapshot`).

**Recommended Architecture (vs. Rejected Alternatives):**
- **Recommended:** **Immutable `WorkflowVersion` model + `publishedVersionId` on `Workflow`** (or bounded `draftUiNodes`/`draftUiEdges` on `Workflow` + immutable `WorkflowVersion` rows storing `versionNumber`, `definition`, `uiNodes`, `uiEdges`, `definitionHash`, `publishedAt`, `publishedById`).
  - *Why superior to tracker's `isPublished` + `publishedAt` + `draftData` proposal:* `WorkflowVersion` preserves full version history (preventing silent overwrite of prior published configs, enabling rollback, and allowing `WorkflowRun.workflowVersionId` traceability), cleanly separates mutable draft state on `Workflow` from immutable published snapshots, and aligns with F-03's `WorkflowRun.definitionSnapshot` pattern.
  - *Alternative (bounded columns):* Adding `publishedDefinition`, `publishedAt`, `isPublished` directly on `Workflow` is simpler for a single active version, **but** loses version history and mixes draft/published concerns on one row.

| Criterion / Aspect | Existing Implementation | Evidence | Classification | Remaining Work |
|---|---|---|---|---|
| **Draft editing isolated from published execution** | `updateWorkflowState` overwrites `Workflow.definition` in place. | E1 (`workflow.ts:143-156`, `schema.prisma:561-580`) | **NEW / REVISE** | Add `WorkflowVersion` model + `Workflow.publishedVersionId` (Prisma migration); canvas saves update draft columns on `Workflow` only. |
| **Explicit Publish transition** | Does not exist; saving auto-sets `isActive: !!eventId`. | E1 (`workflow.ts:80,154`) | **NEW** | Implement `publishWorkflowAction` (validates via FC-014, creates immutable `WorkflowVersion` in `$transaction`, updates `publishedVersionId`, sets `isActive: true`). |
| **Active/Inactive toggle** | `isActive` is auto-computed from `!!eventId` on save; `startWorkflow` ignores `isActive`. | E1 (`workflow.ts:80,154`, `trigger.ts:44-65`) | **NEW** | Add `toggleWorkflowActiveAction` (`ADMIN`/`MANAGER` or authorized member); gate production ignition on `isActive && publishedVersionId` without cancelling in-flight `WorkflowRun`s. |

---

### FC-016 — Manual Test-Run Drawer & Trigger Output Preview

**Answers to Mandatory Audit Questions:**
1. **Does the current test-run route start a real execution?** **Yes.** Both `triggerWorkflowRun` (`workflow-run.ts:56`) and `POST /api/workflow/test/[workflowId]/test-run` (`route.ts:122`) call `startWorkflow(orgId, workflowId, triggerData)`.
2. **Does it create a persistent `WorkflowRun`?** **Yes** (`trigger.ts:115-123`).
3. **Can it dispatch real queue work?** **Yes** — `advanceWorkflow` writes `WorkflowOutbox` rows and calls `drainWorkflowOutbox()`, publishing to QStash `/api/worker`.
4. **Which actions mutate real business data?** `createTaskAction` (`"task.create"`) calls `createTaskInOrg`, creating **real `Task` rows** in PostgreSQL and emitting real `TASK_CREATED` vector/domain outbox events.
5. **Which actions contact external services?** `sendEmailAction` (Resend) and `generateReportAction` (UploadThing) exist on disk (M5), though not yet registered in `ActionRegistry`.
6. **Are test results isolated from production runs?** **No.**
7. **Is there a simulation adapter / DI seam?** **No.**
8. **Are execution outputs available to the UI?** `StepRun.outputs` (`Json?`) is persisted by `wrapper.ts`, **but never queried or passed to the UI** in `runs/[runId]/page.tsx`, `WorkflowRunDashboard.tsx`, or `WorkflowLiveViewer.tsx`.
9. **Does the run viewer display outputs?** **No** — only node `executionStatus` pills and timeline labels (`WorkflowRunDashboard.tsx:46-50`).
10. **Is there a test drawer / payload editor UI?** **No.** `RunWorkflowButton.tsx` immediately calls `triggerWorkflowRun(workflowId, orgId)` with no payload and redirects to `/org/${orgId}/runs/${runId}`.

**Side-Effect Policy per Action (M3 Test/Simulation Mode):**
- `task.create` (and future M5 `task.update`, `comment.create`, `project.archive`): **Simulated** (return deterministic mock output matching `ActionCapabilities[id].output` schema without writing to `Task`/`Comment`/`Project`).
- `logic.condition`: **Read-only / Permitted** (pure computation using `executeConditionNode`).
- `communication.send_email`, `utils.generate_report`, `http.request` (M5): **Simulated / Blocked from external I/O** in test mode (never call Resend, UploadThing, or external HTTP endpoints).

**Recommended Simulation Architecture:**
- Introduce an explicit **in-process, non-mutating simulation runner** (`simulateWorkflowRun(orgId, nodes, edges, triggerPayload)` or `executionMode: "SIMULATION"` adapter over `compileWorkflow` + `resolveInputs` + `ActionCapabilities` output schemas), **rather than** calling `startWorkflow()` + QStash + real `ActionRegistry` handlers.
- Benefits: works on **unsaved drafts** directly from the canvas, returns **immediate synchronous step-by-step inputs, redacted outputs, errors, and skipped-branch trace** to `WorkflowTestRunModal.tsx` / drawer without polluting `WorkflowRun` history, creating real tasks, or requiring QStash round-trips. Reuse `validateTriggerContext` (`trigger-context.ts`) and `resolveInputs` (`resolver.ts`).

| Criterion / Aspect | Existing Implementation | Evidence | Classification | Remaining Work |
|---|---|---|---|---|
| **Test-run modal / payload editor** | `RunWorkflowButton.tsx` triggers real run with no payload UI; `POST /api/workflow/test/[workflowId]/test-run` accepts optional JSON body. | E1, E2 (`run-workflow-button.test.tsx`, `workflow-test-run-tenant-context.test.ts` PASS) | **NEW / REVISE** | Build `WorkflowTestRunModal` (drawer/modal) pre-populated with `AVAILABLE_TRIGGERS` sample JSON payload; validate via `validateTriggerContext`. |
| **Safe sandbox execution** | `startWorkflow` executes real DB mutations and real QStash dispatch. | E1 (`trigger.ts`, `route.ts`, `create-task.ts`) | **NEW** | Implement `simulateWorkflowRun` action/service with strict side-effect isolation (zero DB business writes, zero external APIs, zero QStash) and tenant-scoped `getOrgAccess` + rate limiting. |
| **Step-by-step output preview & error highlighting** | `WorkflowRunDashboard.tsx` shows statuses only; `wrapper.ts` has `redactSensitiveData` (unexported). | E1 (`WorkflowRunDashboard.tsx:46-96`, `wrapper.ts:85-108`) | **NEW** | Return structured step timeline (`stepId`, `status`, `resolvedInputs`, `outputs` truncated & redacted, `error`, `durationMs`) and render in drawer + highlight failing nodes. |

---

## 6. Cross-Cutting Architectural Analysis

- **Single Source of Truth:** `ActionCapabilities` (`action-capabilities.ts`) &rarr; `registry.ts` &rarr; `PropertiesPanel.tsx` must remain the single source of truth for action fields and outputs; `resolver.ts` (`{{stepId.outputs.field}}`) is the single variable syntax; `collectWorkflowDefinitionIssues` (`workflow.ts`) should be extended as the single graph validator.
- **Multi-Tenant Security:** Every new/extended server action (`saveWorkflowState`, `updateWorkflowState`, `publishWorkflowAction`, `toggleWorkflowActiveAction`, `simulateWorkflowRun`) must derive `orgId` exclusively from `getOrgAccess(orgslug)`, include `orgId` in all Prisma `where` predicates, and validate any supplied `projectId` in test payloads against `orgId` (`workflow-test-run-tenant-context.test.ts` pattern).
- **Persistence & Concurrency:**
  - `publishWorkflowAction` must acquire a row lock (`SELECT ... FROM "Workflow" WHERE id = $1 AND "orgId" = $2 FOR UPDATE`) inside `$transaction` to serialize concurrent publish/save races and assign monotonic `versionNumber`.
  - `startWorkflow` (`trigger.ts`) must read the published `WorkflowVersion` under `FOR SHARE` and verify `workflow.isActive` (for production triggers) so in-flight runs remain bound to `WorkflowRun.definitionSnapshot`.
- **M3 / M4 Boundary:** M3 establishes draft vs. published versioning, `isActive` gating, and manual test-run simulation. M3 **must not** implement `WorkflowOutbox` domain-event consumers, task mutation CDC hooks (`createTask.ts` / `updateTaskInOrg.ts`), or recursion depth headers (`FC-017`–`FC-019`).
- **Documentation Contradictions Identified:**
  1. Tracker `FC-013` cites `{{steps.step1.output}}`; code uses `{{stepId.outputs.field}}`.
  2. Tracker `FC-014` asks to block disconnected nodes; `dag-validation.test.ts:128` explicitly permits independent parallel roots.
  3. Tracker `FC-016` claims *"No mechanism exists to test workflows manually"*; `RunWorkflowButton.tsx` and `/api/workflow/test/[workflowId]/test-run` already exist (but run real production workflows).

---

## 7. Revised Implementation Sequence

1. **Unit 1 — FC-012: Canvas Header, Naming, Toasts & MiniMap**  
   *Files:* `WorkflowCanvas.tsx`, `RunWorkflowButton.tsx`, `src/app/actions/workflows/workflow.ts`, `workflows/new/page.tsx`, `workflows/[workflowId]/page.tsx` (+ optional `WorkflowEditorHeader.tsx`).  
   *No schema migration.*
2. **Unit 2 — FC-013: Schema-Driven `PropertiesPanel` & Manual Variable Picker**  
   *Files:* `registry.ts` (project `description`, `defaultValue`), `PropertiesPanel.tsx` (number/boolean/json widgets, Zod inline errors, manual `{{stepId.outputs.field}}` picker), `utils.ts` (optional-field/multi-source support).
3. **Unit 3 — FC-014: Unified Pre-Publish Validation & Canvas Diagnostics**  
   *Files:* `workflow.ts` (`severity`, extended pre-publish issue codes), `compiler.ts`, `ActionNode.tsx`, `TriggerNode.tsx`, `WorkflowCanvas.tsx` (error banner + node badges).
4. **Unit 4 — FC-015: `WorkflowVersion` Draft/Published Lifecycle & `isActive` Gating**  
   *Files:* `prisma/schema.prisma` + new migration, `src/app/actions/workflows/workflow.ts` (or lifecycle actions), `trigger.ts`, `workflows/page.tsx`, `WorkflowCanvas.tsx` (Save Draft / Publish / Active toggle).
5. **Unit 5 — FC-016: Sandbox Simulation Runner & Test-Run Drawer**  
   *Files:* `src/lib/workflow/execution/simulator.ts` (new), `src/app/actions/workflows/workflow-run.ts` (or test-run action), `WorkflowTestRunModal.tsx` (new), `RunWorkflowButton.tsx` / `WorkflowCanvas.tsx`.

---

## 8. Risk Register & Unresolved Owner Decisions

### Risk Register
| Risk | Severity | Mitigation |
|---|---|---|
| Variable syntax mismatch (`{{steps.step1.output}}` vs `{{stepId.outputs.field}}`) | High | Standardize strictly on `resolver.ts` syntax `{{stepId.outputs.field}}` / `{{trigger.outputs.field}}`. |
| Breaking AI-generated parallel workflows by forbidding disconnected roots in `WorkflowDefinitionSchema` | High | Keep `WorkflowDefinitionSchema` independent-root support; emit canvas `WARNING` for unreachable nodes when a trigger exists. |
| Sandbox side-effect leakage (`createTaskAction` writing real DB tasks during test run) | Critical | Dedicated non-mutating `simulateWorkflowRun` engine; never call `createTaskInOrg` or `publishEvent` in simulation mode. |
| Concurrent draft save vs. publish race | Medium | `FOR UPDATE` row lock on `Workflow` in `publishWorkflowAction`; `WorkflowRun` continues reading `definitionSnapshot`. |
| Unauthenticated / cross-tenant simulation or publish | Critical | Mandatory `getOrgAccess(orgslug)` + `orgId` in all write predicates + `validateTriggerContext`. |

### Unresolved Decisions Requiring Owner Input
1. **FC-014 Trigger Cardinality:** Should publishing require **exactly 1 trigger** (matching `WorkflowCanvas.tsx:129`), or allow multiple triggers / 0 triggers? *(Recommended default: drafts allow 0–1 triggers; publishing requires exactly 1 trigger.)*
2. **FC-015 Versioning Model:** Confirm **separate `WorkflowVersion` table + `publishedVersionId` on `Workflow`** (preserves version history and auditability) vs. simple `draftData`/`publishedAt` columns on `Workflow`. *(Recommended default: `WorkflowVersion` table.)*
3. **FC-016 Existing `RunWorkflowButton` & `/test-run` Route:** Should the canvas "Test Workflow" button open the new **Sandbox Simulation Drawer** by default (with an optional "Run Live" mode for real DB execution), and should `POST /api/workflow/test/[workflowId]/test-run` default to simulation or keep its existing contract for security/rate-limit tests? *(Recommended default: keep `/api/workflow/test/[workflowId]/test-run` contract intact or gate with `mode: "simulation" | "live"`, and wire the canvas drawer to simulation by default.)*

---

## 9. Verification Performed & Evidence Limitations

Executed safe, DB-guarded Jest suites (`jest.config.ts` with `jest.setup-db-guard.ts`):
- **Run 1 (`npx jest action-capabilities workflow-node-validation immutable-definition workflow-test-run-tenant-context workflow-update-scope run-workflow-button`):** **6/6 suites PASSED, 93/93 tests PASSED** (E2).
- **Run 2 (`npx jest dag-validation proposal-references trigger-context trigger-tenant-scope`):** **4/4 suites PASSED, 84/84 tests PASSED** (E2).
- **Limitations:** `*.realdb.test.ts`, `*.live.test.ts`, and `src/tests/e2e/` were deliberately **not** executed during this non-destructive audit.

---

## 10. Proposed Replacement for M3 Tracker (`FC-012` through `FC-016`)

> [!NOTE]
> **Proposal Only:** The canonical tracker (`forge/docs/product/PRODUCT_COMPLETION_TRACKER.md`) was NOT modified during this audit. Below is the proposed replacement text for owner review.

```markdown
### Milestone M3: Complete Workflow Builder

#### FC-012 | M3 | Canvas Authoring UX, Workflow Naming & Toast Notifications
- **Milestone:** M3
- **Capability:** Smooth visual workflow authoring with editable workflow metadata, non-blocking toast feedback, and canvas navigation polish.
- **Current Evidence:** `WorkflowCanvas.tsx` loads React Flow with `<Background>` and `<Controls>`, but hardcodes `"My First Automation"` on create, omits `name`/`description` editing on update, omits `<MiniMap />`, and uses `window.alert()` despite `sonner` (`<Toaster />`) already mounted in `src/app/layout.tsx`.
- **Required Outcome:** Add inline workflow title/description editing (`WorkflowEditorHeader` or integrated header), extend `saveWorkflowState`/`updateWorkflowState` to persist `name` and `description`, replace all `alert()` calls in `WorkflowCanvas.tsx` and `RunWorkflowButton.tsx` with `sonner` toasts, and add `<MiniMap />`.
- **Dependencies:** FC-008
- **Files Involved:** `src/features/organizations/components/workflow/WorkflowCanvas.tsx`, `src/features/organizations/components/workflow/RunWorkflowButton.tsx`, `src/app/actions/workflows/workflow.ts`, `src/app/org/[orgId]/workflows/new/page.tsx`, `src/app/org/[orgId]/workflows/[workflowId]/page.tsx`
- **Acceptance Criteria:**
  - User can set/edit workflow `name` and `description` on both `/workflows/new` and `/workflows/[workflowId]` and persist changes.
  - Saving, updating, or validation errors display `sonner` toasts with actionable messages (zero `window.alert()` calls).
  - Canvas renders `<Controls />` and `<MiniMap />` smoothly without layout shifts.
  - **Tenant Boundary:** Metadata reads and writes enforce `getOrgAccess` and `orgId` predicates.
- **Status:** `NOT_STARTED`

#### FC-013 | M3 | Node Property Configuration Drawer & Variable Auto-Mapping
- **Milestone:** M3
- **Capability:** Schema-driven node configuration panel with manual and automatic `{{stepId.outputs.field}}` variable mapping.
- **Current Evidence:** `registry.ts` already derives `AVAILABLE_ACTIONS` from `ActionCapabilities` (`action-capabilities.ts`) and `autoMapNodeVariables` (`utils.ts`) auto-maps matching required fields using `{{nodeId.outputs.field}}` / `{{trigger.outputs.field}}`. However, `PropertiesPanel.tsx` lacks `number`/`boolean` widgets, field descriptions, inline Zod errors, and a manual upstream variable picker.
- **Required Outcome:** Extend `registry.ts` and `PropertiesPanel.tsx` to render all Zod field types, descriptions, and inline validation errors, and add a manual upstream output picker inserting canonical `{{stepId.outputs.field}}` / `{{trigger.outputs.field}}` expressions across required and optional fields.
- **Dependencies:** FC-012
- **Files Involved:** `src/features/organizations/components/workflow/PropertiesPanel.tsx`, `src/lib/workflow-types/registry.ts`, `src/lib/workflow/graph-ui/utils.ts`
- **Acceptance Criteria:**
  - Clicking any node opens `PropertiesPanel` with all required and optional inputs derived from `ActionCapabilities` + `AVAILABLE_TRIGGERS`, including descriptions and defaults.
  - String/textarea inputs provide a variable insertion picker listing all topological upstream outputs (`{{stepId.outputs.field}}` / `{{trigger.outputs.field}}`), disambiguated by source node.
  - Inline validation highlights missing required fields and invalid field values against the action's Zod input schema.
- **Status:** `NOT_STARTED`

#### FC-014 | M3 | Graph Validation & Actionable Error Diagnostics
- **Milestone:** M3
- **Capability:** Unified pre-publish DAG and configuration diagnostics with visual node badges and clickable error summary.
- **Current Evidence:** `collectWorkflowDefinitionIssues` (`workflow.ts`) and `compileWorkflow` (`compiler.ts`) enforce structural DAG validity (`CYCLE`, `EMPTY_GRAPH`, `SELF_DEPENDENCY`, `UNKNOWN_DEPENDENCY`, `ID_MISMATCH`, `DUPLICATE_STEP_ID`, `UNKNOWN_ROUTING_CONDITION`) while intentionally allowing independent parallel roots. However, trigger presence, registered action IDs, Zod input completeness, and `{{...}}` reference validity are not surfaced in a canvas diagnostics banner or node badges.
- **Required Outcome:** Extend `collectWorkflowDefinitionIssues` / pre-publish validation with severity (`ERROR` vs `WARNING`) and node attribution; surface error/warning badges on `ActionNode.tsx`, `TriggerNode.tsx`, and a clickable canvas diagnostics banner.
- **Dependencies:** FC-013
- **Files Involved:** `src/lib/workflow-types/workflow.ts`, `src/lib/workflow/graph-ui/compiler.ts`, `src/features/organizations/components/workflow/nodes/ActionNode.tsx`, `src/features/organizations/components/workflow/nodes/TriggerNode.tsx`, `src/features/organizations/components/workflow/WorkflowCanvas.tsx`
- **Acceptance Criteria:**
  - Canvas flags nodes unreachable from a trigger with a non-blocking `WARNING` badge (preserving `WorkflowDefinitionSchema` independent-root compatibility).
  - Canvas flags nodes with unset/unregistered actions, missing required inputs, invalid `{{...}}` references, or cycles with `ERROR` badges and a clickable diagnostics list.
  - Publishing is blocked when any `ERROR` issue exists (including cycles, missing trigger, invalid action, or invalid inputs).
- **Status:** `NOT_STARTED`

#### FC-015 | M3 | Draft vs. Published State Management & Active Lifecycle
- **Milestone:** M3
- **Capability:** Separation between mutable canvas drafts and immutable published workflow versions, with explicit active/inactive lifecycle gating.
- **Current Evidence:** `WorkflowRun` snapshots (`definitionSnapshot` + `definitionHash`) isolate in-flight runs from edits (F-03), but `Workflow` itself has only one mutable `definition` row overwritten on every save, `isActive` is auto-set to `!!eventId`, and `startWorkflow` does not check `isActive`.
- **Required Outcome:** Introduce immutable `WorkflowVersion` persistence (and `publishedVersionId` on `Workflow`) via Prisma migration; keep canvas saves strictly on draft fields; add explicit `publishWorkflow` (validated by FC-014 under `FOR UPDATE` lock) and `toggleWorkflowActive` actions; gate production ignition on `isActive` + `publishedVersionId` without affecting in-flight runs.
- **Dependencies:** FC-014
- **Files Involved:** `prisma/schema.prisma`, `src/app/actions/workflows/workflow.ts`, `src/lib/workflow/execution/trigger.ts`, `src/features/organizations/components/workflow/WorkflowCanvas.tsx`, `src/app/org/[orgId]/workflows/page.tsx`
- **Acceptance Criteria:**
  - Saving draft edits on the canvas does not mutate the currently published `WorkflowVersion` used by new production runs.
  - Clicking "Publish" runs FC-014 validation, creates an immutable `WorkflowVersion` snapshot, and updates `publishedVersionId`.
  - Toggling `isActive` suspends/resumes new production ignition immediately without cancelling or mutating in-flight `WorkflowRun`s.
  - **Tenant & Concurrency Boundary:** All draft/publish/toggle actions enforce `getOrgAccess`, `orgId` write predicates, and transactional row locking.
- **Status:** `NOT_STARTED`

#### FC-016 | M3 | Manual Test-Run Drawer & Trigger Output Preview
- **Milestone:** M3
- **Capability:** Non-mutating sandbox simulation of workflow drafts from the canvas with trigger payload editor and step output preview.
- **Current Evidence:** `RunWorkflowButton.tsx` and `POST /api/workflow/test/[workflowId]/test-run` call `startWorkflow()`, which creates real `WorkflowRun`s, dispatches real QStash work, and executes real `Task` mutations in PostgreSQL. `WorkflowRunDashboard.tsx` displays only step statuses, not step outputs.
- **Required Outcome:** Build a sandbox simulation runner (`simulateWorkflowRun`) that evaluates the current draft DAG in-memory using `resolveInputs`, `validateTriggerContext`, and action-level side-effect policies (no real DB business mutations, no emails, no QStash dispatch), paired with `WorkflowTestRunModal.tsx` showing pre-populated trigger JSON and redacted step-by-step inputs/outputs/errors.
- **Dependencies:** FC-014, FC-015
- **Files Involved:** `src/lib/workflow/execution/simulator.ts`, `src/app/actions/workflows/workflow-run.ts`, `src/features/organizations/components/workflow/WorkflowTestRunModal.tsx`, `src/features/organizations/components/workflow/RunWorkflowButton.tsx`
- **Acceptance Criteria:**
  - Clicking "Test Run" opens `WorkflowTestRunModal` pre-populated with a JSON payload matching the selected trigger type and validated via `validateTriggerContext`.
  - Running a test executes in sandbox mode: creates zero real `Task` rows, sends zero emails, dispatches zero QStash jobs, and does not pollute production `WorkflowRun` history.
  - Drawer renders per-step status, resolved inputs, redacted/truncated JSON outputs, skipped branches, and error highlights.
- **Status:** `NOT_STARTED`
```
