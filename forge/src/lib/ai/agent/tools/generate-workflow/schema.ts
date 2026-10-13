import { WorkflowProposalSchema } from "@/lib/workflow-types/workflow-proposal";

/**
 * Model-facing input for `generateWorkflow`.
 *
 * This IS the Assignment 37.2 proposal contract, not a copy of it. The schema
 * the model generates against and the schema the compiler validates must not be
 * able to drift: a proposal the model was told was well-formed must not be
 * rejected by the registry for a reason it could not see. Action membership and
 * per-action input rules are enforced by the compiler, not restated here.
 *
 * Structural violations (a missing `name`, a malformed step id, an empty
 * `steps`) are therefore rejected by the model-facing schema before the executor
 * runs. Semantic violations that the schema does not encode — unknown actions,
 * dangling or self dependencies, cycles, invalid `{{...}}` references — reach
 * the executor and are returned as structured issues. The two paths are
 * deliberately distinct and are asserted as such in the tests.
 */
export const generateWorkflowSchema = WorkflowProposalSchema;
