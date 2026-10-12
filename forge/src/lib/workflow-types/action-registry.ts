
import { WorkflowAction } from "./type";


import { createTaskAction } from "../workflow/actions/core/create-task";
// Import other future actions here...
// import { sendSlackMessage } from "./integrations/slack";
// import { sendEmail } from "./integrations/email";


/**
 * The execution registry, and the only authority on what can actually run.
 *
 * `satisfies` rather than a type annotation so `RegisteredActionId` below is the
 * literal key set instead of `string`. The capability catalog
 * (`action-capabilities.ts`) keys off that union, so registering an action
 * without describing it fails to compile rather than failing at execution.
 *
 * The runtime shape is unchanged: still a plain object of id -> WorkflowAction,
 * still read through getAction.
 */
export const ActionRegistry = {
  "task.create": createTaskAction,

  //more features later v2
} satisfies Record<string, WorkflowAction>;


export type RegisteredActionId = keyof typeof ActionRegistry;


export function getAction(actionId: string): WorkflowAction | undefined {
  // Widened only for the lookup. `actionId` arrives from a persisted workflow
  // step, so it is genuinely `string`, while the object above is a closed set.
  return (ActionRegistry as Record<string, WorkflowAction | undefined>)[
    actionId
  ];
}
