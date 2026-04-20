
export type ActionContext = {
  workflowId: string;
  runId: string;
  stepId: string;
  
  // The fully resolved payload. The engine guarantees that all {{pointers}} 
  // have been replaced with real data before the action ever sees this.
  inputs: Record<string, any>; 
};


export type ActionResult = {
  success: boolean;
  
  // If success is true, this is dumped into the WorkflowRun.context JSONB.
  data?: any; 
  
  // If success is false, this goes to the ExecutionAuditLog and StepRun.error.
  error?: string; 
  
  // CRITICAL FOR STEP 12: Differentiating between a 500 (API down, try again) 
  // and a 400 (Bad email format, retrying will never work).
  isRetriable?: boolean; 
};

export type ActionFunction = (ctx: ActionContext) => Promise<ActionResult>;


export interface WorkflowAction {

  id: string; 

  execute: ActionFunction; 
  compensate?: ActionFunction; 
}

