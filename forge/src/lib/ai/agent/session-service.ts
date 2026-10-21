import "server-only";

import {
  AgentSessionStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma/extended";
import { AGENT_PROMPT_VERSION } from "./prompts/system-prompt";
import type { AgentTerminalReason } from "./types";


type CreateAgentSessionInput = {
  orgId: string;
  userId: string;
};


type AgentSessionForOwnerInput = {
  sessionId: string;
  orgId: string;
  userId: string;
};

export const sessionSelect = {
  id: true,
  orgId: true,
  userId: true,
  status: true,
  currentStep: true,
  finalResponse: true,
  errorMessage: true,
  terminalReason: true,
  promptVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AgentSessionSelect;
/**
 * Create a fresh, user-private agent session.
 *
 * The route that calls this must already have verified:
 * - signed-in user
 * - org membership
 * - the trusted orgId
 */
export async function createAgentSession({
  orgId,
  userId,
}: CreateAgentSessionInput) {
  return prisma.agentSession.create({
    data: {
      orgId,
      userId,
      status: AgentSessionStatus.RUNNING,
      currentStep: 0,
      // Stamped at creation from the compiled-in constant, not from a request
      // field. A client cannot claim to be running a different prompt.
      promptVersion: AGENT_PROMPT_VERSION,
    },
    select: sessionSelect,
  });
}

/**
 * User-private lookup.
 *
 * The orgId + userId conditions are deliberate:
 * knowing another sessionId must not reveal that session.
 */
export async function getAgentSessionForOwner({
  sessionId,
  orgId,
  userId,
}: AgentSessionForOwnerInput) {
  return prisma.agentSession.findFirst({
    where: {
      id: sessionId,
      orgId,
      userId,
    },
    select: sessionSelect,
  });
}

/**
 * User-scoped lookup.
 *
 * `getAgentSessionForOwner` is the strictest form: it also pins orgId. This
 * variant exists because the NextAuth session carries only `user.id` and no
 * organization context, so request-time callers (Pusher private-channel auth,
 * session recovery) cannot supply a trusted orgId.
 *
 * The ownership rule is unchanged and still deliberate: the persisted
 * `AgentSession.userId` must equal the authenticated caller. Knowing a
 * sessionId is not authorization.
 */
export async function getAgentSessionForUser({
  sessionId,
  userId,
}: {
  sessionId: string;
  userId: string;
}) {
  return prisma.agentSession.findFirst({
    where: {
      id: sessionId,
      userId,
    },
    select: sessionSelect,
  });
}

/**
 * Internal worker lookup.
 *
 * Queue workers use the session's stored orgId/userId as authority,
 * so they load by id and do not accept those identities from QStash.
 */
export async function getAgentSessionForWorker(sessionId: string) {
  return prisma.agentSession.findUnique({
  where: {
    id: sessionId,
  },
  include: {
  organization: {
    select: {
      id: true,
      name: true,
    },
  },
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
  
},
});
}



/**
 * Advance the durable step counter only if the worker is acting on
 * the session version it expected.
 *
 * `updateMany` gives us an atomic compare-and-swap:
 * - count 1 = this worker advanced the session
 * - count 0 = stale/duplicate event, terminal session, or wrong step
 */
export async function claimNextAgentStep(
  sessionId: string,
  expectedStep: number,
) {
  const result = await prisma.agentSession.updateMany({
    where: {
      id: sessionId,
      status: AgentSessionStatus.RUNNING,
      currentStep: expectedStep,
    },
    data: {
      currentStep: {
        increment: 1,
      },
    },
  });

  return result.count === 1;
}

export async function completeAgentSession(
  sessionId: string,
  finalResponse: string,
) {
  return prisma.agentSession.updateMany({
    where: {
      id: sessionId,
      status: AgentSessionStatus.RUNNING,
    },
    data: {
      status: AgentSessionStatus.COMPLETED,
      finalResponse,
      errorMessage: null,
      terminalReason: null,
    },
  });
}

export async function failAgentSession(
  sessionId: string,
  errorMessage: string,
  terminalReason: AgentTerminalReason = "ERROR",
) {
  return prisma.agentSession.updateMany({
    where: {
      id: sessionId,
      status: {
        in: [
          AgentSessionStatus.RUNNING,
          AgentSessionStatus.WAITING_CONFIRMATION,
        ],
      },
    },
    data: {
      status: AgentSessionStatus.FAILED,
      errorMessage,
      terminalReason,
    },
  });
}

/**
 * Terminate a session that is out of model-turn budget.
 *
 * Kept separate from `failAgentSession` so the reason is impossible to forget
 * and cannot be confused with an unexpected error. `finalResponse` is left
 * null: the run produced no final answer, and claiming otherwise is exactly
 * the DB/wire contradiction this replaces.
 */
export async function terminateAgentSessionForMaxSteps(
  sessionId: string,
  { maxSteps, currentStep }: { maxSteps: number; currentStep: number },
) {
  return prisma.agentSession.updateMany({
    where: {
      id: sessionId,
      status: AgentSessionStatus.RUNNING,
    },
    data: {
      status: AgentSessionStatus.FAILED,
      terminalReason: "MAX_STEPS_EXCEEDED" satisfies AgentTerminalReason,
      errorMessage: `Agent loop stopped: exceeded the maximum of ${maxSteps} model turns (last step ${currentStep}).`,
      finalResponse: null,
    },
  });
}

export async function cancelAgentSession(
  sessionId: string,
  orgId: string,
  userId: string,
) {
  return prisma.agentSession.updateMany({
    where: {
      id: sessionId,
      orgId,
      userId,
      // Assignment 37.14 (AD-P7): a human-wait session is now reachable as
      // WAITING_CONFIRMATION, and a session that parked before this status was
      // written is still RUNNING. Both are legitimately cancellable, so the
      // guard accepts either rather than filtering on a single state. Terminal
      // states (COMPLETED/FAILED/CANCELLED) remain unmatched, so a cancel can
      // never resurrect or overwrite an ended session.
      status: {
        in: [
          AgentSessionStatus.RUNNING,
          AgentSessionStatus.WAITING_CONFIRMATION,
        ],
      },
    },
    data: {
      status: AgentSessionStatus.CANCELLED,
    },
  });
}

/**
 * Assignment 37.14 (AD-P7) — durable session-level human-wait.
 *
 * `WAITING_CONFIRMATION` records that the session is parked waiting on a human.
 * It deliberately does NOT say WHICH human decision is pending: clarification is
 * still identified by the persisted `NEEDS_USER_INPUT` tool result, and approval
 * by `AgentToolExecution.status = PENDING_CONFIRMATION` plus the proposal state.
 * The three loops stay distinguishable in those authoritative records; this
 * session status is only the coarse "a human owes this session an answer" marker.
 *
 * The write is a compare-and-swap on the CURRENT state, so it can never move an
 * already-terminal session into a wait, and a duplicate delivery of the same
 * park loses cleanly instead of re-asserting the status.
 */
export async function markAgentSessionWaiting(
  sessionId: string,
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? prisma;

  return client.agentSession.updateMany({
    where: {
      id: sessionId,
      status: AgentSessionStatus.RUNNING,
    },
    data: {
      status: AgentSessionStatus.WAITING_CONFIRMATION,
    },
  });
}

/**
 * Clear the human-wait marker and return the session to RUNNING.
 *
 * Used when the human act that the session was waiting on has been accepted and
 * the loop is either resuming (clarification) or simply no longer blocked
 * (proposal decision/expiry). The CAS only matches a session that is currently
 * WAITING_CONFIRMATION, so:
 *   - a stale or duplicate clear cannot overwrite a newer terminal state, and
 *   - clearing a session that never parked (still RUNNING) is a no-op, which
 *     keeps the transition safe for legacy sessions created before this status
 *     was written.
 *
 * This does NOT itself schedule the loop; callers that must resume (clarification)
 * record their `AGENT_LOOP_REQUESTED` in the same transaction, so the session is
 * RUNNING again by the time the continuation is claimed.
 */
export async function clearAgentSessionWaiting(
  sessionId: string,
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? prisma;

  return client.agentSession.updateMany({
    where: {
      id: sessionId,
      status: AgentSessionStatus.WAITING_CONFIRMATION,
    },
    data: {
      status: AgentSessionStatus.RUNNING,
    },
  });
}

/**
 * Session states from which a human answer or proposal decision may be accepted.
 *
 * A session parked on a human is WAITING_CONFIRMATION (Assignment 37.14, AD-P7).
 * A session created before that status was written, or one whose park landed
 * while the human ingress was already in flight, is still RUNNING. Both are
 * legitimately able to accept the human act, so both are accepted here. Every
 * other state (COMPLETED, FAILED, CANCELLED) is rejected by the callers, which
 * keeps a terminal session from gaining a new side effect.
 */
export function isHumanDecisionAcceptableStatus(
  status: AgentSessionStatus,
): boolean {
  return (
    status === AgentSessionStatus.RUNNING ||
    status === AgentSessionStatus.WAITING_CONFIRMATION
  );
}