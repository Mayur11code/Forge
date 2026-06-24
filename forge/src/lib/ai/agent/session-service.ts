import "server-only";

import {
  AgentSessionStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma/extended";
import type { AgentSessionMessage } from "./types";

type CreateAgentSessionInput = {
  orgId: string;
  userId: string;
  initialMessage: AgentSessionMessage;
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
  messages: true,
  finalResponse: true,
  errorMessage: true,
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
  initialMessage,
}: CreateAgentSessionInput) {
  return prisma.agentSession.create({
    data: {
      orgId,
      userId,
      status: AgentSessionStatus.RUNNING,
      currentStep: 0,
      messages: [initialMessage] as Prisma.InputJsonValue,
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
 * Internal worker lookup.
 *
 * Queue workers use the session's stored orgId/userId as authority,
 * so they load by id and do not accept those identities from QStash.
 */
export async function getAgentSessionForWorker(sessionId: string) {
  return prisma.agentSession.findUnique({
    where: { id: sessionId },
    select: sessionSelect,
  });
}

/**
 * Append exactly one durable message.
 *
 * We load first because Prisma cannot portably append to a JSON array
 * across databases in the way we need here.
 *
 * Later, the agent session mutex will ensure two workers cannot append
 * concurrently to the same session.
 */
export async function appendAgentSessionMessage(
  sessionId: string,
  message: AgentSessionMessage,
) {
  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId },
    select: {
      messages: true,
      status: true,
    },
  });

  if (!session) {
    throw new Error(`Agent session ${sessionId} not found.`);
  }

  if (session.status !== AgentSessionStatus.RUNNING) {
    throw new Error(
      `Cannot append message to agent session in ${session.status} state.`,
    );
  }

  const currentMessages = Array.isArray(session.messages)
    ? session.messages
    : [];

  return prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      messages: [
        ...currentMessages,
        message,
      ] as Prisma.InputJsonValue,
    },
    select: sessionSelect,
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
    },
  });
}

export async function failAgentSession(
  sessionId: string,
  errorMessage: string,
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