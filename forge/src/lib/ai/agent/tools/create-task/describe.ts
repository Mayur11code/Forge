// src/lib/ai/agent/tools/create-task/describe.ts

import type { ToolProposalSummary } from "../policy";
import { createTaskSchema } from "./schema";

/**
 * Render the persisted createTask proposal for the confirmation UI.
 *
 * This runs on the PROPOSED `input`, the same bytes the executor will later
 * validate and act on, so what the user approves and what executes cannot
 * drift. It performs no I/O: projectName is shown as the human typed it, and
 * the trusted projectId is resolved later, at execution time, inside the org.
 *
 * If the input does not parse there is nothing meaningful to show, so the
 * caller is told to fall back to a generic prompt.
 */
export function describeCreateTaskProposal(
  input: unknown,
): ToolProposalSummary | null {
  const parsed = createTaskSchema.safeParse(input);

  if (!parsed.success) {
    return null;
  }

  const { title, projectName, priority, assigneeId } = parsed.data;

  const fields: ToolProposalSummary["fields"] = [
    { label: "Title", value: title },
    { label: "Project", value: projectName },
    // Show the effective value, not the raw optional: "MEDIUM" reads as an
    // intentional choice, whereas an absent field reads as an oversight.
    { label: "Priority", value: priority ?? "MEDIUM" },
  ];

  if (assigneeId) {
    fields.push({ label: "Assignee", value: assigneeId });
  }

  return {
    summary: `Create task "${title}" in ${projectName}`,
    fields,
  };
}
