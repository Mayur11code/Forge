import {
  claimNextAgentStep,
  getAgentSessionForWorker,
} from "@/lib/ai/agent/session-service";
import { withAgentSessionLock } from "@/lib/ai/agent/mutex";
import type { EventPayloadMap } from "@/lib/events/schema";
import { decideNextAction } from "@/lib/ai/agent/decision-engine";

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

      console.info(
        `[AGENT] Processing session ${session.id} (step ${expectedStep}).`,
      );

      /*
       * Next step:
       * - Retrieve RAG context (if needed)
       * - Call Gemini
       * - Complete session OR enqueue tool execution
       */
        const decision =
    await decideNextAction(session.id);

switch (decision.kind) {

    case "FINAL_RESPONSE":
        break;

    case "TOOL_CALL":
        break;
}


    },
  );

  if (acquired === null) {
    console.info(
      `[AGENT] Session ${sessionId} is already being processed.`,
    );
  }
}