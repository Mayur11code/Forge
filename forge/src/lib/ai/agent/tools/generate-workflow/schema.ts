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
 * The Assignment 37.2 proposal contract, by reference.
 *
 * This IS the compiler's proposal schema, not a copy: a proposal the model was
 * told was well-formed cannot be rejected by a drifting duplicate. Action
 * membership and per-action input rules are enforced by the compiler, not
 * restated here.
 *
 * Structural violations (a missing `name`, a malformed step id, an empty
 * `steps`) are rejected by this schema before the executor runs. Semantic
 * violations that the schema does not encode — unknown actions, dangling or self
 * dependencies, cycles, invalid `{{...}}` references — reach the executor and
 * are returned as structured issues. The two paths are deliberately distinct and
 * are asserted as such in the tests.
 *
 * It carries no `clarifications` field, so it is the parser/compat schema, not
 * the model-facing one. See `generateWorkflowModelInputSchema` below.
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
 * The schema the model is handed as the `generateWorkflow` tool's `inputSchema`.
 *
 * ONE flat object, never a root `z.union`. A root union serializes to a root
 * `anyOf` in the tool's JSON Schema, and function-calling degrades against
 * `anyOf`: the model must choose a branch AND populate it, and a payload that is
 * a near-miss for the branch it chose matches none of them, so the call is
 * rejected with no usable feedback. A single canonical object gives the model
 * exactly one target to fill.
 *
 * The shape is the 37.2 proposal plus an OPTIONAL `clarifications` array. An
 * absent `clarifications` is an ordinary proposal; a non-empty array carries
 * clarification requests, exactly as the executor already expects. Structural
 * rules (non-empty `steps`, local-id grammar, strictness) are inherited
 * unchanged from `WorkflowProposalSchema` via `.extend`, so the model-facing
 * contract and the compiler contract cannot drift.
 */
export const generateWorkflowModelInputSchema = WorkflowProposalSchema.extend({
  clarifications: ClarificationRequestItemSchema.array()
    .min(1, "At least one clarification request is required when supplied.")
    .optional()
    .describe(
      "Optional clarification requests for genuinely missing required inputs. Omit for an ordinary proposal.",
    ),
});

/**
 * Every input shape the executor still accepts, retained for compatibility and
 * parsing. This is NOT sent to the model; the model sees only
 * `generateWorkflowModelInputSchema`.
 *
 *   - plain proposal:          { name, description?, steps }
 *   - nested + clarifications: { proposal: { name, description?, steps }, clarifications: [...] }
 *   - flat + clarifications:   { name, description?, steps, clarifications: [...] }
 *
 * The executor dissects these itself (`extractProposalAndClarifications` in
 * execute.ts), so this union documents and validates the legacy boundary; it is
 * not a runtime dependency of the tool call.
 */
export const generateWorkflowAcceptedInputSchema = z.union([
  WorkflowProposalSchema,
  ProposalWithClarificationsFormASchema,
  ProposalWithClarificationsFormBSchema,
]);
