import { withAgentSessionLock, withToolExecutionLock } from "./locks";
import { AGENT_EXECUTION_HEARTBEAT_INTERVAL_MS } from "./constants";
import {
  abandonToolExecution,
  failToolExecution,
  getToolExecutionForWorker,
  heartbeatToolExecution,
  markToolExecutionRunning,
} from "./services/tool-execution-service";
import { getToolExecutor } from "./tools/registry";
import { withClarificationBinding } from "./tools/shared-output";
import type { ToolExecutionWorkerEvent } from "./worker-types";
import { recordAgentEvent } from "./outbox";
// The RAW client, for the transactional tool-result + outbox path below. The
// extended client only intercepts the `task` model; agent tables are not
// intercepted, and the outbox is infrastructure rather than a domain event.
import { db } from "@/lib/prisma/db";
import { AGENT_TRANSACTION_OPTIONS } from "@/lib/prisma/transaction-options";
import { createMessage } from "./services/message-service";
import { failAgentSession, markAgentSessionWaiting } from "./session-service";
import { publishAgentStatus } from "./status";
import { AgentProposalState } from "@prisma/client";
import {
  computeProposalRevision,
  deriveProposalLifecycle,
  findProposalIdentities,
  persistExecutionOutcome,
  reconcileActiveProposal,
} from "./services/proposal-service";
import type { JsonValue } from "./types";

export async function handleToolExecution({
  event,
}: ToolExecutionWorkerEvent): Promise<void> {
  const { sessionId, executionId, expectedStep } = event.data;

  // Session lock OUTSIDE, execution lock INSIDE.
  //
  // The session lock is what serialises the proposal lifecycle: the loop, the
  // clarification and criticality services, the reaper and this worker all take
  // it, so a tool execution can never park or supersede a proposal while another
  // execution in the same session is mid-completion. That serialisation is what
  // makes the single-pending invariant ("at most one proposal awaits a human")
  // hold even when two executions of one session finish out of order - the
  // revision is computed from a table no other writer can change underneath it.
  //
  // The execution lock then keeps the per-execution claim exactly-once. Only
  // this worker ever takes the execution lock, and nothing takes it before the
  // session lock, so the fixed session -> execution order cannot deadlock.
  const acquired = await withAgentSessionLock(sessionId, () =>
    withToolExecutionLock(executionId, async () => {
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

      // Deferred best-effort UI notification. It is deliberately NOT part of the
      // authoritative transaction and NOT inside the failure boundary below: by
      // the time it runs the outcome is already durable, so a transport failure
      // must never fail the execution or a deliberately parked session.
      // Capturing the intent here and awaiting it AFTER the `finally` is what
      // keeps it out of the catch that would otherwise call `failAgentSession`.
      let notify: (() => Promise<void>) | null = null;

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

        // A clarification result is a HALT, not a continuation. Attaching the
        // backend-owned interaction id here is what makes the pending request
        // answerable: the executor is pure and never sees the execution row, so
        // this is the only point that can bind the ask to a durable handle.
        const { output, clarification } = withClarificationBinding(
          result,
          execution.id,
        );

        // Assignment 37.8: classify a `generateWorkflow` result into a durable
        // proposal state. A valid proposal PARKS the loop at AWAITING_CRITICALITY
        // until a human decides per-step criticality (37.8) and approves (37.9);
        // it must NOT re-enter the model, or the loop would regenerate the
        // proposal it just made. Every other outcome is unaffected.
        const outputValue = output.type === "json" ? output.value : null;

        const lifecycle = deriveProposalLifecycle(
          execution.toolName,
          outputValue,
        );

        const parksProposal =
          lifecycle?.state === AgentProposalState.AWAITING_CRITICALITY;

        // The revision is the 1-based rank of this proposal in deterministic
        // (createdAt, id) order, so supersession is reproducible after a restart.
        // Computed while holding the session lock, so no other writer can park a
        // proposal between this read and the transaction below.
        const revision =
          parksProposal && lifecycle
            ? computeProposalRevision(
                await findProposalIdentities(execution.sessionId),
                execution.id,
              )
            : null;

        // The tool result and the intent to continue the conversation are
        // written in ONE transaction, and the execution's TERMINAL status lands
        // in the same compare-and-set as its result.
        //
        // These used to be four separate writes ending in a publish, and the
        // COMPLETED status was stamped by a fifth write AFTER the transaction.
        // A crash in that gap left a finished execution - and, for a proposal,
        // a parked lifecycle - still RUNNING, which had no honest recovery: the
        // reaper would treat it as a dead worker. Folding the status into the
        // result CAS removes the gap entirely.
        //
        // A clarification is the exception to the continuation half: asking the
        // human is not a reason to re-drive the model. Recording
        // AGENT_LOOP_REQUESTED here would send the loop straight back to the
        // model with the same missing input, which is the exact spin the
        // missing-input protocol exists to stop. The result still commits
        // durably - it is the request the human will answer.
        const persisted = await db.$transaction(async (tx) => {
          // The outcome CAS runs FIRST and short-circuits. If it loses, this
          // delivery is a duplicate that no longer owns the claim: committing
          // nothing else means no second transcript entry and no second
          // continuation intent.
          const wrote = await persistExecutionOutcome(tx, {
            executionId: execution.id,
            result: outputValue as JsonValue,
            lifecycle,
            revision,
          });

          if (!wrote) {
            return false;
          }

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
                output,
              }],
            },
            tx,
          });

          // Assignment 37.8: keep the single-pending invariant. A newer proposal
          // retires every older one, and an out-of-order older proposal retires
          // itself when a newer one has already parked.
          if (parksProposal && revision !== null) {
            await reconcileActiveProposal(tx, {
              sessionId: execution.sessionId,
              executionId: execution.id,
              revision,
            });
          }

          // A clarification and a parked proposal are both HALTS, not
          // continuations. Re-driving the loop for either would send the model
          // straight back to the input it is already waiting on. Every other
          // completion records the intent to continue.
          //
          // Assignment 37.14 (AD-P7): a halt parks the SESSION too. The session
          // moves RUNNING -> WAITING_CONFIRMATION in this same transaction, so the
          // coarse human-wait marker is durable exactly when the halt is. Which
          // decision is pending stays distinguishable: a clarification through the
          // NEEDS_USER_INPUT result just persisted, a proposal through the
          // PENDING_CONFIRMATION execution status and the parked proposal state.
          // The status is written only for genuine halts - a correctable
          // INVALID_INPUT never parks the session, because the model continues.
          if (clarification || parksProposal) {
            await markAgentSessionWaiting(execution.sessionId, tx);
          }

          if (!clarification && !parksProposal) {
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
          }

          return true;
        }, AGENT_TRANSACTION_OPTIONS);

        if (!persisted) {
          // A duplicate delivery that lost the outcome CAS. The winning
          // delivery already recorded the result and published its status; this
          // one must do nothing at all.
          console.info(
            `[AGENT] Tool execution ${execution.id} outcome already ` +
              `persisted by another delivery.`,
          );
          return;
        }

        // The outcome is durable. Only now build the notification intent, to be
        // delivered after this error boundary has closed.
        if (clarification) {
          // The loop is parked. Status is a UI signal, not domain state: the
          // durable request is the persisted tool result above.
          notify = async () => {
            await publishAgentStatus(execution.sessionId, {
              type: "CLARIFICATION_REQUESTED",
              executionId: execution.id,
              toolName: execution.toolName,
              interactionId: clarification.interactionId ?? execution.id,
              correlationId: clarification.correlationId ?? "",
              fields: clarification.fields,
            });
          };
        } else {
          notify = async () => {
            await publishAgentStatus(execution.sessionId, {
              type: "TOOL_COMPLETED",
              executionId: execution.id,
              toolName: execution.toolName,
            });
          };
        }
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

      // Post-commit, best-effort. The transaction above is the source of truth;
      // a notification that fails here is logged and otherwise ignored, never
      // routed into the failure path (which would mark a durable COMPLETED
      // execution - and a parked proposal session - as FAILED).
      if (notify) {
        try {
          await notify();
        } catch (error) {
          console.warn(
            `[AGENT] Tool execution ${execution.id} is committed, but its ` +
              `status notification failed; the outcome is durable.`,
            error,
          );
        }
      }
    }),
  );

  if (acquired === null) {
    // Either a live worker is mid-turn on this session or another delivery owns
    // this execution. Nothing is claimed, so the row stays PENDING and the
    // recovery sweep re-records the delivery intent rather than this pass
    // half-doing the work.
    console.info(
      `[AGENT] Tool execution ${executionId} left for redelivery: the ` +
        `session or execution lock is held.`,
    );
  }
}
