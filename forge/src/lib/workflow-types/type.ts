
/**
 * A value that can round-trip through the JSONB columns the workflow run uses
 * (`WorkflowRun.context`, `StepRun.outputs`, `ActionResult.data`).
 *
 * `unknown` would also be honest, but it is unactionable: every reader would
 * have to narrow from scratch, and nothing would stop a `Date` or a class
 * instance being assigned to a field that is persisted as JSON. This type makes
 * the storage boundary explicit, so the compiler rejects a value that would be
 * silently mangled on write.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ActionContext = {
  workflowId: string;
  runId: string;
  stepId: string;

  // The fully resolved payload. The engine guarantees that all {{pointers}}
  // have been replaced with real data before the action ever sees this.
  inputs: Record<string, JsonValue>;

};


export type ActionResult = {
  success: boolean;

  // If success is true, this is dumped into the WorkflowRun.context JSONB.
  data?: JsonValue;

  // If success is false, this goes to the ExecutionAuditLog and StepRun.error.
  error?: string;

  //Differentiaing between 500 and 400 level errors can help us decide whether to retry or not.
  isRetriable?: boolean;
};

export type ExecuteFunction = (ctx: ActionContext) => Promise<ActionResult>;


export type CompensateFunction = (
  ctx: ActionContext & { outputs: JsonValue }
) => Promise<ActionResult>;

export interface WorkflowAction {

  id: string; 

  execute: ExecuteFunction; 
  compensate?: CompensateFunction; 
}

