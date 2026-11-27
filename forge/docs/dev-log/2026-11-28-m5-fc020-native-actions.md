# M5 — FC-020: Native Actions Reconciliation & Registration

- **Date:** 2026-11-28
- **Milestone:** M5 — Actions and Integrations (`FC-020`)
- **Methodology:** Universal Prompt Patterns Registry (UPPR) Rev 4.1
- **Status:** Complete & Verified — Owner Acceptance Pending

---

## 1. Executive Summary

FC-020 establishes the reconciliation and formal registration of Forge's core native actions:
- `email.send@1.0.0` (`send-email.ts`)
- `report.generate@1.0.0` (`generate-report.ts`)
- `logic.condition@1.0.0` (`conditions.ts`)
- `task.create@1.0.0` capability schema reconciliation (`compensation.available: true`)

Prior to this assignment, action implementations existed in isolation or without formal synchronization across the three canonical action surfaces:
1. Execution Registry (`src/lib/workflow-types/action-registry.ts`)
2. Capability Registry (`src/lib/workflow-types/action-capabilities.ts`)
3. UI Presentation Catalog (`src/lib/workflow-types/registry.ts`)

FC-020 fully aligned all three surfaces, standardizing version-pinned keys (`@1.0.0`), explicit Zod input/output schemas, compensation availability, and React Flow visual widget configurations.

---

## 2. Architectural Changes & Key Invariants

### 2.1 Send Email Action (`email.send@1.0.0`)
- **Source:** `src/lib/workflow/actions/core/send-email.ts`
- **Canonical Action ID:** `email.send` (versioned `email.send@1.0.0`)
- **Key Invariants:**
  - Strict input validation via Zod: `to` (valid email string), `subject` (min 1 char), `body` (plain text string or HTML content).
  - Production path dispatches transactional emails via Resend (`resend.emails.send`).
  - Strict HTML escaping for plain-text inputs to prevent HTML/XSS injection vulnerabilities in generated email templates.
  - Returns deterministic output: `{ messageId: string, to: string, subject: string, sentAt: string, provider: "resend" }`.
  - Classified as **Irreversible** in the compensation taxonomy: external emails cannot be un-sent. On saga rollback, an audit record is logged.

### 2.2 Report Generator Action (`report.generate@1.0.0`)
- **Source:** `src/lib/workflow/actions/core/generate-report.ts`
- **Canonical Action ID:** `report.generate` (versioned `report.generate@1.0.0`)
- **Key Invariants:**
  - Generates real, structured Markdown reports containing comprehensive project metadata, execution timestamps, and markdown tables of all organization tasks (`ID | Title | Status | Priority | CreatedAt`).
  - No dummy or mock strings: dynamically queries project tasks from PostgreSQL scoped strictly to `context.organizationId`.
  - Artifact upload via UploadThing (`utapi.uploadFiles`) returning a permanent public URL and file key.
  - Provides forward compensation: on backward saga rollback, the uploaded artifact is deleted from cloud storage via `utapi.deleteFiles(fileKey)` and logged in `ExecutionAuditLog`.

### 2.3 Condition Evaluator (`logic.condition@1.0.0`)
- **Source:** `src/lib/workflow/actions/logic/conditions.ts`
- **Canonical Action ID:** `logic.condition` (versioned `logic.condition@1.0.0`)
- **Key Invariants:**
  - Evaluates comparison operators: `equals`, `notEquals`, `contains`, `greaterThan`, `lessThan`, `in`.
  - Pure, stateless evaluation with zero side effects.
  - Classified as **Stateless / Read-only** (zero compensation required).

### 2.4 Registry Synchronization
- Synchronized `AVAILABLE_ACTIONS` and `ActionCapabilities` to expose all native actions in the visual canvas palette (`ACTION_FIELD_PRESENTATION`), supporting properties drawer editing, field auto-generation, and execution edge validation.

---

## 3. Verification & Evidence

### Dedicated Test Suite: `src/tests/workflow/m5-fc020-native-actions.test.ts`
- **Tests Executed:** 10 / 10 passed
  1. Registry exposes `email.send@1.0.0` with handler, schema, and Irreversible compensation.
  2. Registry exposes `report.generate@1.0.0` with handler, schema, and Reversible compensation.
  3. Registry exposes `logic.condition@1.0.0` with handler, schema, and zero compensation.
  4. `email.send` successfully sends email via Resend and returns messageId.
  5. `email.send` handles delivery failures gracefully.
  6. `report.generate` generates real markdown table from project tasks and uploads via UTApi.
  7. `report.generate` compensation deletes file via UTApi.
  8. `report.generate` compensation is idempotent when fileKey is missing.
  9. `logic.condition` evaluates equality and inequality operators.
  10. `logic.condition` evaluates numerical comparisons.

### Registry Correspondence: `src/tests/workflow/action-capabilities.test.ts`
- **Tests Executed:** 32 / 32 passed asserting compile-time and runtime consistency across all registered actions.
