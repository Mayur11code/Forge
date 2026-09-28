import { generateText, type ModelMessage } from "ai";

import { agentModel } from "./model";
import {
  AGENT_PROMPT_VERSION,
  buildAgentSystemPrompt,
} from "./prompts/system-prompt";
import { agentTools } from "./tools/registry";
import { getAgentSessionForWorker } from "./session-service";
import { decideStepGate, decideToolCalls } from "./loop-policy";
import { JsonValue } from "./types";
import type { AgentTerminalReason } from "./types";
import { buildModelMessages } from "./message-mapper";
import { getMessages } from "./services/message-service";
import { createMessage } from "./services/message-service";
import { MAX_AGENT_STEPS } from "./constants";

/**
 * Exhaustive outcome of one agent loop turn.
 *
 * Every variant is produced by `runAgentLoop` and must be handled explicitly
 * by the caller. `MAX_STEPS_EXCEEDED` is kept separate from `COMPLETE` because
 * an exhausted run produced no final answer; collapsing the two is what
 * previously produced DB=FAILED with wire=COMPLETED.
 */
export type LoopResult =
  | {
      kind: "COMPLETE";
      response: string;
    }
  | {
      kind: "TOOL_CALL";
      toolName: string;
      toolCallId: string;
      input: JsonValue;
    }
  | {
      kind: "MAX_STEPS_EXCEEDED";
      maxSteps: number;
      currentStep: number;
    }
  | {
      kind: "FAILED";
      reason: AgentTerminalReason;
      message: string;
    };

export async function runAgentLoop(
  sessionId: string,
): Promise<LoopResult> {
  const session = await getAgentSessionForWorker(sessionId);

  if (!session) {
    return {
      kind: "FAILED",
      reason: "SESSION_NOT_FOUND",
      message: `Agent session '${sessionId}' not found.`,
    };
  }

  // Step budget gate. `session.currentStep` was already incremented by the
  // durable claim, so it is the 1-based index of the turn about to run.
  // No model call is made once the budget is spent.
  const gate = decideStepGate(session.currentStep, MAX_AGENT_STEPS);

  if (gate.kind === "STOP_MAX_STEPS") {
    return {
      kind: "MAX_STEPS_EXCEEDED",
      maxSteps: gate.maxSteps,
      currentStep: gate.currentStep,
    };
  }

  const dbMessages = await getMessages(session.id);

  const messages = buildModelMessages(dbMessages);

  // The session records the contract it was CREATED under; the prompt is
  // rebuilt from current source on every turn. A mismatch means this
  // transcript spans two contracts, which is worth seeing in the logs when a
  // run later misbehaves.
  if (session.promptVersion !== AGENT_PROMPT_VERSION) {
    console.warn(
      `[AGENT] Session ${session.id} was created under prompt ` +
        `${session.promptVersion} but is running ${AGENT_PROMPT_VERSION}.`,
    );
  }

  const result = await generateText({
    model: agentModel,
    system: buildAgentSystemPrompt({ organizationName: session.organization.name }),
    messages,
    tools: agentTools,
  });

  // Resolve the turn BEFORE persisting anything. Persisting an assistant
  // message with tool calls that will never receive matching tool results
  // would corrupt the transcript.
  const expectsToolCall = result.finishReason === "tool-calls";
  const toolCallDecision = decideToolCalls(
    expectsToolCall ? result.toolCalls : [],
  );

  if (toolCallDecision.kind === "TOO_MANY_CALLS") {
    return {
      kind: "FAILED",
      reason: "MULTIPLE_TOOL_CALLS",
      message:
        `Model returned ${toolCallDecision.count} tool calls in a single turn. ` +
        `This agent allows at most one tool call per model turn.`,
    };
  }

  if (
    toolCallDecision.kind === "EMPTY_TOOL_CLAIMS" ||
    (toolCallDecision.kind === "NO_CALLS" && expectsToolCall)
  ) {
    return {
      kind: "FAILED",
      reason: "NO_TOOL_CALL",
      message: "Model finished with tool-calls but returned no tool call.",
    };
  }

  for (const message of result.response.messages as ModelMessage[]) {
    await createMessage({
      sessionId: session.id,
      step: session.currentStep,
      message,
    });
  }

  if (toolCallDecision.kind === "ONE_CALL") {
    return {
      kind: "TOOL_CALL",
      toolName: toolCallDecision.toolName,
      toolCallId: toolCallDecision.toolCallId,
      input: toolCallDecision.input,
    };
  }

  return {
    kind: "COMPLETE",
    response: result.text,
  };
}
