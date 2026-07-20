import { generateText, type ModelMessage } from "ai";

import { agentModel } from "./model";
import { buildAgentSystemPrompt } from "./prompts/system-prompt";
import { agentTools } from "./tools/registry";
import { failAgentSession, getAgentSessionForWorker } from "./session-service";
import { JsonValue } from "./types";
import { buildModelMessages } from "./message-mapper";
import { getMessages } from "./services/message-service";
import { createMessage } from "./services/message-service";
import { publishAgentStatus } from "./status";
import { MAX_AGENT_STEPS } from "./constants";

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
  | { kind: "FAILED"; reason: string };

export async function runAgentLoop(
  sessionId: string,
): Promise<LoopResult> {
  const session = await getAgentSessionForWorker(sessionId);



  if (!session) {
    throw new Error(`Agent session '${sessionId}' not found.`);
  }

  if (session.currentStep >= MAX_AGENT_STEPS) {
    await failAgentSession(
      session.id,
      "max_steps_exceeded",
    );

    await publishAgentStatus(session.id, {
      type: "FAILED",
      message: "Maximum agent steps exceeded.",
    });

    return {
      kind: "COMPLETE",
      response: "Agent loop stopped: Maximum execution steps exceeded.",
    };

  }
  const dbMessages = await getMessages(session.id);

  const messages = buildModelMessages(dbMessages);

  const result = await generateText({
    model: agentModel,
    system: buildAgentSystemPrompt({ organizationName: session.organization.name }),
    messages,
    tools: agentTools,
  });

  for (const message of result.response.messages) {
    await createMessage({
      sessionId: session.id,
      step: session.currentStep,
      message,
    });
  }

  if (result.finishReason === "tool-calls") {
    const toolCall = result.toolCalls[0];

    if (!toolCall) {
      throw new Error(
        "Model finished with tool-calls but returned no tool call.",
      );
    }

    return {
      kind: "TOOL_CALL",
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      input: toolCall.input as JsonValue,
    };
  }

  return {
    kind: "COMPLETE",
    response: result.text,
  };
}