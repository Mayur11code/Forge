import { createWorker } from "@/lib/events/worker";



export const POST = createWorker(
    "AGENT_TOOL_EXECUTION_REQUESTED",
    handleToolExecution,
);