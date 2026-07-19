// src/lib/ai/agent/services/tool-execution-service.ts

import { AgentToolExecutionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma/extended";
import { JsonValue } from "../agent/types";

export interface CreateToolExecutionInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: JsonValue;
}

export async function createToolExecution({
  sessionId,
  toolCallId,
  toolName,
  args,
}: CreateToolExecutionInput) {
  return prisma.agentToolExecution.create({
    data: {
      sessionId,
      toolCallId,
      toolName,
      args,
      status: AgentToolExecutionStatus.PENDING,
    },
  });
}

export async function getToolExecutionForWorker(
  executionId: string,
) {
  return prisma.agentToolExecution.findUnique({
    where: {
      id: executionId,
    },
    include: {
      session: {
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
      },
    },
  });
}

export async function markToolExecutionRunning(
  executionId: string,
) {
  const { count } = await prisma.agentToolExecution.updateMany({
    where: {
      id: executionId,
      status: AgentToolExecutionStatus.PENDING,
    },
    data: {
      status: AgentToolExecutionStatus.RUNNING,
    },
  });

  return count === 1;
}

export async function completeToolExecution(
  executionId: string,
  result: JsonValue,
) {
  return prisma.agentToolExecution.update({
    where: {
      id: executionId,
    },
    data: {
      status: AgentToolExecutionStatus.COMPLETED,
      result,
      error: null,
    },
  });
}

export async function failToolExecution(
  executionId: string,
  error: unknown,
) {
  return prisma.agentToolExecution.update({
    where: {
      id: executionId,
    },
    data: {
      status: AgentToolExecutionStatus.FAILED,
      error:
        error instanceof Error
          ? error.stack ?? error.message
          : String(error),
    },
  });
}