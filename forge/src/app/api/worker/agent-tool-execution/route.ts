import { createWorker } from "@/lib/events/worker";
import { handleToolExecution } from "@/lib/ai/agent/tool-worker";



export const POST = createWorker(
    "AGENT_TOOL_EXECUTION_REQUESTED",
    handleToolExecution,
);