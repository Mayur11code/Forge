# M5 — FC-021: Task & Comment Actions with Saga Compensation

- **Date:** 2026-11-28
- **Milestone:** M5 — Actions and Integrations (`FC-021`)
- **Methodology:** Universal Prompt Patterns Registry (UPPR) Rev 4.1
- **Status:** Complete & Verified — Owner Acceptance Pending

---

## 1. Executive Summary

FC-021 implements two core workflow mutation actions with backward saga compensation and tenant-isolated execution:
- `task.update@1.0.0` (`src/lib/workflow/actions/core/update-task.ts`)
- `comment.create@1.0.0` (`src/lib/workflow/actions/core/create-comment.ts`)

In addition, FC-021 established the worker-safe canonical comments service (`src/lib/comments/create-comment.ts`), separating headless background engine operations from Next.js server-action UI dependencies (`getOrgAccess`, `notFound()`, `revalidatePath()`).

---

## 2. Architectural Changes & Key Invariants

### 2.1 Worker-Safe Comments Domain Service (`src/lib/comments/create-comment.ts`)
- Previously, comments were managed through `src/app/actions/comments/createComments.ts`, which depended on interactive request contexts and user sessions.
- Created `src/lib/comments/create-comment.ts` exposing:
  - `createCommentInOrg`: Transactional comment creation with actor/author attribution, tenant scoping, and vector sync.
  - `deleteCommentInOrg`: Safe deletion of comments ensuring tenant isolation.
  - `appendTombstoneCommentInOrg`: Appends compensation markers upon rollback.

### 2.2 Task Update Action (`task.update@1.0.0`)
- **Key Invariants:**
  - Multi-tenant boundary check: verifies `task.project.orgId === context.organizationId`.
  - Captures atomic `previousState` snapshot (status, priority, title, description, assigneeId) *before* applying the mutation.
  - Returns `previousState` alongside updated values in `ActionResult.data`.
  - Emits domain mutation carrying `originType: "WORKFLOW"`, ensuring workflow-originated updates do not trigger infinite loops or recursion storms.
  - **Saga Compensation Handler:**
    - Checks whether current database state matches the expected post-action state. If concurrent manual edits occurred, compensation detects the conflict and does not blindly overwrite user changes.
    - Restores previous status, priority, title, description, and assigneeId.
    - Records an audit entry in `ExecutionAuditLog`.

### 2.3 Comment Creation Action (`comment.create@1.0.0`)
- **Key Invariants:**
  - Multi-tenant boundary check: verifies target task belongs to caller's active organization.
  - Creates comment with `authorType: "SYSTEM"` (or workflow bot) and returns `{ commentId, taskId, createdAt }`.
  - **Saga Compensation Handler (Tombstoning):**
    - Classified as **Compensatable (Append-only)**.
    - Rather than hard-deleting the comment (which could erase audit visibility), compensation appends a visible tombstone indicator:
      `⚠️ [Compensated: Action rolled back by Saga Engine]`
    - Records an audit log entry in `ExecutionAuditLog`.

---

## 3. Verification & Evidence

### Dedicated Test Suite: `src/tests/workflow/m5-fc021-task-comment-actions.test.ts`
- **Tests Executed:** 6 / 6 passed
  1. `task.update` executes forward, captures previous state, and updates database.
  2. `task.update` enforces tenant isolation (rejects cross-tenant task update).
  3. `task.update` saga compensation restores previous state when unchanged.
  4. `task.update` saga compensation detects concurrent user edits and guards against blind overwrite.
  5. `comment.create` forward execution posts comment to task.
  6. `comment.create` saga compensation appends tombstone marker and logs audit trail.
