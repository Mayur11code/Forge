// src/lib/ai/agent/loop-policy.ts
//
// Pure decision logic for the agent loop.
//
// These functions deliberately contain no I/O so the two contracts that
// matter most can be tested without mocking Gemini, Prisma or Redis:
//
//   1. how many model turns are allowed (MAX_AGENT_STEPS boundary)
//   2. how many tool calls a single model turn may produce
//
// Deliberately free of `server-only` so tests can import it directly.

import { MAX_AGENT_STEPS } from "./constants";
import type { AgentTerminalReason, JsonValue } from "./types";

// ---------------------------------------------------------------------------
// Step budget
// ---------------------------------------------------------------------------

export type StepGateDecision =
  | { kind: "RUN" }
  | {
      kind: "STOP_MAX_STEPS";
      currentStep: number;
      maxSteps: number;
    };

/**
 * Contract: `maxSteps` is the maximum number of Gemini model calls.
 *
 * `currentStep` is the value AFTER the durable claim succeeded, so it equals
 * the 1-based index of the model turn that is about to run.
 *
 * The gate is therefore `currentStep > maxSteps`, NOT `>=`.
 *
 * With maxSteps = 5:
 *   currentStep 1..5 -> RUN   (exactly 5 model calls are performed)
 *   currentStep 6     -> STOP (the 6th turn never reaches the model)
 *
 * Using `>=` here would silently cap the loop at maxSteps - 1.
 */
export function decideStepGate(
  currentStep: number,
  maxSteps: number = MAX_AGENT_STEPS,
): StepGateDecision {
  if (currentStep > maxSteps) {
    return { kind: "STOP_MAX_STEPS", currentStep, maxSteps };
  }

  return { kind: "RUN" };
}

// ---------------------------------------------------------------------------
// Tool calls per model turn
// ---------------------------------------------------------------------------

export type ModelToolCall = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

export type ToolCallDecision =
  | { kind: "NO_CALLS" }
  | {
      kind: "ONE_CALL";
      toolName: string;
      toolCallId: string;
      input: JsonValue;
    }
  | {
      kind: "TOO_MANY_CALLS";
      count: number;
    }
  | {
      kind: "EMPTY_TOOL_CLAIMS";
    };

/**
 * The first slice of this agent runs exactly ONE tool per model turn.
 *
 * The architecture is one AgentToolExecution -> one AgentToolExecutionRequested
 * event -> one loop continuation. Batched/parallel tool execution is Phase 2
 * work, so a turn that produces more than one call is a protocol violation.
 *
 * The installed AI SDK (ai@6) exposes `toolChoice` only as
 * `'auto' | 'none' | 'required' | { type: 'tool', toolName }` and has no
 * `parallelToolCalls` flag, so the constraint cannot be pushed down to the
 * provider. It is enforced here, and reinforced by the system prompt.
 *
 * `TOO_MANY_CALLS` is returned WITHOUT a usable call on purpose: the caller
 * must not persist an assistant message whose tool calls would never receive
 * matching tool results, which would leave malformed message history.
 */
export function decideToolCalls(
  toolCalls: readonly ModelToolCall[],
): ToolCallDecision {
  if (toolCalls.length === 0) {
    return { kind: "NO_CALLS" };
  }

  if (toolCalls.length > 1) {
    return { kind: "TOO_MANY_CALLS", count: toolCalls.length };
  }

  const [call] = toolCalls;

  if (!call) {
    return { kind: "EMPTY_TOOL_CLAIMS" };
  }

  return {
    kind: "ONE_CALL",
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    input: call.input as JsonValue,
  };
}

export function terminalReasonForToolCallDecision(
  decision: ToolCallDecision,
): Extract<
  AgentTerminalReason,
  "MULTIPLE_TOOL_CALLS" | "NO_TOOL_CALL"
> | null {
  switch (decision.kind) {
    case "TOO_MANY_CALLS":
      return "MULTIPLE_TOOL_CALLS";
    case "EMPTY_TOOL_CLAIMS":
      return "NO_TOOL_CALL";
    default:
      return null;
  }
}
