// src/lib/ai/agent/services/proposal-service.ts
//
// Assignment 37.8 (F4) — the durable proposal lifecycle.
//
// F4's open fork was: reuse/extend `AgentToolExecution` (Option A) or introduce a
// dedicated `WorkflowProposal` model (Option B). Option A was chosen and is
// recorded in the plan and the Decision Log. This module is its implementation:
// the execution row already holds the immutable proposal (`input`), the approval
// audit trail, and the unique `toolCallId` that clarification and criticality
// bind to, so the lifecycle state lives on the SAME row rather than in a second
// table with its own state machine to keep in sync.
//
// Two invariants this module exists to protect:
//
//   1. Execution status and proposal state are DIFFERENT things.
//      `AgentToolExecutionStatus` answers "did the tool run?". `AgentProposalState`
//      answers "where is the human decision about the proposal?". A successful
//      `generateWorkflow` leaves its execution COMPLETED and parked at
//      AWAITING_CRITICALITY - a single enum could not express that honestly.
//
//   2. A parked proposal is durable, not an in-flight guess.
//      The state, the fingerprint, the revision, and the execution result are all
//      committed in the worker's own transaction, so a cold restart can resume the
//      lifecycle from the database alone and never has to parse the transcript to
//      learn what happened.
//
// `proposalRevision` is the 1-based rank of this proposal among its session's
// proposals in deterministic `(createdAt, id)` order. It makes supersession total
// and reproducible after a restart: a newer proposal retires every older one whose
// revision is lower, regardless of wall-clock ties.
//
// A NULL `proposalRevision` marks a legacy row that predates the lifecycle
// columns (or one adopted through the null-state branch of the criticality CAS).
// It is treated as OLDER than every revisioned proposal and never as newer, and
// every supersession sweep and pending lookup here spells that out explicitly:
// in SQL `NULL < n` is UNKNOWN rather than true, so the obvious predicate alone
// would leave a legacy proposal parked beside the one that replaced it.

import "server-only";

import { AgentProposalState, AgentToolExecutionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma/extended";
import {
  WorkflowProposalSchema,
} from "@/lib/workflow-types/workflow-proposal";

import type { AgentOutboxTx } from "../outbox";
import { computeProposalCorrelationId } from "../tools/generate-workflow/execute";
import { isClarificationFailure } from "../tools/shared-output";
import type { JsonValue } from "../types";

/** The one tool whose executions carry a proposal lifecycle. */
export const PROPOSAL_TOOL_NAME = "generateWorkflow";

/**
 * Proposal states that mean "a human still has to act before this proposal can
 * advance". These are the states that make a session legitimately parked, so
 * recovery must never re-drive or fail a session holding one.
 */
export const PENDING_HUMAN_PROPOSAL_STATES: readonly AgentProposalState[] = [
  AgentProposalState.AWAITING_CRITICALITY,
  AgentProposalState.AWAITING_APPROVAL,
];

export type ProposalLifecycle = {
  state: AgentProposalState;
  /** Backend-owned revision fingerprint, or null when the state has none. */
  fingerprint: string | null;
};

/**
 * Classify a completed `generateWorkflow` tool result into a proposal state.
 *
 * Returns null for every other tool and for any result that is not a proposal
 * outcome, so a caller can never accidentally give a non-proposal execution a
 * proposal state. The three outcomes are the ones the executor can produce:
 *
 *   - `ok: true` with a valid proposal  -> VALIDATED/AWAITING_CRITICALITY
 *   - `NEEDS_USER_INPUT` (clarification) -> NEEDS_CLARIFICATION
 *   - `INVALID_INPUT`                    -> INVALID (the model self-corrects)
 *
 * The fingerprint for a valid proposal is computed from the PARSED proposal, the
 * same object the criticality service re-derives from the transcript, so the two
 * always agree on the revision identity.
 */
export function deriveProposalLifecycle(
  toolName: string,
  outputValue: unknown,
): ProposalLifecycle | null {
  if (toolName !== PROPOSAL_TOOL_NAME) {
    return null;
  }

  if (typeof outputValue !== "object" || outputValue === null) {
    return null;
  }

  const value = outputValue as {
    ok?: unknown;
    code?: unknown;
    correlationId?: unknown;
    proposal?: unknown;
  };

  if (isClarificationFailure(value)) {
    return {
      state: AgentProposalState.NEEDS_CLARIFICATION,
      fingerprint:
        typeof value.correlationId === "string" ? value.correlationId : null,
    };
  }

  if (value.ok === true) {
    const parsed = WorkflowProposalSchema.safeParse(value.proposal);

    if (!parsed.success) {
      // A success envelope whose proposal will not parse is not something to
      // guess a state for; leave the lifecycle untouched rather than lie.
      return null;
    }

    return {
      state: AgentProposalState.AWAITING_CRITICALITY,
      fingerprint: computeProposalCorrelationId(parsed.data),
    };
  }

  if (value.ok === false && value.code === "INVALID_INPUT") {
    return { state: AgentProposalState.INVALID, fingerprint: null };
  }

  return null;
}

/** The fields of an execution this module needs to order proposals by. */
export type ProposalIdentity = {
  id: string;
  createdAt: Date;
};

function compareIdentity(a: ProposalIdentity, b: ProposalIdentity): number {
  const aTime = a.createdAt.getTime();
  const bTime = b.createdAt.getTime();

  if (aTime !== bTime) {
    return aTime - bTime;
  }

  if (a.id === b.id) {
    return 0;
  }

  return a.id < b.id ? -1 : 1;
}

/**
 * 1-based rank of `executionId` among `rows`, in `(createdAt, id)` order.
 *
 * Total and deterministic on purpose: two proposals created in the same
 * millisecond still order by id, so supersession is reproducible after a restart
 * and never depends on read order. When the execution is not yet in `rows` (it
 * is being persisted right now), it is ranked after everything already known.
 */
export function computeProposalRevision(
  rows: readonly ProposalIdentity[],
  executionId: string,
): number {
  const ordered = [...rows].sort(compareIdentity);
  const index = ordered.findIndex((row) => row.id === executionId);

  return index >= 0 ? index + 1 : ordered.length + 1;
}

/** Load the proposal identities for a session, for revision ranking. */
export async function findProposalIdentities(
  sessionId: string,
): Promise<ProposalIdentity[]> {
  const rows = await prisma.agentToolExecution.findMany({
    where: { sessionId, toolName: PROPOSAL_TOOL_NAME },
    select: { id: true, createdAt: true },
  });

  return rows.map((row) => ({ id: row.id, createdAt: row.createdAt }));
}

export type PersistExecutionOutcomeInput = {
  executionId: string;
  /** The durable tool result, exactly as it was persisted to the transcript. */
  result: JsonValue;
  lifecycle: ProposalLifecycle | null;
  /** Required when `lifecycle` is a valid proposal; the 1-based rank. */
  revision: number | null;
};

/**
 * Durable write of an execution's outcome, in the caller's transaction.
 *
 * Compare-and-set from RUNNING, and the SAME write that lands the terminal
 * COMPLETED status. Folding the status into this CAS is what closes the crash
 * window the audit found (F-1): `status = COMPLETED` and the durable result can
 * no longer commit in two separate steps, so there is no state in which a
 * finished, parked proposal is left RUNNING for the reaper to cancel. A
 * duplicate delivery that lost the claim can never overwrite a real outcome, and
 * the result, the lifecycle state and the terminal status commit atomically with
 * the transcript message and the (optional) continuation intent.
 */
export async function persistExecutionOutcome(
  tx: AgentOutboxTx,
  {
    executionId,
    result,
    lifecycle,
    revision,
  }: PersistExecutionOutcomeInput,
): Promise<boolean> {
  const { count } = await tx.agentToolExecution.updateMany({
    where: {
      id: executionId,
      status: AgentToolExecutionStatus.RUNNING,
    },
    data: {
      status: AgentToolExecutionStatus.COMPLETED,
      error: null,
      result,
      proposalState: lifecycle?.state ?? null,
      proposalFingerprint: lifecycle?.fingerprint ?? null,
      proposalRevision: lifecycle ? revision : null,
    },
  });

  return count === 1;
}

/**
 * Pending rows that are DEFINITIVELY older than `revision`, for the sweep below.
 *
 * A lower revision is the ordinary case. A NULL revision is the legacy case: the
 * row predates the lifecycle columns, or was adopted through the null-state
 * branch of the criticality CAS, and it is older than anything carrying a
 * revision - a revision is only ever assigned to a proposal created after the
 * columns existed. Listing `{ proposalRevision: null }` explicitly is the whole
 * point of this predicate: in SQL `NULL < n` evaluates to UNKNOWN, never true,
 * so a plain `proposalRevision < n` sweep silently skips every legacy row and
 * leaves it parked beside the proposal that superseded it.
 *
 * `id: { not: executionId }` keeps the sweep off the row being reconciled. A
 * revisioned row never matched itself anyway (`n < n` is false), but a legacy
 * row DOES match `{ proposalRevision: null }`, and retiring the proposal this
 * function is about to declare active would be self-defeating.
 */
function olderPendingProposals(
  sessionId: string,
  executionId: string,
  revision: number,
) {
  return {
    sessionId,
    proposalState: { in: [...PENDING_HUMAN_PROPOSAL_STATES] },
    id: { not: executionId },
    OR: [
      { proposalRevision: { lt: revision } },
      { proposalRevision: null },
    ],
  };
}

/**
 * Enforce the single-pending-proposal invariant for a session.
 *
 * Called in the same transaction as the durable outcome, under the session lock,
 * when a proposal parks at AWAITING_CRITICALITY. It handles BOTH orderings of
 * two proposals, which is the out-of-order case the audit found (F-2):
 *
 *   - the normal order: this proposal is newer, so every older pending proposal
 *     (revision < this, or no revision at all) is retired to SUPERSEDED; and
 *   - the out-of-order case: a NEWER proposal already parked (revision > this),
 *     so THIS one arrived late and retires ITSELF to SUPERSEDED.
 *
 * The older-row sweep runs in BOTH orderings. The newer proposal's own sweep
 * could not have retired a legacy row (see `olderPendingProposals`), so leaving
 * it out of the out-of-order path would put a stale legacy proposal back on the
 * human's desk next to its successor.
 *
 * The second branch is the one `supersedeEarlierProposals` could not express.
 * Without it, two executions of the same session completing out of order would
 * leave two proposals a human could act on. The revision is a total order over
 * `(createdAt, id)`, so "newer" is unambiguous regardless of completion order.
 *
 * Returns "superseded" when this proposal retired itself. The caller treats
 * that exactly like a park: the loop stays halted, because a newer proposal is
 * already the one pending a decision.
 */
export async function reconcileActiveProposal(
  tx: AgentOutboxTx,
  {
    sessionId,
    executionId,
    revision,
  }: {
    sessionId: string;
    executionId: string;
    revision: number;
  },
): Promise<"active" | "superseded"> {
  await tx.agentToolExecution.updateMany({
    where: olderPendingProposals(sessionId, executionId, revision),
    data: { proposalState: AgentProposalState.SUPERSEDED },
  });

  // A legacy row can never be the NEWER one: it carries no revision, so it
  // cannot exceed this proposal's. It therefore never forces self-retirement.
  const newerPending = await tx.agentToolExecution.count({
    where: {
      sessionId,
      proposalState: { in: [...PENDING_HUMAN_PROPOSAL_STATES] },
      proposalRevision: { gt: revision },
    },
  });

  if (newerPending > 0) {
    const { count } = await tx.agentToolExecution.updateMany({
      where: {
        id: executionId,
        proposalState: { in: [...PENDING_HUMAN_PROPOSAL_STATES] },
      },
      data: { proposalState: AgentProposalState.SUPERSEDED },
    });

    return count === 1 ? "superseded" : "active";
  }

  return "active";
}

/**
 * Newest-pending-first ordering for proposal rows, in memory.
 *
 * The SQL twin of this is the `orderBy` in `getPendingProposal`; the session
 * read route sorts rows it already has in memory with this comparator so both
 * paths answer "what is pending a human?" the same way.
 *
 * A NULL revision marks a legacy row that predates the lifecycle columns, so it
 * is OLDER than anything carrying a revision and sorts LAST. That is the
 * explicit half of the fix: PostgreSQL's default for `ORDER BY x DESC` is
 * NULLS FIRST, which would surface the stale legacy row as "the" pending
 * proposal. `createdAt`, then `id`, break ties so the winner never depends on
 * scan order.
 */
export function comparePendingProposalRecency(
  a: { proposalRevision: number | null; createdAt: Date; id: string },
  b: { proposalRevision: number | null; createdAt: Date; id: string },
): number {
  if (a.proposalRevision !== b.proposalRevision) {
    if (a.proposalRevision === null) return 1;
    if (b.proposalRevision === null) return -1;

    return b.proposalRevision - a.proposalRevision;
  }

  const aTime = a.createdAt.getTime();
  const bTime = b.createdAt.getTime();

  if (aTime !== bTime) {
    return bTime - aTime;
  }

  if (a.id === b.id) {
    return 0;
  }

  return a.id < b.id ? 1 : -1;
}

/** The pending proposal, as the read API exposes it. */
export type PendingProposal = {
  interactionId: string;
  toolName: string;
  state: AgentProposalState;
  fingerprint: string | null;
  revision: number | null;
  criticalityDecisions: unknown;
  clarificationAnswer: unknown;
};

/**
 * The newest proposal in a session that is still waiting on a human.
 *
 * Read straight from the execution rows, not the transcript: this is the whole
 * point of the durable lifecycle, a restart must be able to answer "what is
 * parked?" without replaying messages.
 */
export async function getPendingProposal(
  sessionId: string,
): Promise<PendingProposal | null> {
  const row = await prisma.agentToolExecution.findFirst({
    where: {
      sessionId,
      proposalState: { in: [...PENDING_HUMAN_PROPOSAL_STATES] },
    },
    // Newest first, and NULL revisions are placed EXPLICITLY last. Relying on
    // `ORDER BY proposalRevision DESC` alone inherits PostgreSQL's NULLS FIRST
    // default and inverts the answer exactly when a legacy row is present -
    // the stale proposal would outrank the one that superseded it.
    // `createdAt` then `id` break ties deterministically (mirrored by
    // `comparePendingProposalRecency`).
    orderBy: [
      { proposalRevision: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    select: {
      id: true,
      toolName: true,
      proposalState: true,
      proposalFingerprint: true,
      proposalRevision: true,
      criticalityDecisions: true,
      clarificationAnswer: true,
    },
  });

  if (!row || row.proposalState === null) {
    return null;
  }

  return {
    interactionId: row.id,
    toolName: row.toolName,
    state: row.proposalState,
    fingerprint: row.proposalFingerprint,
    revision: row.proposalRevision,
    criticalityDecisions: row.criticalityDecisions,
    clarificationAnswer: row.clarificationAnswer,
  };
}

/** Cheap liveness probe for the recovery sweeps. */
export async function hasPendingProposal(sessionId: string): Promise<boolean> {
  const count = await prisma.agentToolExecution.count({
    where: {
      sessionId,
      proposalState: { in: [...PENDING_HUMAN_PROPOSAL_STATES] },
    },
  });

  return count > 0;
}

/**
 * Record the human's criticality decision durably and advance the proposal.
 *
 * Compare-and-set from AWAITING_CRITICALITY so a repeat or a stale decision
 * cannot move a proposal that has already advanced. Returns false when the CAS
 * was lost - the signal the caller must act on rather than ignore.
 *
 * A NULL proposal state is also adopted. A proposal whose execution row predates
 * the lifecycle columns (or was written by an older build) has no state to
 * compare against, and refusing every such decision would make an otherwise
 * valid proposal undecidable. Adopting it advances it into the lifecycle
 * instead. A proposal that has already ADVANCED (AWAITING_APPROVAL, SUPERSEDED,
 * ...) is still refused: that is a genuine lost CAS, not a legacy row.
 */
export async function recordCriticalityDecision(
  tx: AgentOutboxTx,
  {
    executionId,
    sessionId,
    decisions,
  }: {
    executionId: string;
    sessionId: string;
    decisions: Record<string, boolean>;
  },
): Promise<boolean> {
  const { count } = await tx.agentToolExecution.updateMany({
    where: {
      id: executionId,
      sessionId,
      OR: [
        { proposalState: AgentProposalState.AWAITING_CRITICALITY },
        { proposalState: null },
      ],
    },
    data: {
      criticalityDecisions: decisions,
      proposalState: AgentProposalState.AWAITING_APPROVAL,
    },
  });

  return count === 1;
}

/**
 * Record the human's clarification answer durably and advance the proposal.
 *
 * CAS from NEEDS_CLARIFICATION so an answer cannot advance a proposal that is no
 * longer waiting on one.
 */
export async function recordClarificationAnswer(
  tx: AgentOutboxTx,
  {
    executionId,
    sessionId,
    answers,
  }: {
    executionId: string;
    sessionId: string;
    answers: Record<string, unknown>;
  },
): Promise<boolean> {
  const { count } = await tx.agentToolExecution.updateMany({
    where: {
      id: executionId,
      sessionId,
      proposalState: AgentProposalState.NEEDS_CLARIFICATION,
    },
    data: {
      clarificationAnswer: answers as JsonValue,
      proposalState: AgentProposalState.CLARIFICATION_ACCEPTED,
    },
  });

  return count === 1;
}
