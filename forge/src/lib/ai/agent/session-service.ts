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

const sessionSelect = {
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
      status: AgentSessionStatus.WAITING_CONFIRMATION,
    },
    data: {
      status: AgentSessionStatus.CANCELLED,
    },
  });
}