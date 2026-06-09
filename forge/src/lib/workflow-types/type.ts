
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
  
  //Differentiaing between 500 and 400 level errors can help us decide whether to retry or not.
  isRetriable?: boolean; 
};

export type ExecuteFunction = (ctx: ActionContext) => Promise<ActionResult>;


export type CompensateFunction = (
  ctx: ActionContext & { outputs: any } 
) => Promise<ActionResult>;

export interface WorkflowAction {

  id: string; 

  execute: ExecuteFunction; 
  compensate?: CompensateFunction; 
}

