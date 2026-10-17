import { WorkflowProposalSchema } from "@/lib/workflow-types/workflow-proposal";

import type { ToolProposalSummary } from "../policy";

/**
 * Cap on the step rows rendered into a summary. A proposal may legally hold many
 * steps; the summary is a confirmation prompt, not the proposal itself.
 */
const MAX_DESCRIBED_STEPS = 8;

function extractProposalInput(input: unknown): {
  proposal: unknown;
  clarificationCount: number;
} {
  if (typeof input !== "object" || input === null) {
    return { proposal: input, clarificationCount: 0 };
  }
  const obj = input as Record<string, unknown>;
  if ("proposal" in obj) {
    const clarificationCount = Array.isArray(obj.clarifications)
      ? obj.clarifications.length
      : 0;
    return { proposal: obj.proposal, clarificationCount };
  }
  if ("clarifications" in obj) {
    const { clarifications, ...rest } = obj;
    const clarificationCount = Array.isArray(clarifications)
      ? clarifications.length
      : 0;
    return { proposal: rest, clarificationCount };
  }
  return { proposal: input, clarificationCount: 0 };
}

/**
 * Render a persisted proposal for the confirmation surface.
 *
 * Lifecycle note: `generateWorkflow` is READ_ONLY, so it never enters the
 * confirmation path (`requiresConfirmation` returns false for it) and this
 * function is not currently shown to a user. It exists because every registered
 * tool exposes the same optional describer contract through
 * `describeToolProposal`; today that generic resolver is its only caller. This
 * is presentation only and must not be relied on to decide what executes.
 */
export function describeGenerateWorkflowProposal(
  input: unknown,
): ToolProposalSummary | null {
  const { proposal, clarificationCount } = extractProposalInput(input);
  const parsed = WorkflowProposalSchema.safeParse(proposal);

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

  if (clarificationCount > 0) {
    fields.push({
      label: "Clarifications",
      value: `${clarificationCount} requested`,
    });
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
