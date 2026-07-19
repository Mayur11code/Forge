import { z } from "zod";

export const searchKnowledgeSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        "The search query to execute against the organization's knowledge base.",
      ),

    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe(
        "Maximum number of documents to retrieve.",
      ),
  })
  .strict();