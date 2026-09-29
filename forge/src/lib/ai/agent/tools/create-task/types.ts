import { z } from "zod";

import type { ToolValidationIssue } from "../shared-output";
import { createTaskSchema } from "./schema";

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export type CreateTaskProjectSuggestion = {
  id: string;
  name: string;
};

export type CreateTaskOutput = {
  ok: boolean;
  task?: {
    id: string;
    title: string;
    projectId: string;
    projectName: string;
    status: string;
    priority: string;
    assigneeId: string | null;
    createdAt: string;
  };
  /** Machine-readable failure reason, mirrored from the canonical operation. */
  code?:
    | "INVALID_INPUT"
    | "PROJECT_NOT_FOUND"
    | "PROJECT_AMBIGUOUS"
    | "ASSIGNEE_NOT_FOUND"
    | "CREATE_FAILED";
  /** Human-readable, safe to surface to the user. */
  error?: string;
  /**
   * Present only on INVALID_INPUT, from `buildValidationFailure`. Each entry
   * names the field that failed so the model can correct that field on its next
   * turn instead of guessing which argument was malformed. Never contains any
   * part of the submitted input.
   */
  issues?: ToolValidationIssue[];
  /**
   * Present on PROJECT_NOT_FOUND / PROJECT_AMBIGUOUS so the model can correct
   * itself using real projects from the trusted org instead of inventing one.
   */
  suggestions?: CreateTaskProjectSuggestion[];
};
