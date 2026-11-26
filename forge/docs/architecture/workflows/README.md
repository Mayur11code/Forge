# Workflow Engine Architecture

This document describes the architectural specifications, contracts, and core primitives of the Forge DAG Workflow Engine.

> [!IMPORTANT]
> **Active Work & Product Completion:**
> All active implementation assignments, milestone progress, and backlog status are tracked authoritatively in:
> [PRODUCT_COMPLETION_TRACKER.md](../../product/PRODUCT_COMPLETION_TRACKER.md)
>
> Historical Assignment 37 planning and phase verification records are preserved in:
> [forge/docs/archive/workflows/assignment-37/](../../archive/workflows/assignment-37/)

---

## 1. Core Principles

Forge executes durable, multi-tenant, event-driven DAG workflows:

1. **LLM Proposes, Deterministic Backend Disposes:** The AI agent compiles declarative `WorkflowProposal` specs through strict validation; no model output bypasses tenant or schema boundaries.
2. **Transactional Outbox (`WorkflowOutbox`):** Every step execution state transition commits atomically with its queue dispatch intent in PostgreSQL, preventing queue-state divergence.
3. **Immutable Workflow Definition Contract:** Runs freeze the definition and semantic action versions (`@1.0.0`) under `SELECT ... FOR SHARE` locks at ignition, enforced by database triggers.
4. **Saga Compensation:** Step failures invoke deterministic backward rollbacks (`ROLLING_BACK` &rarr; `ROLLED_BACK`) with exclusive compensation leases (`compensationClaimedBy`).
5. **Strict Tenant Boundaries:** All workflow ignition, step advancing, run telemetry, and Pusher streams are verified against server-derived organization identity via `getOrgAccess()`.

---

## 2. Subsystem Layout

| Module | Location | Purpose |
| :--- | :--- | :--- |
| **Execution Engine** | `src/lib/workflow/execution/` | Evaluator (`evaluator.ts`), state transitions (`state.ts`), wrapper (`wrapper.ts`), ignition (`trigger.ts`), outbox (`outbox.ts`), and mutex (`mutex.ts`). |
| **Action Registry** | `src/lib/workflow-types/action-registry.ts` | Strict semantic versioned action registry (`formatActionKey`, `registerAction`, `getAction`). |
| **Capability Catalog** | `src/lib/workflow-types/action-capabilities.ts` | Machine-readable schemas (input/output Zod contracts) used by planners and UI. |
| **Presentation Registry** | `src/lib/workflow-types/registry.ts` | Client-safe form definitions and widgets for the workflow canvas. |
| **Compiler & Graph UI** | `src/lib/workflow/graph-ui/compiler.ts` | Topological sort, cycle detection, edge validation, and DAG compilation. |
| **Maintenance** | `src/lib/workflow/maintenance.ts` | Expired outbox recovery, stale execution sweep, and lease reclamation. |
