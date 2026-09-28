import {
  claimNextAgentStep,
  getAgentSessionForWorker,
  completeAgentSession,
  failAgentSession,
  terminateAgentSessionForMaxSteps,
} from "@/lib/ai/agent/session-service";
import { withAgentSessionLock } from "@/lib/ai/agent/locks";
import type { EventPayloadMap } from "@/lib/events/schema";
import { runAgentLoop } from "@/lib/ai/agent/loop-runner";
import type { LoopResult } from "@/lib/ai/agent/loop-runner";
import { createToolExecution } from "@/lib/ai/agent/services/tool-execution-service";
import {
  describeToolProposal,
  getToolPolicy,
  requiresToolConfirmation,
} from "@/lib/ai/agent/tools/registry";
import { publishEvent } from "@/lib/events/queue";
import { publishAgentStatus } from "@/lib/ai/agent/status";

type AgentLoopWorkerEvent = {
  event: {
    data: EventPayloadMap["AGENT_LOOP_REQUESTED"];
  };
};

/**
 * Compile-time exhaustiveness guard.
 *
 * If a new LoopResult variant is added without being handled here, this fails
 * to typecheck instead of silently falling through.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled agent loop result: ${JSON.stringify(value)}`);
}

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

      await publishAgentStatus(session.id, {
        type: "RUNNING",
        message: "Thinking...",
      });

      try {
        const result = await runAgentLoop(session.id);

        switch (result.kind) {
          case "COMPLETE": {
            const { count } = await completeAgentSession(
              session.id,
              result.response,
            );

            // Only announce the terminal state if the durable transition
            // actually happened, so a duplicate delivery cannot emit a
            // second, contradictory terminal event.
            if (count === 1) {
              await publishAgentStatus(session.id, {
                type: "COMPLETED",
                content: result.response,
              });
            }

            console.info(
              `[AGENT] Session ${session.id} completed.`,
            );

            break;
          }

          case "TOOL_CALL": {
            // Fail closed on an unregistered tool. Without a policy there is no
            // trusted answer to "is this safe to run?", and defaulting to
            // "run it" would let a hallucinated tool name reach an executor.
            const policy = getToolPolicy(result.toolName);

            if (!policy) {
              const message =
                `The agent requested an unavailable tool ` +
                `"${result.toolName}".`;

              const { count } = await failAgentSession(
                session.id,
                message,
                "TOOL_NOT_AVAILABLE",
              );

              if (count === 1) {
                await publishAgentStatus(session.id, {
                  type: "FAILED",
                  reason: "TOOL_NOT_AVAILABLE",
                  message,
                });
              }

              console.error(
                `[AGENT] Session ${session.id} requested unknown tool ` +
                  `${result.toolName}.`,
              );

              break;
            }

            const needsConfirmation =
              requiresToolConfirmation(result.toolName);

            // The proposal arguments are persisted here and are the ONLY thing
            // that will ever be executed. The confirm path replays this row; it
            // never accepts or reconstructs arguments of its own.
            const execution = await createToolExecution({
              sessionId: session.id,
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              input: result.input,
              requiresConfirmation: needsConfirmation,
            });

            if (needsConfirmation) {
              // Halt the loop. Nothing is dispatched and the session is not
              // re-driven until the user confirms or cancels; that request
              // re-enters here with the step already claimed above.
              const proposal = describeToolProposal(
                result.toolName,
                execution.input,
              );

              await publishAgentStatus(session.id, {
                type: "TOOL_PROPOSED",
                executionId: execution.id,
                toolName: result.toolName,
                summary: proposal.summary,
                fields: proposal.fields,
              });

              console.info(
                `[AGENT] Session ${session.id} is waiting for ` +
                  `confirmation of ${result.toolName} ` +
                  `(execution ${execution.id}).`,
              );

              break;
            }

            // READ_ONLY: no user gate, dispatch immediately.
            await publishEvent(
              "AGENT_TOOL_EXECUTION_REQUESTED",
              {
                orgId: session.orgId,
                sessionId: session.id,
                executionId: execution.id,
                expectedStep: expectedStep + 1,
              },
            );

            break;
          }

          case "MAX_STEPS_EXCEEDED": {
            const { count } = await terminateAgentSessionForMaxSteps(
              session.id,
              {
                maxSteps: result.maxSteps,
                currentStep: result.currentStep,
              },
            );

            if (count === 1) {
              await publishAgentStatus(session.id, {
                type: "MAX_STEPS_EXCEEDED",
                reason: "MAX_STEPS_EXCEEDED",
                maxSteps: result.maxSteps,
                currentStep: result.currentStep,
                message: "Maximum agent steps exceeded.",
              });
            }

            console.warn(
              `[AGENT] Session ${session.id} stopped: max steps exceeded ` +
                `(${result.currentStep} > ${result.maxSteps}).`,
            );

            break;
          }

          case "FAILED": {
            const { count } = await failAgentSession(
              session.id,
              result.message,
              result.reason,
            );

            if (count === 1) {
              await publishAgentStatus(session.id, {
                type: "FAILED",
                reason: result.reason,
                message: result.message,
              });
            }

            console.error(
              `[AGENT] Session ${session.id} failed: ${result.reason}.`,
            );

            break;
          }

          default:
            assertNever(result);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown agent error";

        console.error(
          `[AGENT] Session ${session.id} failed.`,
          error,
        );

        const { count } = await failAgentSession(
          session.id,
          message,
          "ERROR",
        );

        if (count === 1) {
          await publishAgentStatus(session.id, {
            type: "FAILED",
            reason: "ERROR",
            message,
          });
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

// Keep the LoopResult import meaningful at runtime for readers of this file.
export type { LoopResult };
