import { tool } from "ai";

import { generateWorkflowToolInputSchema } from "./schema";

export const generateWorkflowTool = tool({
  description: [
    "DRAFT and VALIDATE a workflow from the user's request, or REQUEST CLARIFICATION when required information is genuinely missing.",
    "",
    "This tool does NOT create, save, run, or schedule anything. It validates a",
    "proposed graph and returns it; nothing is persisted and no execution starts.",
    "It runs immediately and needs no user approval.",
    "",
    "Call it only when the user explicitly asks you to design, draft, or generate a",
    "workflow or automation. Never call it proactively.",
    "",
    "A proposal has a `name`, an optional `description`, and `steps`. Each step's",
    "`action` must be a registered workflow action id, `inputs` must match that",
    "action's fields, and `dependsOn` lists the local step ids it needs first. The",
    "keys of `steps` are the step ids: start with a letter or underscore and use",
    "only letters, digits, underscores or hyphens. Reference an earlier step's",
    "output with the existing `{{stepId.outputs.field}}` grammar.",
    "",
    "When a required action input is genuinely missing because the user never",
    "supplied it (and it cannot be inferred from conversation context), supply",
    "a `clarifications` array identifying the missing field, why it is required,",
    "and a human-readable question. Never invent placeholder or hallucinated IDs.",
    "",
    "The result is either { ok: true, proposal } for a valid proposal, or",
    "{ ok: false, status: 'NEEDS_USER_INPUT', fields, correlationId, ... } when human clarification is needed, or a",
    "validation failure listing the fields to fix, by name and path. If it fails,",
    "correct exactly those fields and call again. Never tell the user a workflow",
    "was created or started: this tool only proposes one.",
  ].join(" "),

  inputSchema: generateWorkflowToolInputSchema,
});
