// src/lib/ai/agent/services/proposal-decision-service.ts
//
// ASSIGNMENT 37.9 — HUMAN PROPOSAL-REVIEW DECISION SERVICE.
//
// The human side of the final checkpoint: approve or decline a generated
// workflow proposal. This is a SEPARATE ingress from the 35/36 tool-confirmation
// gate, and that separation is the whole reason it exists (owner decision A).
//
// A tool confirmation answers "may this not-yet-run tool execute?" and is tied
// to `AgentToolExecutionStatus.PENDING_CONFIRMATION`. A proposal has already
// run: the `generateWorkflow` execution is COMPLETED, the model produced a
// proposal, and the loop parked. Confirming it through the tool gate would queue
// a SECOND execution of a tool that already produced its result, so the two
// questions are answered on different endpoints and neither mechanism is bent to
// serve the other.
//
// What IS reused is the shape of the existing criticality ingress, because the
// properties are the same and are worth having by construction:
//   - authenticated caller, ownership from the persisted session (a session id
//     in the URL is a lookup key, never authorization);
//   - a cheap 404 / 409 before any lock is taken;
//   - the session lock, so a decision cannot race a worker or a second decision;
//   - a proposal recovered from the PERSISTED, successful tool result and
//     re-validated server-side, never from the request;
//   - a backend-recomputed fingerprint that binds the decision to the exact
//     revision the human reviewed;
//   - a compare-and-set transition that loses cleanly, plus a transcript-
//     recorded audit line that commits with it.
//
// There is intentionally NO outbox event. Approving does not re-enter the model
// (deferred trigger); materializing the approved proposal is 37.11.

import { AgentProposalState, AgentToolExecutionStatus } from "@prisma/client";

import { db } from "@/lib/prisma/db";
import { AGENT_TRANSACTION_OPTIONS } from "@/lib/prisma/transaction-options";

import { withAgentSessionLock } from "../locks";
import { getAgentSessionForUser, clearAgentSessionWaiting, isHumanDecisionAcceptableStatus } from "../session-service";
import { computeProposalCorrelationId } from "../tools/generate-workflow/execute";
import { createMessage } from "./message-service";
import {
  getProposalReviewExecution,
  proposalFromExecutionResult,
  recordProposalDecision,
  type ProposalDecisionState,
} from "./proposal-service";

export type ProposalDecisionRequest = {
  sessionId: string;
  userId: string;
  /** The durable `AgentToolExecution.id` of the proposal being decided. */
  interactionId: string;
  /** `APPROVED` or `DECLINED` - the two terminal human outcomes. */
  decision: ProposalDecisionState;
};

export type ProposalDecisionResult =
  | {
      ok: true;
      sessionId: string;
      step: number;
      /** The proposal state the row now holds. */
      state: AgentProposalState;
      /** True when an identical decision was already recorded. */
      idempotent?: boolean;
    }
  | {
      ok: false;
      httpStatus: 400 | 404 | 409;
      code: string;
      error: string;
    };

/**
 * Versioned marker making a recorded approval/decline self-describing.
 *
 * Deliberately distinct from the criticality marker (`forge:criticality-decision:v1`)
 * and the clarification-answer text. All three share the `AgentMessage.toolCallId`
 * tag, so they can be told apart only by their own content; a shared marker would
 * let an approval be read back as a criticality decision, or vice versa.
 */
export const PROPOSAL_DECISION_MARKER = "forge:proposal-decision:v1";

/**
 * Canonical, deterministic audit content.
 *
 * The fingerprint binds the record to the exact proposal revision the decision
 * was made against, and the revision makes a supersession of the record legible
 * when read by a human. This is an audit line, not an idempotency key - the
 * durable row state is what the service compares against.
 */
function buildDecisionContent(
  interactionId: string,
  proposalFingerprint: string,
  revision: number | null,
  decision: ProposalDecisionState,
): string {
  return [
    PROPOSAL_DECISION_MARKER,
    `interaction: ${interactionId}`,
    `proposal: ${proposalFingerprint}`,
    `revision: ${revision ?? "none"}`,
    `decision: ${decision === AgentProposalState.APPROVED ? "approved" : "declined"}`,
  ].join("\n");
}

/**
 * Submit the human's approve/decline for one proposal.
 *
 * Order of checks, and why:
 *   1. Cheap shape check first - no lock for a malformed request.
 *   2. Ownership (404) and liveness (409) before taking a lock; knowing a
 *      session id is not authorization.
 *   3. Under the session lock: load the proposal row, re-validate the persisted
 *      proposal, verify the fingerprint, resolve idempotency/conflict from the
 *      durable state, then compare-and-set and record.
 *
 * A 404 covers "no such session for this caller" and "no such proposal in this
 * session" indistinguishably, so owning session A never reveals whether a
 * proposal id exists under session B.
 */
export async function submitProposalDecision({
  sessionId,
  userId,
  interactionId,
  decision,
}: ProposalDecisionRequest): Promise<ProposalDecisionResult> {
  if (
    decision !== AgentProposalState.APPROVED &&
    decision !== AgentProposalState.DECLINED
  ) {
    return {
      ok: false,
      httpStatus: 400,
      code: "INVALID_REQUEST",
      error: "The decision must be APPROVED or DECLINED.",
    };
  }

  if (typeof interactionId !== "string" || interactionId.trim() === "") {
    return {
      ok: false,
      httpStatus: 400,
      code: "INVALID_REQUEST",
      error: "A non-empty interactionId is required.",
    };
  }

  const session = await getAgentSessionForUser({ sessionId, userId });

  if (!session) {
    return {
      ok: false,
      httpStatus: 404,
      code: "INTERACTION_NOT_FOUND",
      error: "Not found.",
    };
  }

  if (!isHumanDecisionAcceptableStatus(session.status)) {
    return {
      ok: false,
      httpStatus: 409,
      code: "SESSION_NOT_RUNNING",
      error: "This session is not running and cannot accept a decision.",
    };
  }

  const outcome = await withAgentSessionLock(sessionId, async () => {
    const target = await getProposalReviewExecution({
      sessionId,
      executionId: interactionId,
    });

    if (!target) {
      return {
        ok: false as const,
        httpStatus: 404 as const,
        code: "INTERACTION_NOT_FOUND",
        error: "Not found.",
      };
    }

    // The execution must have actually produced a proposal. A COMPLETED row that
    // produced a clarification or an invalid-input result is not a decision
    // subject, and neither is a row that is still running.
    if (target.status !== AgentToolExecutionStatus.COMPLETED) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "NOT_A_PROPOSAL",
        error: "This interaction did not produce a workflow proposal.",
      };
    }

    const proposal = proposalFromExecutionResult(target.result);

    if (!proposal) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "NOT_A_PROPOSAL",
        error: "This interaction did not produce a workflow proposal.",
      };
    }

    const fingerprint = computeProposalCorrelationId(proposal);

    // Revision binding. The stored fingerprint is backend-owned; when it is
    // present it must equal the one recomputed from the persisted proposal. A
    // proposal whose result was changed after it was parked therefore cannot be
    // approved under the decision that was reviewed. A NULL stored fingerprint
    // marks a legacy row written before the lifecycle columns existed; there is
    // nothing to compare, and the state CAS below still guards the transition.
    if (
      target.proposalFingerprint !== null &&
      target.proposalFingerprint !== fingerprint
    ) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "REVISION_MISMATCH",
        error:
          "The proposal changed since it was parked; reload and decide on the current revision.",
      };
    }

    const state = target.proposalState;

    // An identical repeat is a no-op success, not a second write.
    if (state === decision) {
      return {
        ok: true as const,
        sessionId,
        step: session.currentStep,
        state,
        idempotent: true,
      };
    }

    // Anything that is not AWAITING_APPROVAL is a conflict. The codes are chosen
    // so each reason is legible rather than collapsed into one generic 409.
    if (state !== AgentProposalState.AWAITING_APPROVAL) {
      if (state === AgentProposalState.AWAITING_CRITICALITY) {
        return {
          ok: false as const,
          httpStatus: 409 as const,
          code: "NEEDS_CRITICALITY",
          error: "Criticality must be decided before the proposal can be approved.",
        };
      }

      if (state === AgentProposalState.EXPIRED) {
        return {
          ok: false as const,
          httpStatus: 409 as const,
          code: "PROPOSAL_EXPIRED",
          error: "The review window for this proposal has closed.",
        };
      }

      if (
        state === AgentProposalState.APPROVED ||
        state === AgentProposalState.DECLINED
      ) {
        return {
          ok: false as const,
          httpStatus: 409 as const,
          code: "PROPOSAL_ALREADY_DECIDED",
          error: "This proposal already has a different decision recorded.",
        };
      }

      // SUPERSEDED, MATERIALIZED, INVALID, or a null legacy state that never
      // reached approval.
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "PROPOSAL_NOT_AWAITING_APPROVAL",
        error:
          "This proposal is no longer awaiting approval; reload the session " +
          "and decide on the current proposal.",
      };
    }

    const content = buildDecisionContent(
      interactionId,
      fingerprint,
      target.proposalRevision,
      decision,
    );

    // CAS first, audit line second, one transaction. A lost CAS therefore
    // commits no transcript record, so the transcript can never claim a decision
    // the durable row did not take.
    const applied = await db.$transaction(async (tx) => {
      const recorded = await recordProposalDecision(tx, {
        executionId: interactionId,
        sessionId,
        decision,
      });

      if (!recorded) {
        return false;
      }

      await createMessage({
        sessionId,
        step: session.currentStep,
        toolCallId: interactionId,
        message: { role: "user", content },
        tx,
      });

      // Assignment 37.14 (AD-P7): the recorded decision releases the human-wait
      // marker in the SAME transaction as the CAS and the audit line, so the
      // session is no longer WAITING_CONFIRMATION exactly when the proposal
      // leaves AWAITING_APPROVAL. This does NOT re-enter the model: approval and
      // decline are terminal human outcomes, and the loop is resumed only by a
      // clarification answer or the deferred materialization (37.11). The clear
      // is a no-op for a legacy RUNNING session, whose status was never parked.
      await clearAgentSessionWaiting(sessionId, tx);

      return true;
    }, AGENT_TRANSACTION_OPTIONS);

    if (!applied) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "PROPOSAL_NOT_APPLIED",
        error:
          "The proposal is no longer awaiting approval; reload the session " +
          "and decide on the current proposal.",
      };
    }

    return {
      ok: true as const,
      sessionId,
      step: session.currentStep,
      state: decision,
    };
  });

  if (outcome === null) {
    return {
      ok: false,
      httpStatus: 409,
      code: "SESSION_BUSY",
      error: "This session is busy; retry the decision shortly.",
    };
  }

  return outcome;
}
