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

// ---------------------------------------------------------------------------
// Content-free model turns
// ---------------------------------------------------------------------------

export type EmptyTurnDecision =
  | { kind: "HAS_CONTENT" }
  | {
      kind: "EMPTY";
      stopReason: string;
      message: string;
    };

/**
 * A model turn that produced NEITHER a tool call NOR any text is not a
 * completion. It is a turn that said nothing.
 *
 * WHY THIS NEEDS A DECISION
 * -------------------------
 * The provider can return a response with no usable content: the model spent
 * its whole output budget on reasoning, or the turn was stopped by a filter.
 * The AI SDK reports that faithfully - `text` is the empty string and
 * `response.messages` is empty - and it is not an error, so nothing throws.
 *
 * Treating that as a completion is the silent no-op this function exists to
 * prevent. The session would be marked COMPLETED with an empty final answer:
 * no proposal, no error, no explanation, and a user looking at a "completed"
 * session that contains nothing at all. The live capstone hit exactly this -
 * the session read `status=COMPLETED`, `finalResponse=""`, one transcript
 * message (the user's own) and no tool execution.
 *
 * WHY IT IS A FAILURE AND NOT A RETRY
 * -----------------------------------
 * The step budget is MAX_AGENT_STEPS (5) and the legitimate lifecycle needs
 * three of them (propose, correct, re-propose). Spending a step on a provider
 * anomaly would starve the real work, and re-driving the same turn would be a
 * second retry controller, which Assignment 37.14 forbids. The turn is
 * therefore terminal and LOUD: the session fails with a machine-readable
 * reason, and a human starts a new one.
 *
 * The provider's own stop reason is carried in the message, because "the
 * model returned nothing" and "the model returned nothing because the output
 * budget ran out" are different incidents and the difference is the whole
 * diagnosis.
 */
export function decideEmptyTurn({
  text,
  toolCallCount,
  finishReason,
}: {
  text: string;
  toolCallCount: number;
  finishReason: string;
}): EmptyTurnDecision {
  // A tool call IS content. The turn that proposes a workflow says nothing in
  // prose on purpose - the tool call is the whole message - so a turn with a
  // call is never an empty turn, however empty its text is.
  if (toolCallCount > 0) {
    return { kind: "HAS_CONTENT" };
  }

  if (text.trim().length > 0) {
    return { kind: "HAS_CONTENT" };
  }

  return {
    kind: "EMPTY",
    stopReason: finishReason,
    message:
      `The model returned no content and made no tool call ` +
      `(finish reason: ${finishReason}).`,
  };
}
