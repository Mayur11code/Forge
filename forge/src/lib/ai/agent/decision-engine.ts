
export type AgentDecision =
    | {
          kind: "FINAL_RESPONSE";
          response: string;
      }
    | {
          kind: "TOOL_CALL";
          toolName: string;
          toolCallId: string;
          args: unknown;
      };


export async function decideNextAction(
    sessionId: string,
): Promise<AgentDecision> {

    return {
    kind: "FINAL_RESPONSE",
    response: "Decision engine stub.",
};

}