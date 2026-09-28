// src/lib/ai/agent/tools/registry.ts
//
// Single source of truth mapping an agent tool name to (a) the AI SDK tool
// definition exposed to Gemini and (b) the server-side executor run by the
// worker.
//
// Trust model:
// - Gemini only ever sees `agentTools`. It never sees the executors.
// - An executor receives the model-controlled `input` plus a TRUSTED
//   `ToolExecutionContext` whose `orgId`/`userId` are loaded by tool-worker.ts
//   from the PERSISTED AgentSession row. They must never be sourced from the
//   LLM input or from the queue payload.

import type { ToolResultPart, ToolSet } from "ai";
import type { Prisma } from "@prisma/client";

import type { ToolExecutionContext } from "../types";

import { createTaskTool, executeCreateTask } from "./create-task";

/**
 * Server-side tool executor.
 *
 * `input` is untrusted (model-controlled) and must be schema-validated.
 * `ctx` is trusted and must be used to scope every read and write.
 */
export type ToolExecutor = (
  input: Prisma.JsonValue,
  ctx: ToolExecutionContext,
) => Promise<ToolResultPart["output"]>;

export const agentTools = {
  createTask: createTaskTool,
} satisfies ToolSet;

const toolExecutors: Record<string, ToolExecutor> = {
  createTask: executeCreateTask,
};

export function getToolExecutor(
  toolName: string,
): ToolExecutor {
  const executor = toolExecutors[toolName];

  if (!executor) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return executor;
}
