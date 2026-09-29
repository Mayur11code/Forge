// src/lib/ai/agent/services/confirmation-service.ts
//
// Shared load-and-authorize for the confirm/cancel endpoints.
//
// The security rules live here rather than in the route handlers so both
// actions enforce them identically, and so the rules are testable without
// standing up a Next request.
//
// Trust boundary, in order:
//   1. Authentication  - handled by the route (`auth()`), 401.
//   2. Ownership       - the session must belong to the caller, 404.
//   3. Binding         - the execution must belong to THAT session, 404.
//   4. State           - what the execution's current status makes possible.
//   5. Transition      - a compare-and-set on the execution's current state.
//
// Steps 2 and 3 are the security boundary and live here. Steps 4 and 5 are the
// behavioural decision, factored into `decideConfirmation` so both endpoints
// resolve an identical (status, action) pair the same way.
//
// Note the ordering: the execution's own state is consulted BEFORE session
// liveness. Once an execution has settled, its outcome no longer depends on the
// session still being alive, so masking that with a generic SESSION_NOT_RUNNING
// would make a repeated confirm report a problem that does not exist.
//
// Nothing after step 1 is allowed to read identity from the request body. The
// endpoints take NO body: a confirm/cancel carries only path ids and can
// therefore never be used to smuggle new tool arguments past review.

import {
  AgentSessionStatus,
  AgentToolExecutionStatus,
} from "@prisma/client";

import { getAgentSessionForUser } from "../session-service";
import { getToolExecutionInSession } from "./tool-execution-service";

export type ConfirmationTarget =
  | {
      ok: true;
      session: {
        id: string;
        orgId: string;
        status: AgentSessionStatus;
        currentStep: number;
      };
      execution: {
        id: string;
        toolCallId: string;
        toolName: string;
        status: AgentToolExecutionStatus;
        expiresAt: Date | null;
      };
    }
  | {
      ok: false;
      httpStatus: 404 | 409;
      code: string;
      error: string;
    };

/**
 * Resolve a (session, execution) pair the caller is allowed to act on.
 *
 * This function decides ONLY reachability. Whether the requested action is
 * still possible is `decideConfirmation`'s job, so that a settled execution
 * still reports its real state instead of being hidden behind a session
 * liveness error.
 *
 * 404 covers both "no such session" and "no such execution in this session".
 * They are deliberately indistinguishable: a caller who owns session A must
 * not be able to learn whether an execution id exists under session B.
 */
export async function loadConfirmationTarget({
  sessionId,
  executionId,
  userId,
}: {
  sessionId: string;
  executionId: string;
  userId: string;
}): Promise<ConfirmationTarget> {
  const session = await getAgentSessionForUser({ sessionId, userId });

  if (!session) {
    return {
      ok: false,
      httpStatus: 404,
      code: "NOT_FOUND",
      error: "Not found",
    };
  }

  const execution = await getToolExecutionInSession({
    executionId,
    sessionId,
  });

  if (!execution) {
    return {
      ok: false,
      httpStatus: 404,
      code: "NOT_FOUND",
      error: "Not found",
    };
  }

  return {
    ok: true,
    session: {
      id: session.id,
      orgId: session.orgId,
      status: session.status,
      currentStep: session.currentStep,
    },
    execution: {
      id: execution.id,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      status: execution.status,
      expiresAt: execution.expiresAt,
    },
  };
}

export type ConfirmationAction = "confirm" | "cancel";

export type ConfirmationDecision =
  | {
      /** The caller must attempt the compare-and-set. */
      kind: "TRANSITION";
    }
  | {
      /**
       * The requested outcome already holds, or already failed permanently.
       * Report the real state; do not act.
       */
      kind: "IDEMPOTENT";
    }
  | {
      kind: "CONFLICT";
      httpStatus: 409;
      code: string;
      error: string;
    };

/**
 * Decide what a confirm or cancel may do, given the execution's status and
 * whether the session is still alive.
 *
 * A pure function, so the ordering property that matters is testable without a
 * database: confirming an already-dispatched execution is IDEMPOTENT even when
 * the session has since completed, and cancelling one that is already running
 * is a CONFLICT.
 *
 * Only a PENDING_CONFIRMATION execution is still undecided, and that is the
 * only case where session liveness is consulted - a terminal session must not
 * gain new side effects.
 */
export function decideConfirmation({
  action,
  executionStatus,
  sessionStatus,
}: {
  action: ConfirmationAction;
  executionStatus: AgentToolExecutionStatus;
  sessionStatus: AgentSessionStatus;
}): ConfirmationDecision {
  if (executionStatus === AgentToolExecutionStatus.PENDING_CONFIRMATION) {
    if (sessionStatus !== AgentSessionStatus.RUNNING) {
      return {
        kind: "CONFLICT",
        httpStatus: 409,
        code: "SESSION_NOT_RUNNING",
        error: `Session is ${sessionStatus}.`,
      };
    }

    return { kind: "TRANSITION" };
  }

  // Expired by the approval timeout. This is a settled outcome in exactly the
  // way CANCELLED or COMPLETED is, so both actions are no-ops: a late-arriving
  // user cannot confirm their way out of a deadline, and cannot cancel something
  // the system already closed either. Cancelling reports IDEMPOTENT rather than
  // a conflict because there is nothing left to cancel.
  if (executionStatus === AgentToolExecutionStatus.EXPIRED) {
    return { kind: "IDEMPOTENT" };
  }

  if (action === "cancel") {
    // Cancelling something already dispatched cannot undo a write that is
    // under way or already done.
    if (executionStatus === AgentToolExecutionStatus.CANCELLED) {
      return { kind: "IDEMPOTENT" };
    }

    return {
      kind: "CONFLICT",
      httpStatus: 409,
      code: "NOT_CANCELLABLE",
      error: "Execution is no longer cancellable.",
    };
  }

  // Confirming something already past the gate. CANCELLED is the one direction
  // that can never be confirmed, so it is a conflict rather than a no-op.
  if (executionStatus === AgentToolExecutionStatus.CANCELLED) {
    return {
      kind: "CONFLICT",
      httpStatus: 409,
      code: "ALREADY_CANCELLED",
      error: "Execution was cancelled and cannot be confirmed.",
    };
  }

  return { kind: "IDEMPOTENT" };
}
