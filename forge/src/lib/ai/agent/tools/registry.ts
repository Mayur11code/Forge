import type { ToolSet } from "ai";
import type { Prisma } from "@prisma/client";

import {
  executeSearchKnowledge,
  searchKnowledgeTool,
} from "./search-knowledge";

import type { ToolResultPart } from "ai";

export type ToolExecutor = (
  input: Prisma.JsonValue,
) => Promise<ToolResultPart["output"]>;

export const agentTools = {
  searchKnowledge: searchKnowledgeTool,
} satisfies ToolSet;

const toolExecutors: Record<string, ToolExecutor> = {
  searchKnowledge: executeSearchKnowledge,
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