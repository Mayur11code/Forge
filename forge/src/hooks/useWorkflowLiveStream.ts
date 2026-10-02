import { useEffect } from "react";
import { getPusherClient } from "@/lib/pusher/pusher-client";
import { StepExecutionStatus } from "@prisma/client";
import type { AppNode } from "@/lib/workflow-types/workflow";

/**
 * What the server puts on the wire for STEP_STATE_CHANGE.
 *
 * This comes from a Pusher channel, i.e. the public internet, so `status` is
 * whatever the publisher sent. It was typed as `string` and assigned straight
 * into node data - a node type that expects a `StepExecutionStatus` - so the
 * type checker could never have caught a bad status. Validated at the boundary
 * instead: an unrecognised value is dropped and the log says so, rather than
 * pushing a status the UI has no branch for.
 */
type StepStateChange = {
  stepId: string;
  status: unknown;
};

/**
 * Narrows a wire status to a `StepExecutionStatus`.
 *
 * `hasOwnProperty` rather than a bare index: the generated enum object inherits
 * from Object.prototype, so a payload of `"constructor"` would otherwise index
 * straight through to `Object` and pass the undefined check.
 */
function toStepExecutionStatus(
  raw: unknown,
): StepExecutionStatus | undefined {
  if (typeof raw !== "string") return undefined;

  return Object.prototype.hasOwnProperty.call(StepExecutionStatus, raw)
    ? (StepExecutionStatus[raw as keyof typeof StepExecutionStatus] as StepExecutionStatus)
    : undefined;
}

/**
 * Applies an execution status to a node.
 *
 * `AppNode` is a union discriminated on `type`, so the status cannot simply be
 * spread into `node.data`: TypeScript widens the spread to a union of the two
 * shapes and cannot prove the result is still an `AppNode`, which is why this
 * used to need `any`. Switching on the discriminant narrows `node` to one member
 * at a time, and both members carry `executionStatus`, so each case is provably
 * well-typed.
 */
function withExecutionStatus(
  node: AppNode,
  status: StepExecutionStatus,
): AppNode {
  switch (node.type) {
    case "trigger":
      return { ...node, data: { ...node.data, executionStatus: status } };
    case "action":
      return { ...node, data: { ...node.data, executionStatus: status } };
    default:
      return node;
  }
}

export function useWorkflowLiveStream(
  runId: string | undefined,
  setNodes: React.Dispatch<React.SetStateAction<AppNode[]>>,
) {
  useEffect(() => {
    // Failsafes
    if (!runId || !setNodes) return;

    const pusher = getPusherClient();
    if (!pusher) return;

    const channelName = `private-workflow-${runId}`;
    const channel = pusher.subscribe(channelName);

    const handleStepChange = (data: StepStateChange) => {
      const status = toStepExecutionStatus(data.status);

      if (typeof data.stepId !== "string" || status === undefined) {
        console.warn(
          "[PUSHER] Ignoring STEP_STATE_CHANGE with unusable payload",
          data,
        );
        return;
      }

      console.log(`[PUSHER] Forcing React re-render for ${data.stepId} -> ${status}`);

      console.log("[PUSHER EVENT]", data);

// Update the local component state directly!
      setNodes((nds) =>
        nds.map((node) =>
          node.id === data.stepId ? withExecutionStatus(node, status) : node,
        ),
      );
    };

    channel.bind("STEP_STATE_CHANGE", handleStepChange);

    return () => {
      channel.unbind("STEP_STATE_CHANGE", handleStepChange);
      pusher.unsubscribe(channelName);
    };
  }, [runId, setNodes]);
}