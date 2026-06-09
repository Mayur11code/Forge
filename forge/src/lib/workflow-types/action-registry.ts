
import { WorkflowAction } from "./type";


import { createTaskAction } from "../workflow/actions/core/create-task";
// Import other future actions here...
// import { sendSlackMessage } from "./integrations/slack";
// import { sendEmail } from "./integrations/email";



export const ActionRegistry: Record<string, WorkflowAction> = {
  "task.create": createTaskAction,
  
  //more features later v2
};



export function getAction(actionId: string): WorkflowAction | undefined {
  return ActionRegistry[actionId];
}