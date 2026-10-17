import { z } from "zod";

import {
  MAX_PROPOSAL_DESCRIPTION_LENGTH,
  MAX_PROPOSAL_NAME_LENGTH,
  MAX_PROPOSAL_STEPS,
  PROPOSAL_LOCAL_REF_PATTERN,
  WorkflowProposalSchema,
  WorkflowProposalStepSchema,
} from "@/lib/workflow-types/workflow-proposal";

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

/**
 * Model-facing clarification request for one required action input that the
 * workflow genuinely requires but which the user has not supplied.
 */
export const ClarificationRequestItemSchema = z
  .object({
    field: z
      .string()
      .min(1, "A clarification request must identify a field path.")
      .describe(
        "Dotted path identifying the missing required input, e.g. 'steps.kickoff.inputs.projectId'.",
      ),
    reason: z
      .string()
      .min(1, "A clarification request must provide a reason.")
      .describe(
        "Explanation of why this information is required by the workflow action.",
      ),
    question: z
      .string()
      .min(1, "A clarification request must provide a question.")
      .describe(
        "Human-readable question to ask the user to provide the missing value.",
      ),
    candidateValues: z
      .array(z.unknown())
      .optional()
      .describe(
        "Optional list of grounded candidate values for the user to choose from.",
      ),
  })
  .strict();

export type ClarificationRequestItem = z.infer<
  typeof ClarificationRequestItemSchema
>;

/**
 * Proposal input schema with embedded clarification requests (Form A: nested proposal).
 */
export const ProposalWithClarificationsFormASchema = z
  .object({
    proposal: WorkflowProposalSchema,
    clarifications: z
      .array(ClarificationRequestItemSchema)
      .min(1, "At least one clarification request is required."),
  })
  .strict();

/**
 * Proposal input schema with flat clarification requests (Form B: top-level fields).
 */
export const ProposalWithClarificationsFormBSchema = z
  .object({
    name: z
      .string()
      .min(1, "A proposal must have a name.")
      .max(
        MAX_PROPOSAL_NAME_LENGTH,
        `A proposal name must be at most ${MAX_PROPOSAL_NAME_LENGTH} characters.`,
      ),
    description: z
      .string()
      .max(
        MAX_PROPOSAL_DESCRIPTION_LENGTH,
        `A proposal description must be at most ${MAX_PROPOSAL_DESCRIPTION_LENGTH} characters.`,
      )
      .optional(),
    steps: z.record(z.string(), WorkflowProposalStepSchema),
    clarifications: z
      .array(ClarificationRequestItemSchema)
      .min(1, "At least one clarification request is required."),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const entries = Object.entries(proposal.steps);

    if (entries.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "A workflow proposal must contain at least one step.",
        path: ["steps"],
        params: { proposalCode: "EMPTY_PROPOSAL" },
      });
    }

    if (entries.length > MAX_PROPOSAL_STEPS) {
      ctx.addIssue({
        code: "custom",
        message: `A workflow proposal may contain at most ${MAX_PROPOSAL_STEPS} steps.`,
        path: ["steps"],
        params: { proposalCode: "TOO_MANY_STEPS" },
      });
    }

    for (const [localRef, step] of entries) {
      if (!PROPOSAL_LOCAL_REF_PATTERN.test(localRef)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Step id "${localRef}" must start with a letter or underscore and ` +
            `contain only letters, digits, underscores or hyphens.`,
          path: ["steps", localRef],
          params: { proposalCode: "INVALID_LOCAL_REF" },
        });
      }

      step.dependsOn.forEach((dependency, index) => {
        if (!PROPOSAL_LOCAL_REF_PATTERN.test(dependency)) {
          ctx.addIssue({
            code: "custom",
            message: `Dependency "${dependency}" is not a valid step id.`,
            path: ["steps", localRef, "dependsOn", index],
            params: { proposalCode: "INVALID_DEPENDENCY" },
          });
        }
      });
    }
  });

/**
 * Union schema for generateWorkflow tool input: accepts either an ordinary
 * proposal or a proposal accompanied by clarification requests.
 */
export const generateWorkflowToolInputSchema = z.union([
  WorkflowProposalSchema,
  ProposalWithClarificationsFormASchema,
  ProposalWithClarificationsFormBSchema,
]);

export const generateWorkflowInputSchema = generateWorkflowToolInputSchema;
