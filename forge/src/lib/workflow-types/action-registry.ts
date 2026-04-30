// src/lib/workflow/actions/registry.ts
import { WorkflowAction } from "./type";
import { createTaskAction } from "../workflow/actions/core/create-task";

// Import other future actions here...
// import { sendSlackMessage } from "./integrations/slack";
// import { sendEmail } from "./integrations/email";



/**
 * THE ACTION REGISTRY
 * The Orchestrator Engine only imports this single object. 
 * It looks up the step's action string (e.g., 'task.create') and fires the execute() function.
 */
export const ActionRegistry: Record<string, WorkflowAction> = {
  "task.create": createTaskAction,
  
  // As you build more features, you just register them here:
  // "slack.send_message": sendSlackMessage,
  // "email.send": sendEmail,
};

/**
 * Helper utility for the engine to safely pull actions
 */
export function getAction(actionId: string): WorkflowAction | undefined {
  return ActionRegistry[actionId];
}