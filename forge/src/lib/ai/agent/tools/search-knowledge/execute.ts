import type { Prisma } from "@prisma/client";
import type { ToolResultPart } from "ai";

import { searchKnowledgeSchema } from "./schema";

type ToolOutput = ToolResultPart["output"];

export async function executeSearchKnowledge(
  input: Prisma.JsonValue,
): Promise<ToolOutput> {
  if (input === null) {
    throw new Error("Tool input cannot be null.");
  }

  const parsed = searchKnowledgeSchema.parse(input);

  return {
    type: "json",
    value: {
      query: parsed.query,
      results: [],
    },
  };
}