# M5 — FC-023: End-to-End Automation Scenarios Verification

- **Date:** 2026-11-28
- **Milestone:** M5 — Actions and Integrations (`FC-023`)
- **Methodology:** Universal Prompt Patterns Registry (UPPR) Rev 4.1
- **Status:** Complete & Verified — Owner Acceptance Pending

---

## 1. Executive Summary

FC-023 validates the complete integration of Forge's workflow engine, trigger filtering, action catalogue, and saga rollback infrastructure across three practical business automation scenarios:
1. **Scenario 1 (Auto-Triage):** `task.created` (HIGH/URGENT) &rarr; Filter &rarr; `task.update` (Assign Lead & Status `IN_PROGRESS`) &rarr; `email.send` via Resend.
2. **Scenario 2 (Progress Digest):** Trigger &rarr; `report.generate` (writes real structured Markdown table artifact & uploads to UploadThing) &rarr; `comment.create` &rarr; `email.send`.
3. **Scenario 3 (Escalation & Rollback):** `task.updated` (`BLOCKED`) &rarr; `comment.create` (audit note) &rarr; `task.update` (`IN_PROGRESS`, `HIGH`) &rarr; Downstream `http.request` fails (500) &rarr; Reverse Saga Compensation restores `BLOCKED` status & appends tombstone comment.

---

## 2. Detailed Execution Walkthrough & Invariants

### 2.1 Scenario 1: Auto-Triage
- **Trigger:** Incoming task created with `priority: "HIGH"`.
- **Filter Evaluation:** Evaluates `{{trigger.outputs.priority}} == "HIGH"`. Filter evaluates `true`.
- **Step 1 (`task.update@1.0.0`):**
  - Resolves `{{trigger.outputs.id}}` to task ID.
  - Updates status to `IN_PROGRESS` and assigns to lead user (`lead-user-123`).
  - Records previous state snapshot `{ status: "TODO", priority: "HIGH", assigneeId: null }`.
- **Step 2 (`email.send@1.0.0`):**
  - Dispatches email to tech lead notifying them of assignment with task title in subject.
  - Returns `messageId`.
- **Outcome:** Full forward execution completes with status `COMPLETED`.

### 2.2 Scenario 2: Progress Digest
- **Trigger:** Manual trigger / event trigger.
- **Step 1 (`report.generate@1.0.0`):**
  - Queries project tasks directly from database.
  - Assembles structured Markdown document with title, summary, timestamp, and a Markdown table:
    `| Task ID | Title | Status | Priority | Created At |`
  - Uploads generated report file via UploadThing `utapi.uploadFiles`.
  - Outputs `{ fileUrl, fileKey, fileSize, generatedAt, rowCount }`.
- **Step 2 (`comment.create@1.0.0`):**
  - Resolves `{{report.generate.fileUrl}}`.
  - Posts markdown comment to parent task: `Automated digest report generated: [Download Report]({{fileUrl}})`.
  - Returns `{ commentId, createdAt }`.
- **Step 3 (`email.send@1.0.0`):**
  - Dispatches digest summary email with download link to project stakeholders.
- **Outcome:** Full forward execution completes with status `COMPLETED`. Real Markdown table verified.

### 2.3 Scenario 3: Escalation & Saga Backward Rollback
- **Trigger:** Task status updated to `BLOCKED`.
- **Step 1 (`comment.create@1.0.0`):**
  - Posts audit comment: `Automated escalation initiated to incident paging system.`.
  - Step 1 completes with status `COMPLETED`.
- **Step 2 (`task.update@1.0.0`):**
  - Captures `previousState: { status: "BLOCKED", priority: "MEDIUM" }`.
  - Escalates task status to `IN_PROGRESS` and priority to `HIGH`.
  - Step 2 completes with status `COMPLETED`.
- **Step 3 (`http.request@1.0.0`):**
  - Dispatches outbound notification webhook to an allowed public webhook URL (`https://incident-alerts.ops-monitor.com/api/v1/page`).
  - Pre-resolves to public IP `93.184.216.34`, passing all SSRF scheme, hostname, and socket pinning checks.
  - The injected test transport simulates an upstream HTTP 500 Internal Server Error without performing unconstrained external network calls.
  - Production `http.request` handler receives status 500, sets `isRetriable: true`, and marks the step as failed.
- **Saga Backward Rollback:**
  - Engine enters reverse saga compensation for all previously completed steps in reverse order (Step 2 &rarr; Step 1).
  - **Step 2 Compensation (`task.update`):**
    - Verifies multi-field concurrency invariant under transactional check: confirms neither status nor priority was modified concurrently by a human.
    - Restores task `status` back to `BLOCKED` and `priority` to `MEDIUM`.
    - Writes `ExecutionAuditLog` record documenting compensation.
  - **Step 1 Compensation (`comment.create`):**
    - Executes append-only tombstone compensator.
    - Appends `\n\n*[ROLLED BACK: Automated action rolled back due to downstream workflow failure]*` to comment.
    - Writes `ExecutionAuditLog` record documenting compensation.
- **Outcome:** Workflow run transitions to `FAILED` with all prior mutations safely compensated and reconciled.

---

## 3. Verification & UPPR Evidence Classification

In strict compliance with UPPR Rev 4.1 evidence standards:

| Level | Evidence Category | Scope & Status |
|:---:|:---|:---|
| **E1** | Source inspection and static evidence | **VERIFIED:** Version-pinned action definitions (`@1.0.0`), Zod schemas, React Flow canvas presentations. |
| **E2** | Controlled mocks and automated tests | **VERIFIED:** 110/110 passing workflow engine tests (including 3/3 business scenarios in `src/tests/workflow/automation-scenarios.test.ts` and 79 dedicated M5 tests) pass deterministically using in-memory transactional stores and controlled provider mocks. |
| **E3** | Real PostgreSQL execution and persisted-state verification | **PENDING:** Real PostgreSQL execution and persisted-state verification pending until performed. |
| **E4** | Physical external-provider verification | **PENDING:** Physical external-provider verification pending until performed. |
| **E5** | Production operational evidence | **PENDING:** Production operational evidence pending until operational deployment. |
