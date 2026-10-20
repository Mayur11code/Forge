// src/app/api/agent/session/[sessionId]/route.ts
//
// Session recovery / read endpoint.
//
// Lets a client reconstruct agent state after a page refresh without relying
// on live Pusher traffic, which is transport-only and lossy by nature.
//
// Authorization: the caller must be authenticated, and the persisted
// AgentSession.userId must match. The session id in the URL is NOT
// authorization; it is only a lookup key. Ownership is enforced by the
// existing session service rather than an inline query.

import { auth } from "@/lib/auth/auth";
import { getAgentSessionForUser } from "@/lib/ai/agent/session-service";
import { getMessages } from "@/lib/ai/agent/services/message-service";
import { findPendingClarification } from "@/lib/ai/agent/services/clarification-service";
import {
  comparePendingProposalRecency,
  proposalFromExecutionResult,
  SETTLED_PROPOSAL_STATES,
} from "@/lib/ai/agent/services/proposal-service";
import { findMaterializedWorkflowIdForSource } from "@/lib/ai/agent/services/proposal-materialization-service";
import { buildProposalReviewModel } from "@/lib/ai/agent/services/proposal-review";
import { validateCriticalityDecisions } from "@/lib/workflow-types/workflow-criticality";
import type { CriticalityDecisions } from "@/lib/workflow-types/workflow-criticality";
import { getToolExecutionsForSession } from "@/lib/ai/agent/services/tool-execution-service";
import { describeToolProposal } from "@/lib/ai/agent/tools/registry";
import { toPublicError } from "@/lib/security/public-error";
import { AgentToolExecutionStatus, AgentProposalState } from "@prisma/client";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

/**
 * Project one proposal execution into the renderable review view, or null when
 * its persisted result is not a valid proposal.
 *
 * The proposal is re-parsed from the durable `result`, so the SAME proposal the
 * decision service would bind an approval to is what the client renders. The name
 * comes from the proposal itself, never the compiler placeholder (F2).
 *
 * Assignment 37.10 adds two read-only fields for the graph preview, both derived
 * from that same re-parsed proposal and both additive:
 *
 *   - `proposal` — the canonical proposal itself. The preview must not
 *     reconstruct a proposal from the review model: the review is a
 *     presentation projection, and rebuilding compiler input from it is exactly
 *     the kind of lossy round trip this endpoint exists to avoid.
 *   - `approvedCriticality` — the human's COMPLETE decision set, present only
 *     when the established 37.7 contract accepts it for THIS proposal AND the
 *     stored revision fingerprint still matches. Revision binding therefore
 *     happens here, on the server, with `node:crypto` available; a browser
 *     cannot recompute the fingerprint and is never asked to. When the check
 *     fails the field is `null`, so the client is handed either a complete,
 *     revision-bound set or nothing at all.
 */
function buildExecutionView(execution: {
  result: unknown;
  criticalityDecisions: unknown;
  clarificationAnswer: unknown;
  expiresAt: Date | null;
  proposalFingerprint: string | null;
}) {
  const proposal = proposalFromExecutionResult(execution.result);

  if (!proposal) {
    return null;
  }

  const approval = validateCriticalityDecisions(
    proposal,
    execution.criticalityDecisions,
  );

  // Bound to this exact revision: `approval.approved.fingerprint` is recomputed
  // server-side from the re-parsed proposal, so a decision recorded against a
  // different revision - or a row that never carried a fingerprint at all - is
  // withheld rather than handed to the preview as if it still applied.
  const approvedCriticality: CriticalityDecisions | null =
    approval.success &&
    execution.proposalFingerprint === approval.approved.fingerprint
      ? { ...approval.approved.decisions }
      : null;

  return {
    proposal,
    approvedCriticality,
    review: buildProposalReviewModel({
      proposal,
      criticality: execution.criticalityDecisions,
      clarification: execution.clarificationAnswer,
      reviewExpiresAt: execution.expiresAt,
    }),
  };
}

/**
 * Stable response shape. Clients should branch on `status` and
 * `terminalReason`, never on the presence of `finalResponse`.
 */
export async function GET(
  _req: Request,
  { params }: RouteContext,
) {
  try {
    const userId = (await auth())?.user?.id;

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = await params;

    if (!sessionId) {
      return Response.json({ error: "Invalid session id" }, { status: 400 });
    }

    const session = await getAgentSessionForUser({ sessionId, userId });

    // Unknown session and someone else's session are deliberately
    // indistinguishable, so the endpoint cannot be used to probe for valid
    // session ids.
    if (!session) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const [messages, toolExecutions] = await Promise.all([
      getMessages(session.id),
      getToolExecutionsForSession(session.id),
    ]);

    // Derived from the transcript, not stored separately. This is what lets a
    // client rebuild a "we asked for this" card after a refresh, with the exact
    // interactionId it must answer.
    const clarification = findPendingClarification(messages);

    // Assignment 37.8: the durable proposal lifecycle, derived from the already
    // fetched execution rows rather than a second query. A proposal parked on a
    // human decision (criticality, then approval) is what tells a refreshed
    // client the session is waiting on it. It is read from persisted state, so
    // it is correct after a restart and does not depend on live Pusher traffic.
    //
    // Ordering is `comparePendingProposalRecency`, the same newest-first,
    // NULL-revisions-last rule `getPendingProposal` pushes into SQL. Sorting by
    // revision alone would let a legacy row that carries no revision surface as
    // the pending proposal instead of the one that superseded it.
    const pendingProposalExecution = toolExecutions
      .filter(
        (execution) =>
          execution.proposalState === AgentProposalState.AWAITING_CRITICALITY ||
          execution.proposalState === AgentProposalState.AWAITING_APPROVAL,
      )
      .sort(comparePendingProposalRecency)[0];

    // Assignment 37.9: the newest proposal whose review is over. A refreshed
    // client must see the outcome (approved / declined / expired) rather than a
    // stale "pending" card, so this too is derived from durable state and not
    // from whether a card was ever rendered live.
    //
    // Assignment 37.11 adds MATERIALIZED to this read set. It is the terminal
    // outcome of an approved proposal that became a Workflow, and a refreshed
    // client must be able to show the created workflow rather than a lingering
    // "approved" banner. MATERIALIZED is deliberately NOT in the persisted
    // `SETTLED_PROPOSAL_STATES` (37.8 wording is about a decision being over, not
    // about a workflow existing), so it is added here, at the read boundary, and
    // nowhere the write paths depend on.
    const reviewedProposalExecution = toolExecutions
      .filter(
        (execution) =>
          execution.proposalState !== null &&
          (SETTLED_PROPOSAL_STATES.includes(execution.proposalState) ||
            execution.proposalState === AgentProposalState.MATERIALIZED),
      )
      .sort(comparePendingProposalRecency)[0];

    const settledProposalExecution = reviewedProposalExecution;

    // Assignment 37.10: the canonical proposal and the revision-bound criticality
    // decision set ride along with each view, so the graph preview is built from
    // the same durable row as the review instead of from presentation fields.
    const pendingView = pendingProposalExecution
      ? buildExecutionView(pendingProposalExecution)
      : null;
    const settledView = settledProposalExecution
      ? buildExecutionView(settledProposalExecution)
      : null;

    // Assignment 37.11: for a MATERIALIZED outcome, resolve the durable
    // `Workflow.id` from provenance, scoped to the authorized organization. This
    // is a read-only lookup - it never creates a workflow and never restarts the
    // agent loop. A MATERIALIZED state with no resolvable workflow reports a null
    // id, so the client is never told a creation succeeded when it did not.
    const settledWorkflowId =
      settledProposalExecution &&
      settledProposalExecution.proposalState === AgentProposalState.MATERIALIZED
        ? await findMaterializedWorkflowIdForSource(
            session.orgId,
            settledProposalExecution.id,
          )
        : null;

    return Response.json(
      {
        sessionId: session.id,
        orgId: session.orgId,
        status: session.status,
        currentStep: session.currentStep,
        finalResponse: session.finalResponse,
        error: session.errorMessage,
        terminalReason: session.terminalReason,
        promptVersion: session.promptVersion,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        clarification: clarification
          ? {
              interactionId: clarification.interactionId,
              correlationId: clarification.correlationId,
              toolName: clarification.toolName,
              step: clarification.step,
              fields: clarification.fields,
            }
          : null,
        /**
         * The proposal a human still has to act on, if any. `state` says which
         * decision is pending; the durable row is the source of truth. `review`
         * is the renderable view of the exact persisted proposal, and is null
         * only when the stored result is not a valid proposal.
         */
        pendingProposal: pendingProposalExecution
          ? {
              interactionId: pendingProposalExecution.id,
              toolName: pendingProposalExecution.toolName,
              state: pendingProposalExecution.proposalState,
              fingerprint: pendingProposalExecution.proposalFingerprint,
              revision: pendingProposalExecution.proposalRevision,
              expiresAt: pendingProposalExecution.expiresAt,
              review: pendingView?.review ?? null,
              // Additive (37.10): null when the result is not a proposal, and
              // `approvedCriticality` is additionally null when the decision set
              // is absent, incomplete, or not bound to this proposal revision.
              proposal: pendingView?.proposal ?? null,
              approvedCriticality: pendingView?.approvedCriticality ?? null,
            }
          : null,
        /**
         * The outcome of the newest reviewed proposal, once the review is over.
         * Deliberately separate from `pendingProposal`: a decided or expired
         * proposal must never be presented as something to act on.
         */
        proposalOutcome: settledProposalExecution
          ? {
              interactionId: settledProposalExecution.id,
              state: settledProposalExecution.proposalState,
              decidedAt:
                settledProposalExecution.expiredAt ??
                settledProposalExecution.updatedAt,
              review: settledView?.review ?? null,
              // Additive (37.10), same rules as `pendingProposal`.
              proposal: settledView?.proposal ?? null,
              approvedCriticality: settledView?.approvedCriticality ?? null,
              // Additive (37.11): the durable `Workflow.id` for a MATERIALIZED
              // outcome, null otherwise (including a MATERIALIZED row whose
              // workflow cannot be resolved in this org - never presented as a
              // successful creation).
              workflowId: settledWorkflowId,
            }
          : null,
        messages: messages.map((message) => ({
          id: message.id,
          step: message.step,
          toolCallId: message.toolCallId,
          message: message.message,
          createdAt: message.createdAt,
        })),
        toolExecutions: toolExecutions.map((execution) => ({
          id: execution.id,
          toolCallId: execution.toolCallId,
          toolName: execution.toolName,
          input: execution.input,
          status: execution.status,
          // S5 (security) — the persisted `error` is untrusted for disclosure
          // purposes, regardless of how it was written. `toPublicError` returns
          // a value ONLY when it matches the application's allowlist of authored
          // user-facing messages; anything else (a database error, a filesystem
          // path, a provider response, a stack) collapses to a generic message.
          error: toPublicError(execution.error),
          confirmedAt: execution.confirmedAt,
          cancelledAt: execution.cancelledAt,
          proposalState: execution.proposalState,
          proposalFingerprint: execution.proposalFingerprint,
          proposalRevision: execution.proposalRevision,
          createdAt: execution.createdAt,
          updatedAt: execution.updatedAt,
          /**
           * Server-rendered description of the PERSISTED arguments, attached
           * only while the proposal is still actionable. This is what lets a
           * client rebuild a pending confirmation card after a refresh instead
           * of showing an approve button for an action it cannot display.
           */
          proposal:
            execution.status ===
            AgentToolExecutionStatus.PENDING_CONFIRMATION
              ? describeToolProposal(execution.toolName, execution.input)
              : null,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[AGENT SESSION GET]", error);

    return Response.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
