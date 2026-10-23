import type { ModelMessage } from "ai";

import type { MissingUserInputField } from "./tools/shared-output";





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

/**
 * Machine-readable reason an AgentSession reached a terminal state.
 *
 * Stored in `AgentSession.terminalReason` and published on the wire so that
 * workers, clients and alerting can branch on the cause instead of parsing
 * free-text `errorMessage`.
 */
export type AgentTerminalReason =
  | "MAX_STEPS_EXCEEDED"
  | "MULTIPLE_TOOL_CALLS"
  | "NO_TOOL_CALL"
  | "TOOL_NOT_AVAILABLE"
  | "SESSION_NOT_FOUND"
  | "EMPTY_MODEL_RESPONSE"
  | "ERROR";

export type AgentStatusEvent =
  | {
      type: "RUNNING";
      message: string;
    }
  | {
      /**
       * A write or destructive tool was proposed and is waiting for the user.
       *
       * The loop is halted at this point: no execution is dispatched and no
       * further model call happens until the user confirms or cancels. The
       * agent resumes only when a confirm/cancel request re-drives the loop.
       *
       * `summary` and `fields` are derived server-side from the PERSISTED
       * proposal arguments, so the user approves the concrete action rather
       * than an opaque tool name. They are display-only.
       */
      type: "TOOL_PROPOSED";
      executionId: string;
      toolName: string;
      summary: string;
      fields: { label: string; value: string }[];
    }
  | {
      type: "TOOL_CONFIRMED";
      executionId: string;
      toolName: string;
    }
  | {
      type: "TOOL_CANCELLED";
        executionId: string;
        toolName: string;
      }
  | {
      /**
       * Assignment 37.6: a tool halted the loop to ask the user for a missing
       * required input.
       *
       * Deliberately distinct from the confirmation events: no action was
       * proposed, so there is nothing to approve or reject. The loop is parked
       * - no execution is dispatched and no further model call happens - until
       * an authenticated answer re-drives it through the outbox.
       *
       * `interactionId` is the durable `AgentToolExecution.id` the answer must
       * be bound to; `correlationId` fingerprints the proposal revision the
       * question is about. `fields` are the questions, derived server-side from
       * the persisted tool result like TOOL_PROPOSED's `fields`.
       */
      type: "CLARIFICATION_REQUESTED";
      executionId: string;
      toolName: string;
      interactionId: string;
      correlationId: string;
      fields: MissingUserInputField[];
    }
    | {
        /**
         * The approval window closed before the user decided.
         *
         * Distinct from TOOL_CANCELLED because the user did not decline
         * anything - the system stopped waiting. A client that renders this as a
         * cancellation would tell the user they refused an action they were
         * simply never asked about in time, and would likely offer no way to
         * try again.
         */
        type: "TOOL_EXPIRED";
        executionId: string;
        toolName: string;
      }
    | {
        /** A tool finished. The authoritative result is in session history. */
        type: "TOOL_COMPLETED";
        executionId: string;
        toolName: string;
      }
  | {
      type: "COMPLETED";
      content: string;
    }
  | {
      /**
       * The loop hit MAX_AGENT_STEPS. This is deliberately distinct from
       * COMPLETED: the run did not produce a final answer.
       */
      type: "MAX_STEPS_EXCEEDED";
      reason: Extract<AgentTerminalReason, "MAX_STEPS_EXCEEDED">;
      maxSteps: number;
      currentStep: number;
      message: string;
    }
  | {
      type: "FAILED";
      reason: AgentTerminalReason;
      message: string;
    };