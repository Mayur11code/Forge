# Assignment 37 — Phase 37.6: Missing-Input Protocol and Clarification State

```text
Phase:            37.6 — Missing-input protocol and clarification state
Status:           VERIFIED (2026-10-17 — backend missing-input protocol + same-session continuation accepted; durable proposal persistence deferred to 37.8; F4 open)
Classification:   P1
Depends on:       37.5 IMPLEMENTED (`generateWorkflow` tool); 37.4 IMPLEMENTED (compiler); 37.0A VERIFIED
Blocks:           37.7 (human criticality), 37.8 (durable proposal persistence)
Resolves:         AD-18 (AD-P2 resolution: missing-input protocol & persistence boundary)
Writes workflows: No
Writes anything:  No (proposal and tool-level clarification protocol only; continuation writes agent message + outbox event)
Runtime changed:  No
Resolver changed: No
Schema migration: No (honored boundary: no Prisma models or migration created)
```

Companion documents: `assignments-37-tracker.md`, `assignments-37-plan.md`, `assignments-37-issue-register.md`,
`assignments-37-phase-37.5-generate-workflow.md`.

**Status — `VERIFIED` (2026-10-17).** The missing-input protocol and clarification lifecycle are
accepted at final review for the scope 37.6 owns: the `NEEDS_USER_INPUT` protocol identity, the
clarification-intent validation, the real `POST /api/agent/session/[sessionId]/clarification` ingress with
session GET exposure, `interactionId` + proposal-revision `correlationId` binding, idempotent/conflicting
continuation under the session lock, and the reaper `skippedWaiting` exemption. The scope is the **backend**
protocol and same-session continuation only - **no external user-facing UI is implemented or claimed by 37.6.**

> **Addendum 2026-10-19 — the answer surface now exists (owned by 37.9.1, not
> 37.6).** The client that answers this protocol is
> `ClarificationRequestCard.tsx`, mounted by `WorkflowProposalPanel.tsx` (see the
> 37.9.1 addendum in `assignments-37-phase-37.9-proposal-review.md` §14). It
> consumes the session GET's projected `clarification` verbatim and POSTs the
> exact `{ interactionId, correlationId, answers }` shape documented below; it
> adds no second clarification service and changes no service, route, schema, or
> migration. The 37.6 backend status and its evidence are unchanged.

Acceptance evidence: `src/tests/agent/missing-input-protocol.test.ts` 28/28; `session-step-claim.test.ts` 5/5;
focused clarification 4 suites / 57 tests; agent + workflow 36 suites / 672 tests; full suite 40 suites / 692
tests; `tsc --noEmit` exit 0; scoped ESLint 0; `git diff --check` clean; Prisma schema untouched.

**Full proposal-lifecycle durability and process-restart survival remain OPEN** and are owned by Phase 37.8:
they cannot be guaranteed without a database schema decision (F4). The durability gate therefore stays OPEN
even though 37.6 is now `VERIFIED` for the scope it owns. (Prior status note, 2026-10-14: the phase was
`IMPLEMENTED` while that durability gate was open.)

**Documented limitation (distinct from F4).** Independent verification cannot establish whether an answer
the human "already supplied" was in fact present in the prior conversation: the continuation path validates
that a clarification targets a genuinely missing required input, but no durable record proves a value the
model omitted had already been provided. This is an evidence limitation of the clarification path itself,
not the F4 persistence/durability fork, and it is not resolved by 37.8's schema decision.

**Remediation (2026-10-14).** The first cut of this phase proved the *classification* half of the protocol
but left the *lifecycle* half inert: the tool worker recorded an `AGENT_LOOP_REQUESTED` continuation even
for a `NEEDS_USER_INPUT` result (sending the model straight back to the same missing input), the session
could then be marked `COMPLETED`, the reaper could fail a session that was legitimately waiting, and
`submitClarificationAnswer` had no production route and bound answers only by a content fingerprint. The
remediation closes those gaps **without** a schema change:

- **Worker halts instead of continuing.** `tool-worker.ts` detects a clarification result, stamps the
  backend-owned `interactionId` (= `AgentToolExecution.id`) onto the persisted tool-result, records **no**
  `AGENT_LOOP_REQUESTED`, completes the execution, and publishes a new `CLARIFICATION_REQUESTED` status
  event. The halt is a durable transcript state, not a special session status.
- **Real ingress.** `POST /api/agent/session/[sessionId]/clarification` is the production caller, and the
  session GET route exposes the derived pending `clarification` so a client can rebuild the question after
  a refresh.
- **Authoritative correlation.** An answer must match both the pending `interactionId` and (when present)
  the proposal-revision `correlationId`; a mismatch is `STALE_CLARIFICATION`. The fingerprint is a secondary
  check - two revisions with the same missing field hash the same, so it cannot bind an ask on its own.
- **Safe continuation.** Under the session lock, the pending request is re-read, duplicates are idempotent
  (same content) or `CLARIFICATION_CONFLICT` (different content), and the answer message plus the
  `AGENT_LOOP_REQUESTED` intent commit in one transaction.
- **Reaper exemption.** `redriveStalledSessions` skips a session with a pending clarification
  (`skippedWaiting`), so a deliberate wait is neither re-driven nor failed by the attempt cap.
- **Canonical fingerprint.** `computeProposalCorrelationId` now hashes a key-sorted serialisation, so
  logically identical revisions produce identical fingerprints.

---

## 1. Purpose and Scope

Implement the Assignment 37.6 missing-user-input protocol, providing a first-class, machine-readable
control-flow state (`NEEDS_USER_INPUT`) distinct from ordinary validation errors (`INVALID_INPUT`) and human
approvals (`PENDING_CONFIRMATION`).

When a user request genuinely lacks necessary parameters (for example, "Create an onboarding workflow for Acme",
where `task.create` requires a project ID that the user never provided), Forge must ask the human instead
of inventing or hallucinating a placeholder value.

```text
Model generates proposal + optional clarifications
                      |
                      v
     Structural / Graph Validation (Compiler)
                      |
          +-----------+-----------+
          |                       |
     Model Errors?        Missing Inputs Only?
          |                       |
          v                       v
     INVALID_INPUT        Clarifications Requested?
   (Self-Correction)              |
                            +-----+-----+
                            |           |
                           No          Yes
                            |           |
                            v           v
                      INVALID_INPUT   NEEDS_USER_INPUT
                    (Self-Correction) (Human Question)
```

### Out of scope (honoured)

- **No Prisma migration or new persistence model:** `AgentToolExecution` has no `result` column or `NEEDS_INPUT`
  status, and `AgentSession` has no `AWAITING_INPUT` status. Deciding between extending `AgentToolExecution`
  vs creating a dedicated `WorkflowProposal` model belongs to Phase 37.8.
- **No prompt change or prompt version bump:** deferred to Phase 37.13.
- **No modification to completed 37.2 `WorkflowProposalSchema`:** the 37.2 proposal schema remains untouched.
- **No execution of workflow actions or workflow materialization:** proposal and clarification only.

---

## 2. Naming Contract Reconciled

The repository distinguishes three related identifiers without redundant aliases:

1. `MISSING_REQUIRED_INPUT`: A validator diagnostic emitted by the proposal compiler (`validateStepInputs` in
   `workflow-proposal.ts`) indicating that an input required by an action capability schema is absent from a step.
2. `NEEDS_USER_INPUT`: A control-flow state and top-level tool result discriminator indicating that human
   clarification is required because essential user information was not provided in context.
3. `INVALID_INPUT`: The standard tool-failure code returned when the model made a correctable mistake (e.g. unknown
   action, malformed input, cycle, unknown dependency, or unrequested omission).

---

## 3. The Three Distinct Loops

Forge distinguishes three independent loops:

| Loop | Trigger | Who Resolves It | Outcome Envelope |
|---|---|---|---|
| **1. Self-Correction** | Model mistake / omitted field | Model | `{ ok: false, code: "INVALID_INPUT", issues: [...] }` |
| **2. Human Clarification** | Missing user information | Human | `{ ok: false, status: "NEEDS_USER_INPUT", code: "NEEDS_USER_INPUT", fields: [...], correlationId }` |
| **3. Human Approval** | Persisted proposal review | Human | Existing confirmation loop (`PENDING_CONFIRMATION`, bodyless POST) |

These three outcomes are completely distinguishable at the top-level machine-readable protocol boundary:
`code` and `status` immediately discriminate `NEEDS_USER_INPUT` from `INVALID_INPUT`.

---

## 4. API and Protocol Envelopes

### Result Envelopes (`src/lib/ai/agent/tools/generate-workflow/types.ts` & `shared-output.ts`)

```ts
export type MissingUserInputField = {
  field: string;
  reason: string;
  question: string;
  candidateValues?: JsonValue[];
};

export type GenerateWorkflowClarification = {
  ok: false;
  status: "NEEDS_USER_INPUT";
  code: "NEEDS_USER_INPUT";
  error: string;
  fields: MissingUserInputField[];
  correlationId: string;
  proposal?: GeneratedProposal;
};

export type GenerateWorkflowOutput =
  | GenerateWorkflowSuccess
  | GenerateWorkflowFailure
  | GenerateWorkflowClarification;
```

### Clarification-Intent Schema (`src/lib/ai/agent/tools/generate-workflow/schema.ts`)

```ts
export const ClarificationRequestItemSchema = z
  .object({
    field: z.string().min(1),
    reason: z.string().min(1),
    question: z.string().min(1),
    candidateValues: z.array(z.unknown()).optional(),
  })
  .strict();

// What the MODEL is handed as the tool's `inputSchema`: ONE flat object.
export const generateWorkflowModelInputSchema = WorkflowProposalSchema.extend({
  clarifications: ClarificationRequestItemSchema.array().min(1).optional(),
});

// What the EXECUTOR still accepts (parser/compat): three historical shapes.
export const generateWorkflowAcceptedInputSchema = z.union([
  WorkflowProposalSchema,
  ProposalWithClarificationsFormASchema,
  ProposalWithClarificationsFormBSchema,
]);
```

- **Model-facing contract:** the schema passed to the AI SDK/Gemini is
  `generateWorkflowModelInputSchema` — a single flat object (`name`, `description?`,
  `steps`, `clarifications?`). A root `z.union` serializes to a root `anyOf` in the
  tool's JSON Schema, which function-calling handles unreliably (the model must both
  choose a branch and populate it, and a near-miss matches no branch), so the union is
  deliberately NOT exposed to the model.
- **Executor compatibility (legacy):** the executor still accepts all three historical
  input shapes — plain proposal, nested Form A (`{ proposal, clarifications }`), and flat
  Form B (`{ name, description?, steps, clarifications }`) — via
  `extractProposalAndClarifications`. `generateWorkflowAcceptedInputSchema` documents and
  validates that boundary; it is not sent to the model.
- `generateWorkflowSchema` continues to export `WorkflowProposalSchema` by reference, preserving backward compatibility.
- Proposals with clarification requests specify which missing inputs need human clarification.

---

## 5. Clarification-Intent Validation & False Positive Prevention

To prevent false `NEEDS_USER_INPUT` classification:

1. **Model errors take precedence:** If the proposal contains any error other than `MISSING_REQUIRED_INPUT`
   (`UNKNOWN_ACTION`, `UNKNOWN_DEPENDENCY`, `CYCLE`, `MALFORMED_REFERENCE`, wrong type, format violation),
   the tool returns `INVALID_INPUT` with compiler issues so the model corrects its graph/action mistake.
2. **Clarification requests must correspond to genuinely missing required inputs:** If a clarification targets
   a field that is already supplied, an optional field, or a non-existent field, it is rejected as `INVALID_INPUT`.
3. **Unrequested omissions remain model-correctable:** If a required input is absent but the model did not ask
   for clarification, it is treated as a model omission (`INVALID_INPUT` with `MISSING_REQUIRED_INPUT` issue)
   to allow bounded self-correction if the value was already in the conversation context.
4. **Already-complete proposals reject clarifications:** Requesting clarification on a fully valid proposal
   returns `INVALID_INPUT`.
5. **Candidate values grounded:** Candidate values are only included when non-empty grounded values are provided,
   and never expose backend-trusted authorization tokens or unauthenticated cross-tenant data.

---

## 6. Same-Session Continuation Design & Service

Module: `src/lib/ai/agent/services/clarification-service.ts`.

Function: `submitClarificationAnswer({ sessionId, userId, interactionId, correlationId, answers })`

Security & Correlation Rules:
1. **Authenticated ownership:** Validates session exists and belongs to the calling user (`userId`).
2. **Session liveness:** Session must be in active `RUNNING` status (an ended or failed session cannot be resumed).
3. **Single writer:** The whole body runs under `withAgentSessionLock(sessionId, ...)`; a null lock reports
   `SESSION_BUSY` rather than racing the worker.
4. **Idempotency first:** If an answer already tagged with this `interactionId` exists, identical content
   returns success with `idempotent: true` and no writes; different content is `CLARIFICATION_CONFLICT`. This
   check runs **before** the pending scan, because an accepted answer retires its own request.
5. **Authoritative correlation:** The pending request is re-read from the transcript and compared against the
   supplied `interactionId` (backend-owned) and, when present, the proposal-revision `correlationId`; any
   mismatch is `STALE_CLARIFICATION`. Answers must cover exactly the requested fields (`INVALID_ANSWER_VALUE`
   otherwise).
5. **Loop re-entry:** Atomically records the answer as a `user` message (tagged `toolCallId = interactionId`)
   and emits an `AGENT_LOOP_REQUESTED` event into the transactional outbox, in one transaction.
6. **Re-compilation:** When the model runs on the next step, any newly generated proposal passes through
   `compileWorkflowProposal` again from scratch.

---

## 7. Explicit Persistence Boundary (AD-18 / 37.6 vs 37.8)

### What 37.6 Owns:
- Protocol distinction between model error and missing user information.
- Structured `NEEDS_USER_INPUT` result envelope.
- Clarification-intent validation.
- Safe same-session continuation design (`submitClarificationAnswer`).

### What 37.8 Owns:
- Final durable proposal-lifecycle storage decision (reuse of `AgentToolExecution` vs dedicated `WorkflowProposal` model).
- Any database schema migration and enum additions.
- Process restart mid-lifecycle survival tests.

### Why Durability Is Relocated, Not Waived:
Currently, `AgentToolExecution` has no `result` column and no `NEEDS_INPUT` status; `AgentSession` has no
`AWAITING_INPUT` status. Simulating a durable pause by leaving a row `RUNNING` would create a stalled session
indistinguishable from a hung worker. Therefore, 37.6 created NO migration and NO temporary workaround.
Full restart durability is formally relocated to Phase 37.8.

**F4 remains OPEN.** 37.6's protocol and same-session continuation scope is now `VERIFIED`
(2026-10-17); the durable proposal-lifecycle persistence and restart-survival criteria that keep F4 open
belong to 37.8.

**Documented limitation (not F4).** Independent verification cannot establish whether a value the human had
*already supplied* in the prior conversation was in fact present: the continuation path confirms an answer
corresponds to a genuinely missing required input, but no durable record proves the model omitted a value the
human had already provided. This is a limitation of the current evidence for the current continuation path,
distinct from F4's persistence/durability fork, and it is not resolved by 37.8's schema decision.

---

## 8. Test Coverage and Verification Evidence

### New Test Suite: `src/tests/agent/missing-input-protocol.test.ts` (28 tests)

- **Group A: Classification and Issue Contract (Tests 1–10)**
  1. One required field absent produces `MISSING_REQUIRED_INPUT` at correct field path.
  2. Multiple required fields absent all identified.
  3. Missing required fields not automatically classified as user omission without clarification evidence.
  4. Required field omitted without clarification remains model-correctable `INVALID_INPUT`.
  5. Genuinely missing user-supplied value produces structured `NEEDS_USER_INPUT`.
  6. `NEEDS_USER_INPUT` distinguishable from `INVALID_INPUT` at top-level protocol boundary.
  7. Null, empty, wrong-type and present-but-invalid values not misclassified as missing user information.
  8. Template references in required fields retain deferred-reference behavior (no missing input issue).
  9. Multiple missing inputs produce multiple field records and human questions.
  10. Candidate values absent unless supported by authoritative evidence.

- **Group B: Three-Loop Separation (Tests 11–15)**
  11. `UNKNOWN_ACTION`, `UNKNOWN_DEPENDENCY`, and `CYCLE` follow existing model-correction behavior (even if clarifications were attached).
  12. `NEEDS_USER_INPUT` does not enter uncontrolled self-correction loop.
  13. Clarification state cannot be mistaken for `PENDING_CONFIRMATION` (`generateWorkflow` is `READ_ONLY`).
  14. Existing confirmation contracts remain green (`createTask` is `WRITE`).
  15. Unexpected errors (null input) throw rather than returning validation/clarification envelopes.

- **Group C: Continuation (Tests 16–19)**
  16. Same-session answer path authenticated and org-scoped (404 on invalid user/session).
  17. Answer correlated with pending clarification (`interactionId`) and proposal revision (`correlationId`).
  18. Answer rejection matrix (18a–18f): not found, session not running, empty answers, missing field,
     malformed value, stale `interactionId`/`correlationId`.
  19. Duplicate answers are idempotent (same content) or `CLARIFICATION_CONFLICT` (different content),
     and idempotency wins over the pending scan.
  20. Regenerated proposal passes through `compileWorkflowProposal` again.
  21. No workflow action executed and no workflow materialized during clarification.

- **Group D: Worker Halt vs Continuation (Tests 22–23)**
  22. A `NEEDS_USER_INPUT` tool result records **no** `AGENT_LOOP_REQUESTED`, completes the execution, and
     publishes `CLARIFICATION_REQUESTED` with the backend `interactionId`.
  23. An ordinary tool result still records `AGENT_LOOP_REQUESTED` and publishes `TOOL_COMPLETED`.

Reaper exemption is covered by `src/tests/agent/durability.test.ts`:
"does not re-drive a session that is waiting on a clarification answer" (`skippedWaiting === 1`, no outbox)
and "re-drives a session once its clarification has been answered" (`redriven === 1`).

### Verification Results

```text
npx jest src/tests/agent/missing-input-protocol.test.ts -> 28/28 passed
npx jest src/tests/agent/session-step-claim.test.ts    -> 5/5 passed (CAS regression)
npx jest missing-input-protocol durability maintenance -> 3 suites / 87 tests passed
npx jest durability maintenance generate-workflow      -> 3 suites / 83 tests passed
npx jest durability maintenance                        -> 2 suites / 59 tests passed
npx jest <4 clarification suites>                      -> 4 suites / 57 tests passed
npx jest src/tests/agent src/tests/workflow            -> 36 suites / 672 tests passed
npx jest (full suite)                                  -> 40 suites / 692 tests passed
npx tsc --noEmit                                       -> exit 0
npx eslint (changed files)                             -> 0 errors / 0 warnings
git diff --check                                       -> clean
Prisma schema diff                                     -> empty
```

---

## 9. Next Phase

Phase 37.7 (Human criticality state) enforces that the human decides step criticality and saga rollback
behavior, continuing the F4 fork before durable persistence lands at Phase 37.8.

---

## 9a. Remediation (2026-10-20) — clarification must be able to win

Found by running the flow against the live database, not by reading tests. A session observing
`RUNNING` at step 3/5 with **zero workflow runs** had three `generateWorkflow` executions, all
failures, all of which *did* carry `clarifications`. The model asked correctly, and also wrote
`{{clientName}}` / `{{forgeCoreProjectId}}` into the same inputs. The compiler reported those as
`UNKNOWN_REFERENCE_SOURCE`; the executor's gate treated any non-`MISSING_REQUIRED_INPUT` issue as a
model-correctable mistake, returned `INVALID_INPUT`, discarded the clarification, and sent the model
back to retry a value only a human can supply — a guaranteed march to `MAX_STEPS_EXCEEDED`.

Two changes, both in `fix(...)` commits:

1. **`7bc05a7` — `generate-workflow/execute.ts`.** An `UNKNOWN_REFERENCE_SOURCE` issue on an input path
   that a clarification request names is treated as a human-supplied placeholder: it no longer forces
   `INVALID_INPUT` and is excluded from the downstream `validateProposalReferences` re-check. The
   clarification-legitimacy check uses `resolvablePaths = missingPaths ∪ placeholderPaths`. **Narrow by
   design:** malformed references, unknown outputs, unknown actions, cycles and dangling dependencies
   still force model correction.
2. **`c7809f2` — prompt + tool description.** A rule under `<WORKFLOW_GENERATION>` (mirrored in the
   `generateWorkflow` description) tells the model to emit a clarification for a required input absent
   from context rather than inventing a placeholder. `AGENT_PROMPT_VERSION` bumped `v4 → v5`. A second
   earlier session (`cmvfo40ti…`) reached `COMPLETED` at step 1 with a prose question and no answer
   surface; this rule is the missing piece that produces the structured clarification field the client
   consumes.

**Scope boundary crossed, recorded.** §1 Out-of-scope and the status matrix of 37.5 both state
*"No prompt change or prompt version bump: deferred to Phase 37.13."* This remediation touches the
prompt and the version constant. It is logged here rather than silently absorbed. 37.13 still owns the
prompt text and version identifier as a phase; whether this v5 bump remains, or the rule folds into
37.13 proper, is a reviewer decision.

**No migration, no schema change, no new service or route.** The protocol envelopes, validator,
continuation service and reaper exemption above are unchanged.

**Operator action.** The orphaned session `cmvfog8hv…` (`promptVersion "v5"`, `currentStep 4`, three
`COMPLETED` executions, no pending clarification) was terminated by a controlled Prisma write to
`FAILED` / `terminalReason "MANUAL_TERMINATION"` with an explanatory `errorMessage`. There is no
session-level terminate route in the app; this was a deliberate, recorded operator action. (An earlier
hypothesis that the session was a "v4 zombie" is wrong — the DB says `v5`; the mismatch is a warning,
not a reject, per `loop-runner.ts:82`.)

Evidence: `src/tests/agent/missing-input-protocol.test.ts` +3 (10b: the exact failing two-field `{{…}}`
payload now yields `NEEDS_USER_INPUT`; 10c: an uncovered reference still yields `INVALID_INPUT`; 10d:
a malformed reference on a clarified path still yields `INVALID_INPUT`); full suite 56 suites / 1077
tests; `tsc --noEmit` exit 0; eslint 0 on changed files.

---

## 10. Status History

| Date | Status | Change | Evidence |
|---|---|---|---|
| 2026-10-14 | IMPLEMENTED | Structured clarification protocol (`NEEDS_USER_INPUT`), clarification-intent validation, continuation service; no migration; durability deferred to 37.8 (AD-18; F4 open) | 21/21 focused; 32 suites / 629 tests; tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |
| 2026-10-14 | IMPLEMENTED (remediated) | Worker halts on clarification (no `AGENT_LOOP_REQUESTED`, publishes `CLARIFICATION_REQUESTED`); real `POST .../clarification` ingress + session GET exposure; `interactionId`+`correlationId` binding; idempotent/conflict continuation under lock; reaper `skippedWaiting` exemption; canonical `computeProposalCorrelationId` | 28/28 focused + durability reaper tests; 32 suites / 638 tests; full suite 658; tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |
| 2026-10-17 | IMPLEMENTED (cleanup) | `currentStep` compare-and-set predicate enforced in the in-memory prisma double; new `claimNextAgentStep` regression suite (`session-step-claim.test.ts`, 5 cases); stale verification totals corrected; mocked-boundary comment corrected | 5/5 CAS focused; 3 suites / 87 (`missing-input-protocol durability maintenance`); 3 suites / 83 (`durability maintenance generate-workflow`); 2 suites / 59 (`durability maintenance`); 4 suites / 57 (clarification focused); 36 suites / 672 (agent + workflow); 40 suites / 692 (full); tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |
| 2026-10-17 | VERIFIED | Final acceptance of the backend missing-input protocol and same-session clarification continuation (accepted scope; external UI not claimed); durability/restart survival still OPEN and owned by 37.8; F4 remains open | `missing-input-protocol` 28/28; `session-step-claim` 5/5; clarification focused 4 suites / 57; agent + workflow 36 suites / 672; full suite 40 suites / 692; tsc exit 0; eslint 0; `git diff --check` clean; Prisma schema untouched |
| 2026-10-19 | VERIFIED (unchanged) | Addendum only: recorded that the client answer surface (`ClarificationRequestCard`) was added by 37.9.1 over this unchanged protocol. 37.6 itself was not modified; no service, route, schema, or migration changed. | `clarification-request-card.test.tsx` 11; `workflow-proposal-panel.test.tsx` 15; full suite 51 suites / 954; tsc exit 0; Prisma schema untouched |
| 2026-10-20 | REMEDIATION (live-testing defect fixed) | Two defects surfaced by running the flow against the live DB. (1) An `UNKNOWN_REFERENCE_SOURCE` issue on a field a clarification names now demotes to human-resolvable placeholder instead of forcing `INVALID_INPUT`, so a well-formed "ask + placeholder" proposal reaches `NEEDS_USER_INPUT` instead of retrying to the step cap (`execute.ts`; commit `7bc05a7`). (2) A prompt rule routes an unfilled placeholder to the clarification field; `AGENT_PROMPT_VERSION` bumped `v4 → v5` (`system-prompt.ts`, `generate-workflow/tool.ts`; commit `c7809f2`). The demotion is narrow — malformed/unknown-output/unknown-action/cycle/dangling-dep still force model correction. **This deliberately crosses the 37.5/37.6 "no prompt change — deferred to 37.13" boundary; recorded, not absorbed. Reviewer call whether the bump stays or folds into 37.13.** | `missing-input-protocol.test.ts` +3 (10b/10c/10d); full suite 56 suites / 1077 tests; tsc exit 0; eslint 0 on changed files; no migration, no schema change, no new service or route |
