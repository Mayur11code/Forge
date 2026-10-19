# Assignment 37 — Phase 37.10: Deterministic UI Graph Projection and Read-Only Preview

```text
Phase:            37.10 — UI graph projection / deterministic layout
Status:           IMPLEMENTED (2026-10-19 — submitted for independent acceptance)
Classification:   P2
Depends on:       37.9 IMPLEMENTED (approved proposal, criticality recorded); 37.0B VERIFIED (node-data schema on both save paths); 37.4/37.7 IMPLEMENTED (compiler, criticality contract)
Blocks:           37.11 (canvas-first materialization)
Resolves:         — (F1 remains OPEN; AD-11 records the ordering it implied)
Writes workflows: No
Writes anything:  Nothing at all — no row, no message, no state transition
Runtime changed:  No
Resolver changed: No
Schema migration: None
```

Companion documents: `assignments-37-plan.md` (Phase 11, F1),
`assignments-37-tracker.md` (37.10), `assignments-37-issue-register.md`,
[`assignments-37-phase-37.9-proposal-review.md`](./assignments-37-phase-37.9-proposal-review.md).

**Status — `IMPLEMENTED`, not `VERIFIED`.** The projection, the preview and their
tests are implemented and locally verified; this document is submitted for
independent acceptance. **F1 and F2 remain open.** This document does not
self-accept.

---

## 1. Purpose and Scope

Show the human the dependency structure they are about to approve — layers, edge
direction, and which steps are critical — as a graph, derived deterministically
from the reviewed proposal. This is plan Phase 11 ("derive UI representation"),
moved ahead of materialization by **F1** (persistence in Forge is canvas-first).

In scope:

- A **pure** projection `WorkflowProposal` + complete criticality decisions →
  positioned `uiNodes` / `uiEdges`, with a documented, hand-rolled layered-DAG
  layout (no layout library was added).
- A **read-only** React Flow preview rendered inside the existing proposal-review
  experience (37.9.1's `WorkflowProposalPanel`).
- Delegation: validation is still 37.4, the exact-set criticality rule is still
  37.7, revision binding is still the 37.7 fingerprint. Nothing is re-implemented.
- Tests for determinism, layout, criticality enforcement, error rendering and
  panel gating; documentation of the layout contract.

Explicitly out of scope (deferred): materializing an approved proposal (**37.11**),
provenance/name placement (**F2**), any `Workflow`/`Task` creation, any execution,
any persistence, and any change to 37.6–37.9 behaviour.

## 2. Decisions

- **A — one projection module, delegating, returning a structured union.**
  `projectProposalToUIGraph` never throws and never returns partial output:
  `{ success, uiNodes, uiEdges } | { success: false, issues }`. The failure arm
  carries **both** vocabularies (`ProposalUIProjectionIssue = ProposalIssue |
  CriticalityIssue`) — the two code unions do not overlap, so `issue.code`
  discriminates them and there is no second error type to render.
- **B — a hand-rolled longest-path layered layout.** The repo has no
  dagre/elk/d3-hierarchy and none was added; pulling a layout engine in for a
  graph of ≤ 50 nodes would be a new dependency bought with a purity it would
  cost. Layer = longest-path depth from a root, computed by iterative relaxation
  (bounded by `refs.length` passes, order-independent), within-layer refs sorted
  lexicographically and stacked top-to-bottom. The constants are exported as
  `PROPOSAL_UI_LAYOUT` so tests assert the contract rather than restate it.
- **C — split the 37.7 contract so the exact-set rule can run in a browser.**
  `workflow-criticality.ts` imported `computeProposalCorrelationId` from the
  `generateWorkflow` executor, which imports `node:crypto`, and Next's client
  bundle has no `resolve.fallback` for it — a client component in that chain
  breaks `next build`. The pure half of 37.7 moved verbatim to
  `workflow-criticality-set.ts`; `workflow-criticality.ts` imports it back and
  re-exports the types, so there is **one** implementation and 37.7's public
  surface is unchanged (its suite imports only `apply`/`validate`, is untouched,
  and passes).
- **D — revision binding stays on the server.** The browser cannot recompute the
  fingerprint, so it is never asked to: the session GET validates the decision
  set against the re-parsed proposal and compares its recomputed fingerprint with
  the stored `proposalFingerprint`, exposing an additive `approvedCriticality`
  field only when both hold. The client receives either a complete, revision-bound
  set or `null`.
- **E — the preview is a wrapper, not a new node renderer.** `ActionNode` does not
  surface `isCritical`, so a small `PreviewActionNode` composes the shared
  renderer with a criticality chip. The 37.6 canvas component is unchanged and no
  second node model exists: both consume `AppNode` / `ActionNodeData`.

## 3. The Projection Contract

```text
projectProposalToUIGraph(proposal, completeCriticalityDecisions, options?)
  → { success: true,  uiNodes: AppNode[], uiEdges: AppEdge[] }
  | { success: false, issues: ProposalUIProjectionIssue[] }
```

Order of work, and each step's owner:

1. `compileWorkflowProposal` (**37.4**, unchanged) — structural → references →
   mapping → graph semantics. Stops on `ProposalIssue[]`.
2. `collectCriticalityIssues` (**37.7**, in the client-safe module) —
   exact-and-complete set. Stops on `CriticalityIssue[]`.
3. Layout and node/edge emission (this phase).

`completeCriticalityDecisions` is typed `unknown` on purpose: a TypeScript type is
not evidence that a runtime value was validated. There is no `?? false`, so a step
the human never classified is **never** rendered as non-critical — the projection
fails instead.

Emitted nodes (presentation only, never savable workflow state):

| Field | Value | Why |
| --- | --- | --- |
| `id` | the proposal-local `ref` | identity is the record key (AD-08) |
| `type` | `"action"` | reuses the canvas renderer |
| `position` | `{ x, y }` from the layout contract | §4 |
| `data.label` | `"<ref> (<action>)"` | legible on its own; the ref stays primary |
| `data.actionType` | `step.action` | `ActionNode` renders it in the body |
| `data.config` | `{ ...step.inputs }` | a copy, so a node cannot edit the proposal |
| `data.isConfigured` | `true` | inputs were validated by 37.1 |
| `data.isCritical` | the human's decision for that ref | the reason the preview exists |
| `data.executionStatus` | **absent** | no run has happened; a proposal has no trigger node |

Edges: `id = "e:<dep>-><ref>"`, `source = dep`, `target = ref`, emitted in
sorted-target then sorted-dependency order, **once per distinct dependency** (a
free-form `dependsOn` may repeat a name). Record-key insertion order and
`dependsOn` order therefore cannot change the output.

## 4. Layout Contract

```text
layer(ref) = 0                      when dependsOn is empty
           = 1 + max(layer(dep))    otherwise     <- longest path, not first path

x = x0 + layer * (nodeWidth + horizontalGap)
y = y0 + indexWithinLayer * (nodeHeight + verticalGap)

PROPOSAL_UI_LAYOUT = { x0: 100, y0: 100, nodeWidth: 250,
                       nodeHeight: 140, horizontalGap: 80, verticalGap: 60 }
```

- Computed by iterative relaxation over refs in sorted order, at most
  `refs.length` passes, so the result is total (never a stack overflow) and
  independent of record-key insertion order. Each pass reads only the previous
  pass's values, so no visit order can matter. Cycles cannot reach this point —
  `compileWorkflowProposal` rejects them first.
- Nodes are ordered layer 0…n, then ref; within a layer, sorted lexicographically
  and stacked top-to-bottom.
- `nodeWidth`/`nodeHeight` approximate `ActionNode`'s `min-w-[250px]` plus its
  header/body. `ReactFlow fitView` corrects any drift, and the gaps keep the
  assumed box from overlapping the real one.
- The box is deliberately a constant rather than a measurement: the preview is
  read-only, so a slightly conservative box costs nothing and keeps the layout
  pure (no effect, no reflow).

## 5. Client-Bundle Constraint and the 37.7 Split

`node:crypto` would have reached the browser through this chain:

```text
WorkflowProposalPanel -> ProposalGraphPreview -> workflow-criticality.ts
                      -> computeProposalCorrelationId (generate-workflow/execute.ts)
                      -> node:crypto           <- no client resolve.fallback
```

`next.config` supplies a fallback for `process` only, so the fix was **not** a
build escape hatch. The exact-set rule and its issue vocabulary were already
pure, so they moved verbatim to `src/lib/workflow-types/workflow-criticality-set.ts`,
which `workflow-criticality.ts` imports back and re-exports. That module remains
the single import path for the whole 37.7 contract and still owns revision
binding; the split is a *home* change, not a logic change, and 37.7's suite
passes unmodified.

Nothing else in the preview's chain uses a Node builtin: `workflow.ts` already
reached client code through `ActionNode`, and the projection imports only
`workflow-proposal`, `workflow-proposal-compiler` and `workflow-criticality-set`.

## 6. Revision Binding — Server, Not Browser

The session GET (`src/app/api/agent/session/[sessionId]/route.ts`) gained
`buildExecutionView` (renamed from `buildReviewForExecution`), which returns two
**additive** fields alongside the existing 37.9 review model, on both
`pendingProposal` and `proposalOutcome`:

```text
proposal            the canonical proposal re-parsed from the durable result
                    (null when the result does not parse)
approvedCriticality the COMPLETE decision set, or null
```

`approvedCriticality` is non-null only when **both** hold:

1. `validateCriticalityDecisions(proposal, execution.criticalityDecisions)`
   succeeds — the same 37.7 exact-set rule; and
2. `execution.proposalFingerprint === approval.approved.fingerprint`, where the
   right-hand side is recomputed server-side from that same re-parsed proposal.

A `null` stored fingerprint is therefore also a mismatch (there is nothing to bind
to), so no special case was kept for it. The field is derived from the same durable
row as `review`, never from presentation fields and never from the request. This is
where **node:crypto is available**, which is why the check lives here rather than in
the client.

## 7. The Preview and Its Gating

- `ProposalGraphPreview.tsx` (`src/features/organizations/components/ai/`) — a
  `"use client"` leaf. It runs the projection in `useMemo`; on failure it renders
  `role="alert"` plus the structured issue messages, never a fabricated graph and
  never a lifecycle action. On success it renders a read-only React Flow
  (`nodesDraggable`, `nodesConnectable`, `elementsSelectable`, `edgesFocusable` all
  false; `deleteKeyCode={null}`; `Controls showInteractive={false}`) over the shared
  `ActionNode`, plus the criticality chip. The caption is required: *"Read-only
  preview of the reviewed proposal. Nothing has been created."* — an APPROVED
  proposal still materializes nothing until 37.11.
- `WorkflowProposalPanel.tsx` mounts it **only** when the proposal and
  `approvedCriticality` are both present and — for a pending proposal — only at
  `state === "AWAITING_APPROVAL"`. So `AWAITING_CRITICALITY` never renders a
  preview: no step is ever presented as definitively non-critical before the human
  has classified it, and the criticality controls sit exactly where they did.
  Terminal outcomes (`APPROVED`/`DECLINED`/`EXPIRED`) render it under the existing
  terminal banner.

## 8. Test Coverage

New and extended suites (Assignment 37.10):

| Suite | Tests | Subject |
| --- | --- | --- |
| `src/tests/workflow/proposal-ui-projection.test.ts` (new) | 33 | layout constants; chain / parallel / fan-out / fan-in / diamond / longest-path; options override; edge order, dedupe, uniqueness; node data incl. schema validity and absent `executionStatus`; determinism under shuffled key and `dependsOn` order; non-mutation; criticality complete/extra/missing/non-boolean; 37.4 delegation incl. issue precedence |
| `src/tests/agent/proposal-graph-preview.test.tsx` (new) | 7 | jsdom/RTL with `@xyflow/react` doubled so the REAL `ActionNode` and chip render: read-only props, node/edge counts, caption, and the failure alerts showing no fabricated state |
| `src/tests/agent/workflow-proposal-panel.test.tsx` (extended) | 19 | preview mounted at `AWAITING_APPROVAL` with proposal + decisions; withheld while criticality is outstanding; withheld when the server refused the binding; mounted for a settled outcome |
| `src/tests/agent/session-read.test.ts` (extended) | 19 | both fields on pending and outcome; withheld on fingerprint mismatch, on a null fingerprint, while criticality is outstanding, and when a step is unclassified (while the review model still reports the partial set); both null when the result does not parse |

Also touched: `jest.setup-env.ts` — `jest-environment-jsdom` does not expose
`TextEncoder`/`TextDecoder`, and `@prisma/client` (reached through `ActionNode` →
`StepExecutionStatus`) constructs them at module load. Node provides both, so they
are copied across **only when absent** (`??=`). That unblocked the first
client-component test to import the shared canvas node renderer.

## 9. Verification Commands and Results

```text
npx jest                                53 suites / 1005 tests  PASS (0 fail)
npx tsc --noEmit                        0 errors                PASS
npx eslint <changed + new files>        0 warnings/errors       PASS
npx prisma validate                     schema valid            PASS
git diff --check                        no whitespace errors    PASS (only autocrlf notices)
```

Non-vacuity mutations (each applied to source, failing tests confirmed, then
restored and re-run green):

| Mutation | Test that failed |
| --- | --- |
| fingerprint comparison in the session read neutered to `true` | 2 fail — `…another revision`, `…never carried a fingerprint` |
| `collectCriticalityIssues` guard disabled in the projection | 7 fail — incomplete-set cases across projection + preview |
| vertical gap dropped from the layout formula | 5 fail — within-layer stacking |

Each mutation made its intended tests fail; all three were restored and the
affected suites re-run green.

## 10. Boundaries — What 37.10 Does NOT Do

- Does not create a `Workflow`, a `Task` or any action execution, and does not
  start, queue or resume anything. **No persistence: no row, no message, no state
  transition, no migration.**
- Does not approve, decline or expire a proposal and changes no lifecycle rule,
  route contract, lock or CAS. 37.6–37.9 behaviour is untouched; their suites are
  unmodified and green.
- Does not add a second validator, a second representation or a second
  persistence path. Validation is 37.4; the exact-set rule is 37.7; the
  fingerprint is 37.7's; the node schema is 37.0B's.
- Does not ask a model for coordinates and does not persist the projection —
  nothing writes `uiNodes` (that is 37.11's canvas-first path).
- Does not resolve **F1** or **F2**. F1's ordering consequence (projection before
  materialization) is already AD-11; the persistence decision itself and
  provenance/name placement remain open for 37.11.
- Does not stage or commit anything.

## 11. Regression Surface and Known Limitations

- **No live-database and no production-build evidence in this change.** The suites
  run at the mocked boundary. `next build` is not part of this repo's verification
  set and was not run; the `node:crypto` hazard it would catch was found by
  inspection and closed by the 37.7 split, and no client import chain now reaches
  a Node builtin. A production build is owed and is named here.
- **The layout box is approximate by design.** `nodeWidth`/`nodeHeight` are
  constants, not measured boxes; `fitView` absorbs the difference. A multi-line
  body can crowd its neighbour at extreme zoom-out. Measuring real boxes would
  need an effect and would trade the purity this phase is about.
- **Preview gating depends on a server-computed field.** If a future change ever
  returns `approvedCriticality` for a proposal it was not validated against, the
  panel would render a wrong-criticality graph — which is exactly why the binding
  is computed and asserted in the route rather than trusted from the row.
- **F1 and F2 are not closed**, and this document is not acceptance of them or of
  37.9.

## 12. Acceptance Checklist and Recommendation

- [x] Pure projection: same proposal in, byte-identical `uiNodes`/`uiEdges` out;
      input never mutated; no I/O, no clock, no model call.
- [x] Layout documented (longest-path layers, sorted within layer) and asserted
      against exported `PROPOSAL_UI_LAYOUT`; no layout library added.
- [x] `uiEdges` derive from `dependsOn` alone, deduplicated, direction recorded in
      the id; no coordinate originates from model output.
- [x] Nodes carry valid `position` and pass `ActionNodeDataSchema`; no
      `executionStatus`, because no run exists.
- [x] Criticality enforced by the existing 37.7 rule with no `?? false`; revision
      binding computed on the server and withheld when it fails.
- [x] Preview is read-only, renders a failure as an error, and states that nothing
      has been created; it is not mounted while criticality is outstanding.
- [x] No `Workflow`, no `Task`, no execution, no persistence, no migration; 37.6–37.9
      unchanged and green.
- [x] 53 suites / 1005 tests pass; tsc, eslint, `prisma validate`, `git diff --check`
      clean; three non-vacuity mutations confirmed and reverted.
- [ ] Independent acceptance (out of this document's hands).
- [ ] Production build (`next build`) verification (owed).

**Recommendation:** record 37.10 in the tracker as `IMPLEMENTED` pending
independent verification; do not mark `VERIFIED`, do not close F1 or F2, and do not
treat this phase as creating anything.
