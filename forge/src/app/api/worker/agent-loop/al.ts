import {
  claimNextAgentStep,
  getAgentSessionForWorker,
} from "@/lib/ai/agent/session-service";
import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import type { EventPayloadMap } from "@/lib/events/schema";
import { decideNextAction } from "@/lib/ai/agent/decision-engine";
import { runAgentLoop } from "@/lib/ai/agent/loop-runner";
import { createToolExecution } from "@/lib/ai/agent/services/tool-execution-service";
import { publishEvent } from "@/lib/events/queue";

type AgentLoopWorkerEvent = {
  event: {
    data: EventPayloadMap["AGENT_LOOP_REQUESTED"];
  };
};

export async function handleAgentLoop({
  event,
}: AgentLoopWorkerEvent): Promise<void> {
  const { sessionId, expectedStep } = event.data;

  const acquired = await withAgentSessionLock(
    sessionId,
    async () => {
      const session = await getAgentSessionForWorker(sessionId);

      if (!session) {
        console.warn(
          `[AGENT] Session ${sessionId} not found. Ignoring.`,
        );
        return;
      }

      const claimed = await claimNextAgentStep(
        sessionId,
        expectedStep,
      );

      if (!claimed) {
        console.info(
          `[AGENT] Ignoring stale loop event for session ${sessionId}.`,
        );
        return;
      }

      const result = await runAgentLoop(session.id);

      switch (result.kind) {
        case "COMPLETE": {
          console.info(
            `[AGENT] Session ${session.id} completed.`,
          );

          break;
        }

        case "TOOL_CALL": {
          const execution =
            await createToolExecution({
              sessionId: session.id,
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              input: result.input,
            });

          await publishEvent("AGENT_TOOL_EXECUTION_REQUESTED", {
            orgId: session.orgId,
            sessionId: session.id,
            executionId: execution.id,
            expectedStep: session.currentStep + 1,
          });

          break;
        }
      }


    },
  );

  if (acquired === null) {
    console.info(
      `[AGENT] Session ${sessionId} is already being processed.`,
    );
  }
}