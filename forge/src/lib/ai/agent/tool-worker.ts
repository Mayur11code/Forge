import { publishEvent } from "@/lib/events/queue";

import { withToolExecutionLock } from "./locks";
import type { ToolExecutionWorkerEvent } from "./worker-types";
import {
  completeToolExecution,
  failToolExecution,
  getToolExecutionForWorker,
  markToolExecutionRunning,
} from "./services/tool-execution-service";
import { getToolExecutor } from "./tools/registry";

export async function handleToolExecution({
  event,
}: ToolExecutionWorkerEvent): Promise<void> {
  const { executionId, expectedStep } = event.data;

  await withToolExecutionLock(executionId, async () => {
    const execution = await getToolExecutionForWorker(executionId);

    if (!execution) {
      return;
    }

    const claimed = await markToolExecutionRunning(execution.id);

    if (!claimed) {
      return;
    }

    try {
      const executor = getToolExecutor(execution.toolName);

      const result = await executor(execution.input);

      await completeToolExecution(
        execution.id,
        result,
      );

      await publishEvent("AGENT_LOOP_REQUESTED",
        {
          sessionId: execution.sessionId,
          expectedStep,
          orgId: execution.session.orgId,
        }
        );
    } catch (error) {
      await failToolExecution(
        execution.id,
        error instanceof Error
          ? error.message
          : "Unknown tool execution error",
      );

      throw error;
    }
  });
}