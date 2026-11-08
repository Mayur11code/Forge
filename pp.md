# Universal Prompt Patterns Registry (UPPR) — Revision 4.1
## Enforceable Implementation, Integration & Acceptance Gates: Evidence Completeness & Acceptance Hardening

> [!IMPORTANT]
> **The Core Operational Distinction:**  
> **A design being specified is not an implementation being integrated.**  
> **An implementation existing is not a production path invoking it.**  
> **A helper passing a test is not a workflow being correct.**  
> **A test passing is not a guarantee beyond what that test actually exercised.**  
>  
> UPPR Rev 4.1 converts prompt patterns from advisory engineering principles into an enforceable engineering methodology. Every critical invariant must be bound to a concrete, executable verification chain:  
> `INVARIANT → AUTHORITY → INPUT CONTRACT → PRODUCTION ENTRY POINT → ENFORCEMENT BRANCH → FAILURE PATH → SUCCESS PATH → STATE TRANSITION → TEST → EVIDENCE`

---

## 1. Evidence Governance and Lifecycle Statuses

Every pattern in this registry is bound to empirical evidence derived from engineering experiments on real software systems. Statuses reflect demonstrated proof, not theoretical merit, unverified assertions, or uncalibrated self-reports.

| Status | Definition | Promotion Criteria |
| :--- | :--- | :--- |
| **PROPOSED** | Formulated from architectural analysis, post-mortem audits, or single failure observations. Not yet implemented or verified in code. | Identified in root-cause analysis or architectural review. |
| **EXPERIMENTAL** | Implemented and verified in at least one concrete engineering task with passing automated tests. | Demonstrated in a verified implementation with passing unit/invariant tests. |
| **REPEATED** | Independently applied and confirmed across two or more distinct tasks, revisions, or subsystems. | Replicated with consistent defect prevention across different subsystems or tasks. |
| **VALIDATED** | Repeatedly proven across multiple independent experiments with comparative evidence of improved outcomes, zero unresolved counterexamples, and independent adversarial acceptance. | Multi-revision replication across independent codebases/projects, adversarial review survival, and measured comparative improvement against controls. |
| **SUPERSEDED** | Replaced by a more precise, comprehensive, or proportional pattern. | Explicitly linked to its replacement pattern with historical rationale preserved. |

> [!IMPORTANT]
> **Strict Validation Promotion Standard:** Passing a test suite is not comparative prompt-workflow evidence. Compiler error reduction is not causal proof of prompt pattern superiority. Multiple iterations within the same task or codebase do not constitute independent experiments. Therefore, patterns tested across multiple revisions of a single codebase are classified as `REPEATED` or `EXPERIMENTAL`. Promotion to `VALIDATED` strictly requires multi-codebase independent comparative outcome validation with external adversarial review.
>
> **Lifecycle Governance Consistency:** Every pattern in this registry carries exactly one unambiguous lifecycle status across all matrix tables, audit sections, and pattern definitions. P29 was promoted to `EXPERIMENTAL` based on its implementation and verification in Experiment PP-006 and empirical audit in PP-007. No pattern lifecycle status is promoted to `VALIDATED` solely from single-codebase remediation experiments (such as PP-007 and PP-008).

---

## 2. Portability and Pattern Applicability Classification

To prevent imposing one repository's conventions, language idioms, or storage engines onto another, every pattern in this registry carries an explicit **Portability Classification**:

| Classification | Meaning | Agent Activation Rule |
| :--- | :--- | :--- |
| **GENERAL** | Universally applicable to any codebase, language, runtime, or architectural paradigm. | Always eligible for selection based on task risk profile. |
| **CONDITIONAL** | Applicable only when a specific technical or architectural prerequisite exists (e.g. relational transactions, distributed workers, external HTTP APIs). | Activated ONLY when repository inspection confirms the prerequisite architectural capability is present. |
| **DOMAIN-SPECIFIC** | Specialized engineering guidance for a particular problem domain (e.g. AI retrieval pipelines, vector databases). | Activated ONLY when working directly within the designated domain. Never apply to general backend, frontend, or systems code. |
| **EXPERIMENTAL** | Validated in bounded experiments, undergoing empirical calibration. | Activated selectively when governing risks align with the pattern's proven failure modes. |
| **HISTORICAL** | Retained primarily as an empirical lesson from prior experiments. | Inactive for general execution; serves as audit and architectural precedent. |

### Pattern Applicability Matrix (P1–P29)

| ID | Pattern Name | Portability | Prerequisites / Activation Trigger | Explicit Exclusions (When NOT to Apply) |
| :--- | :--- | :---: | :--- | :--- |
| **P1** | Repository-First Grounding | **GENERAL** | Any task initiation, plan generation, or review turn. | Never excluded. Mandatory grounding. |
| **P2** | Baseline-Before-Editing | **GENERAL** | Before applying code edits to any existing codebase. | Brand-new empty repositories with zero existing tests; planning/audit tasks with zero code edits. |
| **P3** | Explicit Invariant Specification | **GENERAL** | Architectural planning, task scoping, and bug fixing. | Trivial formatting, comment, or pure text edits. |
| **P4** | Bounded Architectural Scope | **GENERAL** | All code modification and refactoring tasks. | Explicit greenfield rewrites where scope is unconstrained. |
| **P5** | Failure-Specific Incremental Implementation | **GENERAL** | Resolving compiler, linter, type, or test failures. | Prototyping scratch files outside main source tree. |
| **P6** | Security, Tenant Isolation, and Provenance | **CONDITIONAL** | Multi-tenant systems, authenticated APIs, shared resources. | Single-user CLI tools, local offline scripts, public static assets. |
| **P7** | Evidence-Based Completion | **GENERAL** | Task completion reporting across all tasks. | Never excluded. Mandatory reporting discipline. |
| **P8** | Authoritative Context Gating | **DOMAIN-SPECIFIC** | AI/RAG context compilation, semantic caches, LLM retrieval. | Conventional CRUD APIs, static query endpoints, non-AI systems. |
| **P9** | Explicit Entity Version Decoupling | **DOMAIN-SPECIFIC** | Hierarchical document indexing, composite vector metadata. | Flat relational tables, non-hierarchical entities, non-vector data. |
| **P10** | Invariant-to-Implementation Traceability | **GENERAL** | Designing or reviewing critical stateful or distributed logic. | Trivial stateless utilities, simple pure helper functions. |
| **P11** | Explicit Authority for Destructive Operations | **CONDITIONAL** | Deletion sweeps, soft/hard deletion, record purges. | Pure append-only logs, immutable ledgers, read-only services. |
| **P12** | Complete Lifecycle State-Machine Verification | **CONDITIONAL** | Multi-step asynchronous state transitions, background jobs. | Simple atomic CRUD mutations completed in a single synchronous call. |
| **P13** | Concurrency Feasibility & Realistic Interleavings | **CONDITIONAL** | Concurrent mutations, shared row locks, distributed workers. | Single-threaded CLI scripts, read-only endpoints, isolated batch jobs. |
| **P14** | External Side-Effect Durability and Asynchrony | **CONDITIONAL** | Calling remote HTTP APIs, webhooks, or cloud services. | Pure in-memory operations, local database transactions with no network. |
| **P15** | Pagination and Completeness Proof | **CONDITIONAL** | Sweeping, purging, or batch-processing collections. | Single-record lookups, fixed-size small enumerations. |
| **P16** | Rollback and Migration Separation | **CONDITIONAL** | Promoting major schema versions, data migrations, cutovers. | Backwards-compatible additive non-breaking field additions. |
| **P17** | Evidence-Calibrated Engineering Guarantees | **GENERAL** | Formulating completion claims and readiness disclosures. | Never excluded. Mandatory reporting standard. |
| **P18** | Cross-Artifact Consistency Verification | **GENERAL** | Multi-file contracts (schemas, types, queries, docs, tests). | Single-file self-contained scripts with no external dependencies. |
| **P19** | Failure-First Test Design | **GENERAL** | Authoring test suites for business logic or state machines. | Pure declarative type definitions or schema-only tasks. |
| **P20** | Solution Proportionality & Complexity Bounding | **GENERAL** | Architectural design, edge-case resolution, refactoring. | Hard real-time or safety-critical systems with fixed specifications. |
| **P21** | Persistence Contract Fidelity | **CONDITIONAL** | Code interacting with persistence delegates or test doubles. | Tasks with no test doubles, pure integration tests against real DBs. |
| **P22** | Database Artifact Semantic Consistency | **CONDITIONAL** | Relational schemas, ORM models, and DDL migrations. | Schemaless NoSQL stores (e.g. MongoDB), key-value caches (Redis). |
| **P23** | Global Lock Ordering & Deadlock Reduction | **CONDITIONAL** | Multi-row or multi-table database transactions acquiring locks. | Optimistic-concurrency-only stores, lock-free queues, single-row writes. |
| **P24** | Write-Receipt Identity & Read-Back Separation | **CONDITIONAL** | Asynchronous worker pipelines reporting completion receipts. | Synchronous inline request-response workflows. |
| **P25** | Disposable Database Isolation & Verification Gating | **CONDITIONAL** | Running integration tests requiring live databases or migrations. | Pure unit-test suites running entirely with in-memory doubles. |
| **P26** | Database-Clock Lease Authority and Fencing | **CONDITIONAL** | Distributed worker leases, heartbeats, and lock timeouts. | Single-instance synchronous request handlers, stateless workers. |
| **P27** | Referential Retention Semantics | **CONDITIONAL** | Designing relational foreign keys and cascading deletion logic. | Document stores without relational foreign keys, flat key-value stores. |
| **P28** | Secret-Safe Execution & Credential Sanitization | **GENERAL** | Reading configuration, inspecting environments, logging, reporting. | Never excluded. Mandatory security baseline. |
| **P29** | Documentation & Reference-Grounded Design Selection | **GENERAL** | Architecture or subsystem planning; introducing new integrations, providers, or SDKs; choosing between materially different design patterns; decisions affecting consistency, concurrency, security, or migration; dependence on external provider contracts. | Trivial, local, self-contained single-function edits with no architectural impact. |

---

## 3. Experiment History & Empirical Evidence Base

### Experiment PP-001 — Two-Stage Planning and Implementation
**Date:** 2026-10-28 | **Project:** Forge | **Task:** Semantic-cache production-safety hardening  
**Workflow:** Claude Sonnet 4.6 (planning) → Gemini 3.8 Flash (implementation)  
**Status:** Completed (reported outcomes from single implementation run; non-independently-reproduced; requires cross-codebase replication)  
*Prompt Patterns Retained:* P1 (Repository-First Grounding), P2 (Baseline-Before-Editing), P3 (Explicit Invariants), P4 (Bounded Scope), P5 (Failure-Specific Incremental Fixes), P6 (Security & Tenant Isolation), P7 (Evidence-Based Completion).

---

### Experiment PP-002 — Single-Family Planning and Remediation (Gemini 3.8 Flash)
**Date:** 2026-10-28 | **Project:** Forge | **Task:** Semantic-cache freshness verification, source version synchronization, and test suite hardening  
**Workflow:** Gemini 3.8 Flash (planning) → Gemini 3.8 Flash (implementation)  
**Status:** Completed (single-family remediation verified within Forge test suite)  
*Prompt Patterns Retained:* P8 (Authoritative Context Gating), P9 (Explicit Entity Version Decoupling).

---

### Experiment PP-003 — Production Readiness and Lifecycle Verification (Negative Control)
**Origin:** Follow-up to PP-002, Forge semantic-cache freshness remediation  
**Workflow:** Gemini 3.8 Flash for unguided implementation  
**Status:** Completed (informative single negative control demonstrating F1–F14 failure modes under unguided agent execution).

---

### Experiment PP-004 — Iterative Architecture Verification and Adversarial Review
**Date:** October–November 2, 2026 | **Project:** Forge | **Task:** Semantic-cache vector generation, reconciliation, deletion safety, and dual-namespace retrieval  
**Workflow:** Claude Sonnet 4.6 (initial planning) → Gemini 3.8 Flash (implementation, adversarial audit, multi-revision remediation)  
**Status:** Completed Phase 1 (Revisions 1–11 architectural audit)  
*Prompt Patterns Retained:* P10 (Invariant Traceability), P11 (Destructive Authority), P12 (Lifecycle State Machines), P13 (Concurrency Realism), P14 (Side-Effect Durability), P15 (Pagination Completeness), P16 (Rollback Separation), P17 (Evidence Calibration), P18 (Cross-Artifact Consistency), P19 (Failure-First Testing), P20 (Solution Proportionality).

---

### Experiment PP-005 — Vector V2 Phase A Implementation, Review and Hardening
**Date:** 2026-11-02 to 2026-11-03 | **Project:** Forge | **Task:** Vector Generation V2 Phase A (Durable Generation State Model, Foreign Key Alignment, Write Receipt Contract, Deadlock-Risk Reduction, and Mock Double Fidelity)  
**Workflow:** Claude Sonnet 4.6 (initial planning / review) → Gemini 3.8 Flash (implementation, independent review, and hardening)  
**Status:** Completed implementation and unit/mock verification; Level E3 real-database verification passed on approved Neon development database.  
*Prompt Patterns Retained:* P21 (Persistence Contract Fidelity), P22 (Database Artifact Semantic Consistency), P23 (Global Lock Ordering), P24 (Write-Receipt Identity), P25 (Disposable DB Isolation), P26 (DB-Clock Lease Authority), P27 (Referential Retention Semantics), P28 (Secret-Safe Execution).

---

### Experiment PP-006 — Vector V2 Phase B Architectural Adversarial Review & Specification Hardening
**Date:** 2026-11-03 to 2026-11-05 | **Project:** Forge | **Task:** Vector Generation V2 Phase B (Distributed Multi-Worker Embedding Execution, Pinecone Bounded Verification, EventLog Ownership, Non-Blocking Outbox Coalescing, and Serving Retrievability)  
**Workflow:** Claude Sonnet 4.6 (initial planning) → Gemini 3.8 Flash (adversarial audit, specification hardening, closure amendments Rev 1 → Rev 3.2)  
**Status:** Completed specification closure (Revision 3.2 accepted; ready for PR-1 implementation)

#### Key Failure Modes Discovered & Resolved
1. **Unverified SDK Assumptions:** Initial specifications assumed `@pinecone-database/pinecone` supported `fetch(ids, { signal })`. Inspecting the installed SDK v8 revealed that `FetchOptions` accepts only `ids` and `namespace`, requiring monotonic budget tracking and application-level timeouts.
2. **Conflating Revision Freshness with Wall-Clock Timestamps:** Relying on `updatedAt` for $A \to B \to A$ ordering failed because PostgreSQL transaction timestamps are wall-clock values subject to collisions. Corrected by introducing strictly monotonic per-entity revisions (`latestRevision Int`).
3. **Blocking Domain Writes on Asynchronous Dispatch:** Scoping outbox unique indexes to `CLAIMED` rows caused background broker latency to block user-facing domain mutations. Corrected by scoping the partial unique index strictly to `PENDING` rows.
4. **Publish-Before-Mark Dispatcher Race:** Fast worker completion before dispatcher state marking risked state regression. Corrected by enforcing Compare-And-Set (CAS) dispatch transitions.
5. **Conflating Delivery Identity with Logical Work Identity:** Keying `EventLog` solely by QStash `messageId` allowed redrives to bypass worker execution locks. Corrected by introducing durable `outboxEventId` and database-clock lease stealing.
6. **Unbounded Polling Claims:** Claiming a 5s deadline while allowing unbounded request timeouts. Corrected by enforcing `performance.now()` remaining budget caps.
7. **Heuristic vs Mathematical Recall Overclaims:** Treating candidate oversampling as an exhaustive recall guarantee. Corrected by framing oversampling as a bounded heuristic with explicit secondary fetch limits.

*Prompt Patterns Retained & Motivated:* Motivated and established **P29 (Documentation & Reference-Grounded Design Selection)**; strengthened P3, P12, P13, P14, P17, P18, P22, P24, P26.

---

### Experiment PP-007 — Vector V2 Phase B Production Acceptance & Independent Audit
**Date:** 2026-11-05 to 2026-11-06 | **Project:** Forge | **Task:** Vector Generation V2 Phase B Production Implementation, Verification Remediation, and Independent Code-Grounded Audit  
**Workflow:** Gemini 3.8 Flash (Implementation PR-1..PR-5 & Remediation) → External Adversarial Reviewer (Audit & Evidence Collection)  
**Status:** Completed implementation and independent code-grounded audit. 110 test suites passed (1,762 tests); 6/6 E3 Neon real-database suites passed (26/26 tests); 1/1 E4 live Pinecone suite passed.

#### Key Failure Modes Discovered & Resolved
1. **Outbox Capture Bypass:** Dedicated transactional outbox helpers existed and passed helper-level database tests, but canonical domain mutation functions (`createTask`, `updateTask`, `deleteTask`, `createAttachment`) were not invoking the outbox capture helper, leaving production writes without asynchronous vector synchronization.
2. **Lease Heartbeat Execution Omission:** Lease renewal and heartbeat helpers existed and passed unit tests, but a recurring background heartbeat was omitted from the actual worker execution loop, leaving long-running jobs vulnerable to premature lease theft.
3. **Duplicate-Delivery Pre-Check Race:** Duplicate-delivery handling checked the database for an existing `SUCCESS` record, but an interleaving race existed between the initial pre-check and the creation of a new active claim.
4. **Over-Broad Child Attachment Refresh:** Domain mutations triggered cascading attachment refreshes even when parent mutations modified non-indexable properties.
5. **Conflation of Helper-Level Tests with Production Integration Proof:** 1,762 passing tests proved helper functions in isolation, but did not prove that production entry points actually invoked those helpers.
6. **Specification Contract Drift:** The Pinecone bounded read-back verification implementation used a 15-second total budget where the approved Rev 3.2 specification strictly defined 5 seconds.
7. **Premature Acceptance Declarations:** The implementation was initially reported as production-ready before an independent adversarial review discovered critical integration and lifecycle gaps.

*Prompt Patterns Retained & Strengthened:* Directly motivated the transition from UPPR Rev 3 to Rev 4. Motivated and established the **Integration Proof Protocol (IPP)**, **Mandatory Defect-Escape Checklist**, calibrated E1–E5 test-scope taxonomy, and strengthened P10, P12, P13, P17, P18, P19, and P26. Promoted P29 to `EXPERIMENTAL`.

---

### Experiment PP-008 — Vector V2 Phase B Controlled Remediation & Production Acceptance Hardening (Parts 1–4.1)
**Date:** 2026-11-08 to 2026-11-09 | **Project:** Forge | **Task:** Vector Generation V2 Phase B Multi-Part Controlled Remediation (Transactional Outbox Capture, EventLog & Generation Lease Lifecycles, Outbox Dispatch State Machine & Forward Migration, Pinecone Physical Verification Hardening, and Part 4.1 Fail-Closed Corrections)  
**Workflow:** Multi-stage iterative implementation with strict single-part scope, independent verification, and adversarial audit under UPPR Rev 4.  
**Status:** Completed implementation, adversarial falsification review, and independent verification across all four parts. 116 test suites passed (1,890 tests); 6/6 E3 Neon real-database suites passed; 1/1 E4 live Pinecone suite passed (confirmed index dimension 768, readback latency 728 ms). Clean patch verification (incremental + cumulative bidirectional reverse check).

#### Key Failure Modes Discovered & Resolved
1. **Outbox Capture Bypass in Domain Mutations:** Canonical task and attachment domain mutations (`createTask`, `updateTask`, `createAttachment`) were executing database modifications without transactionally recording vector-sync intents, leaving vector generation out of sync. Resolved by making `recordVectorSyncIntent` mandatory, transactional, and fail-closed within domain transactions, removing all mock-detection fallbacks.
2. **Database-Clock Authority Bypass in Worker Leases:** Worker lease renewal, completion, and failure paths included application-clock ORM fallbacks (`new Date()`, `Date.now()`), allowing clock drift and stale workers to clobber active leases. Resolved by removing application-clock fallbacks from ownership-sensitive transitions and strictly enforcing PostgreSQL `clock_timestamp()` via authoritative SQL predicates (`claimToken` match, current status, non-null expiration, `leaseExpiresAt > clock_timestamp()`).
3. **Generation Lease Heartbeat Release Boundary Leak:** The active worker heartbeat continued renewing generation leases after generation activation and outbox dispatch, violating lease ownership boundaries. Resolved by establishing a strict termination barrier where the heartbeat is stopped and joined before generation activation.
4. **Outbox Dispatch Contention & Retry State Visibility:** Missing active index on `EventLog` caused dispatch query performance degradation under concurrent load; dispatcher publish retry failures were not surfaced atomically. Resolved by introducing forward migration `20261108000000_eventlog_outbox_active_idx`, implementing an atomic state machine for retry persistence, and verifying concurrent dispatchers with competing connections on PostgreSQL.
5. **Fail-Open Pinecone Verification (Missing Record ID & Digest Bypass):** Verification permitted missing `rec.id` via `if (rec.id !== undefined && rec.id !== id)`, allowing malformed responses to pass; `expectedManifestDigest` was optional or allowed readbacks without pre-validation. Resolved in Part 4.1 by enforcing `typeof rec.id === "string" && rec.id === id`, validating canonical 64-char hex `expectedManifestDigest` prior to readback (failing closed with `attempts: 0` without calling fetcher), and making chunk text validation unconditional.
6. **Artifact-to-Repository Patch Ambiguity:** An initial Part 4 submission patch conflated 231 lines of worker changes from earlier parts. Resolved by enforcing strict baseline reconciliation between scoped incremental patches and cumulative repository patches, verified with `git apply --stat` and reverse application checks.

*Prompt Patterns Retained & Strengthened:* Directly motivated the transition from UPPR Rev 4 to Rev 4.1. Strengthened **P7 (Artifact-to-Repository Reconciliation)**, **P10 (Extended Proof Chain)**, **P18 (Patch and Acceptance Manifest Consistency)**, **P19 (Negative-Space Coverage)**, and **IPP Gates 2, 4, 7, and 8**. Retained all pattern lifecycle statuses (no premature promotions).

---

## 4. Pattern-by-Pattern Evidence Status Audit (P1–P29)

| ID | Pattern Name | Status | Exercised In | Implementation Behavior | Verification Performed | Highest Evidence Level | Independent Replication | Unresolved Blocker / Counterexample |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :---: | :--- |
| **P1** | Repository-First Grounding | **REPEATED** | PP-001–008 | Inspect actual git tree and files before editing | `git status`, file reads | **E1** | Replicated across 7 Forge tasks | Requires multi-project comparative trials before VALIDATED |
| **P2** | Baseline-Before-Editing | **REPEATED** | PP-001, 002, 005, 007, 008 | Run tests/type checks before making edits | Native test runners, compiler checks | **E1/E2** | Replicated across 5 Forge tasks | Requires multi-project comparative trials before VALIDATED |
| **P3** | Explicit Invariant Specification | **REPEATED** | PP-001–008 | State requirements as observable system guarantees | Invariant-to-test mapping | **E1/E2** | Replicated across 7 Forge tasks | Requires multi-project comparative trials before VALIDATED |
| **P4** | Bounded Architectural Scope | **REPEATED** | PP-001–008 | Restrict edits strictly to assigned subsystem | Diff reviews, file-change audits | **E1** | Replicated across 7 Forge tasks | Requires multi-project comparative trials before VALIDATED |
| **P5** | Failure-Specific Incremental Fixes | **REPEATED** | PP-001, 002, 005, 007, 008 | Address concrete compiler/test errors incrementally | Sequential compiler & test runs | **E1/E2** | Replicated across 5 Forge tasks | Requires multi-project comparative trials before VALIDATED |
| **P6** | Security, Tenant Isolation, Provenance | **REPEATED** | PP-001, 002, 005, 007, 008 | Re-resolve ownership at trusted server boundaries | Mocked cross-tenant rejection tests | **E2** | Replicated across 4 Forge tasks | Live multi-tenant database isolation (E3) unverified |
| **P7** | Evidence-Based Completion | **REPEATED** | PP-001–008 | Require exact test counts, commands, patch stats, and reconciliation | Verification command transcripts & patch application proofs | **E1–E4** | Replicated across 7 Forge tasks | Requires multi-project comparative trials before VALIDATED |
| **P8** | Authoritative Context Gating | **EXPERIMENTAL** | PP-002, 006, 007 | Purge stale/unversioned chunks from LLM context | Freshness unit tests | **E2** | Replicated across 2 Forge tasks | Live vector retriever verification (E4) pending |
| **P9** | Explicit Entity Version Decoupling | **REPEATED** | PP-002, 005, 006, 007 | Decouple child metadata from parent task versions | Provenance & generation unit tests | **E2** | Replicated across 3 Forge tasks | Live vector metadata verification (E4) pending |
| **P10** | Invariant-to-Implementation Traceability | **REPEATED** | PP-004–008 | Trace invariant through 10-point proof chain to entry point, failure branch, and test | Production-entry-point test suites & negative-space tests | **E1/E2/E3** | Replicated across 5 Forge tasks | Helper tests must not substitute for production entry-point mapping |
| **P11** | Explicit Authority for Destructive Ops | **REPEATED** | PP-004–007 | Require committed tombstones before physical purges | Sweeper unit tests with unindexed entities | **E2** | Replicated across 4 Forge tasks | Live vector sweeper execution (E4) unstarted |
| **P12** | Complete Lifecycle State Machines | **REPEATED** | PP-004–008 | Handle all states, transitions, competing deliveries, and crash leases | State transition test matrices & interleaving schedules | **E2/E3** | Replicated across 5 Forge tasks | Live crash recovery under real load (E3/E4) unstarted |
| **P13** | Concurrency Feasibility & Interleavings | **REPEATED** | PP-004–008 | Database clock leases, serialized lock order, interleaving matrices | Competing-connection tests on Neon dev DB | **E3** | Replicated across 4 Forge tasks | Multi-process worker contention (E3) verified on Neon |
| **P14** | External Side-Effect Durability | **REPEATED** | PP-004–008 | Decouple external dispatch from DB finalization via outbox | Mocked outbox atomicity & real DB tests | **E2/E3** | Replicated across 5 Forge tasks | Live provider timeout recovery (E4) unstarted |
| **P15** | Pagination and Completeness Proof | **PROPOSED** | PP-004, 006, 007 | Architectural specification of prefix pagination | Audit analysis only | **E1** | Audit only | Sweeper implementation unstarted |
| **P16** | Rollback and Migration Separation | **PROPOSED** | PP-004, 006, 007 | Additive migrations & dispatcher pause runbook | Audit analysis only | **E1** | Audit only | Dual-namespace execution unstarted |
| **P17** | Evidence-Calibrated Engineering | **REPEATED** | PP-004–008 | Calibrate claims to E1–E5 scope; report BLOCKED; separate helper vs prod tests | Completion reports matching logs and scopes | **E1–E4** | Replicated across 5 Forge tasks | Requires multi-task comparative trials before VALIDATED |
| **P18** | Cross-Artifact Consistency | **REPEATED** | PP-004–008 | Cross-check specs, schemas, migrations, code, types, patches, and manifests | Schema/migration audits, exact limit checks & patch diff stats | **E1/E2** | Replicated across 5 Forge tasks | Discrepancies must be classified into 5 defect categories |
| **P19** | Failure-First Test Design | **REPEATED** | PP-004–008 | Negative-space matrix (absent, null, malformed, bypasses) & race schedules | Negative test suites with typed exceptions & 9-point matrix | **E2/E3** | Replicated across 5 Forge tasks | Must exercise production entry point under race schedules |
| **P20** | Solution Proportionality & Complexity | **REPEATED** | PP-004–008 | Reject over-engineering when simpler mechanism suffices | Architectural simplicity reviews | **E1** | Replicated across 5 Forge tasks | None |
| **P21** | Persistence Contract Fidelity | **EXPERIMENTAL** | PP-005, 007, 008 | Remove mock fallbacks; update test doubles | Unit tests against strict doubles | **E2** | Replicated across 3 Forge tasks | Needs replication across external repositories |
| **P22** | Database Artifact Semantic Consistency | **EXPERIMENTAL** | PP-005–008 | Align ORM schema, migration DDL, and client | Schema validate, DDL audit | **E1/E3** | Replicated across 4 Forge tasks | Verified on Neon dev DB |
| **P23** | Global Lock Ordering & Deadlock Reduction | **EXPERIMENTAL** | PP-005–008 | Establish canonical class & ID order across all paths | Real competing transactions on Neon | **E3** | Replicated across 4 Forge tasks | Real PostgreSQL competing-connection test verified |
| **P24** | Write-Receipt Identity & Read-Back Separation | **EXPERIMENTAL** | PP-005–008 | Validate write receipts; define serving readiness | Negative unit test suites | **E2** | Replicated across 4 Forge tasks | Verified against live Pinecone index (E4) |
| **P25** | Disposable Database Isolation & Gating | **EXPERIMENTAL** | PP-005–008 | Positively validate test target; report BLOCKED | Target validation script; Neon dev DB tests | **E3** | Replicated across 4 Forge tasks | Successfully executed against authorized Neon dev DB |
| **P26** | Database-Clock Lease Authority & Fencing | **EXPERIMENTAL** | PP-005–008 | DB clock lease comparison & claim token fencing with active lifecycle heartbeat | Neon dev DB multi-connection tests | **E3** | Replicated across 4 Forge tasks | Heartbeat renewal & stolen claim fencing verified on Neon |
| **P27** | Referential Retention Semantics | **EXPERIMENTAL** | PP-005, 007 | Configure `RESTRICT` on parent; atomic tombstones | Cascade deletion unit tests | **E2** | Replicated across 2 Forge tasks | Real-database cascade verification (E3) pending |
| **P28** | Secret-Safe Execution & Sanitization | **EXPERIMENTAL** | PP-005–008 | Sanitized diagnostics; zero credentials in output | Automated output scan | **E1** | Replicated across 4 Forge tasks | Verified clean in terminal logs and reports |
| **P29** | Documentation & Reference-Grounded Design Selection | **EXPERIMENTAL** | PP-006, 007, 008 | Discover project docs, verify installed SDK contracts, compare alternatives, ground claims | SDK method signature audit (`fetch.d.ts`), spec reviews | **E1/E2** | Single project (Forge) | Requires multi-codebase comparative trials before VALIDATED |

---

## 5. Detailed Pattern Specifications (Universal Principles & Technology Realizations)

### Foundational Execution Patterns (P1–P7, P29) — General

#### P1. Repository-First Grounding
- **Classification:** GENERAL  
- **Trigger:** Any task initiation, plan generation, code investigation, or review turn.  
- **Invariant:** The actual filesystem and repository state on disk is the sole authoritative source of truth. Prior summaries, chat transcripts, design documents, and memory caches are unverified until confirmed against current repository files.  
- **Required Behavior:**  
  1. Inspect directory structure, entry points, package configuration, and current Git status (`git status`) before formulating assumptions.  
  2. Read actual source files and uncommitted changes rather than relying on conversation summaries.  
  3. Verify runtime versions, dependency manifests, and build commands directly from configuration files.  
- **Verification:** Direct file reads, directory listings, and working-tree status commands (Level E1).  
- **Anti-Pattern:** Assuming a model, function, or configuration option exists because a previous report mentioned it, without opening the file.

#### P2. Baseline-Before-Editing
- **Classification:** GENERAL  
- **Trigger:** Before applying code edits to any existing codebase. (Explicitly excluded for planning, audit, or pure specification tasks where zero code edits are performed).  
- **Invariant:** A regression cannot be distinguished from pre-existing failure unless initial compiler and test states are captured prior to modification.  
- **Required Behavior:**  
  1. Execute the project's native static analysis, type checking, or compilation command before editing.  
  2. Execute focused unit or regression tests for the affected subsystem to establish a verified baseline.  
  3. Document any pre-existing failures explicitly in the task record before making changes.  
- **Verification:** Initial command logs recording baseline compiler and test status (Level E1/E2).  
- **Anti-Pattern:** Modifying code immediately, seeing tests fail, and guessing whether the failure was pre-existing.

#### P3. Explicit Invariant Specification
- **Classification:** GENERAL  
- **Trigger:** Architectural planning, task scoping, bug remediation, or refactoring.  
- **Invariant:** System requirements must be stated as observable, testable behavioral guarantees (positive behavior, negative edge cases, and permanent invariants) rather than superficial code-change instructions.  
- **Required Behavior:**  
  1. Translate user requirements into concrete system invariants (e.g. "At most one session may be active per device", "Soft-deleted records cannot be returned in active lookups").  
  2. Enumerate boundary conditions, invalid inputs, and unexpected states that must be rejected.  
  3. Map each invariant to a concrete verification mechanism or automated test.  
- **Verification:** Invariant-to-test mapping matrix (Level E1/E2).  
- **Anti-Pattern:** Describing a task purely as "refactor module X to use library Y" without specifying observable behavioral invariants.

#### P4. Bounded Architectural Scope
- **Classification:** GENERAL  
- **Trigger:** Code implementation, bug fixing, and maintenance tasks.  
- **Invariant:** Modifications must be strictly confined to the agreed task boundary; pre-existing unrelated changes, neighboring utilities, and architectural infrastructure must be preserved.  
- **Required Behavior:**  
  1. Explicitly enumerate allowed files to modify and strictly forbidden directories/subsystems before writing code.  
  2. Never reset, discard, format, or clean unrelated uncommitted files found in the working tree.  
  3. Avoid drive-by refactorings of adjacent modules, styling adjustments, or dependency upgrades outside the task scope.  
- **Verification:** Final diff review confirming zero modifications outside the approved boundary (Level E1).  
- **Anti-Pattern:** Reformatting an entire multi-thousand-line utility file to fix a two-line bug, obscuring git history.

#### P5. Failure-Specific Incremental Implementation
- **Classification:** GENERAL  
- **Trigger:** Resolving compiler errors, static analysis diagnostics, linter warnings, or test failures.  
- **Invariant:** Every code change must directly resolve a concrete, observed diagnostic or test failure rather than speculative code restructuring.  
- **Required Behavior:**  
  1. Run the native compiler, linter, or test runner to isolate the failure.  
  2. Apply bounded, targeted edits incrementally, re-running the focused tool after each edit.  
  3. Confirm that error counts strictly decrease with each step without introducing secondary regressions.  
- **Verification:** Sequential execution logs showing incremental reduction in compiler/test error counts (Level E1/E2).  
- **Anti-Pattern:** Rewriting large multi-file subsystems in one massive edit without intermediate compilation or testing.

#### P6. Security, Tenant Isolation, and Provenance Gating
- **Classification:** CONDITIONAL (Multi-Tenant & Authenticated Systems)  
- **Trigger:** Handling user inputs, multi-tenant database queries, authorization checks, or shared resource access.  
- **Invariant:** Tenant identity and resource ownership must be resolved strictly from trusted server session context, never accepted from client payloads, route parameters, or unauthenticated request headers.  
- **Required Behavior:**  
  1. Extract organization/tenant identifiers from verified cryptographic tokens or secure server sessions.  
  2. Enforce tenant isolation in all database queries, cache keys, search indexes, and background job payloads.  
  3. Author explicit negative tests asserting cross-tenant access rejection.  
- **Verification:** Cross-tenant rejection unit and integration tests (Level E2/E3).  
- **Anti-Pattern:** Accepting `tenantId` or `orgId` directly from request bodies or URL parameters without server-side authorization checks.

#### P7. Evidence-Based Completion
- **Classification:** GENERAL  
- **Trigger:** Authoring task completion reports, audit summaries, or pull request descriptions.  
- **Invariant:** A task is complete only when concrete, reproducible empirical evidence proves every acceptance criterion has passed. Completion must never be asserted based on assumptions, unrun scripts, or local mock tests masquerading as production proof.  
- **Required Behavior:**  
  1. Provide exact test suite counts, test command outputs, compiler results, working tree status, and diff reviews.  
  2. Explicitly disclose unproven assumptions, skipped test suites, and blocked acceptance criteria.  
  3. Distinguish implementation completion (code written) from acceptance completion (evidence gathered).  
  4. **Artifact-to-Repository Reconciliation Protocol:**  
     Before declaring implementation or acceptance complete:  
     - Produce the complete working-tree change inventory (`git status --short`).  
     - Reconcile tracked and untracked files to ensure zero unrecorded artifacts or orphaned test files remain.  
     - Generate the cumulative unified diff against the declared original repository baseline.  
     - Generate a scoped incremental patch against the actual pre-task state when available.  
     - Verify that every changed file appears in the relevant patch.  
     - Verify that every newly created file is included.  
     - Verify patch parsing using the repository's native patch tool (e.g. `git apply --stat`).  
     - Reconcile file counts, insertion/deletion statistics, patch checksums, and report manifests.  
     - Explicitly disclose any baseline that cannot be reconstructed.  
- **Patch Reconciliation Invariants:**  
  - Do not present a scoped patch as cumulative or a cumulative patch as task-specific.  
  - A syntactically valid patch does not prove that it applies cleanly to the intended baseline. Report parsing and application as separate outcomes.  
- **Verification:** Verifiable execution transcripts with exact exit codes, output logs, and native patch inspection outputs (Level E1–E5).  
- **Anti-Pattern:** Reporting "All requirements met and verified" without providing command outputs, test execution counts, or patch reconciliation proofs.

#### P29. Documentation & Reference-Grounded Design Selection
- **Classification:** GENERAL  
- **Status:** EXPERIMENTAL  
- **Trigger:** Architecture or subsystem planning; introducing a new integration, provider, framework, SDK, or infrastructure component; choosing between materially different implementation patterns; decisions affecting reliability, consistency, security, concurrency, data integrity, migrations, or deployment; decisions that may conflict with established project architecture; or any design whose correctness depends on external library or provider behavior. (Does NOT apply to trivial, local, self-contained single-function edits).  
- **Invariant:** Architectural and implementation recommendations must be grounded in both the project's documented intent and its actual technical environment, with all external technical claims verified against authoritative, version-correct references and viable alternatives explicitly compared.  
- **Required Behavior:**  
  1. **A. Discover Relevant Project Documentation:** Proportionately inspect relevant project documentation (ADRs, technical specifications, design documents, READMEs, API integration guides, database migration notes, runbooks, acceptance criteria). Do not read every document indiscriminately; discover those governing the subsystem and decision.  
  2. **B. Compare Documented Intent with Actual Implementation:** Contrast what the project documentation states the subsystem should do with what the current code actually implements. Identify which documented decisions are implemented, partially implemented, obsolete, or contradicted by code. Never silently treat documentation as proof of current behavior, nor existing code as proof that its behavior was intended.  
  3. **C. Verify External Technical Contracts:** Where a design depends on an external framework, SDK, provider, or protocol:  
     - Identify the exact installed version or configured provider version from package manifests or environment configuration.  
     - Consult official documentation for that specific version.  
     - Inspect installed package types (`*.d.ts`), source, and configuration directly.  
     - Verify method signatures, supported options, defaults, limits, retry behavior, consistency guarantees, and cancellation semantics.  
     - Never infer that a feature exists merely because a newer version supports it, or assume an API accepts an option based on another SDK or version.  
  4. **D. Discover and Compare Viable Design Alternatives:** Identify materially relevant architectural alternatives. Compare them against actual constraints, evaluating trade-offs (correctness, complexity, failure behavior, concurrency, operational burden, security, migration cost). Explain why the selected approach is preferable, and record meaningful rejected alternatives and why they were rejected. Do not manufacture strawmen.  
  5. **E. Ground the Recommendation:** Clearly distinguish observed repository facts, documented project intent, verified external technical contracts, test/runtime evidence, assumptions/unresolved questions, and engineering judgment. Disclose conflicts between sources and state which source governs.  
- **Expected Output When P29 Applies:** The resulting specification or planning artifact must contain a proportionate record of: (1) relevant project documents inspected, (2) relevant implementation and configuration inspected, (3) external references and exact versions consulted, (4) material discrepancies between documented intent and actual behavior, (5) viable alternatives considered with trade-off comparison, (6) selected approach and rationale, (7) rejected alternatives and reasons, and (8) unverified assumptions requiring implementation-stage confirmation.  
- **Verification:** Documentation citations, installed package inspection transcripts, alternative trade-off comparison matrix (Level E1).  
- **Anti-Pattern:** Designing an asynchronous polling cancellation mechanism assuming `sdk.fetch(ids, { signal })` exists without checking the installed SDK declaration files.

---

### Domain-Specific Patterns (P8–P9) — AI & Retrieval Pipelines

#### P8. Authoritative Context Gating
- **Classification:** DOMAIN-SPECIFIC (AI & Retrieval Pipelines)  
- **Trigger:** Compiling context for Retrieval-Augmented Generation (RAG), semantic caches, or LLM prompt generation.  
- **Invariant:** Stale, unversioned, or unverified chunks must be purged from assembled context before LLM prompt compilation, regardless of retrieval similarity scores or cache hit status.  
- **Required Behavior:** Re-validate retrieved document metadata against authoritative primary storage records before assembling prompts. Discard chunks whose source entities have been updated, deleted, or unindexed since embedding.  
- **Verification:** Freshness rejection test suites (Level E2).  
- **Exclusion:** Conventional relational databases, standard CRUD APIs, non-AI systems.

#### P9. Explicit Entity Version Decoupling
- **Classification:** DOMAIN-SPECIFIC (Hierarchical & Vector Indexing)  
- **Trigger:** Indexing hierarchical entities (e.g. parent task containing child attachments) into vector stores or search indexes.  
- **Invariant:** Child document version tokens must decouple the child's own mutation timestamp from parent entity metadata versioning.  
- **Required Behavior:** Maintain separate version properties (`sourceVersion` for child content, `parentVersion` for inherited metadata) in index metadata to prevent false-positive freshness mismatches. Decouple parent updates so non-index-affecting parent edits do not invalidate child content.  
- **Verification:** Independent mutation tests verifying parent updates do not invalidate child content cache (Level E2).  
- **Exclusion:** Flat relational tables, non-hierarchical documents, non-vector data models.

---

### Distributed Systems, Concurrency, and Lifecycle Patterns (P10–P20)

#### P10. Invariant-to-Implementation Traceability
- **Classification:** GENERAL  
- **Trigger:** Designing, implementing, or reviewing stateful, transactional, or distributed invariants.  
- **Invariant:** An invariant is unverified until explicitly traced across the complete ten-element proof chain:  
  `INVARIANT → AUTHORITY → INPUT CONTRACT → PRODUCTION ENTRY POINT → ENFORCEMENT BRANCH → FAILURE PATH → SUCCESS PATH → STATE TRANSITION → TEST → EVIDENCE`  
  A helper-level test passing in isolation does NOT satisfy a requirement for production-path integration proof. A reference to a source-code line is not sufficient proof that a validation condition is enforced.  
- **Required Behavior:**  
  For every critical guarantee, compile a complete traceability record containing:  
  1. **Invariant ID & Behavioral Guarantee:** Exact observable system behavior under positive and adversarial conditions.  
  2. **Authoritative Persistence / External System:** Database table, unique index, CAS column, or provider store enforcing the state.  
  3. **Input Contract:** Exact required inputs, properties, and attestations. Verify that required inputs are strictly mandatory, and missing evidence cannot bypass validation.  
  4. **Production Entry Point:** Actual application entry point (e.g. API route handler, domain mutation function, scheduled job handler, worker event consumer).  
  5. **Enforcement Branch & Failure Path:** The concrete `if/throw`, schema constraint, or CAS predicate. Verify that the invalid/failure branch terminates or safely rejects the operation, and no subsequent `catch`, fallback, retry, or cleanup branch can silently convert failure into success.  
  6. **Success Path & State Transition:** Explicit verification that the success branch is reachable ONLY after every mandatory condition succeeds.  
  7. **Production-Path Test:** Concrete test that invokes the actual production entry point (not merely an internal helper), tracing both positive and negative execution paths.  
  8. **Evidence Level & Observed Result:** Verified evidence category (E1–E5) and exact test assertion outcome.  
- **Critical Verification Checks:**  
  For each critical invariant, the agent and reviewer must explicitly verify:  
  - The required input is actually mandatory.  
  - Missing evidence cannot bypass validation.  
  - The invalid branch terminates or safely rejects the operation.  
  - The success branch is reachable only after every mandatory condition succeeds.  
  - No subsequent `catch`, fallback, retry, or cleanup branch can silently convert failure into success.  
- **Mandatory Test-Scope Distinction:**  
  Traceability matrices must categorize tests into explicit scopes:  
  - *Helper-Level Test:* Exercises an isolated utility function with mock inputs. (Proves internal algorithm; does NOT prove production invocation).  
  - *Production-Function Test:* Exercises the canonical application entry point with controlled dependencies. (Proves entry-point wiring and branching).  
  - *Integrated Workflow Test:* Exercises multiple components connected across the application pipeline. (Proves data handoffs and state propagation).  
  - *Real Database Concurrency Test:* Exercises competing connections against real DB locks/constraints. (Proves lock ordering and atomicity).  
  - *External Provider Test:* Exercises physical remote provider APIs and read-back attestation. (Proves physical durability).  
- **Acceptance Condition:** Every critical invariant must have an explicit production-path mapping tracing both negative and positive execution paths. An invariant mapping solely to a helper-level test without a verified production entry point call site must be marked **BLOCKED**, never complete.  
- **Anti-Pattern:** Creating a transactional outbox helper, testing the helper with passing unit tests, but forgetting to invoke the helper from the canonical `createTask` mutation function, or citing a source line number as proof of validation without demonstrating failure-path termination.

#### P11. Explicit Authority for Destructive Operations
- **Classification:** CONDITIONAL (Data Deletion & Cleanup Sweepers)  
- **Trigger:** Executing background reconciliation, garbage collection, data purging, or cascading deletions.  
- **Invariant:** Destructive purges require an explicit, authoritative deletion authority (persistent durable tombstone or confirmed primary-table absence), never inferred from metadata absence, unindexed state, or transient timeouts.  
- **Required Behavior:** Treat missing metadata records as unindexed entities, not tombstones. Require durable tombstone records committed in primary persistence before executing physical cleanup sweeps.  
- **Verification:** Unindexed entity preservation test suites in sweeper tests (Level E2).  
- **Exclusion:** Append-only ledgers, immutable event logs, pure read-only systems.

#### P12. Complete Lifecycle State-Machine Verification
- **Classification:** CONDITIONAL (Asynchronous Workflows & State Machines)  
- **Trigger:** Designing multi-step asynchronous processes, background worker jobs, or state machines.  
- **Invariant:** Every stateful workflow must have a closed state digraph with explicit recovery paths for every non-terminal state, explicit execution schedules for competing deliveries, and strict Compare-And-Set (CAS) transition authority.  
- **Required Behavior:**  
  For every asynchronous workflow, formally specify and verify ten lifecycle dimensions:  
  1. **Legitimate States:** Complete enumeration of all valid states (e.g. `PENDING`, `CLAIMED`, `COMPLETED`, `FAILED`, `ABORTED`).  
  2. **Legal Transitions:** Exhaustive list of permitted origin-to-destination transitions.  
  3. **Illegal Transitions:** Explicitly rejected transitions (e.g. `COMPLETED` → `CLAIMED`, `FAILED` → `CLAIMED` without redrive authority).  
  4. **Ownership Rules:** Which worker, token, or process owns the entity in each state.  
  5. **Retry and Redrive Behavior:** Maximum attempts, exponential backoff, dead-letter criteria, and redrive state resets.  
  6. **Terminal States:** States from which no further transitions can occur without explicit administrative intervention.  
  7. **Crash Recovery:** Automatic timeout reclamation or lease expiration handling if a worker dies mid-flight.  
  8. **Duplicate Delivery Behavior:** Idempotency semantics when the same message or logical work is delivered multiple times.  
  9. **State Transition Authority:** The authoritative persistence engine (PostgreSQL CAS, distributed lock) governing transitions.  
  10. **Atomicity & CAS Requirements:** Exact SQL `UPDATE ... WHERE current_state = expected_state` statements.  
- **Explicit Race Schedules:**  
  Require explicit execution schedules for race-sensitive transitions.  
  *Example Interleaving Schedule:*  
  1. Delivery B checks if logical work is already `SUCCESS`.  
  2. Delivery A finishes execution and transitions database state to `SUCCESS`.  
  3. Delivery B attempts to establish a new active claim.  
  4. Transition authority must enforce that Delivery B's claim attempt fails closed, preventing duplicate execution.  
- **Acceptance Condition:** Every critical transition and high-impact interleaving must have an enforcement mechanism and an executable negative or concurrency test.  
- **Verification:** State-machine transition tests simulating worker crashes, lease expirations, and CAS race interleavings (Level E2/E3).

#### P13. Concurrency Feasibility & Realistic Interleavings
- **Classification:** CONDITIONAL (Concurrent Data Access & Mutations)  
- **Trigger:** Designing concurrent transactions, shared state mutations, or distributed worker coordination.  
- **Invariant:** Concurrency safety must be evaluated against realistic execution interleavings governed by real database isolation levels, lock-wait behaviors, and server clock semantics. Mocked test doubles establish only local branching correctness (Level E2); they do NOT prove database-level concurrency or lock serialization (Level E3).  
- **Required Behavior:**  
  1. Compile a **Mandatory Interleaving Matrix** for all critical concurrent paths:  
     | Dimension | Specification |  
     | :--- | :--- |  
     | **Worker A Operation** | The SQL query / mutation executed by the first concurrent actor |  
     | **Worker B Operation** | The SQL query / mutation executed by the second concurrent actor |  
     | **Shared Database State** | Initial state of rows, locks, indexes, and leases |  
     | **Possible Ordering** | The exact order of operations and interleaving windows |  
     | **Expected Winner** | The actor that must succeed according to system invariants |  
     | **Authority Mechanism** | DB constraint, row lock (`FOR UPDATE`), partial unique index, or CAS |  
     | **Failure Behavior** | Expected exception, error code, or rollback behavior for loser |  
     | **Recovery Behavior** | How the losing actor cleans up, backs off, or returns |  
     | **Test Implementation** | Concrete test exercising this exact schedule |  
  2. Do not treat two simultaneous inserts as sufficient coverage for all races involving the same logical identity.  
  3. Test transition boundaries (competing claim during execution, post-check claim acquisition, lease expiry boundary), not just simultaneous starting conditions.  
  4. Use database-side time (`clock_timestamp()` in PostgreSQL, `NOW()` in MySQL) for lease expiration to eliminate cross-server clock skew.  
  5. When an approved isolated test database is available, execute competing-transaction tests with controlled barriers (Level E3). Explicitly declare Level E3 concurrency verification BLOCKED if unavailable.  
- **Acceptance Condition:** Critical interleavings are tested against the real database when database isolation, locks, indexes, or database clock semantics are part of the correctness argument.  
- **Verification:** Real multi-connection competing transaction tests on isolated database instances (Level E3).  
- **Anti-Pattern:** Citing passing mocked Jest/pytest tests as proof that database row locks serialize correctly under concurrency.

#### P14. External Side-Effect Durability and Asynchrony
- **Classification:** CONDITIONAL (External Service & Cloud Integrations)  
- **Trigger:** Interfacing database transactions with external HTTP services, message brokers, or third-party APIs.  
- **Invariant:** Database transactions and external network calls are non-atomic. Rolling back a local database transaction does NOT cancel an in-flight or completed external HTTP request.  
- **Required Behavior:**  
  1. Decouple external network dispatch from database finalization; avoid executing external HTTP calls inside synchronous database transactions.  
  2. Use generation-prefixed identifiers, idempotency keys, or transactional outbox patterns to record intent before dispatch.  
  3. Ensure background dispatchers enforce CAS state transitions when publishing events to prevent racing workers from suffering state regression.  
- **Verification:** Transactional outbox atomicity tests and external timeout recovery tests (Level E2/E3).  
- **Exclusion:** Pure in-memory operations, local database transactions with no external side effects.

#### P15. Pagination and Completeness Proof
- **Classification:** CONDITIONAL (Collection Sweeping & Batch Retrieval)  
- **Trigger:** Paginating, sweeping, purging, or reconciling multi-record collections.  
- **Invariant:** Multi-record operations require an explicit pagination or progressive-window contract with termination proofs and post-operation completeness verification.  
- **Required Behavior:** Paginate through all matching records using deterministic cursors until cursor exhaustion. For destructive sweeps, execute a post-cleanup read-back query confirming zero remaining records before transitioning to terminal state.  
- **Verification:** Multi-page pagination tests and read-back assertions (Level E2/E3).  
- **Exclusion:** Single-record lookups, fixed-size small enumerations.

#### P16. Rollback and Migration Separation
- **Classification:** CONDITIONAL (Data Migrations & Architecture Cutover)  
- **Trigger:** Promoting new architectural versions, schema migrations, or data storage generations.  
- **Invariant:** Activation of a new data generation or schema must be strictly decoupled from the physical destruction of legacy data.  
- **Required Behavior:** Retain legacy data across an explicit observation window in isolated tables, namespaces, or fields; execute legacy decommissioning only after rollback gates have passed. Provide non-destructive pause/rollback runbooks (e.g. outbox dispatcher throttling) instead of destructive table drop/wipe operations.  
- **Verification:** Dual-write / dual-namespace isolation tests and zero-downtime rollback tests (Level E2/E3).  
- **Exclusion:** Additive, non-breaking schema enhancements with no cutover period.

#### P17. Evidence-Calibrated Engineering Guarantees
- **Classification:** GENERAL  
- **Trigger:** Formulating completion claims, production readiness reports, and risk disclosures.  
- **Invariant:** Engineering claims must be strictly calibrated to the specific evidence category gathered (E1–E5). Higher evidence categories can never be inferred from lower ones: `Static Check (E1) != Mocked Unit Test (E2) != Real Integration Test (E3) != External System Test (E4) != Operational Validation (E5)`. Test totals must NEVER substitute for coverage of critical production entry points.  
- **Required Behavior:**  
  1. Classify all tests into the calibrated test-scope taxonomy (E1, E2-Helper, E2-Production Function, E2-Workflow, E3, E4, E5).  
  2. For every test claim, explicitly disclose:  
     - **What was executed:** Test command, suite path, test names.  
     - **What code path it invoked:** Production entry point vs internal helper function.  
     - **What dependencies were real:** Real PostgreSQL, live Pinecone, local containers.  
     - **What dependencies were mocked:** In-memory delegates, simulated timers, mocked fetch.  
     - **What the test proves:** The exact behavioral guarantee verified.  
     - **What the test does NOT prove:** Residual uncertainties, unverified edge cases, scale limits.  
  3. Report unexecuted suites as BLOCKED, never as passed. Avoid converting heuristic optimizations (such as candidate oversampling) into mathematical completeness guarantees.  
- **Acceptance Condition:** The final verification report must explicitly categorize evidence across helpers, production functions, integrated workflows, and infrastructure behavior.  
- **Verification:** Audit report matching claims to empirical logs (Level E1–E5).  
- **Anti-Pattern:** Citing "1,762 tests passed" as proof of production readiness when the canonical production mutation functions were never invoked in those tests.

#### P18. Cross-Artifact Consistency Verification
- **Classification:** GENERAL  
- **Trigger:** Multi-artifact systems involving specifications, schemas, migrations, ORM models, API routes, client SDKs, configuration, patches, manifests, and tests.  
- **Invariant:** No artifact may be assumed consistent with another without explicit cross-verification. Specifications, schemas, migrations, code, limits, configurations, patches, and manifests must maintain strict parity.  
- **Required Behavior:**  
  1. Perform systematic, line-by-line contract comparisons across the complete software delivery envelope:  
     - Approved Architecture Specification (invariants, limits, protocols)  
     - Database Schema (`schema.prisma`, models)  
     - SQL Migrations and Live Database Catalog (`*.sql`, indexes, constraints)  
     - TypeScript Types / Interfaces (`*.ts`)  
     - Runtime Validation Schemas (Zod, Joi)  
     - Production Implementation Code  
     - Automated Test Suites and Actual Test Invocation Paths  
     - Deployment & Environment Configuration  
     - Acceptance Report (claims, metrics, narratives, execution logs)  
     - Scoped Incremental Patch (isolated task delta)  
     - Cumulative Repository Patch (total delta from baseline)  
     - File-Change Manifest (tracked modifications and untracked files)  
  2. Compare exact values, not merely conceptual similarity:  
     - Numeric budgets and timeouts (e.g. 5 seconds in specification vs 15 seconds in code).  
     - Required metadata fields: mandatory vs optional vs silently accepted when absent.  
     - State machine identifiers and legal transition lists.  
     - Retry limits, backoff curves, and dead-letter thresholds.  
     - Top-K bounds and oversampling multipliers.  
     - Lock ordering sequences and transaction scopes.  
     - Patch statistics: exact file counts, line insertions, line deletions, and diffstat parity.  
  3. **Patch and Acceptance Manifest Consistency:**  
     All reported file paths, line references, test names, test counts, and patch statistics must correspond strictly to actual artifacts on disk. A discrepancy between the report and patch (or working tree) is an unresolved acceptance finding, not a cosmetic documentation issue.  
  4. Classify every detected discrepancy into one of five categories:  
     - **(1) Implementation Defect:** Code deviates from approved specification without authorization.  
     - **(2) Specification Defect:** Specification is technically infeasible, contradictory, or incompatible with installed dependencies.  
     - **(3) Intentional Approved Deviation:** Explicitly agreed and documented design adaptation.  
     - **(4) Documentation Inconsistency:** Comments, diagrams, or readmes disagree with code.  
     - **(5) Unresolved Assumption:** Ambiguity requiring explicit decision before proceeding.  
- **Acceptance Condition:** No unresolved discrepancy may be silently classified as implementation-complete.  
- **Verification:** Cross-artifact contract audits, exact parameter diffs, and patch diffstat reconciliation (Level E1/E2).

#### P19. Failure-First Test Design
- **Classification:** GENERAL  
- **Trigger:** Authoring test suites for business logic, state transitions, or integration contracts.  
- **Invariant:** System robustness is established by deriving test cases directly from failure modes, boundary conditions, adversarial scenarios, and negative-space coverage, not merely confirming happy paths.  
- **Required Behavior:**  
  1. For every invariant, design negative tests: worker crashes, expired leases, unauthorized access, malformed inputs, duplicate requests, competing claim races, and missing dependencies.  
  2. Structure tests around explicit failure schedules: force concurrent interleavings where one actor attempts to steal or invalidate another actor's work.  
  3. Verify that failures fail closed: mutations roll back cleanly, error codes are returned, and unauthorized transitions are rejected.  
  4. **Negative-Space Coverage Requirement:**  
     For every mandatory input, field, identity, precondition, receipt, or attestation used to authorize a successful operation, tests MUST cover both invalid values and absent evidence.  
     The minimum applicable test matrix is:  
     - **(1) Property absent:** Property omitted entirely from the input/record payload.  
     - **(2) Explicitly undefined:** Property explicitly assigned `undefined` (`{ field: undefined }`).  
     - **(3) Explicit null:** Property explicitly assigned `null` (`{ field: null }`).  
     - **(4) Empty value:** Empty string `""`, empty collection `[]`, empty object `{}`, or whitespace-only `"   "`.  
     - **(5) Wrong primitive or structural type:** Wrong data type (e.g. number instead of string, boolean, object).  
     - **(6) Malformed value:** Structurally corrupted format (e.g. non-hex string, invalid UUID, truncated hash).  
     - **(7) Boundary values:** Values below, at, and above the allowed range (e.g. index < 0, count = 0, oversized array).  
     - **(8) Validly structured but mismatched identity or provenance:** Valid format but wrong tenant, mismatched task ID, stale generation ID, or forged token.  
     - **(9) Validation bypass analysis:** Test whether optional chaining (`?.`), conditional guards (`if (x !== undefined)`), permissive defaults (`|| default`), or skipped branches allow missing evidence to reach terminal success.  
- **Core Principles of Negative-Space Testing:**  
  - The agent must inspect whether missing evidence can bypass validation logic and still reach a successful return or terminal success transition.  
  - A passing test of a malformed value does not establish rejection of an absent value. These are distinct conditions and must be tested separately where applicable.  
  - **Production-Path Requirement:** At least one negative test for every critical authorization or readiness boundary must exercise the actual production entry point or its real orchestration path, not merely an isolated helper.  
- **Acceptance Condition:** Every critical lifecycle transition, authorization check, readiness boundary, and high-risk race has executable negative tests asserting proper fail-closed behavior across both invalid inputs and absent evidence.  
- **Verification:** Negative test suites with specific typed exception assertions and negative-space matrices (Level E2 for deterministic behavior; Level E3/E4 where the guarantee depends on the actual persistence engine or external provider).  
- **Anti-Pattern:** Test suites containing only successful forward paths with valid mock inputs, or assuming testing a malformed string tests an absent property.

#### P20. Solution Proportionality & Complexity Bounding
- **Classification:** GENERAL  
- **Trigger:** Architectural design, edge-case resolution, and refactoring.  
- **Invariant:** Choose the smallest, most robust architecture capable of satisfying required invariants. Every additional state, table, trigger, worker, or microservice introduces new failure modes.  
- **Required Behavior:** Evaluate simpler native mechanisms (e.g. database partial unique indexes, foreign key constraints, atomic single-row queries) before introducing complex distributed consensus, two-phase commits, or background reconcilers.  
- **Verification:** Architectural simplicity reviews and failure-mode minimization analysis (Level E1).  
- **Anti-Pattern:** Introducing complex multi-table event outboxes or custom database triggers when a partial unique constraint and transactional query suffice.

---

### Production Hardening & Persistence Patterns (P21–P28)

#### P21. Persistence Contract Fidelity
- **Classification:** CONDITIONAL (Persistence Layers & Test Doubles)  
- **Universal Principle:** Production code must NEVER detect incomplete test doubles (e.g. checking for missing delegates or test environment variables) to silently bypass persistence logic. Doing so masks missing dependencies and produces false-positive test passes.  
- **Required Agent Behavior:** Write production persistence code using strict, unconditioned calls against the declared persistence interface. If a test double lacks a required method or query delegate, allow the test to fail loudly. Update the test double to faithfully implement the production persistence contract.  
- **Verification:** Code search confirming zero mock-detection guards in production files; tests run against strict doubles (Level E1/E2).

#### P22. Database Artifact Semantic Consistency
- **Classification:** CONDITIONAL (Relational Databases & ORM Migrations)  
- **Universal Principle:** When an application uses an ORM or schema-definition tool alongside SQL migrations, all database artifacts must maintain **semantic consistency** across representable constructs:  
  ```
        High-Level Schema (e.g. schema.prisma, models.py)
        ┌───────┴───────────────────────┐
        │ (code generation)             │ (semantic consistency)
        ▼                               ▼
  Generated Client / AST          SQL Migration DDL (*.sql)
        │                               │
        │ (runtime queries)             │ (database migration)
        ▼                               ▼
  Live Database Engine ◄────────────── Database Catalog
  ```  
- **Required Agent Behavior:**  
  1. Enforce exact semantic alignment across model definitions, column types, nullability, unique attributes, and foreign-key actions.  
  2. **Document SQL-only constraints separately:** Where high-level schema tools cannot natively express database engine features (partial unique indexes, `CHECK` constraints, custom triggers), document them explicitly in SQL migrations and verify them with raw SQL integration tests.  
  3. Re-generate client types immediately after schema edits; verify type correctness via compilation checks.  
  4. Perform offline diff reviews between migration DDL and schema models; never rely solely on schema syntax validators.  
- **Verification:** Schema validation passes; DDL-to-schema alignment audit (Level E1); PostgreSQL catalog inspection on disposable DB (Level E3).

#### P23. Global Lock Ordering & Deadlock Reduction
- **Classification:** CONDITIONAL (Relational Transactions & Row Locking)  
- **Universal Principle:** Acquiring locks across shared resources in conflicting orders across concurrent transactions causes deadlocks. A subsystem must enforce a uniform global lock acquisition hierarchy across all transaction paths to reduce deadlock risk.  
- **Required Agent Behavior:**  
  1. **Lock Inventory:** Compile an inventory of all transaction paths acquiring locks across cooperating entities.  
  2. **Canonical Class Ordering:** Whenever a transaction locks rows across multiple entity classes, enforce a strict top-down parent-to-child class hierarchy.  
  3. **Deterministic Intra-Class Ordering:** When locking multiple rows of the same entity class in a single transaction, sort deterministically by primary key (e.g. `ORDER BY id ASC`).  
  4. **Secondary Lock Source Inspection:** Audit implicit locks acquired by the database engine (foreign-key validation on parent tables, unique index checks, cascading updates, triggers).  
  5. **Concurrency Testing:** Concurrency safety must be evaluated with real competing transactions under controlled barriers (Level E3). Do not claim universal deadlock elimination.  
- **Verification:** Lock inventory audit (Level E1); competing-connection transaction barrier tests on disposable DB (Level E3).

#### P24. Write-Receipt Identity & Read-Back Separation
- **Classification:** CONDITIONAL (Asynchronous Worker Pipelines & Indexing)  
- **Universal Principle:** Conflating application-level write acknowledgement with physical persistence verification introduces architectural contradictions. A write receipt verifies worker contract compliance; physical read-back verifies storage engine durability.  
- **Required Agent Behavior:**  
  1. **Separate Verification Concepts:**  
     - **Write Receipt (Application-Level):** Worker confirms all expected chunks/records were processed and submitted with matching metadata.  
     - **Physical Read-Back Attestation (Storage-Level):** Independent query against storage engine confirming records are physically readable.  
  2. **Write Receipt Validation Contract:** Validate generation ID, claim token, database-clock lease validity, chunk count, and manifest digest before transitioning to written states.  
  3. **Explicit Activation Readiness Semantics:** Define what `ACTIVE` guarantees to readers: require physical read-back attestation for read-complete serving, or an explicit degraded-readiness fallback contract for staged activation.  
- **Verification:** Negative unit tests for receipt mismatches (Level E2); read-back integration tests (Level E4).

#### P25. Disposable Database Isolation & Verification Gating
- **Classification:** CONDITIONAL (Database Integration Testing & DDL)  
- **Universal Principle:** Database tests requiring DDL, migrations, locks, or destructive operations must NEVER execute against production, staging, or shared environment databases. A test flag or database name suffix is insufficient; positive target identity validation is required.  
- **Required Agent Behavior:**  
  1. Require an explicit dedicated test target variable (e.g. `DISPOSABLE_TEST_DATABASE_URL`), never defaulting to primary `DATABASE_URL`.  
  2. Positively validate target connection identity against an approved whitelist of ephemeral/disposable instances (local container, isolated runner, or explicitly approved development database). Fail closed if identity cannot be verified.  
  3. If an approved disposable database is unavailable, report Level E3 verification as **BLOCKED** and fail CI. Never count unexecuted tests as passed.  
- **Verification:** Automated safety guard in test runner validating target identity (Level E1/E2); real DB integration logs (Level E3).

#### P26. Database-Clock Lease Authority and Fencing
- **Classification:** CONDITIONAL (Distributed Leases, Worker Fencing & Timeouts)  
- **Universal Principle:** Evaluating lease duration or expiration using application-server system clocks introduces race conditions due to clock skew across distributed containers. Leases must be evaluated by the database engine clock. Furthermore, wall-clock timestamps are not monotonic and do not provide fencing; exclusive ownership requires claim tokens, fencing counters, and active execution heartbeats.  
- **Required Agent Behavior:**  
  1. **Complete Worker Lease Lifecycle (10 Stages):** A production worker must not merely expose a lease renewal helper; the execution lifecycle must actively coordinate the full 10-stage lifecycle:  
     - *Stage 1: Lease Claim Acquisition:* Atomically acquire lease via CAS on database clock.  
     - *Stage 2: Database-Clock Expiry:* Set expiration strictly using database time: `clock_timestamp() + interval`.  
     - *Stage 3: Heartbeat Initiation:* Spawn active background heartbeat timer upon execution start.  
     - *Stage 4: Recurring EventLog Renewal:* Periodically extend event log lease in database.  
     - *Stage 5: Recurring Generation Renewal:* Periodically extend generation lease if applicable.  
     - *Stage 6: Ownership-Loss Detection:* Detect if competing worker has stolen lease during renewal CAS.  
     - *Stage 7: Stale Completion Fencing:* Reject completion attempts if lease token is expired or changed (e.g. HTTP 409).  
     - *Stage 8: Activation Fencing:* Abort activation if generation lease was stolen by newer worker.  
     - *Stage 9: Worker Shutdown & Heartbeat Cleanup:* Clear heartbeat timer in `finally` block upon completion/error.  
     - *Stage 10: Renewal Failure Handling:* Immediately halt downstream processing if heartbeat renewal fails.  
  2. **Ownership Loss Behavior:** When ownership is lost or heartbeat renewal fails:  
     - Prevent further authoritative database state transitions.  
     - Prevent stale generation activation.  
     - Prevent stale completion receipts.  
     - Stop initiating additional downstream side effects where feasible.  
     - Explicitly disclose any in-flight external operations that cannot be cancelled over transport (e.g. SDKs lacking cancellation signals).  
  3. **Concurrency Steal Verification:** Author at least one test running the actual worker lifecycle with an injected long-running handler, renewing leases during execution, stealing ownership in a competing connection, and verifying the original worker fails closed.  
- **Acceptance Condition:** At least one test must run the actual worker lifecycle with an injected long-running handler, renew leases during execution, steal ownership in a competing connection, and verify the original worker fails closed.  
- **Verification:** SQL query inspection (Level E1); negative unit tests for lease expiry (Level E2); multi-connection tests on disposable DB (Level E3).

#### P27. Referential Retention Semantics
- **Classification:** CONDITIONAL (Relational Foreign Keys & Cascading Deletions)  
- **Universal Principle:** Foreign key actions must be chosen strictly according to the data retention contract of the referenced entity. Never recommend `SET NULL` as a general history-preservation strategy; `SET NULL` clears the reference link but does not preserve the referenced record if the record itself is deleted.  
- **Required Agent Behavior:** Configure `RESTRICT` on parent relations of audit/generation tables; in transactional cascade deletions, commit child tombstones in the same transaction before deleting parent rows.  
- **Verification:** Schema/DDL inspection (Level E1); deletion rejection tests (Level E2/E3).

#### P28. Secret-Safe Execution & Credential Sanitization
- **Classification:** GENERAL  
- **Trigger:** Reading configuration, inspecting environment variables, running shell commands, database diagnostics, logging, and reporting.  
- **Invariant:** Secrets (passwords, connection URIs, API tokens, private keys, webhook secrets) must NEVER be printed to terminal output, command histories, application logs, agent transcripts, or completion reports.  
- **Required Agent Behavior:**  
  1. Never print complete `.env` files or dump unredacted environment objects (forbidden: `cat .env`, `Get-Content .env`, `console.log(process.env)`).  
  2. Use sanitized presence diagnostics that report key existence, host, port, and SSL mode without logging secret values.  
  3. Redact credentials in error messages and connection strings (`postgresql://user:***@host:5432/dbname`).  
  4. If a secret is inadvertently exposed, halt further propagation immediately, report the incident without repeating the secret value, and mandate credential rotation.  
- **Verification:** Automated log/transcript scanner asserting zero credential substrings (Level E1).  
- **Anti-Pattern:** Running shell commands that print raw `.env` file contents to stdout to debug a configuration issue.

---

## 6. Universal Production Engineering Protocol

### 1. Protocol Architecture: Seven Universal Layers

The universal engineering prompt protocol structures coding-agent tasks into seven sequential, mutually reinforcing layers applicable to any codebase, language, framework, or architectural paradigm:

```mermaid
flowchart TD
    L1["Layer 1: Repository Reconnaissance & Secret Safety
(Structure, dependencies, package versions, secret safety)"] --> L2["Layer 2: Documentation & Reference Grounding
(Project docs, ADRs, installed SDK contracts, intent vs code reconciliation)"]
    L2 --> L3["Layer 3: Requirements, Invariants & Retention Contracts
(Authoritative sources, behavioral guarantees, retention taxonomy, security)"]
    L3 --> L4["Layer 4: Architecture, Alternatives & Global Lock Ordering
(Proportional design, alternative comparison, lock hierarchy, rollback safety)"]
    L4 --> L5["Layer 5: Implementation Discipline & Persistence Fidelity
(Bounded scope, baseline-before-editing, strict doubles, artifact consistency)"]
    L5 --> L6["Layer 6: Adversarial Verification, Integration Proof & Fencing
(Negative tests, IPP gates, Defect-Escape Checklist, lease lifecycle, receipts)"]
    L6 --> L7["Layer 7: Production Readiness, Review & Evidence Calibration
(Target isolation, recovery, diff review, cross-artifact audit, calibrated claims)"]
```

#### Layer 1: Repository Reconnaissance & Secret Safety (P1, P28)
- **Entry Criteria:** Task initiation or receipt of user prompt.
- **Activities:**
  - Inspect actual directory tree, entry points, language/runtime versions, dependency manifests, and current Git status (`git status`) before formulating assumptions (P1).
  - Enforce secret-safe execution: never print `.env` files, credentials, or connection strings in logs or reports (P28).
- **Exit Criteria (Observable Proof):** Verified filesystem tree, recorded Git branch/commit/working tree state, and confirmed secret sanitization in all diagnostics.

#### Layer 2: Documentation & Reference Grounding (P29)
- **Entry Criteria:** Layer 1 exit criteria satisfied; repository baseline established.
- **Activities:**
  - Discover and proportionately inspect relevant project documentation (ADRs, specifications, READMEs, integration guides).
  - Verify external technical contracts against actual installed package versions and declarations (`*.d.ts`), not hypothetical or newer SDK releases (P29).
  - Reconcile documented project intent with actual runtime implementation, identifying stale documentation or unintended code divergences.
- **Exit Criteria (Observable Proof):** Documented intent extracted, exact installed package version and declaration files (`*.d.ts`) inspected and cited, material discrepancies between documented intent and code explicitly cataloged.

#### Layer 3: Requirements, Invariants, and Retention Contracts (P3, P6, P10, P27)
- **Entry Criteria:** Layer 2 exit criteria satisfied; architectural intent and technical contracts understood.
- **Activities:**
  - Frame requirements as observable system behaviors and non-negotiable invariants (P3).
  - Identify authoritative sources of truth, tenant boundaries, and ownership semantics (P6).
  - Explicitly trace invariants: `Invariant -> Authority -> Enforcement -> Code Branch -> Test -> Evidence` (P10).
  - Classify data retention contracts for every entity: Permanent History, Pointer Nullification, Tombstone, Cascaded, or Archival (P27).
- **Exit Criteria (Observable Proof):** Comprehensive invariant inventory with positive, negative, and permanent guarantees; P10 traceability table mapping invariants to production entry points; data retention taxonomy defined.

#### Layer 4: Architecture, Alternative Comparison, and Global Lock Ordering (P4, P16, P20, P23, P29)
- **Entry Criteria:** Layer 3 exit criteria satisfied; invariants and retention contracts defined.
- **Activities:**
  - Discover and compare viable design alternatives against constraints, recording reasons for selected and rejected approaches (P29).
  - Choose the smallest, most robust architecture that satisfies all invariants (P20).
  - Compile a lock inventory and document a uniform global lock hierarchy across all call paths to reduce deadlock risk (P23).
  - Decouple activation paths from destructive legacy decommissioning to preserve rollback viability (P16).
- **Exit Criteria (Observable Proof):** Documented alternative trade-off matrix justifying chosen approach and recording rejected options; global lock hierarchy specified; rollback/migration separation runbook defined.

#### Layer 5: Implementation Discipline & Persistence Fidelity (P2, P4, P5, P18, P21, P22)
- **Entry Criteria:** Layer 4 exit criteria satisfied; architectural plan approved or established.
- **Activities:**
  - Execute baseline static analysis, type checking, or compilation, and targeted tests before modifying code (P2).
  - Restrict modifications strictly to approved files; avoid drive-by refactorings (P4).
  - Apply bounded, incremental edits driven directly by observed diagnostic or test failures (P5).
  - Maintain persistence contract fidelity: never introduce mock-detection fallbacks in production code; update test doubles to implement true persistence contracts (P21).
  - Enforce semantic consistency between high-level schemas, migration DDL, generated clients, and database constraints (P22).
- **Exit Criteria (Observable Proof):** Clean baseline compiler and test logs captured prior to edits; bounded diff strictly confined to assigned files; zero mock-detection bypasses in production code; semantic parity confirmed across schema, DDL, and types.

#### Layer 6: Adversarial Verification, Integration Proof & Fencing (P12, P13, P14, P15, P19, P24, P26)
- **Entry Criteria:** Layer 5 exit criteria satisfied; code implemented with clean compilation.
- **Activities:**
  - Execute the **Integration Proof Protocol (IPP)** across all 8 mandatory gates.
  - Evaluate the **Mandatory Defect-Escape Checklist** across all 4 risk categories.
  - Author negative test cases exercising failure modes: worker crashes, expired leases, chunk count mismatches, manifest tampering (P19, P24).
  - Validate write receipts strictly against reservation parameters before state transitions; separate application write acknowledgement from physical external store read-back (P24).
  - Enforce activation readiness semantics: require physical read-back attestation for read-complete serving, or an explicit degraded-readiness fallback contract for staged activation (P24).
  - Use database-side time for lease evaluation and atomic claim tokens for conditional database fencing, executing full 10-stage lease lifecycle with active heartbeat (P26).
  - Model realistic concurrency interleavings via mandatory Interleaving Matrix; do not cite Level E2 mock tests as Level E3 concurrency proof (P13).
  - Enforce exhaustive pagination and read-back verification on destructive sweeps (P15).
  - Audit state machines for complete crash recovery and ensure no records remain stranded (P12).
  - Decouple external network side-effects from database transactions (P14).
- **Exit Criteria (Observable Proof):** IPP Gates 1–6 evaluated with passing/blocked status; Defect-Escape Checklist completed; negative tests executed asserting failure-closed behavior; competing-connection lease stealing verified.

#### Layer 7: Production Readiness, Review & Evidence Calibration (P7, P11, P17, P18, P25)
- **Entry Criteria:** Layer 6 exit criteria satisfied; adversarial verification and IPP gates evaluated.
- **Activities:**
  - Require explicit persistent tombstones before executing destructive operations (P11).
  - Require a positively identified approved disposable database for real-database tests; explicitly mark verification **BLOCKED** if unavailable (P25).
  - Perform an independent adversarial review of completed changes against all declared invariants (IPP Gate 7).
  - Perform a complete review of the final `git diff` against baseline.
  - Audit cross-artifact consistency across schemas, migrations, code, types, and exact limit values (P18).
  - Calibrate completion claims strictly against the Five-Tier Evidence Hierarchy (E1–E5); clearly distinguish implementation completion from acceptance completion (P7, P17; IPP Gate 8).
- **Exit Criteria (Observable Proof):** Final diff review confirming zero out-of-scope edits; cross-artifact audit proving exact numeric and limit parity; formal IPP Gate 8 Release Decision rendered (PASS / FAIL / BLOCKED).

---

### 2. Integration Proof Protocol (IPP)

The **Integration Proof Protocol (IPP)** is a mandatory structural enforcement mechanism for all multi-component, transactional, background, or distributed engineering tasks. It prevents the primary failure mode observed in complex agent implementations: *producing well-tested internal helpers that are never correctly wired into the actual production execution path.*

#### Protocol Applicability
IPP applies to all tasks modifying or introducing:
- Transactional workflows and outbox patterns
- Background workers and queue consumers
- Distributed execution, leasing, and heartbeat coordination
- Event-driven systems and message dispatchers
- Authentication, authorization, and tenant isolation boundaries
- External cloud provider or API integrations
- Data synchronization and cache invalidation pipelines
- Retrieval, indexing, and vector embedding pipelines
- Schema migrations, version cutovers, and rollback mechanisms

```mermaid
flowchart TD
    G1["Gate 1: Entry-Point Mapping
(Trace user/API/worker trigger to implementation)"] --> G2["Gate 2: Integration Invocation Proof
(Prove production path actually calls helper)"]
    G2 --> G3["Gate 3: Transaction Boundary Proof
(Prove atomic commit, rollback & durable intent)"]
    G3 --> G4["Gate 4: Failure & Interleaving Proof
(Test crashes, retries, duplicate deliveries & races)"]
    G4 --> G5["Gate 5: End-to-End Workflow Proof
(Exercise complete flow from trigger to final state)"]
    G5 --> G6["Gate 6: Contract Conformance Proof
(Verify exact numeric limits & schema parity)"]
    G6 --> G7["Gate 7: Independent Acceptance Review
(Adversarial falsification of all invariants)"]
    G7 --> G8["Gate 8: Evidence-Based Release Decision
(Render formal PASS / FAIL / BLOCKED verdict)"]
```

#### Gate 1 — Entry-Point Mapping
- **Rule:** Identify the actual production entry points (user HTTP routes, mutation resolvers, event listeners, background crons). For each entry point, trace the complete execution path to the enforcement mechanism.
- **Enforcement:** Never assume an implementation is active because its function exists in the codebase. Document the exact call chain from entry point to handler.
- **Verification:** Source code inspection confirming direct call site connectivity.

#### Gate 2 — Integration Invocation Proof
- **Rule:** Verify that each required helper is invoked by the canonical production entry point under the required conditions, and that the relevant execution branch is reached.
- **Enforcement:** Imports, declarations, helper tests, and mock-only function references do not establish invocation proof. A passing test that directly calls the helper function in isolation cannot satisfy this gate. At least one automated test must execute the actual production entry point and assert that the helper's side effects or persistence records are produced on the real execution path.
- **Verification:** Test execution log showing production entry point invoked and downstream record created on the integrated path.

#### Gate 3 — Transaction Boundary Proof
- **Rule:** Explicitly delineate transaction boundaries:
  1. What operations occur inside the atomic transaction?
  2. What operations occur outside the transaction (e.g. asynchronous dispatch, HTTP calls)?
  3. What entities roll back together on transaction failure?
  4. What durable intent survives transaction commit?
  5. What state becomes visible to other workers only after commit?
- **Enforcement:** Author a test that simulates a failure immediately before commit; assert that zero intermediate state or premature events escape to external workers.
- **Verification:** Transaction rollback test asserting pristine state restoration.

#### Gate 4 — Failure and Interleaving Proof
- **Rule:** Enumerate critical crash, retry, timeout, duplicate delivery, competing worker interleavings, and negative-space boundary conditions.
- **Enforcement:** Convert high-impact interleavings and failure modes into executable concurrency and negative tests:
  1. **Negative-Space Tests:** Assert fail-closed behavior for missing evidence, absent required fields, malformed identities, and conditional validation bypasses.
  2. **Concurrency Interleavings:** Convert high-impact interleavings into executable concurrency tests (e.g. Delivery B checking SUCCESS state while Delivery A transitions to SUCCESS; Worker A lease renewal racing Worker B lease steal).
  Where concurrency is relevant, retain controlled realistic interleavings and appropriate E3 evidence.
- **Verification:** Multi-connection concurrency tests executing explicit race schedules and negative-space test suites asserting typed error codes (Level E2/E3).

#### Gate 5 — End-to-End Workflow Proof
- **Rule:** Exercise the entire workflow pipeline from its initiating production entry point to its final observable outcome.
  `Domain Mutation → Transactional Intent → Durable Outbox → Dispatcher → Broker → Worker → Provider Write → Read-Back → Activation`
- **Enforcement:** A test that begins at the outbox or worker level does NOT satisfy this gate. The test must initiate at the domain mutation entry point.
- **Verification:** End-to-end integration test execution transcript verifying final active generation and serving retrievability.

#### Gate 6 — Contract Conformance Proof
- **Rule:** Compare the implementation against the governing specification line-by-line, verifying exact numeric limits, timeouts, and data schemas.
- **Enforcement:** Explicitly compare parameters (e.g. specification 5s timeout vs code implementation; metadata schema requirements; retry counts). Classify any discrepancies.
- **Verification:** Contract comparison audit document.

#### Gate 7 — Independent Acceptance Review
- **Rule:** The reviewer must audit the completed implementation adversarially, attempting to actively falsify every critical invariant.
- **Enforcement:** The reviewer must inspect the actual final diff, production call paths, tests, and delivered patches (scoped incremental and cumulative). The implementation agent's self-review and acceptance report are evidence inputs, not independent approval. The reviewer must run negative assertions and inspect branch coverage to prove invariants cannot be bypassed.
- **Verification:** Adversarial audit report detailing attempted falsifications, patch reconciliation audits, and observed outcomes.

#### Gate 8 — Evidence-Based Release Decision
- **Rule:** Every mandatory acceptance criterion and gate must be formally evaluated and assigned exactly one definitive disposition:
  - **PASS:** Concrete empirical evidence proves the requirement is satisfied.
  - **FAIL:** Concrete evidence demonstrates an implementation defect, invariant violation, or test failure.
  - **BLOCKED:** Required verification infrastructure (real DB, external provider, credentials) is unavailable.
  - **NOT APPLICABLE:** The gate does not apply to this specific task, supported by explicit technical justification.
- **Enforcement:** 
  - `NOT APPLICABLE` requires a brief, verifiable technical justification.
  - `BLOCKED` and `FAIL` cannot be silently counted as PASS or ignored.
  - A mandatory criterion that fails or remains blocked strictly prevents an overall accepted verdict. The release decision must state **CONDITIONAL RELEASE** or **BLOCKED RELEASE** with all gaps transparently disclosed.

---

### 3. Mandatory Defect-Escape Checklist

Before declaring any implementation complete, the agent must evaluate this compact checklist under Layer 6. The checks directly target the failure modes uncovered in historical experiments (PP-001–PP-008):

#### A. Production Integration
- [ ] **Entry-Point Invocation:** Does the canonical production entry point (e.g. API mutation function) directly invoke the required helper?
- [ ] **Transactional Placement:** Is the helper call located inside the correct database transaction, ensuring atomicity with domain state?
- [ ] **Bypass Audit:** Are there secondary mutation paths, batch endpoints, or administrative routes that bypass this helper?
- [ ] **Outbox Integrity:** Do all event emissions flow through the durable outbox rather than directly dispatching over the network?

#### B. Distributed Execution
- [ ] **Logical vs Delivery Identity:** Can distinct delivery IDs (e.g. message redrives) represent the same underlying logical work without creating duplicate claims?
- [ ] **Post-Success Race Prevention:** Can a duplicate delivery establish an active claim after an earlier delivery has already transitioned to `SUCCESS`?
- [ ] **Expired Worker Containment:** Does an expired worker immediately halt processing and fail closed upon database lease expiration?
- [ ] **Stale Completion Fencing:** Does the completion endpoint reject results from workers whose claim tokens have expired or been stolen (HTTP 409 / CAS)?
- [ ] **Active Heartbeat Scheduling:** Is lease renewal actively scheduled and executed as a recurring heartbeat during worker processing, rather than merely provided as an uninvoked helper?
- [ ] **Heartbeat Failure Safety:** Does the worker abort downstream side effects immediately if a recurring heartbeat renewal fails?

#### C. Data Correctness
- [ ] **Metadata Validation:** Are all mandatory metadata fields strictly validated, and are unexpected or malformed values rejected?
- [ ] **Negative-Space Coverage:** Are all mandatory inputs, tokens, and fields tested against both invalid/corrupted values AND absent/undefined/null evidence?
- [ ] **Validation Bypass Audit:** Does the validation logic strictly prevent optional chaining, permissive defaults, or conditional guards from reaching terminal success?
- [ ] **Boundary Rejection:** Are missing records, empty collections, zero-length chunks, and out-of-order sequences rejected loudly?
- [ ] **Exact Limit Parity:** Are exact operational limits (polling timeouts, retry bounds, candidate oversampling ratios) identical to the approved specification?
- [ ] **Monotonic Revisions:** Are entity source revisions strictly monotonic, preventing wall-clock timestamp collisions?

#### D. Testing Rigor
- [ ] **Production-Path Execution:** Does the automated test invoke the actual production entry point rather than only the internal helper?
- [ ] **Transaction Rollback Testing:** Does an automated test verify that rolling back the domain transaction leaves zero leaked outbox records?
- [ ] **Lifecycle Heartbeat Testing:** Does an automated test execute the worker lifecycle with an injected long-running task to verify active lease renewal?
- [ ] **Competing Steal Testing:** Does an automated test steal an active lease in a competing connection and verify the original worker fails closed?
- [ ] **Real Database Execution:** Are concurrency and constraint tests executed against a real database instance (E3) rather than mocks?
- [ ] **Physical External Verification:** Is external store durability verified via physical read-back (E4) rather than write receipt assumption?
- [ ] **Patch & Manifest Reconciliation:** Are scoped incremental patches and cumulative patches reconciled against git status with verified native patch parsing and application?
- [ ] **Evidence Calibration:** Are all test results calibrated strictly to their true evidence level (E1–E5)?

---

### 4. Five-Tier Evidence Hierarchy (E1–E5)

Evidence levels represent **claim-specific evidence categories**, NOT an automatic cumulative ladder. Achieving a higher evidence category (e.g. E5 live operational telemetry) does NOT automatically establish lower-level determinism (e.g. edge-case state-machine transitions or schema constraint enforcement). Every engineering claim must be supported by the appropriate category of evidence.

| Level | Evidence Category | Primary Verification Mechanism | What It Demonstrates | What It Does NOT Establish | Mandatory For Claims Regarding |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **E1** | **Static Checks** | Compiler (`tsc`, `javac`, `cargo check`), linters, schema validators, AST diffs. | Syntax validity, type safety, schema structure, configuration completeness. | Runtime correctness, transaction isolation, database constraint enforcement, operational behavior. | Type safety, import resolution, schema syntax, buildability. |
| **E2** | **Isolated Unit & Workflow Tests** | Test suites using in-memory doubles or mocked dependencies (Jest, pytest, JUnit). | Local business logic, branching correctness, state transition algorithms under simulated deterministic conditions. | Real database lock-wait behavior, physical constraint enforcement, transaction rollbacks, external store durability. | Invariant state transitions, receipt validation, domain error handling, query construction. |
| **E3** | **Real Integration Tests** | Verified approved disposable database or local service containers with applied migrations. | Real foreign key constraints, partial unique indexes, CHECK constraints, actual row locking and competing-transaction serialization. | External service durability (cloud APIs, third-party webhooks), multi-region network latency, operational telemetry. | Database constraints, partial unique indexes, real transaction serialization, deadlock-risk behavior. |
| **E4** | **External-System Tests** | Live staging or sandbox external providers (cloud storage, remote vector stores, payment sandboxes). | Actual network latency, remote provider contracts, remote slicing/indexing, physical read-back confirmation. | Multi-region production traffic, tenant noisy-neighbor limits, live failover. | External API contracts, physical read-back durability, remote webhook delivery. |
| **E5** | **Operational Validation** | Live production telemetry, canary rollouts, synthetic traffic, automated rollback tests. | Production end-to-end reliability, recovery under live load, actual operational latency. | Rare edge-case coverage never triggered in production; does not substitute for deterministic adversarial tests (E2/E3). | Deployment stability, live latency SLA, production error rate, canary verification. |

#### Refined Test-Scope Taxonomy (E2 Breakdown)
To prevent conflating helper unit tests with integrated application tests, Level E2 is explicitly subdivided:

| Scope | Category | What It Actually Proves | What It Does NOT Prove |
| :--- | :---: | :--- | :--- |
| **E2 — Helper** | Unit Test | Isolated function logic with artificial inputs. | Production invocation, wiring, transaction boundaries. |
| **E2 — Production Function** | Component Test | Canonical application entry point with controlled doubles. | Multi-component pipeline handoffs, real database concurrency. |
| **E2 — Workflow** | Integration Double | Connected application components (e.g. Outbox → Dispatcher → Handler). | Real database locks, real network provider contracts. |

#### Strict Evidence Governance Rules
1. **Distinguish Four Engineering States:**  
   - **Proposed Design:** An architectural specification or plan (not evidence of implementation).  
   - **Designed Test:** A planned test suite specified in an artifact (not evidence that the test was executed).  
   - **Executed Test:** A test run against a specific environment with captured command transcripts and exit codes.  
   - **Verified Behavior:** An empirical result where test assertions prove the invariant holds under the tested conditions.
2. **Mandatory Test Claim Disclosure:** Every test claim must explicitly disclose:  
   - What was executed (command and test suite path).  
   - What code path it invoked (production entry point vs internal helper).  
   - What dependencies were real (PostgreSQL, Pinecone) vs mocked.  
   - What the test proves.  
   - What the test does NOT prove.  
3. **No Category Substitution:** Never infer E3 (database constraints/locks) from E2 (mocks), and never infer E4 (external store durability) from application write receipts.
4. **Unit Tests Do Not Prove Concurrency:** A passing single-connection unit test does not prove that row locks serialize correctly under multi-worker contention. Multi-connection or multi-process tests against an approved database are required for E3 concurrency claims.
5. **Mocks Do Not Prove Remote Semantics:** Mocking a third-party SDK does not prove provider consistency, eventual visibility lag, or network retry behavior.
6. **Documented Options Do Not Prove Installed Availability:** Citing official documentation for a newer SDK release does not prove the installed package supports that option. Installed package types and implementation must be verified (P29).
7. **Write Receipts Do Not Prove Physical Read-Back:** An API write acknowledgement (e.g. Pinecone HTTP 200) proves the data plane accepted the request, but does not prove immediate ID fetch visibility or ANN search visibility.
8. **Passed vs. Skipped Distinction:** Always report skipped or bypassed tests separately from passed tests. An unexpectedly skipped test suite is a verification failure.
9. **Open Acceptance Gates:** A requirement requiring Level E3 or E4 that cannot be executed due to missing environment infrastructure must be declared **BLOCKED**; it must never be marked completed or passed.
10. **Test Totals Never Substitute for Scope:** A claim of 1,000+ passing tests is irrelevant if none of those tests execute the actual production entry points governing system invariants.

---

### 5. Domain-Dependent Source-of-Truth Hierarchy & Conflict Resolution

Authority is domain-dependent. No single source of truth universally overrides every other source in all contexts. Engineering decisions must identify the appropriate governing authority for the specific claim:

| Source Category | What It Authoritatively Establishes | What It Does NOT Automatically Establish | Governing Domain |
| :--- | :--- | :--- | :--- |
| **User Requirements & Explicit Constraints** | Intended business outcome, functional goals, authorized scope, non-negotiable boundaries. | Technical feasibility, runtime behavior, or implementation correctness. | Task Scope & Purpose |
| **Runtime Implementation & Configuration** | How the current application code is structured and what it executes today. | Whether current behavior is correct, intended, or free of legacy bugs. | Existing Execution Behavior |
| **Database Schema, Migrations & DDL Constraints** | Persisted data structure, engine-enforced integrity (FKs, unique constraints, nullability, defaults). | Application-level business rules or un-enforced invariants. | Persisted Structural Guarantees |
| **Tests & Runtime Observations** | Exact behavior demonstrated by executed test scenarios under specific tested conditions. | Untested edge cases, performance under un-tested scale, or universal correctness. | Empirical Behavioral Proof |
| **Architecture Docs, Specifications & ADRs** | Documented design intent, architectural decisions, and historical rationale. | Whether current code actually conforms to or fully implements documented intent. | Documented Architectural Intent |
| **Official External Documentation** | Published provider contracts, API specifications, and guarantees for the documented version. | Behavior of a different installed version or un-documented vendor quirks. | Vendor Interface Contracts |
| **Package Types & Installed Source (`*.d.ts`)** | The exact types, method signatures, and options exposed by the installed dependency version. | Remote service-side consistency or runtime behavior under network partition. | Local Dependency Capabilities |
| **Prompt Patterns Registry (`pp.md`)** | Prescribed engineering processes, failure-mode checklists, and operational protocols. | Repository-specific facts, codebase reality, or proof that a design is correct. | Engineering Process & Rigor |

#### Conflict-Resolution Protocol
When two sources of truth disagree during an audit, planning, or implementation task:
1. **Identify the Precise Disagreement:** Formulate the conflict as a concrete technical contradiction (e.g. "ADR specifies composite active-gen FK with CASCADE, but migration DDL implements single-column FK with RESTRICT").
2. **Determine the Governing Domain:** Identify which domain the disputed claim belongs to (persisted integrity, business intent, external contract).
3. **Identify the Strongest Available Evidence:** Evaluate the claim against the domain's authoritative source (e.g. the live database catalog governs database behavior; the installed package declaration governs SDK capabilities).
4. **Diagnose Root Cause:** Determine whether the implementation is stale, documentation is obsolete, behavior was unverified, or the conflict represents an intentional design pivot.
5. **Propose Supported Resolution:** Recommend a resolution aligned with the governing authority and explicit task constraints.
6. **Disclose Conflicts Transparently:** If a conflict cannot be resolved from available evidence without user input, record it explicitly in the task artifact. Never silently pick the convenient source while ignoring the contradiction.

---

### 6. Operating Modes (Enforced Execution Contexts)

To prevent scope creep, accidental modifications, or premature execution, coding agents must explicitly declare and operate within one of five strict modes:

| Operating Mode | Permitted Actions | Prohibited Actions | Completion Deliverable |
| :--- | :--- | :--- | :--- |
| **1. AUDIT ONLY** | Read files, inspect git state, run read-only scripts/queries, identify defects, evaluate invariants. | File modifications, code creation, database/vector mutations, git operations. | Detailed audit report with defect analysis, invariant traceability, and evidence. |
| **2. PLANNING ONLY** | Formulate architecture, author specifications, evaluate tradeoffs, design state machines and test plans. | File modifications, code edits, database/vector mutations, production operations. | Implementation specification with acceptance criteria, invariants, and rollback plan. |
| **3. IMPLEMENTATION** | Apply bounded file edits, add required types/classes, run incremental compilers and focused tests. | Unapproved architectural changes, edits outside scope, destructive migrations. | Modified source files with clean compilation and focused test passing. |
| **4. IMPLEMENTATION + VERIFICATION** | Implement changes, author adversarial and regression tests, run full test suite, build, and diff review. | Scope expansion, uncalibrated readiness claims, untracked modifications. | Code changes, full test execution counts, build confirmation, and diff review report. |
| **5. INDEPENDENT REVIEW** | Adversarially audit completed changes, inspect diffs, verify cross-artifact consistency, challenge claims. | Authoring implementations, trusting unverified reports, modifying production code. | Independent evaluation report classifying verified claims vs. unproven assertions. |

**Mode Boundary Enforcement:** The agent must never transition silently between modes. If an AUDIT ONLY task uncovers a defect, the agent reports the root cause but does not implement a fix until instructed. If an IMPLEMENTATION task requires architectural redesign, the agent pauses and requests confirmation.

---

### 7. Dynamic Pattern Selection & Precedence Protocol

The registry must never be dumped as an unthinking checklist into every task prompt. Pattern selection must occur **after sufficient reconnaissance**, never before understanding the repository and problem.

#### Pattern Selection Discipline & Active Budget
To prevent cognitive overload and prompt dilution, agents must adhere to strict pattern selection discipline:
- **Active-Pattern Budget:** Select **3 to 6 governing patterns** for an ordinary engineering task. Simple tasks may need only 1–2 patterns; highly complex distributed systems tasks may select up to 8 with explicit justification.
- **Three-Tier Pattern Classification:**  
  1. *Registry-Wide Mandatory Controls:* P1 (Repository Grounding), P3 (Invariants), P7 (Evidence Completion), P10 (Traceability), P18 (Consistency), P28 (Secret Safety), and the IPP Gates apply universally to all applicable engineering turns and do not consume the active pattern budget.  
  2. *Task-Specific Governing Patterns:* The 3–6 patterns chosen specifically to govern the core technical risks of the assigned task (e.g. P12, P13, P26 for distributed worker leasing).  
  3. *Optional Supporting Patterns:* Additional patterns cited as secondary guidance without expanding the core verification checklist.

#### Ten-Step Pattern Selection Sequence
1. **Understand Task & Scope:** Identify requested outcome, authorized operating mode, and non-negotiable boundaries.
2. **Repository Grounding (Layer 1):** Inspect actual directory structure, active branch, git status, and existing conventions (P1).
3. **Documentation Discovery (Layer 2):** Inspect relevant project documentation (ADRs, specs, READMEs) for documented intent.
4. **Reference Verification (P29):** When design depends on external libraries or providers, inspect installed package versions and method signatures.
5. **Identify Actual Engineering Risks:** Isolate concrete failure modes (e.g. concurrency, data loss, credential leakage, stale cache).
6. **Discover Candidate Patterns:** Review the Pattern Applicability Matrix (Section 2) for patterns governing those specific risks.
7. **Select Proportionate Patterns:** Select the smallest set of governing patterns (3–6) that adequately covers the identified risks.
8. **Justify Selections & Reasoned Exclusions:** Document why each pattern applies, and explicitly record why adjacent patterns were excluded.
9. **Formulate Specification / Plan:** Produce the design incorporating the selected pattern invariants.
10. **Define Acceptance & Evidence Criteria:** Map every invariant to concrete test requirements, IPP gates, and evidence levels (E1–E5).

#### Pattern Selection Rules
- **No Mandatory Preloading:** Never preload a large collection of patterns as universally mandatory. Pattern applicability is determined dynamically per task.
- **Titles Are Not Triggers:** Never assume a pattern applies solely because its title sounds relevant. Verify its explicit trigger conditions and exclusions.
- **P2 Trigger Clarification:** P2 (Baseline-Before-Editing) triggers **before code modification**. It does NOT apply to planning, architecture, or audit turns where zero code files are modified.
- **Reasoned Exclusions:** Exclusions must be based on technical facts (e.g. "P14 excluded: operation is purely local in-memory with zero network calls").
- **Proportional Negative-Space Testing (P19 & P20 Compatibility):** Do not require exhaustive pathological test matrices for trivial functions. Apply negative-space coverage proportionately to the criticality of the contract and consequences of failure. Critical authorization checks, readiness gates, state-machine transitions, and persistence boundaries require full negative-space matrices; internal pure helpers require proportionate coverage.
- **Compact Selection Record:** For meaningful architecture, planning, or review tasks, include a compact selection record:

| Pattern | Decision | Repository / Problem Evidence | Rationale |
| :--- | :--- | :--- | :--- |
| **Pxx** | Selected / Excluded / Conditional | Concrete observed technical fact | Why the pattern applies or does not apply |

#### Precedence Rules When Patterns Interact
- **Precedence Tier 1 (Non-Negotiable Safety):** P1 (Repository Grounding), P4 (Bounded Scope), and P28 (Secret Safety) override all other patterns. No pattern may authorize unverified file edits or credential leakage.
- **Precedence Tier 2 (Architectural Invariants & Grounding):** P3 (Invariants), P10 (Traceability), and P29 (Documentation & Reference Grounding) govern functional behavior. Code changes must satisfy declared invariants and verified contracts before optimization.
- **Precedence Tier 3 (Proportionality Filter):** P20 (Solution Proportionality) bounds implementation complexity. Never introduce distributed queues, outbox tables, or multi-phase commits if a simple transactional constraint satisfies the invariant.
- **Precedence Tier 4 (Subsystem Hardening):** Conditional patterns (P11–P16, P21–P27) govern specific technical domains only when activated.

---

### 8. Model-Role Separation and Handoff Protocol

The engineering protocol recognizes that different model specializations optimize different engineering stages, while maintaining strict model-agnostic flexibility:

```mermaid
flowchart LR
    subgraph ReasoningRole ["Reasoning / Planning Role"]
        R1["Deep Repo & Doc Audit"] --> R2["Contract Verification (P29)"]
        R2 --> R3["Invariant Definition (P3)"]
        R3 --> R4["Architectural Spec (P20)"]
    end
    subgraph ExecutionRole ["Execution / Implementation Role"]
        E1["Baseline Checks (P2)"] --> E2["Incremental Edits (P5)"]
        E2 --> E3["Compiler / Test Fixes"]
        E3 --> E4["Targeted Tests (P19)"]
    end
    subgraph ReviewRole ["Adversarial Review Role"]
        V1["Cross-Artifact Check (P18)"] --> V2["Concurrency Audit (P13)"]
        V2 --> V3["Calibrated Sign-Off (P17)"]
    end
    ReasoningRole -->|"Formal Handoff Package"| ExecutionRole
    ExecutionRole -->|"Implementation Diff & Evidence"| ReviewRole
```

- **Reasoning / Planning Role:** Specializes in broad repository investigation, project documentation discovery, external reference verification (P29), architectural tradeoff analysis, invariant extraction, and failure-mode anticipation.
- **Execution / Implementation Role:** Specializes in fast, disciplined, bounded code implementation, compiler error remediation, and test execution against a detailed specification.
- **Adversarial Review Role:** Specializes in challenging implementation claims, uncovering phantom locks, finding stranded states, and verifying cross-artifact consistency.

#### Formal Handoff Package Requirements
When handing off work from the planning/investigation role to an implementation or review role, the handoff payload must contain:
1. **Precise Repository Context:** Root path, active branch, current git status, and uncommitted modifications.
2. **Documented Intent & Verified Contracts:** Relevant project documentation references and verified installed package versions (P29).
3. **Declared Invariants & Authorities:** Precise behavioral invariants linked to authoritative truth sources.
4. **Production Entry-Point Mappings (P10 & IPP Gate 1):** Explicit call paths from production entry points to implementation handlers.
5. **Acceptance Criteria & Test-Scope Taxonomy:** Observable system behaviors and negative failure cases mapped to required evidence categories (E1–E5) and test scopes (Helper, Production Function, Workflow, Real DB, External).
6. **Known Failure Modes & Interleaving Matrix:** Specific edge cases, concurrency interleavings, and crash conditions to handle (P12, P13).
7. **Architectural Scope & Boundaries:** Explicitly permitted modifications and strictly prohibited files or areas.
8. **Execution Commands:** Concrete commands for focused testing, type checking, linting, and building.
9. **Evidence Requirements & IPP Gate Checklist:** Exact deliverables expected (test counts, build results, diff review, IPP Gates 1–8 evaluations, Defect-Escape Checklist results, open risk disclosures).
