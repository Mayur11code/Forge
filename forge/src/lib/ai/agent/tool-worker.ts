import { withToolExecutionLock } from "./locks";
import { AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS } from "./constants";
import {
  abandonToolExecution,
  completeToolExecution,
  failToolExecution,
  getToolExecutionForWorker,
  heartbeatToolExecution,
  markToolExecutionRunning,
} from "./services/tool-execution-service";
import { getToolExecutor } from "./tools/registry";
import type { ToolExecutionWorkerEvent } from "./worker-types";
import { recordAgentEvent } from "./outbox";
// The RAW client, for the transactional tool-result + outbox path below. The
// extended client only intercepts the `task` model; agent tables are not
// intercepted, and the outbox is infrastructure rather than a domain event.
import { db } from "@/lib/prisma/db";
import { createMessage } from "./services/message-service";
import { failAgentSession } from "./session-service";
import { publishAgentStatus } from "./status";

export async function handleToolExecution({
  event,
}: ToolExecutionWorkerEvent): Promise<void> {
  const { executionId, expectedStep } = event.data;

  const acquired = await withToolExecutionLock(
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
        // Either another delivery already claimed it, or the row is in a state
        // that must never run (still awaiting confirmation, or cancelled).
        // Cancelled work is never resurrected by a late event.
        console.info(
          `[AGENT] Tool execution ${executionId} not claimable ` +
            `(status ${execution.status}).`,
        );
        return;
      }

      // A terminal session must not gain new side effects. The execution is
      // already RUNNING at this point and this worker owns the claim, so
      // abandon it back to a terminal CANCELLED state rather than leaving an
      // in-flight row that nobody else will ever transition.
      if (execution.session.status !== "RUNNING") {
        const reason =
          `Execution abandoned: session is ` +
          `${execution.session.status}.`;

        await abandonToolExecution(execution.id, reason);

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
              output: {
                type: "json",
                value: {
                  ok: false,
                  code: "SESSION_NOT_RUNNING",
                  error: reason,
                },
              },
            }],
          },
        });

        console.warn(
          `[AGENT] Tool execution ${executionId} abandoned: session ` +
            `${execution.sessionId} is ${execution.session.status}.`,
        );

        return;
      }

      // Claimed and about to run. From here the row is RUNNING and nothing else
      // touches it, so its updatedAt is pinned - heartbeat it while the
      // executor works, or the recovery sweep cannot tell this apart from a
      // worker that died holding the claim.
      const heartbeat = setInterval(() => {
        void heartbeatToolExecution(execution.id).then(
          (alive) => {
            if (!alive) {
              console.warn(
                `[AGENT] Tool execution ${execution.id} left RUNNING ` +
                  `while this worker was still executing it.`,
              );
            }
          },
          (error) => {
            console.warn(
              `[AGENT] Heartbeat for tool execution ${execution.id} failed.`,
              error,
            );
          },
        );
      }, AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS);

      if (typeof heartbeat.unref === "function") {
        heartbeat.unref();
      }

      try {
        const executor =
          getToolExecutor(
            execution.toolName,
          );

        const result =
          await executor(
            execution.input,
            {
              // Trusted context. Sourced from the PERSISTED AgentSession row
              // loaded by getToolExecutionForWorker. Never from the queue
              // payload, never from model-controlled input.
              orgId: execution.session.orgId,
              userId: execution.session.userId,
              executionId: execution.id,
            },
          );


        // The tool result and the intent to continue the conversation are
        // written in ONE transaction.
        //
        // These used to be four separate writes ending in a publish. A crash
        // after the result was persisted but before the continuation was
        // requested left a complete tool result with nothing to consume it, and
        // the session sat silent until the reaper eventually killed it. The
        // result is now durable together with the reason to re-drive the loop.
        await db.$transaction(async (tx) => {
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
            tx,
          });

          await recordAgentEvent({
            tx,
            eventType: "AGENT_LOOP_REQUESTED",
            sessionId: execution.sessionId,
            aggregateId: `${execution.sessionId}:${expectedStep}`,
            payload: {
              sessionId: execution.sessionId,
              expectedStep,
              orgId: execution.session.orgId,
            },
          });
        });

        // CAS-guarded: a duplicate delivery that lost the race cannot stamp
        // COMPLETED over a row another worker already advanced.
        await completeToolExecution(execution.id);

        await publishAgentStatus(execution.sessionId, {
          type: "TOOL_COMPLETED",
          executionId: execution.id,
          toolName: execution.toolName,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown tool execution error";

        // The raw error, not the formatted message: the execution row stores
        // the stack, which is the only place it survives. The session gets the
        // human-readable message above.
        await failToolExecution(
          execution.id,
          error,
        );

        const { count } =
          await failAgentSession(
            execution.sessionId,
            message,
            "ERROR",
          );

        // Only announce the failure if this delivery actually transitioned the
        // session, so a duplicate event cannot emit a second, contradictory
        // terminal event.
        if (count === 1) {
          await publishAgentStatus(
            execution.sessionId,
            {
              type: "FAILED",
              reason: "ERROR",
              message,
            },
          );
        }

        console.error(
          `[AGENT] Tool execution ${execution.id} failed.`,
          error,
        );

        return;
      } finally {
        clearInterval(heartbeat);
      }
    },
  );

  if (acquired === null) {
    console.info(
      `[AGENT] Tool execution ${executionId} is already being processed.`,
    );
  }
}