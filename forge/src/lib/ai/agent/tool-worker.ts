import { publishEvent } from "@/lib/events/queue";

import { withToolExecutionLock } from "./locks";
import {
  completeToolExecution,
  failToolExecution,
  getToolExecutionForWorker,
  markToolExecutionRunning,
} from "./services/tool-execution-service";
import { getToolExecutor } from "./tools/registry";
import type { ToolExecutionWorkerEvent } from "./worker-types";
import { createMessage } from "./services/message-service";
import { failAgentSession } from "./session-service";
import { publishAgentStatus } from "./status";

export async function handleToolExecution({
  event,
}: ToolExecutionWorkerEvent): Promise<void> {
  const { executionId, expectedStep } = event.data;

  await withToolExecutionLock(
    executionId,
    async () => {
      const execution =
        await getToolExecutionForWorker(
          executionId,
        );

      if (!execution) {
        return;
      }

      const claimed =
        await markToolExecutionRunning(
          execution.id,
        );

      if (!claimed) {
        return;
      }

      try {
        const executor =
          getToolExecutor(
            execution.toolName,
          );

        const result =
          await executor(
            execution.input,
          );


        await createMessage({
          sessionId: execution.sessionId,
          step: execution.session.currentStep,
          toolCallId: execution.toolCallId,
          message: {
            role: "tool",
            content: [{
              type: "tool-result",
              toolCallId: execution.toolCallId,
              toolName: execution.toolName,
              output: result,
            }],
          },
        });

        await completeToolExecution(
          execution.id
        );
        
        await publishEvent(
          "AGENT_LOOP_REQUESTED",
          {
            sessionId:
              execution.sessionId,
            expectedStep,
            orgId:
              execution.session.orgId,
          },
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown tool execution error";

        await failToolExecution(
          execution.id,
          message,
        );

        await failAgentSession(
          execution.sessionId,
          message,
        );

        await publishAgentStatus(
          execution.sessionId,
          {
            type: "FAILED",
            message,
          },
        );

        console.error(
          `[AGENT] Tool execution ${execution.id} failed.`,
          error,
        );

        return;
      }
    },
  );
}