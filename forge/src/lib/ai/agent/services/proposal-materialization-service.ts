// src/lib/ai/agent/services/proposal-materialization-service.ts
//
// ASSIGNMENT 37.11 — PROPOSAL → WORKFLOW MATERIALIZATION.
//
// The one server-side path that turns an approved, durably stored
// `WorkflowProposal` into a persisted Forge `Workflow`. This is MATERIALIZATION
// ONLY: it creates a Workflow record and nothing else. It does not execute the
// workflow, does not create a `WorkflowRun`, does not enqueue a QStash job, and
// does not start or resume the model loop. Dispatching a materialized workflow
// is Assignment 37.12.
//
// Architecture (audit Section 4, Option B):
//
//   - The semantic EXECUTION DEFINITION comes from the canonical proposal
//     compiler (`compileWorkflowProposal`) with the human's criticality applied
//     (`applyCriticalityDecisions`). It is NEVER reconstructed from UI labels or
//     presentation fields: `label` is display text, and the executable identity
//     is `data.actionType` / `steps[ref].action`.
//
//   - The STORED CANVAS GRAPH comes from the exact Assignment 37.10 projection
//     (`projectProposalToUIGraph`). This service does not duplicate, remap or
//     re-implement that projection: there is exactly one proposal→UI algorithm
//     in the codebase, and using a second one here would let the two drift.
//
//   - Both artifacts are derived from ONE re-parsed proposal, so the persisted
//     definition and the persisted UI graph are provably consistent: re-compiling
//     the stored nodes reproduces the stored `dependsOn`.
//
//   - PERSISTENCE reuses the established shared validators
//     (`IncomingNodesSchema` / `IncomingEdgesSchema` from the workflow save
//     boundary) and the org scope from the AUTHORIZED server session. Triggerless
//     storage is deliberate: a proposal carries action steps and no human-approved
//     trigger, so `eventId: null` / `isActive: false` is exactly right (F1).
//
//   - IDENTITY/PROVENANCE (F2): `Workflow.name` is the human-facing name from
//     `proposal.name`; `Workflow.sourceProposalId` is the durable
//     `AgentToolExecution.id`. The compiler's placeholder definition id/name,
//     the session id, and any UI label are NEVER used as provenance.
//
//   - ATOMICITY + IDEMPOTENCY: one transaction creates the Workflow and
//     compare-and-sets the proposal `APPROVED → MATERIALIZED` together. The
//     database's `@unique` on `sourceProposalId` is the final defense against a
//     duplicate materialization across competing callers or processes.
//
// Order of checks mirrors the 37.9 decision service: cheap shape checks, then
// ownership (404) and liveness, then under the session lock re-derive and
// re-verify the persisted proposal before any write.

import "server-only";

import { AgentProposalState, AgentToolExecutionStatus } from "@prisma/client";

import { db } from "@/lib/prisma/db";
import { AGENT_TRANSACTION_OPTIONS } from "@/lib/prisma/transaction-options";
import { projectProposalToUIGraph } from "@/lib/workflow-types/proposal-ui-projection";
import {
  expectValidMaterializationPayload,
  validateWorkflowGraphForPersistence,
} from "./proposal-materialization";

import { withAgentSessionLock } from "../locks";
import { getAgentSessionForUser } from "../session-service";
import { computeProposalCorrelationId } from "../tools/generate-workflow/execute";
import {
  getProposalReviewExecution,
  proposalFromExecutionResult,
  PROPOSAL_TOOL_NAME,
} from "./proposal-service";

export type ProposalMaterializationRequest = {
  sessionId: string;
  userId: string;
  /** The durable `AgentToolExecution.id` of the approved proposal. */
  interactionId: string;
};

export type ProposalMaterializationResult =
  | {
      ok: true;
      sessionId: string;
      /** The persisted `Workflow.id`. The only identity a client should use. */
      workflowId: string;
      /** The proposal state the row now holds (`MATERIALIZED`). */
      state: typeof AgentProposalState.MATERIALIZED;
      /** True when an existing workflow was returned rather than created. */
      idempotent?: boolean;
    }
  | {
      ok: false;
      httpStatus: 400 | 404 | 409;
      code: string;
      error: string;
    };

/** A Prisma unique-constraint violation (P2002) on `sourceProposalId`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Find the Workflow already materialized from one proposal execution, scoped to
 * an organization.
 *
 * The org scope is load-bearing: the provenance key alone must never let one
 * tenant resolve (or be handed) another tenant's workflow. A workflow whose
 * source proposal is in org A is never returned to org B, even though the
 * `sourceProposalId` matches.
 */
async function findMaterializedWorkflow(
  orgId: string,
  executionId: string,
): Promise<string | null> {
  const existing = await db.workflow.findFirst({
    where: { orgId, sourceProposalId: executionId },
    select: { id: true },
  });

  return existing?.id ?? null;
}

/**
 * Materialize an approved proposal as a persisted, inactive Workflow.
 *
 * Order of checks, and why:
 *   1. Cheap shape checks first - no lock for a malformed request.
 *   2. Ownership (404) and liveness (409) before taking a lock; knowing a
 *      session id is not authorization.
 *   3. Under the session lock: load the proposal row, re-derive the proposal
 *      from the PERSISTED result, re-verify the fingerprint, re-validate the
 *      criticality set against that same revision, resolve idempotency and
 *      consistency from durable state, then create + transition atomically.
 *
 * A 404 covers "no such session for this caller" and "no such proposal in this
 * session" indistinguishably, so owning session A never reveals whether a
 * proposal id exists under session B.
 */
export async function materializeProposal({
  sessionId,
  userId,
  interactionId,
}: ProposalMaterializationRequest): Promise<ProposalMaterializationResult> {
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

  // The authorized organization is the PERSISTED session's org - never a
  // client-supplied value. Everything below is scoped to it.
  const orgId = session.orgId;

  // A settled-but-not-running session must still be able to materialize: an
  // approved proposal parks the session, and materialization is the human's
  // explicit follow-up. Only a genuinely terminated/errored session is refused
  // by the ownership lookup upstream. We therefore do NOT require RUNNING here,
  // because an approved proposal's session is parked, not running.
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

    if (
      target.toolName !== PROPOSAL_TOOL_NAME ||
      target.status !== AgentToolExecutionStatus.COMPLETED
    ) {
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

    // Exact-revision binding: re-derive the fingerprint from the PERSISTED
    // proposal and compare it to the stored, backend-owned fingerprint. A
    // NULL stored fingerprint marks a legacy row written before the lifecycle
    // columns existed; there is nothing to compare, and the state CAS below
    // still guards the transition. This mirrors the approval path exactly.
    const fingerprint = computeProposalCorrelationId(proposal);

    if (
      target.proposalFingerprint !== null &&
      target.proposalFingerprint !== fingerprint
    ) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "REVISION_MISMATCH",
        error:
          "The proposal changed since it was approved; reload and retry on the current revision.",
      };
    }

    const state = target.proposalState;

    // The proposal must be APPROVED for a NEW materialization.
    if (state !== AgentProposalState.APPROVED) {
      // Already materialized: resolve the existing workflow idempotently, and
      // refuse to present an inconsistent MATERIALIZED row as a success.
      if (state === AgentProposalState.MATERIALIZED) {
        const existingWorkflowId = await findMaterializedWorkflow(
          orgId,
          interactionId,
        );

        if (!existingWorkflowId) {
          // MATERIALIZED with no matching workflow in this org is a consistency
          // failure. It is never silently recreated: doing so would mask a
          // partial write and could produce a second workflow behind the
          // unique constraint's back (the constraint only holds while the first
          // row still names the source, and SetNull could have severed it).
          return {
            ok: false as const,
            httpStatus: 409 as const,
            code: "MATERIALIZED_WITHOUT_WORKFLOW",
            error:
              "This proposal is marked materialized but its workflow could not be found.",
          };
        }

        return {
          ok: true as const,
          sessionId,
          workflowId: existingWorkflowId,
          state: AgentProposalState.MATERIALIZED,
          idempotent: true,
        };
      }

      if (state === AgentProposalState.DECLINED) {
        return {
          ok: false as const,
          httpStatus: 409 as const,
          code: "PROPOSAL_DECLINED",
          error: "This proposal was declined and cannot be materialized.",
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

      if (state === AgentProposalState.SUPERSEDED) {
        return {
          ok: false as const,
          httpStatus: 409 as const,
          code: "PROPOSAL_SUPERSEDED",
          error: "A newer proposal superseded this one.",
        };
      }

      if (state === AgentProposalState.INVALID) {
        return {
          ok: false as const,
          httpStatus: 409 as const,
          code: "PROPOSAL_INVALID",
          error: "This proposal is invalid and cannot be materialized.",
        };
      }

      // AWAITING_CRITICALITY / AWAITING_APPROVAL / null legacy state: not yet
      // approved. Materialization must never pre-empt the human review.
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "PROPOSAL_NOT_APPROVED",
        error:
          "This proposal has not been approved; approve it before creating a workflow.",
      };
    }

    // APPROVED. A workflow may already exist for this source if a previous
    // attempt committed the create but a caller retried before observing the
    // state transition, or an out-of-band reconciliation partially applied. A
    // matching workflow is the truth: return it and repair the lifecycle with a
    // safe compare-and-set ONLY for this exact transition.
    const existingWorkflowId = await findMaterializedWorkflow(
      orgId,
      interactionId,
    );

    if (existingWorkflowId) {
      await db.$transaction(async (tx) => {
        await tx.agentToolExecution.updateMany({
          where: {
            id: interactionId,
            sessionId,
            proposalState: AgentProposalState.APPROVED,
          },
          data: { proposalState: AgentProposalState.MATERIALIZED },
        });
      }, AGENT_TRANSACTION_OPTIONS);

      return {
        ok: true as const,
        sessionId,
        workflowId: existingWorkflowId,
        state: AgentProposalState.MATERIALIZED,
        idempotent: true,
      };
    }

    // Authoritative criticality: validate the COMPLETE persisted decision set
    // against THIS proposal revision, then apply it to the compiled definition.
    // A missing, extra, incomplete or non-boolean decision fails closed as the
    // 37.7 issue vocabulary; a set bound to a different revision fails as
    // REVISION_MISMATCH.
    const payload = expectValidMaterializationPayload(
      proposal,
      target.criticalityDecisions,
    );

    if (!payload.ok) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: payload.code,
        error: payload.error,
      };
    }

    // Section 3 of the assignment: reuse the 37.10 projection verbatim and the
    // shared persistence validators. A failure here means the proposal passed the
    // compiler but the projected graph did not survive the save boundary - a real
    // incompatibility, surfaced rather than papered over.
    const projection = projectProposalToUIGraph(
      proposal,
      target.criticalityDecisions,
    );

    if (!projection.success) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "PROJECTION_FAILED",
        error: "The proposal could not be projected into an editable graph.",
      };
    }

    const boundary = validateWorkflowGraphForPersistence(
      projection.uiNodes,
      projection.uiEdges,
    );

    if (!boundary.ok) {
      return {
        ok: false as const,
        httpStatus: 409 as const,
        code: "GRAPH_PERSISTENCE_FAILED",
        error: "The projected workflow graph failed validation.",
      };
    }

    const definition = payload.definition;
    const { nodes, edges } = boundary;

    try {
      const workflowId = await db.$transaction(async (tx) => {
        // CAS FIRST, then create. A lost CAS (another caller already advanced
        // the proposal) rolls the transaction back before a workflow exists, so
        // a duplicate can never be left behind. The unique `sourceProposalId`
        // index is the second, database-level defense.
        const transitioned = await tx.agentToolExecution.updateMany({
          where: {
            id: interactionId,
            sessionId,
            proposalState: AgentProposalState.APPROVED,
          },
          data: { proposalState: AgentProposalState.MATERIALIZED },
        });

        if (transitioned.count !== 1) {
          return null;
        }

        const created = await tx.workflow.create({
          data: {
            name: proposal.name,
            description: proposal.description ?? null,
            orgId,
            uiNodes: nodes,
            uiEdges: edges,
            definition,
            // Triggerless by design (F1): a proposal has no human-approved
            // trigger, so the workflow is stored inactive with no event. No
            // synthetic trigger is inserted.
            eventId: null,
            isActive: false,
            sourceProposalId: interactionId,
          },
          select: { id: true },
        });

        return created.id;
      }, AGENT_TRANSACTION_OPTIONS);

      if (workflowId === null) {
        // The CAS lost: another caller materialized concurrently (or the row
        // moved off APPROVED). Resolve the existing workflow idempotently rather
        // than reporting a hard failure.
        const raced = await findMaterializedWorkflow(orgId, interactionId);

        if (raced) {
          return {
            ok: true as const,
            sessionId,
            workflowId: raced,
            state: AgentProposalState.MATERIALIZED,
            idempotent: true,
          };
        }

        return {
          ok: false as const,
          httpStatus: 409 as const,
          code: "PROPOSAL_NOT_APPROVED",
          error:
            "This proposal is no longer approved; reload the session and retry.",
        };
      }

      return {
        ok: true as const,
        sessionId,
        workflowId,
        state: AgentProposalState.MATERIALIZED,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent caller won the unique `sourceProposalId` race. Roll back
        // produced nothing; resolve the winner's workflow.
        const raced = await findMaterializedWorkflow(orgId, interactionId);

        if (raced) {
          return {
            ok: true as const,
            sessionId,
            workflowId: raced,
            state: AgentProposalState.MATERIALIZED,
            idempotent: true,
          };
        }
      }

      throw error;
    }
  });

  if (outcome === null) {
    return {
      ok: false,
      httpStatus: 409,
      code: "SESSION_BUSY",
      error: "This session is busy; retry materialization shortly.",
    };
  }

  return outcome;
}

/**
 * Read-only resolution of the materialized workflow for a source proposal,
 * scoped to an organization. Used by the session-read projection to report the
 * durable `workflowId` for a `MATERIALIZED` outcome without creating anything.
 */
export async function findMaterializedWorkflowIdForSource(
  orgId: string,
  executionId: string,
): Promise<string | null> {
  return findMaterializedWorkflow(orgId, executionId);
}
