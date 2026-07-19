import { generateText, type ModelMessage } from "ai";

import { agentModel } from "./model";
import { buildAgentSystemPrompt } from "./prompts/system-prompt";
import { agentTools } from "./tools/registry";
import { getAgentSessionForWorker } from "./session-service";
import { JsonValue } from "./types";

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
    };

export async function runAgentLoop(
  sessionId: string,
): Promise<LoopResult> {
  const session = await getAgentSessionForWorker(sessionId);

  if (!session) {
    throw new Error(`Agent session '${sessionId}' not found.`);
  }

  const messages = session.messages as ModelMessage[];

  const result = await generateText({
    model: agentModel,

    system: buildAgentSystemPrompt({
      organizationName: session.organization.name,
    }),

    messages,

    tools: agentTools,
  });

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