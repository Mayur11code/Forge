import type { ModelMessage } from "ai";





export type StoredAgentMessage = {
  role: ModelMessage["role"];
  content: ModelMessage["content"];
};





/**
 * This is all the loop event needs.
 *
 * The worker loads orgId, userId, messages, status, and tool state
 * from AgentSession in the database.
 */
export type AgentLoopEventPayload = {
  sessionId: string;
  expectedStep: number;
};



// src/lib/ai/agent/types.ts

import type { Prisma } from "@prisma/client";

export type JsonValue = Prisma.InputJsonValue;

/**
 * The queue payload is only a durable database pointer.
 * It must never be trusted for identity.
 */
export type AgentToolExecutionEventPayload = {
  sessionId: string;
  executionId: string;
  expectedStep: number;
};

/**
 * TRUSTED execution context handed to every ToolExecutor.
 *
 * Security contract:
 * - `orgId` / `userId` are loaded by tool-worker.ts from the PERSISTED
 *   AgentSession row. They are never read from LLM input and never taken
 *   from the queue payload.
 * - `executionId` is the durable AgentToolExecution id.
 *
 * A tool must use `ctx.orgId` to scope every read and write, and must never
 * accept an orgId (or userId) as a model-controlled input field.
 */
export type ToolExecutionContext = {
  orgId: string;
  userId: string;
  executionId: string;
};

export type AgentStatusEvent =
  | {
      type: "RUNNING";
      message: string;
    }
  | {
      type: "WAITING_CONFIRMATION";
      executionId: string;
      summary: string;
      expiresAt: string;
    }
  | {
      type: "COMPLETED";
      content: string;
    }
  | {
      type: "FAILED";
      message: string;
    };