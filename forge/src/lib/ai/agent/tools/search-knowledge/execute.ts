import type { Prisma } from "@prisma/client";

import { searchKnowledgeSchema } from "./schema";

export async function executeSearchKnowledge(
  input: Prisma.JsonValue,
): Promise<Prisma.InputJsonValue> {
  if (input === null) {
    throw new Error("Tool input cannot be null.");
  }

  const parsed = searchKnowledgeSchema.parse(input);

  // Business logic...

  return {
    documents: [],
  };
}