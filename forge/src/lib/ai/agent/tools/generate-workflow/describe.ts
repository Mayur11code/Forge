import { WorkflowProposalSchema } from "@/lib/workflow-types/workflow-proposal";

import type { ToolProposalSummary } from "../policy";

/**
 * Cap on the step rows rendered into a summary. A proposal may legally hold many
 * steps; the summary is a confirmation prompt, not the proposal itself.
 */
const MAX_DESCRIBED_STEPS = 8;

/**
 * Render a persisted proposal for the confirmation surface.
 *
 * Lifecycle note: `generateWorkflow` is READ_ONLY, so it never enters the
 * confirmation path (`requiresConfirmation` returns false for it) and this
 * function is not currently shown to a user. It exists because every registered
 * tool exposes the same optional describer contract through
 * `describeToolProposal`; today that generic resolver is its only caller. This
 * is presentation only and must not be relied on to decide what executes.
 *
 * It parses with the same model-facing schema the tool registers, so the summary
 * describes exactly the input the executor will compile. Input that does not
 * parse has nothing meaningful to show, so the caller falls back to a generic
 * prompt rather than throwing. Action membership is not checked here (the schema
 * does not check it), so an unknown action still renders and is reported by the
 * compiler at execution time, where the error belongs to the model.
 */
export function describeGenerateWorkflowProposal(
  input: unknown,
): ToolProposalSummary | null {
  const parsed = WorkflowProposalSchema.safeParse(input);

  if (!parsed.success) {
    return null;
  }

  const { name, description, steps } = parsed.data;
  const entries = Object.entries(steps);

  const fields: ToolProposalSummary["fields"] = [
    { label: "Name", value: name },
    { label: "Steps", value: String(entries.length) },
  ];

  if (description) {
    fields.push({ label: "Description", value: description });
  }

  for (const [localRef, step] of entries.slice(0, MAX_DESCRIBED_STEPS)) {
    fields.push({ label: localRef, value: step.action });
  }

  const noun = entries.length === 1 ? "step" : "steps";

  return {
    summary: `Propose workflow "${name}" (${entries.length} ${noun})`,
    fields,
  };
}
