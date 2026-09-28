// src/lib/ai/agent/tools/shared-output.ts
//
// Compact task shape returned to the model.
//
// The full `Task` row carries fields the model has no business reasoning
// about and which change on unrelated edits (`updatedAt`, ids it cannot use).
// Project arrives as a NAME, not an id: a CUID is not something the model can
// usefully hold, and a name is what the user actually said.
//
// This type describes both the success and failure shape so the model can
// always branch on `ok`.

import { z } from "zod";

export const taskSummaryOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
  projectName: z.string(),
  assigneeId: z.string().nullable(),
});

export type TaskOutput =
  | { ok: true; tasks: z.infer<typeof taskSummaryOutputSchema>[] }
  | {
      ok: false;
      code: string;
      error: string;
      suggestions?: { id: string; name: string }[];
    };
