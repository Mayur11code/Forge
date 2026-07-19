import { tool } from "ai";
import { z } from "zod";

export const searchKnowledgeTool = tool({
  description:
    "Search the organization's knowledge base for information relevant to the user's request.",

  inputSchema: z
    .object({
      query: z
        .string()
        .min(1)
        .describe("The search query to execute against the knowledge base."),

      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum number of documents to retrieve."),
    })
    .strict(),


  
});