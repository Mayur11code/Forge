import type { EventPayloadMap } from "@/lib/events/schema";

export type AgentLoopWorkerEvent = {
  event: {
    data: EventPayloadMap["AGENT_LOOP_REQUESTED"];
  };
};

export type ToolExecutionWorkerEvent = {
  event: {
    data: EventPayloadMap["AGENT_TOOL_EXECUTION_REQUESTED"];
  };
};