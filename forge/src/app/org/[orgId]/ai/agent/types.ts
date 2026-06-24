import type { ModelMessage } from "ai";

export type AgentSessionMessage = ModelMessage;

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

/**
 * The executor receives only a durable database pointer.
 * It must load args/toolCallId from AgentToolExecution,
 * never trust them from a queue payload.
 */
export type AgentToolExecutionEventPayload = {
  sessionId: string;
  executionId: string;
  expectedStep: number;
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